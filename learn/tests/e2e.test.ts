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

test("glossary terms, formula and sequence animation", async () => {
  expect(await page.locator("abbr.term").count()).toBeGreaterThanOrEqual(2);
  await page.locator("abbr.term[data-term='PTP']").first().hover();
  await page.waitForSelector(".term-card.is-in");
  expect(await page.locator(".term-card").textContent()).toContain("Precision Time Protocol");
  expect(await page.locator(".term-card .term-more").count()).toBe(1);
  await page.mouse.move(5, 5);
  expect(await page.locator(".outline-glossary li").count()).toBe(2);
  expect(await page.locator(".b-formula math").count()).toBeGreaterThan(0);
  expect(await page.locator(".b-formula .fv").count()).toBe(2);
  expect(await page.locator(".callout-project").count()).toBe(1);
  const seq = page.locator(".anim:has(.mode-seq)");
  expect(await seq.locator(".seq-msg").count()).toBe(3);
  expect(await seq.locator(".seq-msg.is-hidden").count()).toBe(2);
  await seq.locator('[data-act="next"]').click();
  expect(await seq.locator(".seq-msg.is-hidden").count()).toBe(1);
  expect(await seq.locator(".seq-msg.is-active").count()).toBe(1);
});

test("theme switch keeps diagrams and animation state", async () => {
  await page.evaluate(() => document.querySelector(".mermaid-svg svg")!.setAttribute("data-mark", "1"));
  const cap = await page.locator(".anim .anim-caption").first().textContent();
  await page.locator("body").click({ position: { x: 5, y: 300 } });
  await page.keyboard.press("t");
  await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
  await Bun.sleep(800);
  expect(await page.locator(".mermaid-svg svg[data-mark='1']").count()).toBe(1); // not re-rendered
  expect(await page.locator(".anim .anim-caption").first().textContent()).toBe(cap);
  await page.keyboard.press("t");
  await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
});

test("keyboard shortcuts", async () => {
  await page.keyboard.press("?");
  await page.waitForSelector(".modal.keys");
  expect(await page.locator(".modal.keys dt").count()).toBeGreaterThan(10);
  await page.keyboard.press("Escape");
  expect(await page.locator(".modal.keys").count()).toBe(0);
  await page.keyboard.press("/");
  expect(await page.evaluate(() => document.activeElement?.tagName)).toBe("TEXTAREA");
  await page.keyboard.press("Escape");
  expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe("TEXTAREA");
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
  await page.waitForSelector(".sec-title:text('Follow-up 4')");
});

test("right-click quotes text and an animation frame into the next message", async () => {
  await page.waitForSelector(".stop-btn[hidden]", { state: "attached" });
  // Select the first paragraph of s1, then right-click inside it.
  await page.locator(".sec[data-id='s1'] .b-md p").scrollIntoViewIfNeeded();
  await Bun.sleep(400);
  await page.evaluate(() => {
    const p = document.querySelector(".sec[data-id='s1'] .b-md p")!;
    const r = document.createRange(); r.selectNodeContents(p);
    const sel = getSelection()!; sel.removeAllRanges(); sel.addRange(r);
  });
  const box = (await page.locator(".sec[data-id='s1'] .b-md p").boundingBox())!;
  await page.mouse.click(box.x + 40, box.y + 10, { button: "right" });
  await page.waitForSelector(".ctx-menu.is-in");
  await page.locator(".ctx-menu button:has-text('Ask about this')").first().click();
  await page.waitForSelector(".chip-quote");
  await page.locator(".anim").first().scrollIntoViewIfNeeded();
  await Bun.sleep(400);
  const anim = (await page.locator(".anim").first().boundingBox())!;
  await page.mouse.click(anim.x + 60, anim.y + 60, { button: "right" });
  await page.waitForSelector(".ctx-menu.is-in");
  await page.locator(".ctx-menu button:has-text('Ask with a picture of this step')").click();
  await page.waitForSelector(".chip-anim img");
  await page.locator(".composer textarea").fill("why one thread?");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => [...document.querySelectorAll(".msg-user blockquote")].some(b => b.textContent?.includes("one thread")));
  expect(await page.locator(".chip").count()).toBe(0);
  await page.waitForSelector(".stop-btn[hidden]", { state: "attached" });
});

test("animation fits one screen, has restart, replays from the end", async () => {
  const anim = page.locator(".anim").first();
  await anim.scrollIntoViewIfNeeded();
  const fit = await anim.evaluate(el => {
    const st = el.querySelector(".anim-stage")!;
    return { scrolls: st.scrollWidth > st.clientWidth + 1, h: el.getBoundingClientRect().height, vh: innerHeight };
  });
  expect(fit.scrolls).toBe(false);
  expect(fit.h).toBeLessThan(fit.vh);
  await anim.focus();
  await page.keyboard.press("End");
  expect(await anim.locator(".anim-play").getAttribute("aria-label")).toBe("Replay");
  await anim.locator('[data-act="restart"]').click();
  expect(await anim.locator(".anim-count").textContent()).toBe("1 / 3");
  expect(await anim.locator('[data-act="restart"]').isDisabled()).toBe(true);
});

