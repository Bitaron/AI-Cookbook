// A live learning session: one Claude Code session (via the Agent SDK) bound to one lesson.
import { query as sdkQuery, createSdkMcpServer, tool, type CanUseTool, type SDKUserMessage, type PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { applyOps, canvasShape, CANVAS_DESCRIPTION, type CanvasOp } from "./canvas";
import { TUTOR_PROMPT, firstMessage, seedFromOutline } from "./prompt";
import { saveLesson } from "./store";
import { SCRATCH_DIR } from "./config";
import type { Lesson, ChatMsg } from "../web/runtime/types";

export interface CanvasArgs { ops?: CanvasOp[]; lesson_title?: string; glossary?: Record<string, string> }
export type ResumeMode = "auto" | "full" | "outline";
export interface ImageInput { mediaType: string; data: string }
export interface Client { send(data: string): void }

/** Minimal surface of the SDK Query we use (lets tests substitute a fake agent). */
export interface AgentHandle extends AsyncIterable<any> { interrupt(): Promise<unknown> }
export interface AgentCtx {
  canvas: (args: CanvasArgs) => Promise<string>;
  canUseTool: CanUseTool;
}
export type QueryFn = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Record<string, any> }, ctx: AgentCtx) => AgentHandle;

export const realQuery: QueryFn = params => sdkQuery(params as any) as unknown as AgentHandle;

const CANVAS_TOOL = "mcp__learn__canvas";
const MAX_SNAPSHOTS = 25;
const MAX_TRANSCRIPT_TEXT = 3000;
const IDLE_CLOSE_MS = 30 * 60_000;
const CACHE_WINDOW_MS = 55 * 60_000;

const clip = (s: string, n = MAX_TRANSCRIPT_TEXT) => (s.length > n ? `${s.slice(0, n)}… [${s.length - n} more chars]` : s);

/** Async queue that feeds user messages into the SDK's streaming input. */
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private waiter: ((v: IteratorResult<SDKUserMessage>) => void) | null = null;
  private closed = false;
  push(m: SDKUserMessage) {
    if (this.waiter) { const w = this.waiter; this.waiter = null; w({ value: m, done: false }); }
    else this.items.push(m);
  }
  close() { this.closed = true; this.waiter?.({ value: undefined as any, done: true }); this.waiter = null; }
  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift()!, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as any, done: true });
        return new Promise(r => { this.waiter = r; });
      },
    };
  }
}

function summarizeInput(name: string, input: any): string {
  if (!input || typeof input !== "object") return "";
  if (name === CANVAS_TOOL) {
    const ops = (input.ops ?? []) as CanvasOp[];
    const g = input.glossary ? Object.keys(input.glossary) : [];
    return [...ops.map(o => `${o.op}${o.id ? ` ${o.id}` : ""}${o.title ? ` "${o.title}"` : ""}`), ...(g.length ? [`glossary ${g.slice(0, 6).join(", ")}${g.length > 6 ? "…" : ""}`] : [])].join(", ");
  }
  const v = input.command ?? input.file_path ?? input.pattern ?? input.url ?? input.query ?? input.description ?? input.path;
  return typeof v === "string" ? clip(v, 160) : clip(JSON.stringify(input), 160);
}

export class LiveSession {
  readonly clients = new Set<Client>();
  private agent: AgentHandle | null = null;
  private input: InputQueue | null = null;
  private perms = new Map<string, { resolve: (r: PermissionResult) => void; suggestions?: any[]; event: any }>();
  private pendingNote = "";
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  busy = false;
  status: { model?: string; auth?: string; error?: string } = {};

  constructor(public lesson: Lesson, private queryFn: QueryFn = realQuery) {}

  // ---- client fan-out -------------------------------------------------------
  broadcast(ev: Record<string, unknown>) {
    const data = JSON.stringify(ev);
    for (const c of this.clients) { try { c.send(data); } catch { /* dropped */ } }
  }

