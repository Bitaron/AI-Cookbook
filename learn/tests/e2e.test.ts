// End-to-end: real server + real browser, scripted fake agent (no tokens spent).
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";

const PORT = 4798;
process.env.LEARN_HOME = mkdtempSync(join(process.env.CLAUDE_JOB_DIR ? join(process.env.CLAUDE_JOB_DIR, "tmp") : tmpdir(), "learn-e2e-"));
process.env.LEARN_PORT = String(PORT);

const { startServer } = await import("../server/server");
const { fakeQuery } = await import("../server/fake-agent");
const { LESSONS_DIR } = await import("../server/config");

let srv: ReturnType<typeof startServer>;
let browser: Browser;
let page: Page;
let lessonId = "";
const errors: string[] = [];
const base = `http://127.0.0.1:${PORT}`;

beforeAll(async () => {
  if (!existsSync(join(import.meta.dir, "..", "web", "dist", "app.js"))) Bun.spawnSync(["bun", "scripts/build.ts"], { cwd: join(import.meta.dir, "..") });
  srv = startServer({ port: PORT, queryFn: fakeQuery });
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on("pageerror", e => errors.push(String(e)));
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
});

afterAll(async () => {
  await browser?.close();
  srv?.server.stop(true);
});

const api = (p: string, init: RequestInit = {}) =>
  fetch(base + p, { ...init, headers: { "content-type": "application/json", "x-learn-token": srv.token, ...(init.headers ?? {}) } });

test("security: token, host and origin checks", async () => {
  expect((await fetch(`${base}/api/lessons`)).status).toBe(401);
  expect((await fetch(`${base}/api/lessons`, { headers: { "x-learn-token": "nope" } })).status).toBe(401);
  expect((await api("/api/lessons", { headers: { origin: "https://evil.example" } })).status).toBe(403);
  expect((await fetch(`${base}/health`, { headers: { host: "evil.example:4798" } })).status).toBe(421);
  expect((await fetch(`${base}/assets/..%2fpackage.json`)).status).toBe(404);
});

test("create a lesson and see the canvas build up", async () => {
  const r = await api("/api/lessons", { method: "POST", body: JSON.stringify({ topic: "event loop", cwd: process.cwd() }) });
  expect(r.status).toBe(200);
  lessonId = ((await r.json()) as any).id;
  await page.goto(`${base}/l/${lessonId}?t=${srv.token}`);
  expect(page.url()).toBe(`${base}/l/${lessonId}`); // token swapped for cookie
  await page.waitForSelector(".sec[data-id='s3']");
  expect(await page.locator(".sec").count()).toBe(3);
  expect(await page.locator(".lesson-title").textContent()).toBe("The JavaScript event loop");
  await page.waitForSelector(".mermaid-svg svg");
  expect(await page.locator(".msg-tool.is-canvas").count()).toBeGreaterThan(0);
  expect(await page.locator(".msg-assistant").last().textContent()).toContain("Added s1");
  expect(await page.locator(".meter").textContent()).toContain("cached");
  expect(await page.locator("math").count()).toBeGreaterThan(0);
});

test("animation steps forward", async () => {
  const anim = page.locator(".anim").first();
  const cap0 = await anim.locator(".anim-caption").textContent();
  await anim.locator('[data-act="next"]').click();
  const cap1 = await anim.locator(".anim-caption").textContent();
  expect(cap0).toBe("Script calls setTimeout");
  expect(cap1).toBe("Timer fires; callback is queued");
  expect(await anim.locator(".anim-node.is-hidden").count()).toBe(0);
});

test("code walkthrough and quiz", async () => {
  const code = page.locator(".b-code").first();
  expect(await code.locator(".ln.is-hl").count()).toBe(1);
  await code.locator('.code-nav button[data-d="1"]').click();
  expect(await code.locator(".ln.is-hl").count()).toBe(3);
  const quiz = page.locator(".b-quiz").first();
  await quiz.locator('.quiz-opt[data-i="0"]').click();
  expect(await quiz.locator(".quiz-feedback").textContent()).toContain("Not quite");
  expect(await quiz.locator(".quiz-ask").count()).toBe(1);
});

