// UI pieces shared by the live app and saved (offline) lessons.
import { md, esc, type RenderOpts } from "./runtime/render";
import type { ChatMsg, Section, TranscriptEntry } from "./runtime/types";

export const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;

export const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Switches theme with a circular reveal from (x, y), or a cross-fade where view transitions aren't available. */
export function setTheme(next: "light" | "dark", origin?: { x: number; y: number }) {
  const root = document.documentElement;
  if (root.dataset.theme === next) return;
  const apply = () => {
    root.dataset.theme = next;
    localStorage.setItem("learn-theme", next);
    // Sandboxed demos keep their own document; tell them too.
    document.querySelectorAll<HTMLIFrameElement>(".b-sandbox iframe").forEach(f => f.contentWindow?.postMessage({ type: "learn:theme", dark: next === "dark" }, "*"));
  };
  const vt = (document as any).startViewTransition as undefined | ((cb: () => void) => { ready: Promise<void> });
  if (reducedMotion()) return apply();
  if (vt) {
    const x = origin?.x ?? innerWidth - 40, y = origin?.y ?? 26;
    const r = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
    root.classList.add("vt-theme");
    const t = vt.call(document, apply);
    t.ready.then(() => {
      root.animate({ clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${r}px at ${x}px ${y}px)`] },
        { duration: 700, easing: "cubic-bezier(.2,.7,.1,1)", pseudoElement: "::view-transition-new(root)" });
    }).catch(() => {});
    (t as any).finished?.finally(() => root.classList.remove("vt-theme"));
  } else {
    root.classList.add("theme-fade");
    apply();
    setTimeout(() => root.classList.remove("theme-fade"), 600);
  }
}

export function toggleTheme(origin?: { x: number; y: number }) {
  setTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light", origin);
}

export function initTheme() {
  const saved = localStorage.getItem("learn-theme");
  if (saved === "light" || saved === "dark") document.documentElement.dataset.theme = saved;
  document.querySelectorAll<HTMLElement>(".theme-toggle").forEach(btn => btn.addEventListener("click", () => {
    const b = btn.getBoundingClientRect();
    toggleTheme({ x: b.left + b.width / 2, y: b.top + b.height / 2 });
  }));
}

export function renderOutline(nav: HTMLElement, sections: Section[], glossary?: Record<string, string>) {
  const secs = sections.length
    ? `<div class="outline-head">Lesson</div>` + sections.map((s, i) => `<a href="#${esc(s.id)}" data-id="${esc(s.id)}" style="--i:${i}"><span class="oid">${esc(s.id)}</span><span class="otitle">${esc(s.title || "Untitled")}</span></a>`).join("")
    : `<div class="empty">Sections appear here as the lesson grows.</div>`;
  const terms = Object.entries(glossary ?? {}).sort((a, b) => a[0].localeCompare(b[0]));
  const gl = terms.length
    ? `<details class="outline-glossary" open><summary>Glossary <span>${terms.length}</span></summary><ul>${terms.map(([t, d]) => `<li><button data-term="${esc(t)}" title="${esc(d)}"><b>${esc(t)}</b><span>${esc(d)}</span></button></li>`).join("")}</ul></details>`
    : "";
  const open = nav.querySelector<HTMLDetailsElement>(".outline-glossary");
  nav.innerHTML = secs + gl;
  if (open && !open.open) nav.querySelector<HTMLDetailsElement>(".outline-glossary")?.removeAttribute("open");
}

/** Highlights the outline entry of the section currently in view. */
export function trackActiveSection(canvas: HTMLElement, nav: HTMLElement): () => void {
  let obs: IntersectionObserver | null = null;
  return () => {
    obs?.disconnect();
    obs = new IntersectionObserver(entries => {
      for (const e of entries) if (e.isIntersecting) {
        const id = (e.target as HTMLElement).dataset.id;
        nav.querySelectorAll("a").forEach(a => a.classList.toggle("is-active", a.dataset.id === id));
      }
    }, { root: canvas, rootMargin: "-10% 0px -70% 0px" });
    canvas.querySelectorAll(".sec").forEach(s => obs!.observe(s));
  };
}

export function chatMsgHtml(m: ChatMsg, opts: RenderOpts = {}): string {
  if (m.role === "user") {
    // Quoted lesson context ("> text (s3)") renders as a quote above the question.
    const lines = m.text.split("\n");
    const quote = lines.filter(l => l.startsWith("> ")).map(l => l.slice(2)).join("\n");
    const rest = lines.filter(l => !l.startsWith("> ")).join("\n").trim();
    return `<div class="msg msg-user">${quote ? `<blockquote>${esc(quote)}</blockquote>` : ""}${esc(rest)}</div>`;
  }
  if (m.role === "tool") {
    const canvas = m.tool === "canvas";
    return `<div class="msg msg-tool${canvas ? " is-canvas" : ""}" title="${esc(m.text)}"><b>${esc(m.tool ?? "tool")}</b> ${esc(m.text)}</div>`;
  }
  if (m.role === "system") return `<div class="msg msg-system">${esc(m.text)}</div>`;
  return `<div class="msg msg-assistant">${md(m.text, opts)}</div>`;
}

export function transcriptHtml(e: TranscriptEntry): string {
  const kind = e.kind.split(" ")[0]!;
  const preview = e.text.replace(/\s+/g, " ").slice(0, 160);
  const time = new Date(e.ts).toLocaleTimeString();
  return `<details class="tx"><summary><span class="tx-kind k-${esc(kind)}">${esc(e.kind)}</span><span class="tx-preview">${esc(preview)}</span><span>${esc(time)}</span></summary><pre>${esc(e.text)}</pre></details>`;
}

export function initTabs(layout: HTMLElement, onTranscript: () => void) {
  document.querySelectorAll<HTMLButtonElement>(".tabs button").forEach(btn => btn.addEventListener("click", () => {
    document.querySelectorAll(".tabs button").forEach(b => b.classList.toggle("is-on", b === btn));
    const tx = btn.dataset.tab === "transcript";
    layout.classList.toggle("show-transcript", tx);
    ($(".transcript", layout)).hidden = !tx;
    if (tx) onTranscript();
  }));
}

export function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}k` : String(n);
}