  snapshotState() {
    const l = this.lesson;
    return {
      type: "state", lesson: { ...l, snapshots: undefined, rendered: undefined, transcript: undefined },
      transcriptCount: l.transcript.length, canUndo: l.snapshots.length > 0, busy: this.busy, live: !!this.agent,
      status: this.status, perms: [...this.perms.values()].map(p => p.event),
      resumeHint: !this.agent && l.sessionId ? (Date.now() - l.updatedAt < CACHE_WINDOW_MS ? "full" : "outline") : null,
    };
  }

  private pushChat(m: Omit<ChatMsg, "ts">) {
    const msg = { ...m, ts: Date.now() };
    this.lesson.chat.push(msg);
    this.broadcast({ type: "chat", msg });
  }

  private pushTranscript(kind: string, text: string) {
    const e = { ts: Date.now(), kind, text: clip(text) };
    this.lesson.transcript.push(e);
    this.broadcast({ type: "transcript", entry: e });
  }

  // ---- canvas tool ----------------------------------------------------------
  private canvas = async (args: CanvasArgs) => {
    const r = applyOps(this.lesson.sections, args.ops ?? []);
    let gloss = "";
    if (args.glossary && typeof args.glossary === "object") {
      const entries = Object.entries(args.glossary).filter(([k, v]) => k.trim() && typeof v === "string").slice(0, 80);
      this.lesson.glossary = { ...(this.lesson.glossary ?? {}) };
      for (const [k, v] of entries) this.lesson.glossary[k.trim().slice(0, 40)] = v.slice(0, 300);
      gloss = ` · glossary ${Object.keys(this.lesson.glossary).length} terms`;
    }
    this.lesson.sections = r.sections;
    if (args.lesson_title) this.lesson.title = args.lesson_title.slice(0, 120);
    // Drop pre-rendered HTML for sections that changed; the live page re-posts it.
    for (const op of args.ops ?? []) if (op.id) delete this.lesson.rendered[op.id];
    this.broadcast({ type: "canvas", sections: this.lesson.sections, title: this.lesson.title, glossary: this.lesson.glossary });
    saveLesson(this.lesson, { html: false });
    return r.summary + gloss;
  };

  // ---- permissions ----------------------------------------------------------
  private canUseTool: CanUseTool = (toolName, input, opts) => {
    if (toolName === CANVAS_TOOL) return Promise.resolve({ behavior: "allow", updatedInput: input });
    const id = randomUUID();
    const event = {
      type: "perm", id, tool: toolName,
      title: opts.title || `Claude wants to use ${toolName}`,
      description: opts.description || opts.decisionReason || "",
      detail: clip(typeof input === "object" ? JSON.stringify(input, null, 2) : String(input), 1500),
      canAlways: !!opts.suggestions?.length && !opts.suppressAlwaysAllowRule,
      defaultToNo: !!opts.defaultToNo,
    };
    return new Promise<PermissionResult>(resolve => {
      const done = (r: PermissionResult) => {
        this.perms.delete(id);
        this.broadcast({ type: "perm-done", id });
        resolve(r);
      };
      this.perms.set(id, { resolve: done, suggestions: opts.suggestions, event });
      opts.signal.addEventListener("abort", () => done({ behavior: "deny", message: "aborted" }));
      this.broadcast(event);
      this.pushTranscript("permission", `${event.title}\n${event.detail}`);
    });
  };

  answerPermission(id: string, decision: "allow" | "always" | "deny") {
    const p = this.perms.get(id);
    if (!p) return;
    if (decision === "deny") p.resolve({ behavior: "deny", message: "The user denied this action." });
    else p.resolve({
      behavior: "allow",
      ...(decision === "always" && p.suggestions?.length ? { updatedPermissions: p.suggestions } : {}),
    } as PermissionResult);
  }

