// Compact animation DSL. Claude writes meaning only; layout, styling and timing are computed.
//
//   mode graph | seq            graph (default) = boxes & arrows; seq = lifelines with timed messages
//   dir LR | TB                 graph direction (default LR)
//   A = Call stack              node; optional shape "(box|round|circle|db|note|diamond|hex|person)",
//                               "!" prefix = hidden at start, "@col,row" pin (graph mode)
//   A -> B "label"              edge ("--" = undirected, "!" prefix = hidden at start)
//   group G "Router": A B       dashed region around nodes ("!" prefix = hidden at start)
//   > Caption for step 1        starts a step; following lines are actions for that step
//   hl A B | dim A | pulse A | show D | hide A | pkt A->B "cb" | label A "New text" | edge A->B | unedge A->B | note A "text"
//
// graph mode: hl / dim / pulse / pkt / note last one step; show / hide / label / edge / unedge persist.
// seq mode:   every pkt becomes a message arrow on the next time row and stays; notes stay next to it.

export type Shape = "box" | "round" | "circle" | "db" | "note" | "diamond" | "hex" | "person";
export interface SceneNode { id: string; label: string; shape: Shape; hidden: boolean; pin?: [number, number] }
export interface SceneEdge { from: string; to: string; label?: string; directed: boolean; hidden: boolean }
export interface SceneGroup { id: string; label: string; members: string[]; hidden: boolean }
export type Action =
  | { a: "hl" | "dim" | "pulse" | "show" | "hide"; ids: string[] }
  | { a: "pkt"; from: string; to: string; label?: string }
  | { a: "label" | "note"; id: string; text: string }
  | { a: "edge" | "unedge"; from: string; to: string };
export interface Step { caption: string; actions: Action[] }
export interface Scene {
  mode: "graph" | "seq"; dir: "LR" | "TB"; dirExplicit?: boolean;
  nodes: SceneNode[]; edges: SceneEdge[]; groups: SceneGroup[]; steps: Step[]; errors: string[];
}

const ID = "[A-Za-z_][\\w]*";
const SHAPES = "box|round|circle|db|note|diamond|hex|person";
const NODE_RE = new RegExp(`^(!)?(${ID})\\s*=\\s*(.+?)\\s*(?:[(\\[](${SHAPES})[)\\]])?\\s*(?:@(\\d+),(\\d+))?$`);
const EDGE_RE = new RegExp(`^(!)?(${ID})\\s*(->|--)\\s*(${ID})\\s*(?:"([^"]*)")?$`);
const GROUP_RE = new RegExp(`^(!)?group\\s+(${ID})\\s*(?:"([^"]*)")?\\s*:\\s*(.+)$`);
const PAIR_RE = new RegExp(`^(${ID})\\s*(?:->|>|--)\\s*(${ID})$`);

function unquote(s: string): string {
  const t = s.trim();
  return t.startsWith('"') && t.endsWith('"') && t.length >= 2 ? t.slice(1, -1) : t;
}

export function parseScene(src: string): Scene {
  const scene: Scene = { mode: "graph", dir: "LR", nodes: [], edges: [], groups: [], steps: [], errors: [] };
  const known = new Set<string>();
  let step: Step | null = null;
  src.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("//")) return;
    const err = (m: string) => scene.errors.push(`line ${i + 1}: ${m}`);
    if (line.startsWith(">")) {
      step = { caption: line.slice(1).trim(), actions: [] };
      scene.steps.push(step);
      return;
    }
    if (!step) {
      const dir = /^dir\s+(LR|TB)$/i.exec(line);
      if (dir) { scene.dir = dir[1]!.toUpperCase() as "LR" | "TB"; scene.dirExplicit = true; return; }
      const mode = /^mode\s+(graph|seq)$/i.exec(line);
      if (mode) { scene.mode = mode[1]!.toLowerCase() as "graph" | "seq"; return; }
      const g = GROUP_RE.exec(line);
      if (g) {
        scene.groups.push({ hidden: !!g[1], id: g[2]!, label: g[3] ?? g[2]!, members: g[4]!.split(/[\s,]+/).filter(Boolean) });
        known.add(g[2]!);
        return;
      }
      const e = EDGE_RE.exec(line);
      if (e) {
        scene.edges.push({ hidden: !!e[1], from: e[2]!, directed: e[3] === "->", to: e[4]!, label: e[5] || undefined });
        return;
      }
      const n = NODE_RE.exec(line);
      if (n) {
        const id = n[2]!;
        if (known.has(id)) return err(`duplicate id ${id}`);
        known.add(id);
        scene.nodes.push({
          id, hidden: !!n[1], label: unquote(n[3]!), shape: (n[4] as Shape) || "box",
          pin: n[5] !== undefined ? [Number(n[5]), Number(n[6])] : undefined,
        });
        return;
      }
      return err(`cannot parse "${line}"`);
    }
    const s: Step = step;
    const [verb, ...restParts] = line.split(/\s+/);
    const rest = line.slice(verb!.length).trim();
    switch (verb) {
      case "hl": case "dim": case "pulse": case "show": case "hide":
        s.actions.push({ a: verb, ids: restParts });
        break;
      case "pkt": case "msg": {
        const m = new RegExp(`^(${ID})\\s*(?:->|>)\\s*(${ID})\\s*(?:"([^"]*)")?$`).exec(rest);
        if (!m) return err(`bad pkt "${rest}"`);
        s.actions.push({ a: "pkt", from: m[1]!, to: m[2]!, label: m[3] || undefined });
        break;
      }
      case "label": case "note": {
        const m = new RegExp(`^(${ID})\\s+(.+)$`).exec(rest);
        if (!m) return err(`bad ${verb} "${rest}"`);
        s.actions.push({ a: verb, id: m[1]!, text: unquote(m[2]!) });
        break;
      }
      case "edge": case "unedge": {
        const m = PAIR_RE.exec(rest);
        if (!m) return err(`bad ${verb} "${rest}"`);
        s.actions.push({ a: verb, from: m[1]!, to: m[2]! });
        break;
      }
      default:
        err(`unknown action "${verb}"`);
    }
  });
  // Implicitly declare nodes referenced by edges or messages.
  const addNode = (id: string, hidden = false) => {
    if (!known.has(id)) { known.add(id); scene.nodes.push({ id, label: id, shape: "box", hidden }); }
  };
  for (const e of scene.edges) { addNode(e.from, e.hidden); addNode(e.to, e.hidden); }
  for (const st of scene.steps) for (const a of st.actions) if (a.a === "pkt") { addNode(a.from); addNode(a.to); }
  for (const g of scene.groups) for (const m of g.members) if (!known.has(m)) scene.errors.push(`group ${g.id}: unknown node ${m}`);
  if (scene.steps.length === 0) scene.steps.push({ caption: "", actions: [] });
  return scene;
}

