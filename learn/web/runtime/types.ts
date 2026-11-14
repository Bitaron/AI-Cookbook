// Lesson data model shared by server, live app and offline runtime.

export type Block =
  | { t: "md"; text: string }
  | { t: "diagram"; mermaid: string; caption?: string }
  | { t: "anim"; scene: string; caption?: string }
  | { t: "code"; lang?: string; code: string; steps?: string }
  | { t: "quiz"; q: string; options?: string[]; answer?: number; why?: string }
  | { t: "compare"; cols: string[]; rows: string[][] }
  | { t: "callout"; kind?: "key" | "pitfall" | "analogy" | "tip"; text: string }
  | { t: "sandbox"; html: string; height?: number };

export interface Section { id: string; title: string; blocks: Block[] }

export interface ChatMsg {
  role: "user" | "assistant" | "tool" | "system";
  text: string;
  ts: number;
  tool?: string;     // tool name for role=tool chips
}

export interface TranscriptEntry { ts: number; kind: string; text: string }

export interface Usage {
  costUsd: number;
  contextTokens: number;   // last turn: input + cache read + cache write
  outputTokens: number;    // last turn
  cacheHitPct: number;     // last turn
  totalOutputTokens: number;
  turns: number;
}

export interface Lesson {
  id: string;
  topic: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  cwd: string;
  scratch: boolean;
  model?: string;
  sessionId?: string;
  tags: string[];
  sections: Section[];
  chat: ChatMsg[];
  transcript: TranscriptEntry[];
  /** Canvas states before each assistant turn, newest last (bounded). */
  snapshots: Section[][];
  /** Pre-rendered static HTML per section id (mermaid → SVG, math, highlighting), posted by the live page. */
  rendered: Record<string, string>;
  usage: Usage;
}

export const emptyUsage = (): Usage => ({ costUsd: 0, contextTokens: 0, outputTokens: 0, cacheHitPct: 0, totalOutputTokens: 0, turns: 0 });
