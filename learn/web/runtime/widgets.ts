// Hydrates interactive placeholders (anim, code, quiz, sandbox). Shared by the live app and saved lessons.
import { mountAnimation } from "./anim";
import { esc } from "./render";
import type { Block, Section } from "./types";

export interface Hooks {
  /** Send a message to Claude (absent in offline mode). */
  send?: (text: string) => void;
  /** Ask user before a sandbox message is sent. */
  confirmSandboxMessage?: (text: string) => Promise<boolean>;
}

export function findBlock(sections: Section[], key: string): Block | undefined {
  const [sid, idx] = key.split(":");
  return sections.find(s => s.id === sid)?.blocks[Number(idx)];
}

/** Parse "1-3: note" / "5: note" walkthrough steps. */
export function parseCodeSteps(src = ""): { from: number; to: number; note: string }[] {
  return src.split(/\r?\n/).map(l => /^\s*(\d+)(?:\s*-\s*(\d+))?\s*:\s*(.+)$/.exec(l)).filter(Boolean)
    .map(m => ({ from: Number(m![1]), to: Number(m![2] ?? m![1]), note: m![3]!.trim() }));
}

function hydrateCode(el: HTMLElement, b: Extract<Block, { t: "code" }>, inlineMd: (s: string) => string) {
  const steps = parseCodeSteps(b.steps);
  const box = el.querySelector(".code-steps") as HTMLElement;
  if (!steps.length) { box.remove(); return; }
  let cur = -1;
  const lines = [...el.querySelectorAll<HTMLElement>(".ln")];
  box.innerHTML = `<div class="code-nav"><button data-d="-1">‹</button><span class="code-pos"></span><button data-d="1">›</button></div><div class="code-note"></div>`;
  const pos = box.querySelector(".code-pos") as HTMLElement;
  const note = box.querySelector(".code-note") as HTMLElement;
  const show = (i: number) => {
    cur = Math.max(0, Math.min(steps.length - 1, i));
    const s = steps[cur]!;
    lines.forEach(l => {
      const n = Number(l.dataset.ln);
      l.classList.toggle("is-hl", n >= s.from && n <= s.to);
      l.classList.toggle("is-dim", !(n >= s.from && n <= s.to));
    });
    pos.textContent = `Step ${cur + 1}/${steps.length} · line${s.from === s.to ? "" : "s"} ${s.from}${s.from === s.to ? "" : `–${s.to}`}`;
    note.innerHTML = inlineMd(s.note);
    lines.find(l => Number(l.dataset.ln) === s.from)?.scrollIntoView({ block: "nearest" });
  };
  box.addEventListener("click", ev => {
    const d = (ev.target as HTMLElement).closest("button")?.dataset.d;
    if (d) show(cur + Number(d));
  });
  show(0);
}

function hydrateQuiz(el: HTMLElement, b: Extract<Block, { t: "quiz" }>, hooks: Hooks, inlineMd: (s: string) => string) {
  const body = document.createElement("div");
  body.className = "quiz-body";
  el.appendChild(body);
  if (b.options && b.options.length) {
    body.innerHTML = b.options.map((o, i) => `<button class="quiz-opt" data-i="${i}"><span class="quiz-letter">${String.fromCharCode(65 + i)}</span>${inlineMd(o)}</button>`).join("") + `<div class="quiz-feedback"></div>`;
    const fb = body.querySelector(".quiz-feedback") as HTMLElement;
    body.addEventListener("click", ev => {
      const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>(".quiz-opt");
      if (!btn || el.classList.contains("is-answered")) return;
      const i = Number(btn.dataset.i);
      const right = i === b.answer;
      el.classList.add("is-answered");
      btn.classList.add(right ? "is-right" : "is-wrong");
      body.querySelector(`.quiz-opt[data-i="${b.answer}"]`)?.classList.add("is-right");
      fb.innerHTML = `<strong>${right ? "Correct." : "Not quite."}</strong> ${b.why ? inlineMd(b.why) : ""}`;
      const retry = document.createElement("button");
      retry.className = "quiz-retry"; retry.textContent = "Try again";
      retry.onclick = () => { el.classList.remove("is-answered"); body.querySelectorAll(".quiz-opt").forEach(o => o.classList.remove("is-right", "is-wrong")); fb.innerHTML = ""; };
      fb.appendChild(retry);
      if (!right && hooks.send) {
        const ask = document.createElement("button");
        ask.className = "quiz-ask"; ask.textContent = "Explain my mistake";
        ask.onclick = () => hooks.send!(`[quiz] Q: ${b.q}\nI answered "${b.options![i]}" (correct: "${b.options![b.answer ?? 0]}"). Explain my mistake briefly.`);
        fb.appendChild(ask);
      }
    });
  } else {
    body.innerHTML = `<textarea class="quiz-free" rows="3" placeholder="Your answer…"></textarea><button class="quiz-check">${hooks.send ? "Check with Claude" : "Reveal notes"}</button><div class="quiz-feedback"></div>`;
    body.querySelector(".quiz-check")!.addEventListener("click", () => {
      const ans = (body.querySelector(".quiz-free") as HTMLTextAreaElement).value.trim();
      if (hooks.send) { if (ans) hooks.send(`[quiz] Q: ${b.q}\nMy answer: ${ans}\nGrade it briefly.`); }
      else (body.querySelector(".quiz-feedback") as HTMLElement).innerHTML = b.why ? inlineMd(b.why) : "<em>No model answer saved.</em>";
    });
  }
}

