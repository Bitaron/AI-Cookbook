// Live app: the browser is the chat for a real Claude Code session.
import hljs from "highlight.js/lib/common";
import katex from "katex";
import { renderSection, md, esc, type RenderOpts } from "./runtime/render";
import { hydrate, findBlock } from "./runtime/widgets";
import { markTerms, initTermCards } from "./runtime/glossary";
import { svgToPng, type AnimHandle } from "./runtime/anim";
import { $, initTheme, toggleTheme, renderOutline, trackActiveSection, chatMsgHtml, transcriptHtml, initTabs, fmtTokens, reducedMotion } from "./ui";
import { mountLibrary, type Meta } from "./library";
import { initMermaid, renderMermaid } from "./mermaid";
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
const isTyping = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

const lessonId = /^\/l\/([a-z0-9-]+)/.exec(location.pathname)?.[1];
initTheme();
if (!lessonId) void showLibrary();
else showLesson(lessonId);

// ============================================================ library
async function showLibrary() {
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
  document.addEventListener("keydown", ev => {
    if (ev.key === "/" && !isTyping(ev.target)) { ev.preventDefault(); $<HTMLInputElement>(".lib-search").focus(); }
    if (ev.key.toLowerCase() === "t" && !isTyping(ev.target) && !ev.ctrlKey && !ev.metaKey) toggleTheme();
  });
}

// ============================================================ lesson
interface CtxChip { kind: "quote" | "diagram" | "anim" | "image" | "section" | "code"; label: string; text: string; image?: { mediaType: string; data: string; url: string } }

