// Live app: the browser is the chat for a real Claude Code session.
import hljs from "highlight.js/lib/common";
import katex from "katex";
import { renderSection, md, esc, type RenderOpts } from "./runtime/render";
import { hydrate } from "./runtime/widgets";
import { $, initTheme, renderOutline, trackActiveSection, chatMsgHtml, transcriptHtml, initTabs, fmtTokens } from "./ui";
import { mountLibrary, type Meta } from "./library";
import type { ChatMsg, Lesson, Section, TranscriptEntry, Usage } from "./runtime/types";

const opts: RenderOpts = {
  highlight: (code, lang) => {
    try {
      return lang && hljs.getLanguage(lang) ? hljs.highlight(code, { language: lang }).value : hljs.highlightAuto(code).value;
    } catch { return esc(code); }
  },
  math: (tex, display) => katex.renderToString(tex, { displayMode: display, output: "mathml", throwOnError: false }),
};
const inline = (s: string) => md(s, opts);

const path = location.pathname;
const lessonId = /^\/l\/([a-z0-9-]+)/.exec(path)?.[1];

if (!lessonId) void showLibrary();
else showLesson(lessonId);

// ============================================================ library
async function showLibrary() {
  initTheme();
  document.title = "learn · library";
  $(".lesson-title").textContent = "Library";
  const root = $(".library");
  root.hidden = false;
  const r = await fetch("/api/lessons");
  if (r.status === 401) {
    root.innerHTML = `<p class="lib-empty">This browser isn't signed in to your learn server yet. Run <code>learn --library</code> in a terminal to open it.</p>`;
    return;
  }
  const lessons = (await r.json()) as Meta[];
  const call = (id: string, method: string, body?: unknown) =>
    fetch(`/api/lessons/${id}`, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }).then(() => {});
  mountLibrary(root, lessons, {
    live: true, serverUp: true, port: Number(location.port),
    hrefOffline: id => `/saved/${encodeURIComponent(id)}/lesson.html`,
    onRename: (id, title) => call(id, "PATCH", { title }),
    onTags: (id, tags) => call(id, "PATCH", { tags }),
    onDelete: id => call(id, "DELETE"),
  });
}

