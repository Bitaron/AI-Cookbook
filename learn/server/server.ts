// Local HTTP + WebSocket server. Binds to 127.0.0.1 only; every API/WS call needs the install token.
import { join, resolve } from "node:path";
import { existsSync, statSync } from "node:fs";
import { HOST, PORT, VERSION, DIST, ROOT, getToken, ensureDirs } from "./config";
import { createLesson, getLesson, listLessons, deleteLesson, saveLesson, lessonDir, writeIndex } from "./store";
import { LiveSession, realQuery, type QueryFn, type ResumeMode } from "./session";
import { timingSafeEqual } from "node:crypto";
import { getCaps, topModel } from "./caps";

type WSData = { lessonId: string };

/** Git commit of the code this server process loaded (null outside a git checkout). Lets `learn update` spot a stale server. */
function codeCommit(): string | null {
  const r = Bun.spawnSync(["git", "-C", ROOT, "rev-parse", "HEAD"], { stdout: "pipe", stderr: "ignore" });
  return r.exitCode === 0 ? r.stdout.toString().trim() || null : null;
}

export function startServer(opts: { port?: number; queryFn?: QueryFn; onShutdown?: () => void } = {}) {
  ensureDirs();
  const port = opts.port ?? PORT;
  const token = getToken();
  const queryFn = opts.queryFn ?? realQuery;
  const sessions = new Map<string, LiveSession>();
  const code = codeCommit();
  const startedAt = Date.now();
  const busyLessons = () => [...sessions.entries()].filter(([, s]) => s.busy).map(([id]) => id);
  let stopping = false;
  const allowedHosts = new Set([`${HOST}:${port}`, `localhost:${port}`]);
  const allowedOrigins = new Set([`http://${HOST}:${port}`, `http://localhost:${port}`]);

  const sessionFor = (id: string): LiveSession | undefined => {
    let s = sessions.get(id);
    if (s) return s;
    const lesson = getLesson(id);
    if (!lesson) return undefined;
    s = new LiveSession(lesson, queryFn);
    sessions.set(id, s);
    return s;
  };

  const tokenOk = (t: string | null | undefined) => {
    if (!t) return false;
    const a = Buffer.from(t), b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
  };
  const cookieToken = (req: Request) => /(?:^|;\s*)learn_token=([^;]+)/.exec(req.headers.get("cookie") ?? "")?.[1];
  const authed = (req: Request, url: URL) =>
    tokenOk(req.headers.get("x-learn-token")) || tokenOk(cookieToken(req)) || tokenOk(url.searchParams.get("t"));

  const json = (v: unknown, status = 200, extra: Record<string, string> = {}) =>
    new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...extra } });
  const SEC_HEADERS = {
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
  };
  const appHtml = () => new Response(Bun.file(join(ROOT, "web", "app.html")), {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...SEC_HEADERS },
  });

  const server = Bun.serve<WSData>({
    hostname: HOST,
    port,
    idleTimeout: 120,
    async fetch(req, srv) {
      const url = new URL(req.url);
      // DNS-rebinding guard.
      if (!allowedHosts.has(req.headers.get("host") ?? "")) return new Response("bad host", { status: 421 });
      const origin = req.headers.get("origin");
      const p = url.pathname;

      if (p === "/health") return json({ ok: true, version: VERSION }, 200, { "access-control-allow-origin": "*" });

      if (p.startsWith("/assets/")) {
        const f = resolve(DIST, p.slice("/assets/".length));
        if (!f.startsWith(DIST + "/") || !existsSync(f) || !statSync(f).isFile()) return new Response("not found", { status: 404 });
        return new Response(Bun.file(f), { headers: { "cache-control": "no-cache", ...SEC_HEADERS } });
      }

      // Cross-site requests are never allowed to touch the API.
      if (origin && !allowedOrigins.has(origin)) return new Response("bad origin", { status: 403 });

      // HTML pages: exchange ?t= for an HttpOnly cookie, then redirect to a clean URL.
      if (req.method === "GET" && (p === "/" || p.startsWith("/l/"))) {
        if (url.searchParams.has("t")) {
          if (!tokenOk(url.searchParams.get("t"))) return new Response("bad token", { status: 401 });
          url.searchParams.delete("t");
          return new Response(null, {
            status: 302,
            headers: {
              location: url.pathname + url.search,
              "set-cookie": `learn_token=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`,
            },
          });
        }
        return appHtml();
      }

      if (!authed(req, url)) return json({ error: "unauthorized", hint: "open the page with `learn --resume <id>` or `learn --library`" }, 401);

      if (p === "/ws") {
        const id = url.searchParams.get("id") ?? "";
        if (!origin) return new Response("origin required", { status: 403 });
        if (!sessionFor(id)) return new Response("no such lesson", { status: 404 });
        return srv.upgrade(req, { data: { lessonId: id } }) ? undefined : new Response("upgrade failed", { status: 400 });
      }

      if (p === "/api/server" && req.method === "GET") {
        return json({ version: VERSION, code, pid: process.pid, root: ROOT, startedAt, busy: busyLessons() });
      }
      // Graceful stop for `learn stop` / `learn update`: refuses while Claude is mid-turn unless forced.
      if (p === "/api/shutdown" && req.method === "POST") {
        const body = await req.json().catch(() => ({})) as any;
        const busy = busyLessons();
        if (busy.length && !body.force) return json({ error: "busy", busy }, 409);
        if (!stopping) {
          stopping = true;
          for (const s of sessions.values()) { s.close(); saveLesson(s.lesson); }
          setTimeout(() => { server.stop(true); (opts.onShutdown ?? (() => process.exit(0)))(); }, 50);
        }
        return json({ ok: true });
      }

      if (p === "/api/lessons" && req.method === "GET") return json(listLessons());
      if (p === "/api/lessons" && req.method === "POST") {
        const body = await req.json().catch(() => ({})) as any;
        const topic = String(body.topic ?? "").trim().slice(0, 300);
        if (!topic) return json({ error: "topic required" }, 400);
        const cwd = typeof body.cwd === "string" && existsSync(body.cwd) ? resolve(body.cwd) : process.cwd();
        // No model asked for: use the most capable one this account offers.
        const model = typeof body.model === "string" && body.model.trim() ? body.model.trim().slice(0, 80)
          : await Promise.race([getCaps(cwd).then(c => topModel(c.models)), Bun.sleep(8000).then(() => undefined)]);
        const lesson = createLesson({ topic, cwd, scratch: !!body.scratch, model });
        const s = sessionFor(lesson.id)!;
        s.send("", { first: true, context: typeof body.context === "string" ? body.context : undefined });
        return json({ id: lesson.id, url: `http://${HOST}:${port}/l/${lesson.id}` });
      }
      const m = /^\/api\/lessons\/([a-z0-9-]+)(\/transcript)?$/.exec(p);
      if (m) {
        const lesson = getLesson(m[1]!);
        if (!lesson) return json({ error: "not found" }, 404);
        if (m[2]) return json(lesson.transcript);
        if (req.method === "PATCH") {
          const body = await req.json().catch(() => ({})) as any;
          if (typeof body.title === "string" && body.title.trim()) lesson.title = body.title.trim().slice(0, 120);
          if (Array.isArray(body.tags)) lesson.tags = body.tags.map((t: unknown) => String(t).trim().slice(0, 30)).filter(Boolean).slice(0, 12);
          saveLesson(lesson);
          sessions.get(lesson.id)?.broadcast({ type: "meta", title: lesson.title, tags: lesson.tags });
          return json({ ok: true });
        }
        if (req.method === "DELETE") {
          sessions.get(lesson.id)?.close();
          sessions.delete(lesson.id);
          deleteLesson(lesson.id);
          return json({ ok: true });
        }
        return json({ ...lesson, rendered: undefined, snapshots: undefined });
      }
      const saved = /^\/saved\/([a-z0-9-]+)\/lesson\.html$/.exec(p);
      if (saved) {
        const f = join(lessonDir(saved[1]!), "lesson.html");
        return existsSync(f) ? new Response(Bun.file(f), { headers: { "content-type": "text/html; charset=utf-8", ...SEC_HEADERS } }) : new Response("not found", { status: 404 });
      }
      if (p === "/api/files") {
        const lesson = getLesson(url.searchParams.get("id") ?? "");
        if (!lesson) return json([], 404);
        return json(await listFiles(lesson.scratch ? null : lesson.cwd, (url.searchParams.get("q") ?? "").toLowerCase()));
      }
      return json({ error: "not found" }, 404);
    },
    websocket: {
      maxPayloadLength: 16 * 1024 * 1024,
      open(ws) {
        const s = sessionFor(ws.data.lessonId);
        if (!s) return ws.close();
        s.clients.add(ws);
        ws.send(JSON.stringify(s.snapshotState()));
        if (!s.caps) void s.refreshCaps();
        void s.refreshGit();
      },
      message(ws, raw) {
        const s = sessions.get(ws.data.lessonId);
        if (!s) return;
        let msg: any;
        try { msg = JSON.parse(String(raw)); } catch { return; }
        switch (msg.type) {
          case "send": {
            const text = String(msg.text ?? "").slice(0, 20000);
            const images = Array.isArray(msg.images) ? msg.images.slice(0, 4).filter((i: any) => /^image\/(png|jpeg|webp|gif)$/.test(i?.mediaType) && typeof i?.data === "string") : [];
            if (!text.trim() && !images.length) return;
            if (s.busy) { ws.send(JSON.stringify({ type: "error", error: "Claude is still working. Stop it first or wait." })); return; }
            s.send(text, { images, resumeMode: (["full", "outline", "auto"].includes(msg.resumeMode) ? msg.resumeMode : "auto") as ResumeMode });
            break;
          }
          case "interrupt": void s.interrupt(); break;
          case "perm": s.answerPermission(String(msg.id), msg.decision === "always" ? "always" : msg.decision === "allow" ? "allow" : "deny"); break;
          case "undo": if (!s.busy) s.undo(); break;
          case "model": if (typeof msg.model === "string") void s.setModel(msg.model); break;
          case "rendered": if (msg.map && typeof msg.map === "object") s.setRendered(msg.map); break;
          case "transcript": ws.send(JSON.stringify({ type: "transcript-all", entries: s.lesson.transcript })); break;
        }
      },
      close(ws) {
        sessions.get(ws.data.lessonId)?.clients.delete(ws);
      },
    },
  });
  writeIndex();
  return { server, token, sessions, port };
}

async function listFiles(cwd: string | null, q: string): Promise<string[]> {
  if (!cwd) return [];
  let files: string[] = [];
  try {
    const out = await Bun.$`git -C ${cwd} ls-files --cached --others --exclude-standard`.quiet().text();
    files = out.split("\n").filter(Boolean);
  } catch {
    const glob = new Bun.Glob("**/*");
    for await (const f of glob.scan({ cwd, onlyFiles: true })) {
      if (/(^|\/)(node_modules|\.git|dist|build)\//.test(f)) continue;
      files.push(f);
      if (files.length > 5000) break;
    }
  }
  return files.filter(f => !q || f.toLowerCase().includes(q)).slice(0, 40);
}