function showLesson(id: string) {
  const layout = $(".layout");
  layout.hidden = false;
  $(".tabs").hidden = false;
  $(".top-actions").hidden = false;
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
  let resumeMode: "auto" | "full" | "outline" = "auto";
  let ws: WebSocket | null = null;
  let chips: CtxChip[] = [];
  const hashes = new Map<string, string>();
  let transcript: TranscriptEntry[] | null = null;
  const permQueue: any[] = [];

  initMermaid();
  initTermCards(() => lesson?.glossary, term => send(`Explain ${term}.`));

  // ---------- websocket ----------
  let retry = 0;
  const connect = () => {
    ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws?id=${encodeURIComponent(id)}`);
    ws.onopen = () => { retry = 0; };
    ws.onmessage = ev => onEvent(JSON.parse(ev.data));
    ws.onclose = ev => {
      if (ev.code === 1006 && retry === 0 && !lesson) {
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
        setTitle(lesson.title);
        $(".meta").textContent = lesson.cwd.split("/").slice(-2).join("/");
        $(".meta").title = lesson.cwd;
        log.innerHTML = "";
        lesson.chat.forEach(m => addChat(m, false));
        log.scrollTop = log.scrollHeight;
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
        if (ev.glossary && JSON.stringify(ev.glossary) !== JSON.stringify(lesson.glossary)) { lesson.glossary = ev.glossary; hashes.clear(); }
        if (ev.title) setTitle(ev.title);
        if (ev.rerender) hashes.clear();
        void renderCanvas(lesson.sections);
        break;
      case "chat": lesson?.chat.push(ev.msg); addChat(ev.msg); break;
      case "transcript": if (transcript) { transcript.push(ev.entry); appendTranscript(ev.entry); } break;
      case "transcript-all": transcript = ev.entries; $(".transcript").innerHTML = (transcript ?? []).map(transcriptHtml).join("") || `<p class="lib-empty">Nothing yet.</p>`; break;
      case "busy": setBusy(ev.busy, ev.canUndo); break;
      case "usage": if (lesson) { lesson.usage = ev.usage; drawMeter(ev.usage); if (ev.title) setTitle(ev.title); } break;
      case "status": drawMeter(lesson?.usage, ev.status); banner.hidden = true; break;
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
    renderOutline(nav, sections, lesson?.glossary);
    if (!sections.length) {
      canvas.innerHTML = `<div class="canvas-empty"><div class="empty-mark"></div><p>${busy ? "Claude is sketching your lesson…" : "Ask a question to start the lesson."}</p></div>`;
      return;
    }
    canvas.querySelector(".canvas-empty")?.remove();
    const keep = new Set(sections.map(s => s.id));
    canvas.querySelectorAll<HTMLElement>(".sec").forEach(el => { if (!keep.has(el.dataset.id!)) { el.remove(); hashes.delete(el.dataset.id!); } });
    const posted: Record<string, string> = {};
    let prev: HTMLElement | null = null;
    const glossKey = JSON.stringify(lesson?.glossary ?? {});
    for (const s of sections) {
      let el = canvas.querySelector<HTMLElement>(`.sec[data-id="${CSS.escape(s.id)}"]`);
      const isNew = !el;
      if (!el) {
        el = document.createElement("section");
        el.className = "sec"; el.id = s.id; el.dataset.id = s.id;
        el.innerHTML = `<div class="sec-gutter"><span class="sec-id"></span></div>
          <div class="sec-main"><h2 class="sec-title"></h2><div class="sec-body"></div></div>
          <div class="sec-tools" role="toolbar" aria-label="Section actions">
            <button data-q="simpler" title="Explain more simply (S)">Simpler</button><button data-q="deeper" title="Go deeper (D)">Deeper</button>
            <button data-q="example" title="Add an example (E)">Example</button><button data-q="ask" title="Ask about this section (A)">Ask…</button>
          </div>`;
      }
      const want: Element | null = prev ? prev.nextElementSibling : canvas.firstElementChild;
      if (want !== el) canvas.insertBefore(el, want);
      prev = el;
      const hash = JSON.stringify(s) + glossKey;
      if (hashes.get(s.id) === hash) continue;
      hashes.set(s.id, hash);
      el.querySelector(".sec-id")!.textContent = s.id;
      el.querySelector(".sec-title")!.textContent = s.title;
      const body = el.querySelector<HTMLElement>(".sec-body")!;
      body.innerHTML = renderSection(s, opts);
      await renderMermaid(body);
      if (seq !== renderSeq && hashes.get(s.id) !== hash) return; // superseded
      posted[s.id] = body.innerHTML; // static HTML for the saved file (before terms and widgets)
      markTerms(el, lesson?.glossary);
      hydrate(body, sections, hooks, inline);
      if (isNew && lesson && lesson.sections.length > 1) {
        el.classList.add("is-new");
        setTimeout(() => el!.classList.remove("is-new"), 2400);
        if (busy) el.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "start" });
      }
    }
    if (Object.keys(posted).length) wsSend({ type: "rendered", map: posted });
    refreshActive();
  }

  const hooks = {
    send: (text: string) => send(text),
    confirmSandboxMessage: (text: string) => confirmModal("Send this from the demo?", `The interactive demo wants to send Claude this message:`, text, "Send to Claude"),
  };

  const quick: Record<string, string> = { simpler: "explain this more simply", deeper: "go deeper", example: "add a concrete example", quiz: "quiz me on this" };
  const sectionAction = (sid: string, q: string) => {
    if (q === "ask") { addChip({ kind: "section", label: `Section ${sid}`, text: `[${sid}]` }); textarea.focus(); return; }
    send(`[${sid}] ${quick[q]}`);
  };
  canvas.addEventListener("click", ev => {
    const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>(".sec-tools button");
    if (btn) sectionAction(btn.closest<HTMLElement>(".sec")!.dataset.id!, btn.dataset.q!);
  });
  nav.addEventListener("click", ev => {
    const t = (ev.target as HTMLElement).closest<HTMLElement>("[data-term]");
    if (t) send(`Explain ${t.dataset.term}.`);
  });

  // ---------- chat ----------
  function addChat(m: ChatMsg, scroll = true) {
    log.querySelector(".typing")?.remove();
    log.insertAdjacentHTML("beforeend", chatMsgHtml(m, opts));
    if (busy) log.insertAdjacentHTML("beforeend", typingHtml);
    if (m.role === "tool") setStatus(`${m.tool === "canvas" ? "Writing the lesson" : toolVerb(m.tool)}${m.text ? ` · ${m.text}` : ""}`);
    if (scroll) log.scrollTo({ top: log.scrollHeight, behavior: reducedMotion() ? "auto" : "smooth" });
  }
  const typingHtml = `<div class="typing" aria-label="Claude is working"><span></span><span></span><span></span></div>`;
  const toolVerb = (t?: string) => ({ Read: "Reading", Grep: "Searching", Glob: "Finding files", Bash: "Running", WebSearch: "Searching the web", WebFetch: "Reading a page", Edit: "Editing", Write: "Writing", Agent: "Delegating" } as Record<string, string>)[t ?? ""] ?? (t ?? "Working");

  // ---------- busy + status line ----------
  let busySince = 0;
  let statusTimer: ReturnType<typeof setInterval> | null = null;
  function setStatus(text: string) { $(".status-text").textContent = text.slice(0, 120); }
  function setBusy(b: boolean, canUndo?: boolean) {
    const was = busy;
    busy = b;
    stopBtn.hidden = !b;
    sendBtn.hidden = b;
    document.body.classList.toggle("is-busy", b);
    if (canUndo !== undefined) undoBtn.disabled = !canUndo || b;
    log.querySelector(".typing")?.remove();
    const line = $(".status-line");
    if (b) {
      log.insertAdjacentHTML("beforeend", typingHtml);
      log.scrollTop = log.scrollHeight;
      if (!was) { busySince = Date.now(); setStatus("Thinking"); }
      line.hidden = false;
      statusTimer ??= setInterval(() => { $(".status-time").textContent = `${Math.round((Date.now() - busySince) / 1000)}s`; }, 1000);
    } else {
      line.hidden = true;
      if (statusTimer) clearInterval(statusTimer);
      statusTimer = null;
      $(".status-time").textContent = "";
    }
    if (lesson && !lesson.sections.length) void renderCanvas(lesson.sections);
    updateSend();
  }

  // ---------- sending (with context chips) ----------
  function send(text: string) {
    if (busy) { toast("Claude is still working. Press Stop or wait for it to finish."); return; }
    const ctxText = chips.filter(c => c.text).map(c => c.text).join("\n");
    const images = chips.filter(c => c.image).map(c => ({ mediaType: c.image!.mediaType, data: c.image!.data }));
    const full = ctxText ? `${ctxText}\n\n${text}`.trim() : text;
    if (!full.trim() && !images.length) return;
    wsSend({ type: "send", text: full, images, resumeMode });
    chips = []; drawChips();
    banner.hidden = true;
  }

  function addChip(c: CtxChip) {
    if (chips.length >= 8) { toast("That's plenty of context. Send or remove some first."); return; }
    chips.push(c); drawChips(); updateSend();
    toast(`Added ${c.label.toLowerCase()} to your next message`);
  }
  function drawChips() {
    $(".ctx-chips").innerHTML = chips.map((c, i) => `<span class="chip chip-${c.kind}" title="${esc(c.text.slice(0, 400))}">
      ${c.image ? `<img src="${c.image.url}" alt="">` : `<span class="chip-kind">${{ quote: "“", diagram: "◇", anim: "▶", image: "▣", section: "§", code: "{}" }[c.kind]}</span>`}
      <span class="chip-label">${esc(c.label)}</span><button data-i="${i}" aria-label="Remove">×</button></span>`).join("");
  }
  $(".ctx-chips").addEventListener("click", ev => {
    const i = (ev.target as HTMLElement).closest<HTMLButtonElement>("button[data-i]")?.dataset.i;
    if (i !== undefined) { chips.splice(Number(i), 1); drawChips(); updateSend(); }
  });

  const autosize = () => { textarea.style.height = "auto"; textarea.style.height = `${Math.min(180, textarea.scrollHeight)}px`; };
  const updateSend = () => { sendBtn.disabled = !textarea.value.trim() && !chips.length; };
  const submit = () => {
    const t = textarea.value.trim();
    if (!t && !chips.length) return;
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
      if (ev.key === "Escape") { mentionItems = []; drawMentions(); ev.stopPropagation(); return; }
    }
    if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); submit(); }
    if (ev.key === "Escape") { textarea.blur(); ev.stopPropagation(); }
    if (ev.key === "Backspace" && !textarea.value && chips.length) { chips.pop(); drawChips(); updateSend(); }
  });

  // ---------- images: paste / drop, downscaled to save tokens ----------
  async function imageChip(blob: Blob, label: string): Promise<CtxChip["image"]> {
    const bmp = await createImageBitmap(blob);
    const scale = Math.min(1, 1024 / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
    c.getContext("2d")!.drawImage(bmp, 0, 0, c.width, c.height);
    const url = c.toDataURL("image/jpeg", 0.85);
    return { mediaType: "image/jpeg", data: url.split(",")[1]!, url };
  }
  async function addImageFile(file: File) {
    if (!file.type.startsWith("image/")) return;
    addChip({ kind: "image", label: file.name || "Pasted image", text: "", image: await imageChip(file, file.name) });
  }
  textarea.addEventListener("paste", ev => {
    const files = [...(ev.clipboardData?.files ?? [])].filter(f => f.type.startsWith("image/"));
    if (files.length) { ev.preventDefault(); files.forEach(addImageFile); }
  });
  $(".chat").addEventListener("dragover", ev => ev.preventDefault());
  $(".chat").addEventListener("drop", ev => { ev.preventDefault(); [...(ev.dataTransfer?.files ?? [])].forEach(addImageFile); });

  // ---------- right-click menu ----------
  const menuRoot = $(".menu-root");
  type Item = { label: string; hint?: string; run: () => void | Promise<void> } | "sep";
  function openMenu(x: number, y: number, title: string, items: Item[]) {
    menuRoot.innerHTML = `<div class="ctx-menu" role="menu"><div class="ctx-title">${esc(title)}</div>${items.map((it, i) => it === "sep" ? `<div class="ctx-sep"></div>`
      : `<button role="menuitem" data-i="${i}"><span>${esc(it.label)}</span>${it.hint ? `<kbd>${esc(it.hint)}</kbd>` : ""}</button>`).join("")}</div>`;
    const m = menuRoot.firstElementChild as HTMLElement;
    const w = m.offsetWidth, h = m.offsetHeight;
    m.style.left = `${Math.min(x, innerWidth - w - 8)}px`;
    m.style.top = `${Math.min(y, innerHeight - h - 8)}px`;
    requestAnimationFrame(() => m.classList.add("is-in"));
    (m.querySelector("button") as HTMLButtonElement | null)?.focus();
    m.addEventListener("click", async ev => {
      const b = (ev.target as HTMLElement).closest<HTMLButtonElement>("button[data-i]");
      if (!b) return;
      closeMenu();
      const it = items[Number(b.dataset.i)];
      if (it && it !== "sep") await it.run();
    });
    m.addEventListener("keydown", ev => {
      const btns = [...m.querySelectorAll<HTMLButtonElement>("button")];
      const i = btns.indexOf(document.activeElement as HTMLButtonElement);
      if (ev.key === "ArrowDown") { btns[(i + 1) % btns.length]!.focus(); ev.preventDefault(); }
      if (ev.key === "ArrowUp") { btns[(i - 1 + btns.length) % btns.length]!.focus(); ev.preventDefault(); }
      if (ev.key === "Escape") { closeMenu(); ev.stopPropagation(); }
    });
  }
  function closeMenu() { menuRoot.innerHTML = ""; }
  document.addEventListener("mousedown", ev => { if (!(ev.target as HTMLElement).closest(".ctx-menu")) closeMenu(); });
  window.addEventListener("blur", closeMenu);
  canvas.addEventListener("scroll", closeMenu, { passive: true });

  const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
  const sectionOf = (n: Node | null) => (n instanceof Element ? n : n?.parentElement)?.closest<HTMLElement>(".sec")?.dataset.id;

  document.addEventListener("contextmenu", async ev => {
    if (ev.shiftKey) return; // Shift+right-click keeps the browser menu
    const target = ev.target as HTMLElement;
    const inCanvas = target.closest("#canvas");
    const inChat = target.closest(".chat-log");
    if (!inCanvas && !inChat) return;
    const sel = getSelection();
    const selText = sel && !sel.isCollapsed ? sel.toString().trim() : "";
    const sid = sectionOf(target) ?? sectionOf(sel?.anchorNode ?? null);
    const where = sid ? ` (${sid})` : inChat ? " (chat)" : "";
    const items: Item[] = [];
    let title = sid ? `Section ${sid}` : "Lesson";

    if (selText) {
      title = `“${clip(selText.replace(/\s+/g, " "), 40)}”`;
      const quote = `> ${clip(selText, 1500).replace(/\n/g, "\n> ")}${where}`;
      items.push(
        { label: "Ask about this", hint: "Q", run: () => { addChip({ kind: "quote", label: clip(selText.replace(/\s+/g, " "), 34), text: quote }); textarea.focus(); } },
        { label: "Explain this simply", run: () => send(`${quote}\nExplain this simply.`) },
        { label: "Define the terms in this", run: () => send(`${quote}\nDefine the technical terms in this (add them to the glossary).`) },
        { label: "Copy", run: () => navigator.clipboard?.writeText(selText) },
      );
    }
    const animHost = target.closest<HTMLElement>(".anim");
    const diagram = target.closest<HTMLElement>(".mermaid-svg");
    const img = target.closest<HTMLImageElement>(".sec-body img");
    const code = target.closest<HTMLElement>(".b-code");
    if (animHost && (animHost as any).__anim) {
      const a = (animHost as any).__anim as AnimHandle;
      const label = `Animation ${sid ?? ""} · step ${a.step() + 1}/${a.total()}`;
      const ref = `[Animation in ${sid}, step ${a.step() + 1}/${a.total()}: "${a.caption()}"]`;
      if (items.length) items.push("sep");
      items.push(
        { label: "Ask about this step", run: async () => { addChip({ kind: "anim", label, text: ref }); textarea.focus(); } },
        { label: "Ask with a picture of this step", run: async () => {
          const url = await a.png();
          addChip({ kind: "anim", label, text: ref, image: { mediaType: "image/png", data: url.split(",")[1]!, url } }); textarea.focus();
        } },
        { label: "Explain this step", run: () => send(`${ref}\nExplain what is happening in this step.`) },
      );
    } else if (diagram) {
      const svg = diagram.querySelector("svg") as SVGSVGElement | null;
      const sec = lesson?.sections.find(s => s.id === sid);
      const srcBlock = sec?.blocks.find(b => b.t === "diagram") as { mermaid: string } | undefined;
      const ref = `[Diagram in ${sid}]${srcBlock && srcBlock.mermaid.length < 1200 ? `\n\`\`\`mermaid\n${srcBlock.mermaid}\n\`\`\`` : ""}`;
      if (items.length) items.push("sep");
      items.push(
        { label: "Ask about this diagram", run: () => { addChip({ kind: "diagram", label: `Diagram ${sid ?? ""}`, text: ref }); textarea.focus(); } },
        { label: "Ask with a picture of it", run: async () => {
          if (!svg) return;
          try {
            const url = await svgToPng(svg);
            addChip({ kind: "diagram", label: `Diagram ${sid ?? ""}`, text: `[Diagram in ${sid}]`, image: { mediaType: "image/png", data: url.split(",")[1]!, url } });
          } catch { addChip({ kind: "diagram", label: `Diagram ${sid ?? ""}`, text: ref }); }
          textarea.focus();
        } },
        { label: "Explain this diagram", run: () => send(`${ref}\nWalk me through this diagram.`) },
      );
    } else if (img) {
      if (items.length) items.push("sep");
      items.push({ label: "Ask about this image", run: async () => {
        try {
          const blob = await (await fetch(img.src)).blob();
          addChip({ kind: "image", label: img.alt || "Image", text: `[Image in ${sid}]`, image: await imageChip(blob, img.alt) });
        } catch { addChip({ kind: "image", label: img.alt || "Image", text: `[Image in ${sid}: ${img.src}]` }); }
        textarea.focus();
      } });
    } else if (code && !selText) {
      const k = code.dataset.k;
      const b = k && lesson ? findBlock(lesson.sections, k) : undefined;
      if (b?.t === "code") {
        if (items.length) items.push("sep");
        const ref = `[Code in ${sid}]\n\`\`\`${b.lang ?? ""}\n${clip(b.code, 2500)}\n\`\`\``;
        items.push(
          { label: "Ask about this code", run: () => { addChip({ kind: "code", label: `Code ${sid ?? ""}`, text: ref }); textarea.focus(); } },
          { label: "Explain this code line by line", run: () => send(`[Code in ${sid}] explain it line by line in plain language.`) },
        );
      }
    }
    if (sid && inCanvas) {
      if (items.length) items.push("sep");
      items.push(
        { label: "Ask about this section", hint: "A", run: () => sectionAction(sid, "ask") },
        { label: "Explain more simply", hint: "S", run: () => sectionAction(sid, "simpler") },
        { label: "Go deeper", hint: "D", run: () => sectionAction(sid, "deeper") },
        { label: "Add an example", hint: "E", run: () => sectionAction(sid, "example") },
        { label: "Quiz me on this", run: () => sectionAction(sid, "quiz") },
      );
    }
    if (!items.length) return;
    ev.preventDefault();
    openMenu(ev.clientX, ev.clientY, title, items);
  });

  // ---------- keyboard shortcuts ----------
  const SHORTCUTS: [string, string][] = [
    ["/", "Focus the message box"], ["Enter", "Send (Shift+Enter for a new line)"], ["Esc", "Leave the message box / close"],
    ["Esc Esc", "Stop Claude"], ["J / K", "Next / previous section"], ["S", "Simpler (current section)"],
    ["D", "Deeper (current section)"], ["E", "Example (current section)"], ["A", "Ask about current section"],
    ["Q", "Quote selected text into the next message"], ["← / →", "Step the focused animation"], ["Space", "Play / pause the focused animation"],
    ["U", "Undo Claude's last canvas change"], ["T", "Switch light / dark"], ["G", "Lesson / transcript tab"],
    ["L", "Open the library"], ["?", "Show this list"],
  ];
  function showShortcuts() {
    $(".modal-root").innerHTML = `<div class="modal-back"><div class="modal keys" role="dialog" aria-modal="true" aria-labelledby="keys-title">
      <h3 id="keys-title">Keyboard shortcuts</h3>
      <dl>${SHORTCUTS.map(([k, d]) => `<dt>${k.split(" / ").map(x => x.split(" ").map(y => `<kbd>${esc(y)}</kbd>`).join(" ")).join(" / ")}</dt><dd>${esc(d)}</dd>`).join("")}</dl>
      <p>Right-click anything in the lesson for more. Hold Shift for the browser's own menu.</p>
      <div class="modal-actions"><button class="primary" data-close>Done</button></div></div></div>`;
    const root = $(".modal-root");
    (root.querySelector("[data-close]") as HTMLButtonElement).focus();
    root.onclick = ev => { if ((ev.target as HTMLElement).closest("[data-close]") || (ev.target as HTMLElement).classList.contains("modal-back")) { closeModal(); root.onclick = null; } };
  }
  $(".keys-btn").addEventListener("click", showShortcuts);

  const currentSection = () => nav.querySelector<HTMLElement>("a.is-active")?.dataset.id ?? lesson?.sections[0]?.id;
  const jump = (dir: 1 | -1) => {
    if (!lesson?.sections.length) return;
    const ids = lesson.sections.map(s => s.id);
    const i = ids.indexOf(currentSection() ?? ids[0]!);
    const next = ids[Math.max(0, Math.min(ids.length - 1, i + dir))]!;
    document.getElementById(next)?.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "start" });
  };
  let lastEsc = 0;
  document.addEventListener("keydown", ev => {
    if (ev.key === "Escape") {
      if ($(".modal-root").innerHTML && !currentPerm) { closeModal(); return; }
      if (menuRoot.innerHTML) { closeMenu(); return; }
      const now = Date.now();
      if (busy && now - lastEsc < 600) { wsSend({ type: "interrupt" }); toast("Stopping Claude…"); }
      lastEsc = now;
      return;
    }
    if (isTyping(ev.target) || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    if ($(".modal-root").innerHTML) {
      // Permission dialog keys: Y allow once, A always, N deny (no one-key approve when the ask says so).
      const p = currentPerm && permQueue[0];
      if (p) {
        const k = ev.key.toLowerCase();
        if (k === "n") answerPerm("deny");
        else if (!p.defaultToNo && k === "y") answerPerm("allow");
        else if (!p.defaultToNo && k === "a" && p.canAlways) answerPerm("always");
      }
      return;
    }
    const k = ev.key;
    const sid = currentSection();
    const act = (fn: () => void) => { ev.preventDefault(); fn(); };
    switch (k) {
      case "/": return act(() => textarea.focus());
      case "?": return act(showShortcuts);
      case "j": return act(() => jump(1));
      case "k": return act(() => jump(-1));
      case "t": return act(() => toggleTheme());
      case "u": return act(() => { if (!undoBtn.disabled) undoBtn.click(); });
      case "g": return act(() => ($(`.tabs [data-tab="${layout.classList.contains("show-transcript") ? "lesson" : "transcript"}"]`) as HTMLButtonElement).click());
      case "l": return act(() => { location.href = "/"; });
      case "q": {
        const sel = getSelection();
        const text = sel && !sel.isCollapsed ? sel.toString().trim() : "";
        if (!text) return;
        const s = sectionOf(sel!.anchorNode);
        return act(() => { addChip({ kind: "quote", label: clip(text.replace(/\s+/g, " "), 34), text: `> ${clip(text, 1500).replace(/\n/g, "\n> ")}${s ? ` (${s})` : ""}` }); textarea.focus(); });
      }
      case "s": if (sid) act(() => sectionAction(sid, "simpler")); return;
      case "d": if (sid) act(() => sectionAction(sid, "deeper")); return;
      case "e": if (sid) act(() => sectionAction(sid, "example")); return;
      case "a": if (sid) act(() => sectionAction(sid, "ask")); return;
    }
  });

  // ---------- export menu ----------
  $(".export-btn").addEventListener("click", ev => {
    const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
    openMenu(r.right - 240, r.bottom + 6, "Save or share", [
      { label: "Download the offline copy", run: () => { const a = document.createElement("a"); a.href = `/saved/${id}/lesson.html`; a.download = `${id}.html`; a.click(); } },
      { label: "Print or save as PDF", run: () => window.print() },
      "sep",
      { label: "Write a one-page summary", run: () => send("Add a final section: a one-page summary of this lesson for someone new to the topic, with the key terms.") },
      { label: "Write a short post to share", run: () => send("Add a final section: a short, plain-language post (under 150 words) I can share with my team about what we covered.") },
    ]);
  });

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

  // ---------- toast ----------
  let toastTimer: ReturnType<typeof setTimeout> | null = null;
  function toast(text: string) {
    const root = $(".toast-root");
    root.innerHTML = `<div class="toast">${esc(text)}</div>`;
    requestAnimationFrame(() => root.firstElementChild?.classList.add("is-in"));
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { root.firstElementChild?.classList.remove("is-in"); }, 2200);
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
  function answerPerm(d: string) {
    const p = permQueue[0];
    if (!p) return;
    wsSend({ type: "perm", id: p.id, decision: d });
    permQueue.shift(); currentPerm = null; closeModal(); $(".modal-root").onclick = null; showNextPerm();
  }
  function showNextPerm() {
    if (currentPerm || !permQueue.length) return;
    const p = permQueue[0];
    currentPerm = p.id;
    const key = (k: string) => (p.defaultToNo ? "" : ` <kbd>${k}</kbd>`);
    $(".modal-root").innerHTML = `<div class="modal-back"><div class="modal perm" role="dialog" aria-modal="true" aria-labelledby="perm-title">
      <h3 id="perm-title">${esc(p.title)}</h3>
      ${p.description ? `<p>${esc(p.description)}</p>` : ""}
      <pre>${esc(p.detail)}</pre>
      <div class="modal-actions">
        <button data-d="deny" class="danger">Deny <kbd>N</kbd></button>
        ${p.canAlways ? `<button data-d="always">Allow for this session${key("A")}</button>` : ""}
        <button data-d="allow" class="primary">Allow once${key("Y")}</button>
      </div></div></div>`;
    const root = $(".modal-root");
    (root.querySelector(p.defaultToNo ? '[data-d="deny"]' : '[data-d="allow"]') as HTMLButtonElement).focus();
    root.onclick = ev => {
      const d = (ev.target as HTMLElement).closest<HTMLButtonElement>("button[data-d]")?.dataset.d;
      if (d) answerPerm(d);
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
