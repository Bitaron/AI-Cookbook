import { join } from "node:path";
import { existsSync, readdirSync, readFileSync, rmSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { LESSONS_DIR, HOME, ensureDirs } from "./config";
import { emptyUsage, type Lesson } from "../web/runtime/types";
import { buildLessonHtml, buildIndexHtml } from "./export";

export function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "lesson";
}

const SAFE_ID = /^[a-z0-9-]{1,80}$/;
const cache = new Map<string, Lesson>();

export function lessonDir(id: string) {
  if (!SAFE_ID.test(id)) throw new Error("bad lesson id");
  return join(LESSONS_DIR, id);
}

export function createLesson(p: { topic: string; cwd: string; scratch: boolean; model?: string }): Lesson {
  ensureDirs();
  const date = new Date().toISOString().slice(0, 10);
  const id = `${date}-${slugify(p.topic)}-${randomBytes(2).toString("hex")}`;
  const now = Date.now();
  const lesson: Lesson = {
    id, topic: p.topic, title: p.topic, createdAt: now, updatedAt: now, cwd: p.cwd, scratch: p.scratch, model: p.model,
    tags: [], sections: [], chat: [], transcript: [], snapshots: [], rendered: {}, usage: emptyUsage(),
  };
  mkdirSync(lessonDir(id), { recursive: true, mode: 0o700 });
  cache.set(id, lesson);
  saveLesson(lesson);
  return lesson;
}

export function getLesson(id: string): Lesson | undefined {
  if (!SAFE_ID.test(id)) return undefined;
  if (cache.has(id)) return cache.get(id);
  const f = join(lessonDir(id), "lesson.json");
  if (!existsSync(f)) return undefined;
  const lesson = JSON.parse(readFileSync(f, "utf8")) as Lesson;
  lesson.usage ??= emptyUsage();
  lesson.rendered ??= {};
  lesson.snapshots ??= [];
  lesson.tags ??= [];
  cache.set(id, lesson);
  return lesson;
}

function atomicWrite(path: string, data: string) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, path);
}

export function saveLesson(lesson: Lesson, opts: { html?: boolean } = { html: true }) {
  lesson.updatedAt = Date.now();
  const dir = lessonDir(lesson.id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  atomicWrite(join(dir, "lesson.json"), JSON.stringify(lesson));
  if (opts.html !== false) {
    atomicWrite(join(dir, "lesson.html"), buildLessonHtml(lesson));
    writeIndex();
  }
}

export interface LessonMeta {
  id: string; title: string; topic: string; createdAt: number; updatedAt: number; cwd: string; tags: string[]; sections: number; costUsd: number;
}

export function listLessons(): LessonMeta[] {
  ensureDirs();
  const out: LessonMeta[] = [];
  for (const id of readdirSync(LESSONS_DIR)) {
    try {
      const l = getLesson(id);
      if (l) out.push({ id: l.id, title: l.title, topic: l.topic, createdAt: l.createdAt, updatedAt: l.updatedAt, cwd: l.cwd, tags: l.tags, sections: l.sections.length, costUsd: l.usage.costUsd });
    } catch { /* skip corrupt */ }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function deleteLesson(id: string) {
  cache.delete(id);
  rmSync(lessonDir(id), { recursive: true, force: true });
  writeIndex();
}

export function writeIndex() {
  atomicWrite(join(HOME, "index.html"), buildIndexHtml(listLessons()));
}