const SANDBOX_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:";
const SANDBOX_BRIDGE = `<script>(function(){var t=null;function h(){var b=document.documentElement;parent.postMessage({type:"learn:height",h:Math.max(b.scrollHeight,document.body?document.body.scrollHeight:0)},"*")}window.learn={send:function(text){parent.postMessage({type:"learn:send",text:String(text).slice(0,2000)},"*")}};addEventListener("load",h);new ResizeObserver(function(){clearTimeout(t);t=setTimeout(h,50)}).observe(document.documentElement)})()<\/script>`;

function sandboxDoc(html: string, dark: boolean): string {
  const base = `<style>:root{color-scheme:${dark ? "dark" : "light"}}body{margin:0;padding:12px;font:14px/1.5 system-ui,sans-serif;background:transparent;color:${dark ? "#e6e1d6" : "#1d1b17"}}</style>`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${SANDBOX_CSP}">${base}${SANDBOX_BRIDGE}</head><body>${html}</body></html>`;
}

const sandboxFrames = new Map<Window, HTMLIFrameElement>();
let listening = false;
function listenSandbox(hooks: Hooks) {
  if (listening) return;
  listening = true;
  window.addEventListener("message", async ev => {
    const frame = ev.source && sandboxFrames.get(ev.source as Window);
    if (!frame || typeof ev.data !== "object" || !ev.data) return;
    if (ev.data.type === "learn:height") frame.style.height = `${Math.min(900, Math.max(60, Number(ev.data.h) + 4))}px`;
    else if (ev.data.type === "learn:send" && hooks.send && typeof ev.data.text === "string") {
      const ok = hooks.confirmSandboxMessage ? await hooks.confirmSandboxMessage(ev.data.text) : true;
      if (ok) hooks.send(ev.data.text);
    }
  });
}

function hydrateSandbox(el: HTMLElement, b: Extract<Block, { t: "sandbox" }>, hooks: Hooks) {
  listenSandbox(hooks);
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "allow-scripts");
  frame.setAttribute("referrerpolicy", "no-referrer");
  frame.style.height = `${b.height ?? 320}px`;
  frame.srcdoc = sandboxDoc(b.html, document.documentElement.dataset.theme !== "light");
  el.innerHTML = "";
  el.appendChild(frame);
  // The WindowProxy is stable across the srcdoc navigation, so register it immediately.
  if (frame.contentWindow) sandboxFrames.set(frame.contentWindow, frame);
}

export function hydrate(root: HTMLElement, sections: Section[], hooks: Hooks, inlineMd: (s: string) => string) {
  root.querySelectorAll<HTMLElement>(".w[data-w]").forEach(el => {
    if (el.dataset.hydrated) return;
    const b = findBlock(sections, el.dataset.k || "");
    if (!b) return;
    el.dataset.hydrated = "1";
    try {
      if (b.t === "anim") mountAnimation(el, b.scene);
      else if (b.t === "code") hydrateCode(el, b, inlineMd);
      else if (b.t === "quiz") hydrateQuiz(el, b, hooks, inlineMd);
      else if (b.t === "sandbox") hydrateSandbox(el, b, hooks);
    } catch (e) {
      el.innerHTML = `<div class="widget-error">Widget failed: ${esc(String(e))}</div>`;
    }
  });
}
