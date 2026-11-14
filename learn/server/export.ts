// Builds self-contained offline HTML for lessons and the library index.
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { DIST, PORT } from "./config";
import type { Lesson } from "../web/runtime/types";
import type { LessonMeta } from "./store";
import { esc } from "../web/runtime/render";

let assets: { css: string; offline: string; index: string } | null = null;
function loadAssets() {
  if (assets) return assets;
  const read = (f: string) => (existsSync(join(DIST, f)) ? readFileSync(join(DIST, f), "utf8") : "");
  assets = { css: read("styles.css"), offline: read("offline.js"), index: read("index-offline.js") };
  return assets;
}
export function resetAssetCache() { assets = null; }

/** JSON safe for embedding inside <script type="application/json">. */
const LS = new RegExp(String.fromCharCode(0x2028), "g");
const PS = new RegExp(String.fromCharCode(0x2029), "g");
export const jsonForScript = (v: unknown) =>
  JSON.stringify(v).replace(/</g, "\\u003c").replace(LS, "\\u2028").replace(PS, "\\u2029");

const fmtDate = (ts: number) => new Date(ts).toISOString().slice(0, 16).replace("T", " ");

export function buildLessonHtml(lesson: Lesson): string {
  const a = loadAssets();
  const sections = lesson.sections.map(s =>
    `<section class="sec" id="${esc(s.id)}" data-id="${esc(s.id)}"><h2 class="sec-title"><span class="sec-id">${esc(s.id)}</span>${esc(s.title)}</h2><div class="sec-body">${lesson.rendered[s.id] ?? ""}</div></section>`
  ).join("\n");
  const data = {
    id: lesson.id, title: lesson.title, topic: lesson.topic, cwd: lesson.cwd, createdAt: lesson.createdAt, updatedAt: lesson.updatedAt,
    sections: lesson.sections, chat: lesson.chat, transcript: lesson.transcript, usage: lesson.usage, port: PORT,
    prerendered: Object.keys(lesson.rendered).filter(k => lesson.sections.some(s => s.id === k)),
  };
  return `<!doctype html>
<html lang="en" data-theme="dark" data-mode="offline">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(lesson.title)} · learn</title>
<style>${a.css}</style>
</head>
<body>
<header class="topbar">
  <div class="brand">learn</div>
  <h1 class="lesson-title">${esc(lesson.title)}</h1>
  <div class="meta">${esc(fmtDate(lesson.updatedAt))} · <span title="${esc(lesson.cwd)}">${esc(lesson.cwd.split("/").slice(-2).join("/"))}</span></div>
  <nav class="tabs"><button data-tab="lesson" class="is-on">Lesson</button><button data-tab="transcript">Transcript</button></nav>
  <button class="theme-toggle" title="Toggle theme"><svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 1.5a6.5 6.5 0 0 1 0 13z" fill="currentColor"/></svg></button>
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
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>learn · library</title><style>${a.css}</style></head>
<body class="library-page">
<header class="topbar"><div class="brand">learn</div><h1 class="lesson-title">Library</h1><button class="theme-toggle" title="Toggle theme"><svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 1.5a6.5 6.5 0 0 1 0 13z" fill="currentColor"/></svg></button></header>
<main class="library"><input class="lib-search" placeholder="Search lessons, tags, folders…"><div class="lib-list"></div></main>
<script id="library-data" type="application/json">${jsonForScript({ lessons, port: PORT })}</script>
<script>${a.index.replace(/<\/script/gi, "<\\/script")}</script>
</body></html>`;
}
