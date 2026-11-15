// What the user's Claude Code offers: models and slash commands (built-ins, skills, plugins).
// Fetched from the SDK without sending a prompt (no tokens), cached per folder.
import { query } from "@anthropic-ai/claude-agent-sdk";

export interface ModelOpt { value: string; displayName: string; description: string }
export interface CommandOpt { name: string; description: string; argumentHint: string }
export interface Caps { models: ModelOpt[]; commands: CommandOpt[] }

/** Commands whose UX only makes sense in a terminal, or that would fight this UI. */
const HIDDEN = new Set(["exit", "quit", "statusline", "terminal-setup", "vim", "doctor", "color", "focus", "theme", "ide", "login", "logout", "resume", "rewind", "tasks", "permissions", "hooks", "keybindings", "install-github-app", "learn"]);

/** Preference order for the default ("top") model. */
const TOP = ["fable", "opus", "default"];

export const FALLBACK: Caps = {
  models: [
    { value: "fable", displayName: "Fable", description: "For your toughest challenges" },
    { value: "opus", displayName: "Opus", description: "For complex work and everyday tasks" },
    { value: "sonnet", displayName: "Sonnet", description: "Most efficient for simpler tasks" },
    { value: "haiku", displayName: "Haiku", description: "Fastest for quick answers" },
  ],
  commands: [
    { name: "compact", description: "Summarize the conversation to free context", argumentHint: "[instructions]" },
    { name: "context", description: "Show what is using the context window", argumentHint: "" },
    { name: "cost", description: "Show usage", argumentHint: "" },
  ],
};

export function topModel(models: ModelOpt[]): string | undefined {
  for (const v of TOP) if (models.some(m => m.value === v)) return v;
  return models[0]?.value;
}

export function cleanCaps(models: any[], commands: any[], terminalOnly: string[] = []): Caps {
  const term = new Set(terminalOnly);
  const seen = new Set<string>();
  return {
    models: (models ?? []).filter(m => typeof m?.value === "string").map(m => ({
      value: m.value, displayName: String(m.displayName ?? m.value), description: String(m.description ?? ""),
    })),
    commands: (commands ?? []).filter(c => typeof c?.name === "string" && !HIDDEN.has(c.name) && !term.has(c.name))
      .filter(c => (seen.has(c.name) ? false : (seen.add(c.name), true)))
      .map(c => ({ name: c.name, description: String(c.description ?? "").slice(0, 160), argumentHint: String(c.argumentHint ?? "") })),
  };
}

const cache = new Map<string, { at: number; p: Promise<Caps> }>();
const TTL = 10 * 60_000;

/** Caps for a folder. In fake-agent mode (tests) returns the static list. */
export function getCaps(cwd: string): Promise<Caps> {
  if (process.env.LEARN_FAKE_AGENT) return Promise.resolve(FALLBACK);
  const hit = cache.get(cwd);
  if (hit && Date.now() - hit.at < TTL) return hit.p;
  const p = probe(cwd).catch(() => FALLBACK);
  cache.set(cwd, { at: Date.now(), p });
  return p;
}

/** Fresh caps reported by a live session replace the cached ones. */
export function putCaps(cwd: string, caps: Caps) {
  cache.set(cwd, { at: Date.now(), p: Promise.resolve(caps) });
}

async function probe(cwd: string): Promise<Caps> {
  let release!: () => void;
  const hold = new Promise<void>(r => { release = r; });
  async function* idle() { await hold; }
  const q = query({
    prompt: idle() as any,
    options: { cwd, settingSources: ["user", "project", "local"], pathToClaudeCodeExecutable: Bun.which("claude") ?? undefined },
  });
  const timeout = new Promise<never>((_, rej) => setTimeout(() => rej(new Error("caps timeout")), 15_000));
  try {
    const [models, commands] = await Promise.race([Promise.all([q.supportedModels(), q.supportedCommands()]), timeout]);
    return cleanCaps(models, commands, ["doctor", "color", "focus", "reload-plugins"]);
  } finally {
    release();
    try { (q as any).close?.(); } catch { /* already gone */ }
  }
}