test("zoom an animation and a diagram in the lightbox", async () => {
  const anim = page.locator(".sec[data-id='s1'] .anim");
  await anim.hover();
  await anim.locator(".zoom-btn").click();
  await page.waitForSelector(".lb-back .anim.is-expanded");
  await page.keyboard.press("+");
  expect(await page.locator(".lb-pct").textContent()).toBe("125%");
  await page.locator(".lb-back .anim [data-act='next']").click(); // controls still work while zoomed
  expect(await page.locator(".lb-back .anim-count").textContent()).toBe("2 / 3");
  await page.keyboard.press("Escape");
  expect(await page.locator(".lb-back").count()).toBe(0);
  expect(await page.locator(".sec[data-id='s1'] .anim .anim-count").textContent()).toBe("2 / 3"); // back in place, state kept
  await page.locator(".mermaid-svg").first().hover();
  await page.locator(".mermaid-svg .zoom-btn").first().click();
  await page.waitForSelector(".lb-back .lb-diagram svg");
  await page.keyboard.press("Escape");
});

test("side panels collapse and come back", async () => {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("]");
  expect(await page.locator(".layout").getAttribute("class")).toContain("no-chat");
  await page.locator(".chat-toggle").click();
  expect(await page.locator(".layout").getAttribute("class")).not.toContain("no-chat");
  await page.locator(".outline-toggle").click();
  expect(await page.locator(".layout").getAttribute("class")).toContain("no-outline");
  await page.keyboard.press("[");
  expect(await page.locator(".layout").getAttribute("class")).not.toContain("no-outline");
});

test("model picker defaults to the top model and switches", async () => {
  const sel = page.locator(".model-select");
  expect(await sel.inputValue()).toBe("fable");
  await sel.selectOption("sonnet");
  await page.waitForFunction(async id => ((await (await fetch(`/api/lessons/${id}`)).json()) as any).model === "sonnet", lessonId);
});

test("git branch and worktree show in the top bar", async () => {
  await page.waitForSelector(".meta-git");
  const branch = (await Bun.$`git rev-parse --abbrev-ref HEAD`.quiet().text()).trim();
  expect(await page.locator(".meta-git").textContent()).toContain(branch);
  const linked = (await Bun.$`git rev-parse --absolute-git-dir`.quiet().text()).trim() !== (await Bun.$`git rev-parse --path-format=absolute --git-common-dir`.quiet().text()).trim();
  expect(await page.locator(".meta-wt").count()).toBe(linked ? 1 : 0);
});

test("slash commands autocomplete and reach Claude verbatim", async () => {
  const ta = page.locator(".composer textarea");
  await ta.fill("");
  await ta.pressSequentially("/cont");
  await page.waitForSelector(".mentions.is-cmd div:has-text('/context')");
  await page.keyboard.press("Tab");
  expect(await ta.inputValue()).toBe("/context ");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => [...document.querySelectorAll(".sec-body")].some(b => b.textContent?.includes("You said: /context")));
  await page.waitForSelector(".stop-btn[hidden]", { state: "attached" });
});

test("right-click a selection offers a web search", async () => {
  await page.locator(".sec[data-id='s1'] .b-md p").scrollIntoViewIfNeeded();
  await Bun.sleep(400);
  await page.evaluate(() => {
    (window as any).__opened = [];
    window.open = ((u: string) => { (window as any).__opened.push(u); return null; }) as any;
    const p = document.querySelector(".sec[data-id='s1'] .b-md p")!;
    const r = document.createRange(); r.selectNodeContents(p);
    const sel = getSelection()!; sel.removeAllRanges(); sel.addRange(r);
  });
  const box = (await page.locator(".sec[data-id='s1'] .b-md p").boundingBox())!;
  await page.mouse.click(box.x + 40, box.y + 10, { button: "right" });
  await page.locator(".ctx-menu.is-in button:has-text('Search the web')").click();
  const opened = await page.evaluate(() => (window as any).__opened as string[]);
  expect(opened[0]).toStartWith("https://www.google.com/search?q=JavaScript");
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
  expect(await off.locator(".sec").count()).toBe(6); // includes the /context follow-up
  expect(await off.locator("abbr.term").count()).toBeGreaterThan(0);
  expect(await off.locator(".mode-seq .seq-msg").count()).toBe(3);
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

test("server info and graceful shutdown (used by learn stop / update)", async () => {
  expect((await fetch(`${base}/api/server`)).status).toBe(401);
  const info = await (await api("/api/server")).json() as any;
  expect(info.pid).toBe(process.pid);
  expect(info.busy).toEqual([]);
  expect(typeof info.code === "string" || info.code === null).toBe(true);

  // A separate server, so the shared one stays up for the other tests.
  let stopped = false;
  const other = startServer({ port: PORT + 1, queryFn: fakeQuery, onShutdown: () => { stopped = true; } });
  const o = (p: string, init: RequestInit = {}) =>
    fetch(`http://127.0.0.1:${PORT + 1}${p}`, { ...init, headers: { "content-type": "application/json", "x-learn-token": other.token } });
  expect((await fetch(`http://127.0.0.1:${PORT + 1}/api/shutdown`, { method: "POST" })).status).toBe(401);
  expect((await o("/api/shutdown", { method: "GET" })).status).toBe(404);
  const r = await o("/api/lessons", { method: "POST", body: JSON.stringify({ topic: "perm wait", cwd: process.cwd() }) });
  const id = ((await r.json()) as any).id;
  // "perm" makes the scripted turn wait on a permission prompt, so Claude is mid-turn: shutdown refuses unless forced.
  const busy = await o("/api/shutdown", { method: "POST", body: "{}" });
  expect(busy.status).toBe(409);
  expect(((await busy.json()) as any).busy).toEqual([id]);
  expect((await o("/api/shutdown", { method: "POST", body: JSON.stringify({ force: true }) })).status).toBe(200);
  for (let i = 0; i < 20 && !stopped; i++) await Bun.sleep(50);
  expect(stopped).toBe(true);
  expect(await fetch(`http://127.0.0.1:${PORT + 1}/health`).then(() => "up", () => "down")).toBe("down");
});
