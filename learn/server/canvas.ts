// The single `canvas` tool: patch-style edits to the lesson document. Results are tiny on purpose.
import { z } from "zod/v4";
import type { Block, Section } from "../web/runtime/types";
import { parseScene } from "../web/runtime/anim-dsl";

export const blockSchema = z.discriminatedUnion("t", [
  z.object({ t: z.literal("md"), text: z.string() }),
  z.object({ t: z.literal("diagram"), mermaid: z.string(), caption: z.string().optional() }),
  z.object({ t: z.literal("anim"), scene: z.string(), caption: z.string().optional() }),
  z.object({ t: z.literal("code"), lang: z.string().optional(), code: z.string(), steps: z.string().optional() }),
  z.object({ t: z.literal("quiz"), q: z.string(), options: z.array(z.string()).optional(), answer: z.number().int().optional(), why: z.string().optional() }),
  z.object({ t: z.literal("compare"), cols: z.array(z.string()), rows: z.array(z.array(z.string())) }),
  z.object({ t: z.literal("callout"), kind: z.enum(["key", "pitfall", "analogy", "tip", "project"]).optional(), text: z.string() }),
  z.object({ t: z.literal("formula"), tex: z.string(), vars: z.array(z.array(z.string())).optional(), caption: z.string().optional() }),
  z.object({ t: z.literal("sandbox"), html: z.string().max(60000), height: z.number().optional() }),
]);

export const opSchema = z.object({
  op: z.enum(["add", "update", "append", "delete", "move"]),
  id: z.string().optional(),
  after: z.string().optional(),
  title: z.string().optional(),
  blocks: z.array(blockSchema).optional(),
});

export const canvasShape = {
  ops: z.array(opSchema).optional(),
  lesson_title: z.string().optional(),
  glossary: z.record(z.string(), z.string()).optional(),
};

export type CanvasOp = z.infer<typeof opSchema>;

export const CANVAS_DESCRIPTION = `Edit the lesson canvas (the main teaching surface). Patch, never rewrite.
ops: add{title,blocks,after?:id|"^"} (new id returned) | update{id,title?,blocks?} (replaces given fields) | append{id,blocks} | delete{id} | move{id,after:id|"^"}.
glossary{TERM:"expansion: one-line definition"} merges lesson-wide; terms get hover cards everywhere. Define every acronym once.
Blocks (t=):
md{text} markdown; $tex$ / $$tex$$ math; \`\`\`mermaid fences ok
diagram{mermaid,caption?} flowchart/sequence/state etc.
anim{scene,caption?} step-through animation, compact DSL, one item per line:
  mode graph|seq (seq = lifelines; each pkt becomes a timed message row, notes stay: ideal for protocols) · dir LR|TB
  node: A = Label, optional shape suffix (round) (circle) (db) (note) (diamond) (hex) (person), optional pin @col,row · edge: A -> B "label" (label optional; -- undirected) · group G "Label": A B · prefix ! = hidden at start
  "> caption" starts a step, then actions: hl A B | dim A | pulse A | pkt A->B "label" | note A "short" | show A | hide A | label A "text" | edge A->B | unedge A->B
  (graph mode: hl/dim/pulse/pkt/note last one step, the rest persist). Keep labels and notes short; ≤5 nodes per row reads best.
Section titles: plain words, no numbering (ids already number them).
code{lang,code,steps?} steps: lines "3-5: plain-language note"
formula{tex,vars?:[[sym,meaning,unit?]],caption?}
quiz{q,options?,answer?(0-based),why?} options → auto-graded MC; no options → free answer graded by you
compare{cols,rows}
callout{kind:key|pitfall|analogy|tip|project,text} project = why it matters for the user's own work
sandbox{html,height?} last resort for what-if sliders/toggles: self-contained HTML/JS, no network; use CSS vars --ink --muted --amber --mint --panel; learn.send(text) messages you.`;

export interface ApplyResult { sections: Section[]; title?: string; summary: string; errors: string[] }

function nextId(sections: Section[]): string {
  const max = sections.reduce((m, s) => Math.max(m, Number(/^s(\d+)$/.exec(s.id)?.[1] ?? 0)), 0);
  return `s${max + 1}`;
}

function insertAfter(list: Section[], sec: Section, after?: string): string | null {
  if (after === "^") { list.unshift(sec); return null; }
  if (after) {
    const i = list.findIndex(s => s.id === after);
    if (i < 0) { list.push(sec); return `after:${after} not found, appended`; }
    list.splice(i + 1, 0, sec);
    return null;
  }
  list.push(sec);
  return null;
}

export function applyOps(current: Section[], ops: CanvasOp[] = []): ApplyResult {
  const sections = current.map(s => ({ ...s, blocks: [...s.blocks] }));
  const errors: string[] = [];
  const touched: string[] = [];
  for (const op of ops) {
    op.blocks?.forEach((b, bi) => {
      if (b.t === "anim") parseScene(b.scene).errors.slice(0, 3).forEach(e => errors.push(`${op.id ?? "new"} block ${bi} anim ${e}`));
      if (b.t === "quiz" && b.options?.length && (b.answer === undefined || b.answer < 0 || b.answer >= b.options.length))
        errors.push(`${op.id ?? "new"} block ${bi} quiz answer out of range`);
    });
    const find = () => sections.findIndex(s => s.id === op.id);
    switch (op.op) {
      case "add": {
        const sec: Section = { id: nextId(sections), title: op.title ?? "", blocks: (op.blocks ?? []) as Block[] };
        const warn = insertAfter(sections, sec, op.after);
        if (warn) errors.push(warn);
        touched.push(`+${sec.id}`);
        break;
      }
      case "update": case "append": {
        const i = find();
        if (i < 0) { errors.push(`${op.op}: no section ${op.id}`); break; }
        const s = sections[i]!;
        if (op.title !== undefined) s.title = op.title;
        if (op.blocks) s.blocks = op.op === "append" ? [...s.blocks, ...(op.blocks as Block[])] : (op.blocks as Block[]);
        touched.push(`~${s.id}`);
        break;
      }
      case "delete": {
        const i = find();
        if (i < 0) { errors.push(`delete: no section ${op.id}`); break; }
        sections.splice(i, 1);
        touched.push(`-${op.id}`);
        break;
      }
      case "move": {
        const i = find();
        if (i < 0) { errors.push(`move: no section ${op.id}`); break; }
        const [sec] = sections.splice(i, 1);
        const warn = insertAfter(sections, sec!, op.after ?? "^");
        if (warn) errors.push(warn);
        touched.push(`>${op.id}`);
        break;
      }
    }
  }
  const outline = sections.map(s => `${s.id} ${s.title.slice(0, 28)}`).join(" | ");
  const summary = `ok ${touched.join(" ")}${errors.length ? ` · errors: ${errors.join("; ")}` : ""} · outline: ${outline}`;
  return { sections, summary, errors };
}
