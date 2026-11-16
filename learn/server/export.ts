// Builds self-contained offline HTML for lessons and the library index.
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { DIST, PORT } from "./config";
import type { Lesson } from "../web/runtime/types";
import type { LessonMeta } from "./store";
import { esc, sectionShell } from "../web/runtime/render";

/** Applies the saved theme before first paint so pages never flash the wrong theme. */
export const THEME_BOOT = `<script>try{var t=localStorage.getItem("learn-theme");if(t)document.documentElement.dataset.theme=t}catch(e){}</script>`;

let assets: { css: string; offline: string; index: string } | null = null;
function loadAssets() {
  if (assets) return assets;
  const read = (f: string) => (existsSync(join(DIST, f)) ? readFileSync(join(DIST, f), "utf8") : "");
  assets = { css: read("styles.css"), offline: read("offline.js"), index: read("index-offline.js") };
  return assets;
}
export function resetAssetCache() { assets = null; build = null; }

let build: string | null = null;
/** Identifies the page code baked into saved files; changes whenever the web bundle is rebuilt with different code. */
export function buildId(): string {
  if (build) return build;
  const a = loadAssets();
  build = Bun.hash(a.css + a.offline + a.index).toString(36);
  return build;
}
const STAMP = /<meta name="learn-build" content="([^"]*)">/;
/** True if a saved page was written by different page code than the current build. */
export const isStaleHtml = (html: string) => STAMP.exec(html.slice(0, 2000))?.[1] !== buildId();

/** JSON safe for embedding inside <script type="application/json">. */
const LS = new RegExp(String.fromCharCode(0x2028), "g");
const PS = new RegExp(String.fromCharCode(0x2029), "g");
export const jsonForScript = (v: unknown) =>
  JSON.stringify(v).replace(/</g, "\\u003c").replace(LS, "\\u2028").replace(PS, "\\u2029");

const fmtDate = (ts: number) => new Date(ts).toISOString().slice(0, 16).replace("T", " ");

export function buildLessonHtml(lesson: Lesson): string {
  const a = loadAssets();
  const sections = lesson.sections.map(s => sectionShell(s.id, s.title, lesson.rendered[s.id] ?? "")).join("\n");
  const data = {
    id: lesson.id, title: lesson.title, topic: lesson.topic, cwd: lesson.cwd, createdAt: lesson.createdAt, updatedAt: lesson.updatedAt,
    sections: lesson.sections, chat: lesson.chat, transcript: lesson.transcript, usage: lesson.usage, port: PORT, glossary: lesson.glossary ?? {},
    prerendered: Object.keys(lesson.rendered).filter(k => lesson.sections.some(s => s.id === k)),
  };
  return `<!doctype html>
<html lang="en" data-theme="dark" data-mode="offline">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="learn-build" content="${buildId()}">
<title>${esc(lesson.title)} · learn</title>
<style>${a.css}</style>
${THEME_BOOT}
</head>
<body>
<header class="topbar">
  <div class="brand"><span class="brand-mark" aria-hidden="true"></span>learn</div>
  <h1 class="lesson-title">${esc(lesson.title)}</h1>
  <div class="meta"><span>${esc(fmtDate(lesson.updatedAt))}</span><span title="${esc(lesson.cwd)}">${esc(lesson.cwd.split("/").slice(-2).join("/"))}</span></div>
  <nav class="tabs"><button data-tab="lesson" class="is-on">Lesson</button><button data-tab="transcript">Transcript</button></nav>
  <button class="icon-btn theme-toggle" title="Switch light or dark theme (T)" aria-label="Switch theme"><svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6"/><path class="fill" d="M8 2a6 6 0 0 1 0 12z"/></svg></button>
</header>
<div class="live-banner" hidden></div>
<main class="layout">
  <nav class="outline"></nav>
  <article id="canvas" class="canvas">${sections}</article>
  <aside class="chat"><div class="chat-log"></div></aside>
  <section class="transcript" hidden></section>
</main>
<script id="lesson-data" type="application/json">${jsonForScript(data)}</script>
<script>${a.offline.replace(/<\/script/gi, "<\\/script")}</script>
</body>
</html>`;
}

export function buildIndexHtml(lessons: LessonMeta[]): string {
  const a = loadAssets();
  return `<!doctype html>
<html lang="en" data-theme="dark" data-mode="offline">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>learn · library</title><style>${a.css}</style>${THEME_BOOT}</head>
<body class="library-page">
<header class="topbar"><div class="brand"><span class="brand-mark" aria-hidden="true"></span>learn</div><h1 class="lesson-title">Library</h1><button class="icon-btn theme-toggle" title="Switch light or dark theme (T)" aria-label="Switch theme"><svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6"/><path class="fill" d="M8 2a6 6 0 0 1 0 12z"/></svg></button></header>
<main class="library"><input class="lib-search" placeholder="Search lessons, tags, folders…"><div class="lib-list"></div></main>
<script id="library-data" type="application/json">${jsonForScript({ lessons, port: PORT })}</script>
<script>${a.index.replace(/<\/script/gi, "<\\/script")}</script>
</body></html>`;
}
