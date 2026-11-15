// Tiny layered auto-layout: rank by longest path (back edges ignored), order by declaration.
import { wrapLabel, type Scene, type SceneNode } from "./anim-dsl";

export interface Box { x: number; y: number; w: number; h: number }
export interface Layout { boxes: Map<string, Box>; width: number; height: number }

const GAP_MAIN = 96;   // between ranks
const GAP_CROSS = 30;  // between nodes in the same rank
const PAD = 28;

export function nodeSize(n: Pick<SceneNode, "label" | "shape">): { w: number; h: number } {
  const lines = wrapLabel(n.label);
  const longest = Math.max(...lines.map(l => l.length));
  const textH = lines.length * 17;
  switch (n.shape) {
    case "circle": { const d = Math.max(56, Math.min(150, longest * 8 + 30)); return { w: d, h: Math.max(56, Math.min(d, textH + 34)) }; }
    case "diamond": return { w: Math.max(110, longest * 8.6 + 64), h: Math.max(64, textH + 40) };
    case "person": return { w: Math.max(84, longest * 7.6 + 24), h: textH + 50 };
    case "hex": return { w: Math.max(100, longest * 7.8 + 52), h: Math.max(48, textH + 26) };
    default: return { w: Math.max(88, Math.min(240, longest * 7.8 + 34)), h: Math.max(48, textH + 26) };
  }
}

/** All edges that can ever appear (declared + introduced by `edge` actions). */
export function allEdges(scene: Scene): { from: string; to: string }[] {
  const seen = new Set<string>();
  const out: { from: string; to: string }[] = [];
  const add = (from: string, to: string) => {
    const k = `${from}>${to}`;
    if (!seen.has(k)) { seen.add(k); out.push({ from, to }); }
  };
  scene.edges.forEach(e => add(e.from, e.to));
  scene.steps.forEach(s => s.actions.forEach(a => { if (a.a === "edge") add(a.from, a.to); }));
  return out;
}

export function layoutScene(scene: Scene): Layout {
  const ids = scene.nodes.map(n => n.id);
  const idx = new Map(ids.map((id, i) => [id, i]));
  const out = new Map<string, string[]>(ids.map(id => [id, []]));
  for (const e of allEdges(scene)) if (idx.has(e.from) && idx.has(e.to) && e.from !== e.to) out.get(e.from)!.push(e.to);

  // Remove back edges with DFS so ranks are well defined on cyclic graphs.
  const state = new Map<string, 1 | 2>();
  const forward = new Map<string, string[]>(ids.map(id => [id, []]));
  const dfs = (u: string) => {
    state.set(u, 1);
    for (const v of out.get(u)!) {
      if (state.get(v) === 1) continue;
      forward.get(u)!.push(v);
      if (!state.get(v)) dfs(v);
    }
    state.set(u, 2);
  };
  ids.forEach(id => { if (!state.get(id)) dfs(id); });

  const indeg = new Map(ids.map(id => [id, 0]));
  forward.forEach(vs => vs.forEach(v => indeg.set(v, indeg.get(v)! + 1)));
  const rank = new Map(ids.map(id => [id, 0]));
  const queue = ids.filter(id => indeg.get(id) === 0);
  while (queue.length) {
    const u = queue.shift()!;
    for (const v of forward.get(u)!) {
      rank.set(v, Math.max(rank.get(v)!, rank.get(u)! + 1));
      indeg.set(v, indeg.get(v)! - 1);
      if (indeg.get(v) === 0) queue.push(v);
    }
  }

  // Pins override: @col,row => rank=col; row is a sort key within the column.
  const cols = new Map<number, { id: string; order: number }[]>();
  for (const n of scene.nodes) {
    const c = n.pin ? n.pin[0] : rank.get(n.id)!;
    const order = n.pin ? n.pin[1] : idx.get(n.id)!;
    if (!cols.has(c)) cols.set(c, []);
    cols.get(c)!.push({ id: n.id, order });
  }

  const lr = scene.dir === "LR";
  const size = new Map(scene.nodes.map(n => [n.id, nodeSize(n)]));
  const boxes = new Map<string, Box>();
  const colKeys = [...cols.keys()].sort((a, b) => a - b);
  const colInfo = colKeys.map(c => {
    const items = cols.get(c)!.sort((a, b) => (a.order - b.order) || (idx.get(a.id)! - idx.get(b.id)!));
    const cross = items.map(it => (lr ? size.get(it.id)!.h : size.get(it.id)!.w));
    const main = Math.max(...items.map(it => (lr ? size.get(it.id)!.w : size.get(it.id)!.h)));
    return { items, cross, main, total: cross.reduce((s, x) => s + x, 0) + GAP_CROSS * (items.length - 1) };
  });
  const maxCross = Math.max(...colInfo.map(c => c.total), 48);
  const top = PAD + (scene.groups.length ? 22 : 0); // room for group labels
  let main = PAD;
  for (const { items, cross, main: mainSize, total } of colInfo) {
    let c = (lr ? top : PAD) + (maxCross - total) / 2;
    items.forEach((it, i) => {
      const s = size.get(it.id)!;
      if (lr) boxes.set(it.id, { x: main + (mainSize - s.w) / 2, y: c, w: s.w, h: s.h });
      else boxes.set(it.id, { x: c, y: main + (mainSize - s.h) / 2, w: s.w, h: s.h });
      c += cross[i]! + GAP_CROSS;
    });
    main += mainSize + GAP_MAIN;
  }
  const mainTotal = main - GAP_MAIN + PAD;
  const crossTotal = maxCross + PAD * 2 + (scene.groups.length ? 22 : 0);
  return lr ? { boxes, width: mainTotal, height: crossTotal + 22 } : { boxes, width: crossTotal, height: mainTotal + 22 };
}

/** Sequence-mode layout: participant columns and time rows. */
export interface SeqLayout { cols: Map<string, { x: number; w: number; h: number }>; headH: number; rowY: (r: number) => number; width: number; height: number }
export function layoutSeq(scene: Scene, rows: number, noteChars = 8): SeqLayout {
  const cols = new Map<string, { x: number; w: number; h: number }>();
  const gap = 170;
  const headH = Math.max(48, ...scene.nodes.map(n => nodeSize(n).h));
  const noteW = noteChars * 6.7 + 30; // widest note pill + gap, reserved on both outer sides
  let x = 0, right = 0;
  scene.nodes.forEach((n, i) => {
    const s = nodeSize(n);
    const w = Math.max(s.w, 100);
    x = i === 0 ? PAD + 24 + Math.max(w / 2, noteW) : x + Math.max(gap, w + 70, noteW + 50);
    cols.set(n.id, { x, w, h: s.h });
    right = x + w / 2;
  });
  const rowH = 56;
  const first = PAD + headH + 46;
  const lastW = scene.nodes.length ? Math.max(nodeSize(scene.nodes[scene.nodes.length - 1]!).w, 100) : 0;
  const width = right - lastW / 2 + Math.max(lastW / 2, noteW) + PAD; // room for notes beside the last lifeline
  return { cols, headH, rowY: r => first + r * rowH, width: Math.max(width, 320), height: first + Math.max(rows, 1) * rowH + 10 };
}