  // ---- agent lifecycle ------------------------------------------------------
  private start(resume: boolean) {
    const l = this.lesson;
    const cwd = l.scratch ? join(SCRATCH_DIR, l.id) : l.cwd;
    if (l.scratch) mkdirSync(cwd, { recursive: true });
    const canvasTool = tool("canvas", CANVAS_DESCRIPTION, canvasShape, async args => ({
      content: [{ type: "text" as const, text: await this.canvas(args as any) }],
    }), { alwaysLoad: true });
    const options: Record<string, any> = {
      cwd,
      model: l.model,
      resume: resume ? l.sessionId : undefined,
      systemPrompt: { type: "preset", preset: "claude_code", append: TUTOR_PROMPT },
      settingSources: ["user", "project", "local"],
      mcpServers: { learn: createSdkMcpServer({ name: "learn", version: "0.1.0", tools: [canvasTool] }) },
      disallowedTools: ["AskUserQuestion"],
      canUseTool: this.canUseTool,
      permissionMode: "default",
      pathToClaudeCodeExecutable: Bun.which("claude") ?? undefined,
      stderr: (d: string) => { if (process.env.LEARN_DEBUG) process.stderr.write(d); },
    };
    this.input = new InputQueue();
    this.agent = this.queryFn({ prompt: this.input, options }, { canvas: this.canvas, canUseTool: this.canUseTool });
    void this.pump(this.agent);
  }

  private async pump(agent: AgentHandle) {
    try {
      for await (const msg of agent) this.onMessage(msg);
    } catch (e) {
      this.status.error = String((e as Error)?.message ?? e);
      this.pushChat({ role: "system", text: `Session error: ${this.status.error}` });
    } finally {
      if (this.agent === agent) { this.agent = null; this.input = null; }
      this.setBusy(false);
      saveLesson(this.lesson);
      this.broadcast({ type: "live", live: false });
    }
  }

  private setBusy(b: boolean) {
    this.busy = b;
    this.broadcast({ type: "busy", busy: b, canUndo: this.lesson.snapshots.length > 0 });
  }

  private onMessage(msg: any) {
    const l = this.lesson;
    switch (msg.type) {
      case "system":
        if (msg.subtype === "init") {
          l.sessionId = msg.session_id;
          this.status = { model: msg.model, auth: msg.apiKeySource === "none" ? "Claude login" : `API key (${msg.apiKeySource})` };
          this.broadcast({ type: "status", status: this.status });
        } else if (msg.subtype === "compact_boundary") this.pushTranscript("system", "Context compacted");
        break;
      case "assistant": {
        if (msg.parent_tool_use_id) { // subagent traffic: transcript only
          for (const b of msg.message?.content ?? []) if (b.type === "text") this.pushTranscript("subagent", b.text);
          break;
        }
        const u = msg.message?.usage;
        if (u) l.usage.contextTokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
        for (const b of msg.message?.content ?? []) {
          if (b.type === "text" && b.text.trim()) {
            this.pushChat({ role: "assistant", text: b.text });
            this.pushTranscript("assistant", b.text);
          } else if (b.type === "tool_use") {
            const short = b.name.replace(/^mcp__learn__/, "");
            this.pushChat({ role: "tool", tool: short, text: summarizeInput(b.name, b.input) });
            this.pushTranscript(`tool_use ${b.name}`, JSON.stringify(b.input, null, 2));
          } else if (b.type === "thinking" && b.thinking) this.pushTranscript("thinking", b.thinking);
        }
        break;
      }
      case "user": {
        const content = msg.message?.content;
        if (Array.isArray(content)) for (const b of content) if (b.type === "tool_result") {
          const text = typeof b.content === "string" ? b.content
            : Array.isArray(b.content) ? b.content.map((c: any) => c.text ?? `[${c.type}]`).join("\n") : "";
          this.pushTranscript(b.is_error ? "tool_error" : "tool_result", text);
        }
        break;
      }
      case "result": {
        const u = msg.usage ?? {};
        const inTok = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
        l.usage.costUsd = msg.total_cost_usd ?? l.usage.costUsd;
        l.usage.outputTokens = u.output_tokens ?? 0;
        l.usage.totalOutputTokens += u.output_tokens ?? 0;
        l.usage.cacheHitPct = inTok ? Math.round(((u.cache_read_input_tokens ?? 0) / inTok) * 100) : 0;
        l.usage.turns += 1;
        if (msg.subtype !== "success") this.pushChat({ role: "system", text: `Turn ended: ${msg.subtype}${msg.errors?.length ? ` (${msg.errors.join("; ")})` : ""}` });
        this.setBusy(false);
        saveLesson(l);
        this.broadcast({ type: "usage", usage: l.usage, title: l.title });
        this.armIdle();
        break;
      }
    }
  }

