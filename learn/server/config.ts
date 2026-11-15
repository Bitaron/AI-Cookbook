import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { randomBytes } from "node:crypto";

export const VERSION = "0.1.0";
export const HOME = process.env.LEARN_HOME || join(homedir(), ".learn");
export const PORT = Number(process.env.LEARN_PORT || 4747);
export const HOST = "127.0.0.1";
export const LESSONS_DIR = join(HOME, "lessons");
export const SCRATCH_DIR = join(HOME, "scratch");
export const ROOT = join(import.meta.dir, "..");
export const DIST = join(ROOT, "web", "dist");

export function ensureDirs() {
  for (const d of [HOME, LESSONS_DIR, SCRATCH_DIR]) mkdirSync(d, { recursive: true, mode: 0o700 });
}

/** Per-install secret required by every API and WebSocket call. */
export function getToken(): string {
  ensureDirs();
  const f = join(HOME, "token");
  if (existsSync(f)) return readFileSync(f, "utf8").trim();
  const t = randomBytes(24).toString("base64url");
  writeFileSync(f, t, { mode: 0o600 });
  chmodSync(f, 0o600);
  return t;
}

export const baseUrl = () => `http://${HOST}:${PORT}`;