test("section quick action, then undo", async () => {
  await page.locator(".sec[data-id='s1']").hover();
  await page.locator(".sec[data-id='s1'] .sec-tools [data-q='simpler']").click();
  await page.waitForFunction(() => document.querySelector(".sec[data-id='s1']")?.textContent?.includes("Simpler take for s1"));
  await page.waitForSelector(".undo-btn:not([disabled])");
  await page.locator(".undo-btn").click();
  await page.waitForFunction(() => !document.querySelector(".sec[data-id='s1']")?.textContent?.includes("Simpler take"));
});

test("permission prompt in the browser", async () => {
  await page.locator(".composer textarea").fill("please run perm check");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".modal [data-d='allow']");
  expect(await page.locator(".modal h3").textContent()).toContain("ls -la");
  expect(await page.locator(".modal [data-d='always']").count()).toBe(1);
  await page.locator(".modal [data-d='allow']").click();
  await page.waitForFunction(() => document.querySelector(".chat-log")?.textContent?.includes("Permission granted."));
});

test("sandbox can message Claude after confirmation", async () => {
  await page.waitForSelector(".stop-btn[hidden]", { state: "attached" });
  const frame = page.frameLocator(".b-sandbox iframe");
  await frame.locator("#b").click();
  await page.waitForSelector(".modal [data-v='1']");
  expect(await page.locator(".modal pre").textContent()).toBe("sandbox says hi");
  await page.locator(".modal [data-v='1']").click();
  await page.waitForFunction(() => document.querySelector(".chat-log")?.textContent?.includes("sandbox says hi"));
  await page.waitForSelector(".sec-name:text('Follow-up 4')");
});

test("transcript tab shows raw log", async () => {
  await page.locator(".tabs [data-tab='transcript']").click();
  await page.waitForSelector(".tx");
  expect(await page.locator(".tx-kind:text('tool_use mcp__learn__canvas')").count()).toBeGreaterThan(0);
  await page.locator(".tabs [data-tab='lesson']").click();
});

test("saved lesson.html works offline", async () => {
  await Bun.sleep(400); // let the last save land
  const file = join(LESSONS_DIR, lessonId, "lesson.html");
  const html = readFileSync(file, "utf8");
  expect(html).toContain("<svg"); // mermaid pre-rendered by the live page
  expect(html).not.toContain("/assets/");
  const kb = Buffer.byteLength(html) / 1024;
  expect(kb).toBeLessThan(400);
  const off = await browser.newPage();
  const offErrors: string[] = [];
  off.on("pageerror", e => offErrors.push(String(e)));
  await off.goto(`file://${file}`);
  await off.waitForSelector(".anim svg");
  expect(await off.locator(".sec").count()).toBe(4);
  await off.locator('.quiz-opt[data-i="1"]').first().click();
  expect(await off.locator(".quiz-feedback").first().textContent()).toContain("Correct");
  expect(await off.locator(".quiz-ask").count()).toBe(0); // no Claude offline
  await off.waitForSelector(".live-banner:not([hidden])");
  expect(await off.locator(".live-banner").textContent()).toContain("Continue this lesson live");
  await off.locator(".tabs [data-tab='transcript']").click();
  expect(await off.locator(".tx").count()).toBeGreaterThan(3);
  expect(offErrors).toEqual([]);
  await off.close();
});

test("library lists the lesson, static index too", async () => {
  await page.goto(`${base}/`);
  await page.waitForSelector(".lib-item");
  expect(await page.locator(".lib-item h2").first().textContent()).toBe("The JavaScript event loop");
  const index = readFileSync(join(process.env.LEARN_HOME!, "index.html"), "utf8");
  expect(index).toContain(lessonId);
});

test("no browser errors", () => {
  expect(errors.filter(e => !/favicon/.test(e))).toEqual([]);
});
