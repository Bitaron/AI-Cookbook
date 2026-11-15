// Runtime embedded in saved lesson.html files: works from file:// with no server.
import { renderSection, md } from "./runtime/render";
import { hydrate } from "./runtime/widgets";
import { markTerms, initTermCards } from "./runtime/glossary";
import { $, initTheme, toggleTheme, renderOutline, trackActiveSection, chatMsgHtml, transcriptHtml, initTabs } from "./ui";
import type { ChatMsg, Section, TranscriptEntry } from "./runtime/types";

interface Data {
  id: string; title: string; port: number; sections: Section[]; chat: ChatMsg[]; transcript: TranscriptEntry[];
  prerendered: string[]; glossary: Record<string, string>;
}
const data = JSON.parse(($("#lesson-data")).textContent || "{}") as Data;

initTheme();
const canvas = $("#canvas");
const layout = $(".layout");
const inline = (s: string) => md(s);

// Sections that were never rendered by a live page get a plain fallback render.
for (const s of data.sections) {
  const body = canvas.querySelector<HTMLElement>(`.sec[data-id="${CSS.escape(s.id)}"] .sec-body`);
  if (body && !data.prerendered.includes(s.id)) body.innerHTML = renderSection(s);
}
markTerms(canvas, data.glossary);
initTermCards(() => data.glossary);
hydrate(canvas, data.sections, {}, inline);
renderOutline($(".outline"), data.sections, data.glossary);
trackActiveSection(canvas, $(".outline"))();
if (!data.sections.length) canvas.innerHTML = `<div class="canvas-empty"><p>This lesson has no sections yet.</p></div>`;

$(".chat-log").innerHTML = data.chat.map(m => chatMsgHtml(m)).join("");
let txDone = false;
initTabs(layout, () => {
  if (txDone) return;
  txDone = true;
  $(".transcript").innerHTML = data.transcript.length ? data.transcript.map(transcriptHtml).join("") : `<p class="lib-empty">No transcript saved.</p>`;
});

document.addEventListener("keydown", ev => {
  const t = ev.target as HTMLElement;
  if (/^(INPUT|TEXTAREA)$/.test(t.tagName) || ev.ctrlKey || ev.metaKey || ev.altKey) return;
  const ids = data.sections.map(s => s.id);
  const cur = $(".outline").querySelector<HTMLElement>("a.is-active")?.dataset.id ?? ids[0];
  const go = (d: number) => document.getElementById(ids[Math.max(0, Math.min(ids.length - 1, ids.indexOf(cur!) + d))]!)?.scrollIntoView({ block: "start", behavior: "smooth" });
  if (ev.key === "t") toggleTheme();
  else if (ev.key === "j" && ids.length) go(1);
  else if (ev.key === "k" && ids.length) go(-1);
  else if (ev.key === "g") ($(`.tabs [data-tab="${layout.classList.contains("show-transcript") ? "lesson" : "transcript"}"]`) as HTMLButtonElement).click();
});

// If the learn server is running, offer to continue live; otherwise show the resume command.
(async () => {
  const banner = $(".live-banner");
  const cmd = `learn --resume ${data.id}`;
  let up = false;
  try {
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 1200);
    up = (await fetch(`http://127.0.0.1:${data.port}/health`, { signal: ctl.signal })).ok;
  } catch { /* server not running */ }
  banner.hidden = false;
  if (up) {
    banner.innerHTML = `<span>The learn server is running.</span><a class="btn" href="http://127.0.0.1:${data.port}/l/${encodeURIComponent(data.id)}">Continue this lesson live</a><span class="meta">If it asks you to sign in, run <code>${cmd}</code> once.</span>`;
  } else {
    banner.innerHTML = `<span>Saved copy. To keep learning, run</span><code>${cmd}</code><button class="copy">Copy command</button>`;
    banner.querySelector(".copy")!.addEventListener("click", async e => {
      await navigator.clipboard?.writeText(cmd).catch(() => {});
      (e.target as HTMLElement).textContent = "Copied";
    });
  }
})();
