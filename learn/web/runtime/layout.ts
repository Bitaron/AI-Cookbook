// Tiny layered auto-layout: rank by longest path (back edges ignored), order by declaration.
import type { Scene } from "./anim-dsl";

export interface Box { x: number; y: number; w: number; h: number }
export interface Layout { boxes: Map<string, Box>; width: number; height: number }

export const NODE_H = 46;
const GAP_MAIN = 90;   // between ranks
const GAP_CROSS = 28;  // between nodes in the same rank
const PAD = 24;

export function nodeWidth(label: string, shape: string): number {
  if (shape === "circle") return Math.max(NODE_H, Math.min(140, label.length * 8 + 24));
  return Math.max(84, Math.min(220, label.length * 7.6 + 32));
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
  const state = new Map<string, 0 | 1 | 2>();
  const forward = new Map<string, string[]>(ids.map(id => [id, []]));
  const dfs = (u: string) => {
    state.set(u, 1);
    for (const v of out.get(u)!) {
      if (state.get(v) === 1) continue; // back edge
      forward.get(u)!.push(v);
      if (!state.get(v)) dfs(v);
    }
    state.set(u, 2);
  };
  ids.forEach(id => { if (!state.get(id)) dfs(id); });

  // Longest-path ranking in topological order.
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

  // Pins override: @col,row => rank=col, order=row.
  const cols = new Map<number, { id: string; order: number }[]>();
  for (const n of scene.nodes) {
    const c = n.pin ? n.pin[0] : rank.get(n.id)!;
    // Row acts as a sort key within the column; unpinned nodes sort by declaration order.
    const order = n.pin ? n.pin[1] : idx.get(n.id)!;
    if (!cols.has(c)) cols.set(c, []);
    cols.get(c)!.push({ id: n.id, order });
  }

  const lr = scene.dir === "LR";
  const nodeById = new Map(scene.nodes.map(n => [n.id, n]));
  const boxes = new Map<string, Box>();
  const colKeys = [...cols.keys()].sort((a, b) => a - b);
  // Compute cross-axis extents per column to center them.
  const colSizes = colKeys.map(c => {
    const items = cols.get(c)!;
    items.sort((a, b) => (a.order - b.order) || (idx.get(a.id)! - idx.get(b.id)!));
    const sizes = items.map(it => lr ? NODE_H : nodeWidth(nodeById.get(it.id)!.label, nodeById.get(it.id)!.shape));
    return { items, sizes, total: sizes.reduce((s, x) => s + x, 0) + GAP_CROSS * (items.length - 1) };
  });
  const maxCross = Math.max(...colSizes.map(c => c.total), NODE_H);
  let main = PAD;
  colSizes.forEach(({ items, sizes, total }) => {
    const mainSize = lr
      ? Math.max(...items.map(it => nodeWidth(nodeById.get(it.id)!.label, nodeById.get(it.id)!.shape)))
      : NODE_H;
    let cross = PAD + (maxCross - total) / 2;
    items.forEach((it, i) => {
      const n = nodeById.get(it.id)!;
      const w = nodeWidth(n.label, n.shape);
      const size = sizes[i]!;
      if (lr) boxes.set(it.id, { x: main + (mainSize - w) / 2, y: cross, w, h: NODE_H });
      else boxes.set(it.id, { x: cross, y: main, w, h: NODE_H });
      cross += size + GAP_CROSS;
    });
    main += mainSize + GAP_MAIN;
  });
  const mainTotal = main - GAP_MAIN + PAD;
  const crossTotal = maxCross + PAD * 2;
  return lr
    ? { boxes, width: mainTotal, height: crossTotal + 20 }
    : { boxes, width: crossTotal, height: mainTotal + 20 };
}
