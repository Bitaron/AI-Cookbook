// UI pieces shared by the live app and saved (offline) lessons.
import { md, esc, type RenderOpts } from "./runtime/render";
import type { ChatMsg, Section, TranscriptEntry } from "./runtime/types";

export const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;

export function initTheme(onChange?: () => void) {
  const saved = localStorage.getItem("learn-theme");
  if (saved === "light" || saved === "dark") document.documentElement.dataset.theme = saved;
  document.querySelectorAll(".theme-toggle").forEach(btn => btn.addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = next;
    localStorage.setItem("learn-theme", next);
    onChange?.();
  }));
}

export function renderOutline(nav: HTMLElement, sections: Section[]) {
  if (!sections.length) { nav.innerHTML = `<div class="empty">Sections appear here as the lesson grows.</div>`; return; }
  nav.innerHTML = sections.map(s => `<a href="#${esc(s.id)}" data-id="${esc(s.id)}"><span class="oid">${esc(s.id)}</span><span>${esc(s.title || "Untitled")}</span></a>`).join("");
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
  if (m.role === "user") return `<div class="msg msg-user">${esc(m.text)}</div>`;
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