  private armIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => { if (!this.busy && this.clients.size === 0) this.close(); }, IDLE_CLOSE_MS);
  }

  // ---- user actions -----------------------------------------------------------
  send(text: string, opts: { images?: ImageInput[]; resumeMode?: ResumeMode; context?: string; first?: boolean } = {}) {
    const l = this.lesson;
    let prompt = opts.first ? firstMessage(l.topic, opts.context) : text;
    if (!this.agent) {
      let mode = opts.resumeMode ?? "auto";
      if (mode === "auto") mode = Date.now() - l.updatedAt < CACHE_WINDOW_MS ? "full" : "outline";
      const canResume = !!l.sessionId && mode === "full";
      if (l.sessionId && !canResume) {
        const outline = l.sections.map(s => {
          const first = s.blocks.find(b => b.t === "md") as { text: string } | undefined;
          return `${s.id} ${s.title}${first ? ` — ${first.text.replace(/\s+/g, " ").slice(0, 90)}` : ""}`;
        }).join("\n");
        const recent = l.chat.filter(m => m.role === "user" || m.role === "assistant").slice(-6)
          .map(m => `${m.role}: ${m.text.slice(0, 200)}`).join("\n");
        prompt = `${seedFromOutline(l.title, outline || "(empty)", recent)}\n\n${prompt}`;
      }
      this.start(canResume);
    }
    if (this.pendingNote) { prompt = `${this.pendingNote}\n\n${prompt}`; this.pendingNote = ""; }

    // Snapshot the canvas so this turn can be undone.
    l.snapshots.push(structuredClone(l.sections));
    if (l.snapshots.length > MAX_SNAPSHOTS) l.snapshots.shift();

    this.pushChat({ role: "user", text: opts.first ? `Teach me: ${l.topic}` : text + (opts.images?.length ? ` [${opts.images.length} image(s)]` : "") });
    this.pushTranscript("user", prompt);
    const content: any[] = (opts.images ?? []).map(im => ({ type: "image", source: { type: "base64", media_type: im.mediaType, data: im.data } }));
    content.push({ type: "text", text: prompt });
    this.setBusy(true);
    this.input!.push({ type: "user", message: { role: "user", content }, parent_tool_use_id: null, origin: { kind: "human" } } as SDKUserMessage);
  }

  async interrupt() {
    if (this.agent) await this.agent.interrupt().catch(() => {});
  }

  undo() {
    const l = this.lesson;
    const prev = l.snapshots.pop();
    if (!prev) return;
    l.sections = prev;
    for (const k of Object.keys(l.rendered)) if (!prev.some(s => s.id === k)) delete l.rendered[k];
    this.pendingNote = `[Note: I reverted the canvas to before your last edit. Current sections: ${prev.map(s => s.id).join(", ") || "none"}.]`;
    this.broadcast({ type: "canvas", sections: l.sections, title: l.title, rerender: true });
    this.broadcast({ type: "busy", busy: this.busy, canUndo: l.snapshots.length > 0 });
    saveLesson(l);
  }

  setRendered(map: Record<string, string>) {
    let changed = false;
    for (const [id, html] of Object.entries(map)) {
      if (typeof html !== "string" || !this.lesson.sections.some(s => s.id === id)) continue;
      this.lesson.rendered[id] = sanitizeRendered(html).slice(0, 2_000_000);
      changed = true;
    }
    if (changed && !this.busy) saveLesson(this.lesson);
  }

  close() {
    this.input?.close();
    for (const p of this.perms.values()) p.resolve({ behavior: "deny", message: "session closed" });
  }
}

/** Defense in depth for client-posted HTML embedded in saved lessons. */
export function sanitizeRendered(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<(iframe|object|embed|link|meta|base)\b[^>]*>/gi, "")
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/(href|src|xlink:href)\s*=\s*(["'])\s*javascript:[^"']*\2/gi, '$1="#"');
}