export interface FrameState {
  caption: string;
  visible: Set<string>;          // node and group ids
  labels: Map<string, string>;
  edges: Set<string>;            // "from>to" keys of visible edges
  hl: Set<string>; dim: Set<string>; pulse: Set<string>;
  pkts: { from: string; to: string; label?: string }[];
  notes: Map<string, string>;
}

export const edgeKey = (from: string, to: string) => `${from}>${to}`;

/** Cumulative state after applying steps 0..index. */
export function frameAt(scene: Scene, index: number): FrameState {
  const st: FrameState = {
    caption: "",
    visible: new Set([...scene.nodes.filter(n => !n.hidden).map(n => n.id), ...scene.groups.filter(g => !g.hidden).map(g => g.id)]),
    labels: new Map(scene.nodes.map(n => [n.id, n.label])),
    edges: new Set(scene.edges.filter(e => !e.hidden).map(e => edgeKey(e.from, e.to))),
    hl: new Set(), dim: new Set(), pulse: new Set(), pkts: [], notes: new Map(),
  };
  const last = Math.max(0, Math.min(index, scene.steps.length - 1));
  for (let i = 0; i <= last; i++) {
    const step = scene.steps[i]!;
    const current = i === last;
    if (current) st.caption = step.caption;
    for (const act of step.actions) {
      switch (act.a) {
        case "show": act.ids.forEach(id => st.visible.add(id)); break;
        case "hide": act.ids.forEach(id => st.visible.delete(id)); break;
        case "label": st.labels.set(act.id, act.text); break;
        case "edge": st.edges.add(edgeKey(act.from, act.to)); break;
        case "unedge": st.edges.delete(edgeKey(act.from, act.to)); break;
        default:
          if (!current) break;
          if (act.a === "hl" || act.a === "dim" || act.a === "pulse") { const set = st[act.a]; act.ids.forEach(id => set.add(id)); }
          else if (act.a === "pkt") st.pkts.push({ from: act.from, to: act.to, label: act.label });
          else if (act.a === "note") st.notes.set(act.id, act.text);
      }
    }
  }
  return st;
}

/** Sequence mode: every message with its time row and step, plus notes anchored to rows. */
export interface SeqMessage { from: string; to: string; label?: string; row: number; step: number }
export interface SeqNote { id: string; text: string; row: number; step: number }
export function seqTimeline(scene: Scene): { messages: SeqMessage[]; notes: SeqNote[]; rows: number } {
  const messages: SeqMessage[] = [];
  const notes: SeqNote[] = [];
  let row = 0;
  scene.steps.forEach((s, step) => {
    let usedRow = false;
    for (const a of s.actions) {
      if (a.a === "pkt") { messages.push({ from: a.from, to: a.to, label: a.label, row, step }); row++; usedRow = true; }
    }
    for (const a of s.actions) {
      // Notes sit beside the last message of this step (or a fresh row if the step has none).
      if (a.a === "note") notes.push({ id: a.id, text: a.text, row: usedRow ? row - 1 : row, step });
    }
    if (!usedRow && s.actions.some(a => a.a === "note")) row++;
  });
  return { messages, notes, rows: row };
}

/** Splits a label into at most two balanced lines. */
export function wrapLabel(label: string, max = 18): string[] {
  if (label.length <= max) return [label];
  const words = label.split(/\s+/);
  let best: [string, string] = [label, ""];
  let bestScore = Infinity;
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(" "), b = words.slice(i).join(" ");
    const score = Math.max(a.length, b.length);
    if (score < bestScore) { bestScore = score; best = [a, b]; }
  }
  if (!best[1]) return [label.length > max * 1.6 ? `${label.slice(0, Math.floor(max * 1.6) - 1)}…` : label];
  return best.map(l => (l.length > max * 1.6 ? `${l.slice(0, Math.floor(max * 1.6) - 1)}…` : l));
}