// ============================================================ lesson
function showLesson(id: string) {
  const layout = $(".layout");
  layout.hidden = false;
  $(".tabs").hidden = false;
  const canvas = $("#canvas");
  const nav = $(".outline");
  const log = $(".chat-log");
  const textarea = $<HTMLTextAreaElement>(".composer textarea");
  const sendBtn = $<HTMLButtonElement>(".send-btn");
  const stopBtn = $<HTMLButtonElement>(".stop-btn");
  const undoBtn = $<HTMLButtonElement>(".undo-btn");
  const banner = $(".live-banner");
  const titleEl = $(".lesson-title");
  const refreshActive = trackActiveSection(canvas, nav);

  let lesson: Lesson | null = null;
  let busy = false;
  let live = false;
  let resumeMode: "auto" | "full" | "outline" = "auto";
  let ws: WebSocket | null = null;
  let images: { mediaType: string; data: string; url: string }[] = [];
  const hashes = new Map<string, string>();
  let transcript: TranscriptEntry[] | null = null;
  const permQueue: any[] = [];

  initTheme(() => { hashes.clear(); if (lesson) void renderCanvas(lesson.sections); });

  // ---------- websocket ----------
  let retry = 0;
  const connect = () => {
    ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws?id=${encodeURIComponent(id)}`);
    ws.onopen = () => { retry = 0; };
    ws.onmessage = ev => onEvent(JSON.parse(ev.data));
    ws.onclose = ev => {
      if (ev.code === 1006 && retry === 0 && !lesson) {
        // Probably not authorized (HTTP 401 before upgrade).
        void fetch(`/api/lessons/${id}`).then(r => {
          if (r.status === 401) showBanner(`This browser isn't signed in yet. Run <code>learn --resume ${esc(id)}</code> in a terminal.`);
          else if (r.status === 404) showBanner(`There's no lesson with id <code>${esc(id)}</code>. <a href="/">Open the library</a>.`);
        });
      }
      retry++;
      setTimeout(connect, Math.min(8000, 500 * 2 ** retry));
    };
  };
  const wsSend = (m: unknown) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m));
  connect();

  function onEvent(ev: any) {
    switch (ev.type) {
      case "state": {
        lesson = ev.lesson as Lesson;
        live = ev.live;
        setTitle(lesson.title);
        $(".meta").textContent = lesson.cwd.split("/").slice(-2).join("/");
        $(".meta").title = lesson.cwd;
        log.innerHTML = "";
        lesson.chat.forEach(addChat);
        void renderCanvas(lesson.sections);
        setBusy(ev.busy, ev.canUndo);
        drawMeter(lesson.usage, ev.status);
        updateResumeBanner(ev.resumeHint);
        permQueue.length = 0;
        (ev.perms ?? []).forEach((p: any) => permQueue.push(p));
        showNextPerm();
        break;
      }
      case "canvas":
        if (!lesson) return;
        lesson.sections = ev.sections;
        if (ev.title) setTitle(ev.title);
        if (ev.rerender) hashes.clear();
        void renderCanvas(lesson.sections);
        break;
      case "chat": lesson?.chat.push(ev.msg); addChat(ev.msg); break;
      case "transcript": if (transcript) { transcript.push(ev.entry); appendTranscript(ev.entry); } break;
      case "transcript-all": transcript = ev.entries; $(".transcript").innerHTML = (transcript ?? []).map(transcriptHtml).join("") || `<p class="lib-empty">Nothing yet.</p>`; break;
      case "busy": setBusy(ev.busy, ev.canUndo); break;
      case "usage": if (lesson) { lesson.usage = ev.usage; drawMeter(ev.usage); if (ev.title) setTitle(ev.title); } break;
      case "status": drawMeter(lesson?.usage, ev.status); live = true; banner.hidden = true; break;
      case "live": live = ev.live; break;
      case "meta": setTitle(ev.title); break;
      case "perm": permQueue.push(ev); showNextPerm(); break;
      case "perm-done": {
        const i = permQueue.findIndex(p => p.id === ev.id);
        if (i >= 0) permQueue.splice(i, 1);
        if (currentPerm === ev.id) { closeModal(); currentPerm = null; showNextPerm(); }
        break;
      }
      case "error": addChat({ role: "system", text: ev.error, ts: Date.now() }); break;
    }
  }

  // ---------- canvas ----------
  let renderSeq = 0;
  async function renderCanvas(sections: Section[]) {
    const seq = ++renderSeq;
    renderOutline(nav, sections);
    if (!sections.length) {
      canvas.innerHTML = `<p class="canvas-empty"><span class="pulse-dot"></span>${busy ? "Claude is preparing your lesson…" : "Ask a question to start the lesson."}</p>`;
      return;
    }
    canvas.querySelector(".canvas-empty")?.remove();
    const keep = new Set(sections.map(s => s.id));
    canvas.querySelectorAll<HTMLElement>(".sec").forEach(el => { if (!keep.has(el.dataset.id!)) { el.remove(); hashes.delete(el.dataset.id!); } });
    const posted: Record<string, string> = {};
    let prev: HTMLElement | null = null;
    for (const s of sections) {
      let el = canvas.querySelector<HTMLElement>(`.sec[data-id="${CSS.escape(s.id)}"]`);
      const isNew = !el;
      if (!el) {
        el = document.createElement("section");
        el.className = "sec"; el.id = s.id; el.dataset.id = s.id;
        el.innerHTML = `<div class="sec-tools">
            <button data-q="simpler">Simpler</button><button data-q="deeper">Deeper</button>
            <button data-q="example">Example</button><button data-q="quiz">Quiz me</button><button data-q="ask">Ask…</button>
          </div><h2 class="sec-title"><span class="sec-id"></span><span class="sec-name"></span></h2><div class="sec-body"></div>`;
      }
      // Keep DOM order in sync with section order.
      const want: Element | null = prev ? prev.nextElementSibling : canvas.firstElementChild;
      if (want !== el) canvas.insertBefore(el, want);
      prev = el;
      const hash = JSON.stringify(s);
      if (hashes.get(s.id) === hash) continue;
      hashes.set(s.id, hash);
      el.querySelector(".sec-id")!.textContent = s.id;
      el.querySelector(".sec-name")!.textContent = s.title;
      const body = el.querySelector<HTMLElement>(".sec-body")!;
      body.innerHTML = renderSection(s, opts);
      await renderMermaid(body);
      if (seq !== renderSeq && hashes.get(s.id) !== hash) return; // superseded
      posted[s.id] = body.innerHTML; // pre-hydration static HTML for the saved file
      hydrate(body, sections, hooks, inline);
      if (isNew && lesson && lesson.sections.length > 1) {
        el.classList.add("is-new");
        setTimeout(() => el!.classList.remove("is-new"), 2500);
        if (busy) el.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
      }
    }
    if (Object.keys(posted).length) wsSend({ type: "rendered", map: posted });
    refreshActive();
  }

  let mermaidMod: typeof import("mermaid").default | null = null;
  let mermaidN = 0;
  async function renderMermaid(root: HTMLElement) {
    const nodes = [...root.querySelectorAll<HTMLElement>("pre.mermaid")];
    if (!nodes.length) return;
    if (!mermaidMod) mermaidMod = (await import("mermaid")).default;
    const dark = document.documentElement.dataset.theme !== "light";
    mermaidMod.initialize({ startOnLoad: false, securityLevel: "strict", theme: dark ? "dark" : "neutral", fontFamily: "system-ui, sans-serif" });
    for (const n of nodes) {
      const src = n.textContent || "";
      try {
        const { svg } = await mermaidMod.render(`mmd-${++mermaidN}`, src);
        const div = document.createElement("div");
        div.className = "mermaid-svg";
        div.innerHTML = svg;
        n.replaceWith(div);
      } catch (e) {
        n.insertAdjacentHTML("afterend", `<div class="diagram-error">Diagram error: ${esc(String((e as Error).message ?? e)).slice(0, 300)}</div>`);
      }
    }
  }

  const hooks = {
    send: (text: string) => send(text),
    confirmSandboxMessage: (text: string) => confirmModal("Send this from the demo?", `The interactive demo wants to send Claude this message:`, text, "Send to Claude"),
  };

  canvas.addEventListener("click", ev => {
    const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>(".sec-tools button");
    if (!btn) return;
    const sid = btn.closest<HTMLElement>(".sec")!.dataset.id;
    const q = btn.dataset.q;
    if (q === "ask") { textarea.value = `[${sid}] `; textarea.focus(); autosize(); updateSend(); return; }
    const say = { simpler: "explain this more simply", deeper: "go deeper", example: "add a concrete example", quiz: "quiz me on this" }[q!];
    send(`[${sid}] ${say}`);
  });

  // ---------- chat ----------
  function addChat(m: ChatMsg) {
    log.querySelector(".typing")?.remove();
    log.insertAdjacentHTML("beforeend", chatMsgHtml(m, opts));
    if (busy) log.insertAdjacentHTML("beforeend", `<div class="typing" aria-label="Claude is working"><span></span><span></span><span></span></div>`);
    log.scrollTop = log.scrollHeight;
  }

  function setBusy(b: boolean, canUndo?: boolean) {
    busy = b;
    stopBtn.hidden = !b;
    sendBtn.hidden = b;
    if (canUndo !== undefined) undoBtn.disabled = !canUndo || b;
    log.querySelector(".typing")?.remove();
    if (b) { log.insertAdjacentHTML("beforeend", `<div class="typing" aria-label="Claude is working"><span></span><span></span><span></span></div>`); log.scrollTop = log.scrollHeight; }
    if (lesson && !lesson.sections.length) void renderCanvas(lesson.sections);
    updateSend();
  }

  function send(text: string) {
    if (busy) { addChat({ role: "system", text: "Claude is still working. Press Stop or wait for it to finish.", ts: Date.now() }); return; }
    wsSend({ type: "send", text, images: images.map(({ mediaType, data }) => ({ mediaType, data })), resumeMode });
    images = []; drawAttachments();
    banner.hidden = true;
  }

  const autosize = () => { textarea.style.height = "auto"; textarea.style.height = `${Math.min(180, textarea.scrollHeight)}px`; };
  const updateSend = () => { sendBtn.disabled = !textarea.value.trim() && !images.length; };
  const submit = () => {
    const t = textarea.value.trim();
    if (!t && !images.length) return;
    send(t);
    textarea.value = ""; autosize(); updateSend();
  };
  sendBtn.onclick = submit;
  stopBtn.onclick = () => wsSend({ type: "interrupt" });
  undoBtn.onclick = () => wsSend({ type: "undo" });
  document.querySelectorAll<HTMLButtonElement>(".shortcuts button").forEach(b => b.addEventListener("click", () => send(b.dataset.say!)));

  // ---------- @ file mentions ----------
  const mentions = $(".mentions");
  let mentionItems: string[] = [];
  let mentionIdx = 0;
  let mentionTimer: ReturnType<typeof setTimeout> | null = null;
  const mentionQuery = () => /(^|\s)@([\w./-]*)$/.exec(textarea.value.slice(0, textarea.selectionStart))?.[2];
  const drawMentions = () => {
    mentions.hidden = !mentionItems.length;
    mentions.innerHTML = mentionItems.map((f, i) => `<div data-i="${i}" class="${i === mentionIdx ? "is-on" : ""}">${esc(f)}</div>`).join("");
  };
  const pickMention = (i: number) => {
    const f = mentionItems[i];
    if (!f) return;
    const pos = textarea.selectionStart;
    const before = textarea.value.slice(0, pos).replace(/@([\w./-]*)$/, `@${f} `);
    textarea.value = before + textarea.value.slice(pos);
    textarea.selectionStart = textarea.selectionEnd = before.length;
    mentionItems = []; drawMentions(); textarea.focus();
  };
  mentions.addEventListener("mousedown", ev => { ev.preventDefault(); pickMention(Number((ev.target as HTMLElement).dataset.i)); });

  textarea.addEventListener("input", () => {
    autosize(); updateSend();
    const q = mentionQuery();
    if (q === undefined) { mentionItems = []; drawMentions(); return; }
    if (mentionTimer) clearTimeout(mentionTimer);
    mentionTimer = setTimeout(async () => {
      const r = await fetch(`/api/files?id=${encodeURIComponent(id)}&q=${encodeURIComponent(q)}`);
      mentionItems = r.ok ? await r.json() : [];
      mentionIdx = 0; drawMentions();
    }, 120);
  });
  textarea.addEventListener("keydown", ev => {
    if (!mentions.hidden && mentionItems.length) {
      if (ev.key === "ArrowDown") { mentionIdx = (mentionIdx + 1) % mentionItems.length; drawMentions(); ev.preventDefault(); return; }
      if (ev.key === "ArrowUp") { mentionIdx = (mentionIdx - 1 + mentionItems.length) % mentionItems.length; drawMentions(); ev.preventDefault(); return; }
      if (ev.key === "Enter" || ev.key === "Tab") { pickMention(mentionIdx); ev.preventDefault(); return; }
      if (ev.key === "Escape") { mentionItems = []; drawMentions(); return; }
    }
    if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); submit(); }
  });

  // ---------- images: paste / drop, downscaled to save tokens ----------
  async function addImage(file: File) {
    if (!file.type.startsWith("image/") || images.length >= 4) return;
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 1024 / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
    c.getContext("2d")!.drawImage(bmp, 0, 0, c.width, c.height);
    const url = c.toDataURL("image/jpeg", 0.85);
    images.push({ mediaType: "image/jpeg", data: url.split(",")[1]!, url });
    drawAttachments(); updateSend();
  }
  function drawAttachments() {
    const box = $(".attachments");
    box.innerHTML = images.map((im, i) => `<img src="${im.url}" data-i="${i}" alt="Attached image ${i + 1}" title="Click to remove">`).join("");
  }
  $(".attachments").addEventListener("click", ev => {
    const i = (ev.target as HTMLElement).dataset.i;
    if (i !== undefined) { images.splice(Number(i), 1); drawAttachments(); updateSend(); }
  });
  textarea.addEventListener("paste", ev => {
    const files = [...(ev.clipboardData?.files ?? [])].filter(f => f.type.startsWith("image/"));
    if (files.length) { ev.preventDefault(); files.forEach(addImage); }
  });
  $(".chat").addEventListener("dragover", ev => ev.preventDefault());
  $(".chat").addEventListener("drop", ev => { ev.preventDefault(); [...(ev.dataTransfer?.files ?? [])].forEach(addImage); });

  // ---------- meter ----------
  let status: any = {};
  function drawMeter(u?: Usage, st?: any) {
    if (st) status = st;
    if (!u) return;
    $(".meter").innerHTML = [
      `<span title="Tokens Claude read on the last request (its context size)">context ${fmtTokens(u.contextTokens)}</span>`,
      `<span title="Tokens Claude wrote in the last turn">wrote ${fmtTokens(u.outputTokens)}</span>`,
      `<span title="Share of the last turn's input served from the prompt cache (cheaper)">cached ${u.cacheHitPct}%</span>`,
      `<span title="Estimated total cost of this lesson">$${u.costUsd.toFixed(3)}</span>`,
      status?.model ? `<span title="Model">${esc(status.model)}</span>` : "",
      status?.auth ? `<span title="How requests are authenticated">${esc(status.auth)}</span>` : "",
    ].join("");
  }

  // ---------- title ----------
  function setTitle(t: string) {
    if (lesson) lesson.title = t;
    if (document.activeElement !== titleEl) titleEl.textContent = t;
    document.title = `${t} · learn`;
  }
  titleEl.addEventListener("click", () => { titleEl.contentEditable = "true"; titleEl.focus(); });
  titleEl.addEventListener("keydown", ev => { if (ev.key === "Enter") { ev.preventDefault(); titleEl.blur(); } });
  titleEl.addEventListener("blur", () => {
    titleEl.contentEditable = "false";
    const t = titleEl.textContent?.trim();
    if (t && lesson && t !== lesson.title) {
      void fetch(`/api/lessons/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: t }) });
      setTitle(t);
    }
  });

  // ---------- resume banner ----------
  function showBanner(html: string) { banner.innerHTML = html; banner.hidden = false; }
  function updateResumeBanner(hint: "full" | "outline" | null) {
    if (!hint) { banner.hidden = true; return; }
    resumeMode = hint;
    const draw = () => showBanner(`<span>This lesson is paused. Your next message continues it, using:</span>
      <span class="seg"><button data-m="outline" class="${resumeMode === "outline" ? "is-on" : ""}" title="Start a fresh session seeded with the lesson outline. Much cheaper.">Lesson outline</button>
      <button data-m="full" class="${resumeMode === "full" ? "is-on" : ""}" title="Reload the whole previous conversation. Best context, more tokens.">Full history</button></span>`);
    draw();
    banner.onclick = ev => {
      const m = (ev.target as HTMLElement).closest<HTMLButtonElement>("button[data-m]")?.dataset.m;
      if (m === "full" || m === "outline") { resumeMode = m; draw(); }
    };
  }

  // ---------- transcript ----------
  initTabs(layout, () => { if (!transcript) wsSend({ type: "transcript" }); });
  function appendTranscript(e: TranscriptEntry) {
    const box = $(".transcript");
    box.querySelector(".lib-empty")?.remove();
    box.insertAdjacentHTML("beforeend", transcriptHtml(e));
  }

  // ---------- modals ----------
  let currentPerm: string | null = null;
  function closeModal() { $(".modal-root").innerHTML = ""; }
  function showNextPerm() {
    if (currentPerm || !permQueue.length) return;
    const p = permQueue[0];
    currentPerm = p.id;
    $(".modal-root").innerHTML = `<div class="modal-back"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="perm-title">
      <h3 id="perm-title">${esc(p.title)}</h3>
      ${p.description ? `<p>${esc(p.description)}</p>` : ""}
      <pre>${esc(p.detail)}</pre>
      <div class="modal-actions">
        <button data-d="deny" class="danger">Deny</button>
        ${p.canAlways ? `<button data-d="always">Allow for this session</button>` : ""}
        <button data-d="allow" class="primary">Allow once</button>
      </div></div></div>`;
    const root = $(".modal-root");
    (root.querySelector(p.defaultToNo ? '[data-d="deny"]' : '[data-d="allow"]') as HTMLButtonElement).focus();
    root.onclick = ev => {
      const d = (ev.target as HTMLElement).closest<HTMLButtonElement>("button[data-d]")?.dataset.d;
      if (!d) return;
      wsSend({ type: "perm", id: p.id, decision: d });
      permQueue.shift(); currentPerm = null; closeModal(); root.onclick = null; showNextPerm();
    };
  }
  function confirmModal(title: string, desc: string, detail: string, ok: string): Promise<boolean> {
    return new Promise(resolve => {
      const root = $(".modal-root");
      root.innerHTML = `<div class="modal-back"><div class="modal" role="dialog" aria-modal="true"><h3>${esc(title)}</h3><p>${esc(desc)}</p><pre>${esc(detail)}</pre>
        <div class="modal-actions"><button data-v="0">Cancel</button><button data-v="1" class="primary">${esc(ok)}</button></div></div></div>`;
      (root.querySelector('[data-v="1"]') as HTMLButtonElement).focus();
      root.onclick = ev => {
        const v = (ev.target as HTMLElement).closest<HTMLButtonElement>("button[data-v]")?.dataset.v;
        if (v === undefined) return;
        root.onclick = null; closeModal(); resolve(v === "1"); showNextPerm();
      };
    });
  }
}
