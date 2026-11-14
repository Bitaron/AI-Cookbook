// Compact animation DSL. Claude writes meaning only; layout, styling and timing are computed.
//
//   dir LR                      (or TB; default LR)
//   A = Call stack              node  (optional "(db|round|circle|note)" shape, "!" prefix = hidden at start, "@col,row" pin)
//   !D = Microtask queue (db)
//   A -> B "setTimeout"         edge  ("--" = undirected, "!" prefix = hidden at start)
//   > Caption for step 1        starts a step; following lines are actions for that step
//   hl A B | dim A | pulse A | show D | hide A | pkt A->B "cb" | label A "New text" | edge A->B | unedge A->B | note A "text"
//
// hl / dim / pulse / pkt / note are transient (only during their step);
// show / hide / label / edge / unedge persist into later steps.

export type Shape = "box" | "round" | "circle" | "db" | "note";
export interface SceneNode { id: string; label: string; shape: Shape; hidden: boolean; pin?: [number, number] }
export interface SceneEdge { from: string; to: string; label?: string; directed: boolean; hidden: boolean }
export type Action =
  | { a: "hl" | "dim" | "pulse" | "show" | "hide"; ids: string[] }
  | { a: "pkt"; from: string; to: string; label?: string }
  | { a: "label" | "note"; id: string; text: string }
  | { a: "edge" | "unedge"; from: string; to: string };
export interface Step { caption: string; actions: Action[] }
export interface Scene { dir: "LR" | "TB"; nodes: SceneNode[]; edges: SceneEdge[]; steps: Step[]; errors: string[] }

const ID = "[A-Za-z_][\\w]*";
const NODE_RE = new RegExp(`^(!)?(${ID})\\s*=\\s*(.+?)\\s*(?:\\((box|round|circle|db|note)\\))?\\s*(?:@(\\d+),(\\d+))?$`);
const EDGE_RE = new RegExp(`^(!)?(${ID})\\s*(->|--)\\s*(${ID})\\s*(?:"([^"]*)")?$`);
const PAIR_RE = new RegExp(`^(${ID})\\s*(?:->|>|--)\\s*(${ID})$`);

function unquote(s: string): string {
  const t = s.trim();
  return t.startsWith('"') && t.endsWith('"') && t.length >= 2 ? t.slice(1, -1) : t;
}

export function parseScene(src: string): Scene {
  const scene: Scene = { dir: "LR", nodes: [], edges: [], steps: [], errors: [] };
  const known = new Set<string>();
  let step: Step | null = null;
  const lines = src.split(/\r?\n/);
  lines.forEach((raw, i) => {
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
      if (dir) { scene.dir = dir[1]!.toUpperCase() as "LR" | "TB"; return; }
      const e = EDGE_RE.exec(line);
      if (e) {
        scene.edges.push({ hidden: !!e[1], from: e[2]!, directed: e[3] === "->", to: e[4]!, label: e[5] || undefined });
        return;
      }
      const n = NODE_RE.exec(line);
      if (n) {
        const id = n[2]!;
        if (known.has(id)) return err(`duplicate node ${id}`);
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
      case "pkt": {
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
  // Implicitly declare nodes referenced only by edges.
  for (const e of scene.edges) for (const id of [e.from, e.to]) {
    if (!known.has(id)) { known.add(id); scene.nodes.push({ id, label: id, shape: "box", hidden: e.hidden }); }
  }
  if (scene.steps.length === 0) scene.steps.push({ caption: "", actions: [] });
  return scene;
}

export interface FrameState {
  caption: string;
  visible: Set<string>;          // node ids
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
    caption: "", visible: new Set(scene.nodes.filter(n => !n.hidden).map(n => n.id)),
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
          if (act.a === "hl" || act.a === "dim" || act.a === "pulse") { const set = st[act.a as "hl" | "dim" | "pulse"]; act.ids.forEach(id => set.add(id)); }
          else if (act.a === "pkt") st.pkts.push({ from: act.from, to: act.to, label: act.label });
          else if (act.a === "note") st.notes.set(act.id, act.text);
      }
    }
  }
  return st;
}
