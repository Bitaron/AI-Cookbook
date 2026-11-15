// Step-through animation player for the compact scene DSL: graph mode (boxes & arrows) and seq mode (lifelines).
import { parseScene, frameAt, edgeKey, seqTimeline, wrapLabel, type Scene, type FrameState, type SceneNode } from "./anim-dsl";
import { layoutScene, layoutSeq, allEdges, type Box } from "./layout";

const SVG = "http://www.w3.org/2000/svg";
const el = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, parent?: Element) => {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  parent?.appendChild(e);
  return e;
};
const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
type Pt = { x: number; y: number };

let uid = 0;

/** Public handle stored on the host element (used by the context menu to quote a frame). */
export interface AnimHandle { step: () => number; total: () => number; caption: () => string; png: () => Promise<string>; svg: SVGSVGElement }

// ---------------------------------------------------------------- shapes
function drawNode(parent: SVGGElement, n: SceneNode, w: number, h: number, gradId: string) {
  const body = el("g", { class: `anim-node-body shape-${n.shape}` }, parent);
  const cls = { class: "anim-shape", fill: `url(#${gradId})` };
  switch (n.shape) {
    case "circle": el("ellipse", { ...cls, cx: w / 2, cy: h / 2, rx: w / 2, ry: h / 2 }, body); break;
    case "db": el("path", { ...cls, d: `M0,8 a${w / 2},8 0 0,0 ${w},0 a${w / 2},8 0 0,0 -${w},0 v${h - 16} a${w / 2},8 0 0,0 ${w},0 v-${h - 16}` }, body); break;
    case "diamond": el("polygon", { ...cls, points: `${w / 2},0 ${w},${h / 2} ${w / 2},${h} 0,${h / 2}` }, body); break;
    case "hex": el("polygon", { ...cls, points: `14,0 ${w - 14},0 ${w},${h / 2} ${w - 14},${h} 14,${h} 0,${h / 2}` }, body); break;
    case "note": el("path", { ...cls, d: `M0,0 H${w - 12} L${w},12 V${h} H0 Z M${w - 12},0 V12 H${w}` }, body); break;
    case "person": {
      el("circle", { ...cls, cx: w / 2, cy: 11, r: 9 }, body);
      el("path", { ...cls, d: `M${w / 2 - 15},40 q0,-18 15,-18 q15,0 15,18 z` }, body);
      break;
    }
    default: el("rect", { ...cls, width: w, height: h, rx: n.shape === "round" ? h / 2 : 10 }, body);
  }
  const lines = wrapLabel(n.label);
  const text = el("text", { class: "anim-label", "text-anchor": "middle", x: w / 2 }, body);
  const baseY = n.shape === "person" ? 58 : h / 2 - ((lines.length - 1) * 17) / 2 + 5;
  lines.forEach((l, i) => { const t = el("tspan", { x: w / 2, y: baseY + i * 17 }, text); t.textContent = l; });
  return { body, text };
}

function setLabel(text: SVGTextElement, label: string, w: number) {
  const lines = wrapLabel(label);
  const spans = [...text.querySelectorAll("tspan")];
  if (spans.length === lines.length) { spans.forEach((s, i) => { s.textContent = lines[i]!; }); return; }
  const y0 = Number(spans[0]?.getAttribute("y") ?? 0);
  text.textContent = "";
  lines.forEach((l, i) => { const t = el("tspan", { x: w / 2, y: y0 + i * 17 }, text); t.textContent = l; });
}

function pill(parent: Element, x: number, y: number, label: string, cls: string) {
  const g = el("g", { class: cls, transform: `translate(${x},${y})` }, parent);
  const w = label.length * 6.7 + 16;
  el("rect", { x: -w / 2, y: -10, width: w, height: 20, rx: 10 }, g);
  const t = el("text", { y: 4, "text-anchor": "middle" }, g);
  t.textContent = label;
  return g;
}

// ---------------------------------------------------------------- geometry
const center = (b: Box): Pt => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });

/** Cubic path between two boxes, leaving and entering through the sides facing each other. */
function edgePath(a: Box, b: Box): { d: string; mid: Pt } {
  const ca = center(a), cb = center(b);
  const dx = cb.x - ca.x, dy = cb.y - ca.y;
  let p1: Pt, p2: Pt, c1: Pt, c2: Pt;
  if (Math.abs(dx) >= Math.abs(dy) * 0.8) {
    const s = Math.sign(dx) || 1;
    p1 = { x: ca.x + (s * a.w) / 2, y: ca.y };
    p2 = { x: cb.x - (s * b.w) / 2 - s * 2, y: cb.y };
    const k = Math.max(28, Math.abs(p2.x - p1.x) * 0.45);
    c1 = { x: p1.x + s * k, y: p1.y }; c2 = { x: p2.x - s * k, y: p2.y };
  } else {
    const s = Math.sign(dy) || 1;
    p1 = { x: ca.x, y: ca.y + (s * a.h) / 2 };
    p2 = { x: cb.x, y: cb.y - (s * b.h) / 2 - s * 2 };
    const k = Math.max(24, Math.abs(p2.y - p1.y) * 0.45);
    c1 = { x: p1.x, y: p1.y + s * k }; c2 = { x: p2.x, y: p2.y - s * k };
  }
  const t = 0.5, mt = 1 - t;
  const mid = {
    x: mt ** 3 * p1.x + 3 * mt * mt * t * c1.x + 3 * mt * t * t * c2.x + t ** 3 * p2.x,
    y: mt ** 3 * p1.y + 3 * mt * mt * t * c1.y + 3 * mt * t * t * c2.y + t ** 3 * p2.y,
  };
  return { d: `M${p1.x},${p1.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${p2.x},${p2.y}`, mid };
}

/** Moves a glowing packet (with a short trail) along a path element. */
function travel(fx: SVGGElement, path: SVGPathElement, label: string | undefined, delay: number, rafs: number[], dur = 1150) {
  const len = path.getTotalLength();
  const g = el("g", { class: "anim-pkt" }, fx);
  const trail = [0.16, 0.1, 0.05].map((_, i) => el("circle", { r: 5 - i, class: "anim-pkt-trail", opacity: 0.45 - i * 0.13 }, g));
  const dot = el("circle", { r: 6.5, class: "anim-pkt-dot" }, g);
  const tag = label ? pill(g, 0, -18, label, "anim-pkt-label") : null;
  const t0 = performance.now() + delay;
  const ease = (k: number) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
  const place = (k: number) => {
    const p = path.getPointAtLength(len * ease(Math.min(1, Math.max(0, k))));
    dot.setAttribute("cx", String(p.x)); dot.setAttribute("cy", String(p.y));
    tag?.setAttribute("transform", `translate(${p.x},${p.y - 18})`);
    trail.forEach((c, i) => {
      const q = path.getPointAtLength(len * ease(Math.min(1, Math.max(0, k - 0.05 * (i + 1)))));
      c.setAttribute("cx", String(q.x)); c.setAttribute("cy", String(q.y));
    });
  };
  if (reduced()) { place(1); return; }
  place(0);
  g.style.opacity = "0";
  const tick = (now: number) => {
    const k = (now - t0) / dur;
    g.style.opacity = k < 0 ? "0" : k > 1.15 ? "0" : "1";
    place(k);
    if (k < 1.2) rafs.push(requestAnimationFrame(tick));
  };
  rafs.push(requestAnimationFrame(tick));
}

function defs(svg: SVGSVGElement, id: string) {
  const d = el("defs", {}, svg);
  for (const [name, cls] of [["arrow", "anim-arrowhead"], ["arrow-on", "anim-arrowhead is-on"]] as const) {
    const m = el("marker", { id: `${id}-${name}`, viewBox: "0 0 10 10", refX: 8.5, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse", markerUnits: "userSpaceOnUse" }, d);
    m.setAttribute("markerWidth", "11"); m.setAttribute("markerHeight", "11");
    el("path", { d: "M0,1 L9,5 L0,9 L2.2,5 z", class: cls }, m);
  }
  const g = el("linearGradient", { id: `${id}-grad`, x1: 0, y1: 0, x2: 0, y2: 1 }, d);
  el("stop", { offset: "0%", style: "stop-color: var(--node-top)" }, g);
  el("stop", { offset: "100%", style: "stop-color: var(--node-bot)" }, g);
}

/** True if any straight edge would pass through a node other than its endpoints (a sign the layout reads badly). */
function edgesCrossNodes(scene: Scene, boxes: Map<string, Box>): boolean {
  for (const e of allEdges(scene)) {
    const a = boxes.get(e.from), b = boxes.get(e.to);
    if (!a || !b) continue;
    const p = center(a), q = center(b);
    const steps = Math.ceil(Math.hypot(q.x - p.x, q.y - p.y) / 8);
    for (let i = 1; i < steps; i++) {
      const x = p.x + ((q.x - p.x) * i) / steps, y = p.y + ((q.y - p.y) * i) / steps;
      for (const [id, r] of boxes) {
        if (id === e.from || id === e.to) continue;
        if (x > r.x - 4 && x < r.x + r.w + 4 && y > r.y - 4 && y < r.y + r.h + 4) return true;
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------- graph mode
function graphRenderer(scene: Scene, svg: SVGSVGElement, id: string, avail: number) {
  let layout = layoutScene(scene);
  // A long left-to-right chain gets tiny in a narrow column: stack it top-to-bottom when that is much narrower.
  if (scene.dir === "LR" && avail > 0 && layout.width > avail * 1.35) {
    const tb = layoutScene({ ...scene, dir: "TB" });
    if (tb.width < layout.width * 0.8 && !edgesCrossNodes(scene, tb.boxes)) { scene.dir = "TB"; layout = tb; }
  }
  svg.setAttribute("viewBox", `0 0 ${layout.width} ${layout.height}`);
  svg.style.maxWidth = `${Math.max(layout.width * 1.15, 360)}px`;
  svg.style.minWidth = `${Math.min(layout.width * 0.68, 1400)}px`; // keep text readable; the stage scrolls sideways if needed
  const groupLayer = el("g", { class: "anim-groups" }, svg);
  const edgeLayer = el("g", { class: "anim-edges" }, svg);
  const nodeLayer = el("g", { class: "anim-nodes" }, svg);
  const fx = el("g", { class: "anim-fx" }, svg);

  const groups = scene.groups.map(g => {
    const gEl = el("g", { class: "anim-group" }, groupLayer);
    const rect = el("rect", { rx: 14 }, gEl);
    const label = el("text", { class: "anim-group-label" }, gEl);
    label.textContent = g.label;
    return { g, gEl, rect, label };
  });

  const declared = new Map(scene.edges.map(e => [edgeKey(e.from, e.to), e]));
  const edges = new Map<string, { g: SVGGElement; path: SVGPathElement }>();
  for (const e of allEdges(scene)) {
    const a = layout.boxes.get(e.from), b = layout.boxes.get(e.to);
    if (!a || !b) continue;
    const meta = declared.get(edgeKey(e.from, e.to));
    const { d, mid } = edgePath(a, b);
    const g = el("g", { class: "anim-edge" }, edgeLayer);
    const path = el("path", { d, fill: "none" }, g);
    el("path", { d, fill: "none", class: "anim-edge-flow" }, g);
    if (meta?.directed !== false) path.setAttribute("marker-end", `url(#${id}-arrow)`);
    if (meta?.label) pill(g, mid.x, mid.y, meta.label, "anim-edge-label");
    edges.set(edgeKey(e.from, e.to), { g, path });
  }

  const nodes = new Map<string, { g: SVGGElement; text: SVGTextElement; note: SVGGElement; w: number; h: number }>();
  for (const n of scene.nodes) {
    const b = layout.boxes.get(n.id)!;
    const g = el("g", { class: "anim-node", transform: `translate(${b.x},${b.y})`, "data-id": n.id }, nodeLayer);
    const { text } = drawNode(g, n, b.w, b.h, `${id}-grad`);
    const note = el("g", { class: "anim-note", transform: `translate(${b.w / 2},${b.h + 18})` }, g);
    nodes.set(n.id, { g, text, note, w: b.w, h: b.h });
  }

  return (st: FrameState, rafs: number[]) => {
    for (const [nid, n] of nodes) {
      n.g.classList.toggle("is-hidden", !st.visible.has(nid));
      n.g.classList.toggle("is-hl", st.hl.has(nid));
      n.g.classList.toggle("is-dim", st.dim.has(nid));
      n.g.classList.toggle("is-pulse", st.pulse.has(nid));
      setLabel(n.text, st.labels.get(nid) ?? nid, n.w);
      n.note.textContent = "";
      const note = st.notes.get(nid);
      if (note) pill(n.note, 0, 0, note, "anim-note-pill");
    }
    for (const [k, e] of edges) {
      const [f, t] = k.split(">") as [string, string];
      const on = st.pkts.some(p => p.from === f && p.to === t) || (st.hl.has(f) && st.hl.has(t));
      e.g.classList.toggle("is-hidden", !st.edges.has(k) || !st.visible.has(f) || !st.visible.has(t));
      e.g.classList.toggle("is-active", on);
      e.path.setAttribute("marker-end", declared.get(k)?.directed === false ? "" : `url(#${id}-${on ? "arrow-on" : "arrow"})`);
    }
    for (const { g, gEl, rect, label } of groups) {
      const members = g.members.filter(m => st.visible.has(m)).map(m => layout.boxes.get(m)).filter(Boolean) as Box[];
      const shown = st.visible.has(g.id) && members.length > 0;
      gEl.classList.toggle("is-hidden", !shown);
      gEl.classList.toggle("is-hl", st.hl.has(g.id));
      gEl.classList.toggle("is-dim", st.dim.has(g.id));
      if (!members.length) continue;
      const x = Math.min(...members.map(b => b.x)) - 16, y = Math.min(...members.map(b => b.y)) - 28;
      const r = Math.max(...members.map(b => b.x + b.w)) + 16, btm = Math.max(...members.map(b => b.y + b.h)) + 16;
      Object.assign(rect.style, { x: `${x}px`, y: `${y}px`, width: `${r - x}px`, height: `${btm - y}px` });
      rect.setAttribute("x", String(x)); rect.setAttribute("y", String(y));
      rect.setAttribute("width", String(r - x)); rect.setAttribute("height", String(btm - y));
      label.setAttribute("x", String(x + 12)); label.setAttribute("y", String(y + 17));
    }
    fx.innerHTML = "";
    st.pkts.forEach((p, i) => {
      const e = edges.get(edgeKey(p.from, p.to));
      let path = e?.path;
      if (!path || e!.g.classList.contains("is-hidden")) {
        const a = layout.boxes.get(p.from), b = layout.boxes.get(p.to);
        if (!a || !b) return;
        path = el("path", { d: edgePath(a, b).d, fill: "none", class: "anim-ghost" }, fx);
      }
      travel(fx, path, p.label, i * 260, rafs);
    });
  };
}

// ---------------------------------------------------------------- seq mode
function seqRenderer(scene: Scene, svg: SVGSVGElement, id: string, steps: number) {
  const tl = seqTimeline(scene);
  const L = layoutSeq(scene, tl.rows, Math.max(0, ...tl.notes.map(n => n.text.length)));
  svg.setAttribute("viewBox", `0 0 ${L.width} ${L.height}`);
  svg.style.maxWidth = `${Math.max(L.width * 1.1, 360)}px`;
  svg.style.minWidth = `${Math.min(L.width * 0.68, 1400)}px`;
  const life = el("g", { class: "seq-lifelines" }, svg);
  const msgLayer = el("g", { class: "seq-messages" }, svg);
  const head = el("g", { class: "anim-nodes" }, svg);
  const fx = el("g", { class: "anim-fx" }, svg);
  const timeAxis = el("g", { class: "seq-time" }, svg);
  el("line", { x1: 12, y1: L.rowY(0) - 18, x2: 12, y2: L.height - 8, "marker-end": `url(#${id}-arrow)` }, timeAxis);
  const tlabel = el("text", { x: 18, y: L.rowY(0) - 22 }, timeAxis);
  tlabel.textContent = "time";

  const nodes = new Map<string, { g: SVGGElement; line: SVGLineElement; text: SVGTextElement; w: number }>();
  for (const n of scene.nodes) {
    const c = L.cols.get(n.id)!;
    const s = { w: c.w, h: c.h };
    const line = el("line", { class: "seq-life", x1: c.x, y1: 28 + L.headH, x2: c.x, y2: L.height - 6 }, life);
    const g = el("g", { class: "anim-node", transform: `translate(${c.x - s.w / 2},${28 + (L.headH - s.h) / 2})`, "data-id": n.id }, head);
    const { text } = drawNode(g, n, s.w, s.h, `${id}-grad`);
    nodes.set(n.id, { g, line, text, w: s.w });
  }

  const msgs = tl.messages.map(m => {
    const a = L.cols.get(m.from)!, b = L.cols.get(m.to)!;
    const y1 = L.rowY(m.row), y2 = y1 + 20;
    const dir = Math.sign(b.x - a.x) || 1;
    const x1 = a.x + dir * 3, x2 = b.x - dir * 5;
    const g = el("g", { class: "seq-msg" }, msgLayer);
    const path = el("path", { d: `M${x1},${y1} L${x2},${y2}`, fill: "none", "marker-end": `url(#${id}-arrow)` }, g);
    if (m.label) pill(g, (x1 + x2) / 2, (y1 + y2) / 2 - 13, m.label, "anim-edge-label");
    return { m, g, path };
  });
  const notes = tl.notes.map(n => {
    const c = L.cols.get(n.id);
    const g = el("g", { class: "seq-note" }, msgLayer);
    if (c) {
      const w = n.text.length * 6.7 + 16;
      // Put the note on the side away from the message touching this lifeline on the same row.
      const m = tl.messages.find(x => x.row === n.row && (x.from === n.id || x.to === n.id));
      const other = m ? L.cols.get(m.from === n.id ? m.to : m.from) : undefined;
      const left = other ? other.x > c.x : false;
      const y = L.rowY(n.row) + (m && m.to === n.id ? 20 : 0);
      pill(g, left ? c.x - w / 2 - 10 : c.x + w / 2 + 10, y, n.text, "anim-note-pill");
    }
    return { n, g };
  });

  return (st: FrameState, rafs: number[], step: number) => {
    for (const [nid, n] of nodes) {
      const hidden = !st.visible.has(nid);
      n.g.classList.toggle("is-hidden", hidden);
      n.line.classList.toggle("is-hidden", hidden);
      n.g.classList.toggle("is-hl", st.hl.has(nid));
      n.g.classList.toggle("is-dim", st.dim.has(nid));
      n.line.classList.toggle("is-dim", st.dim.has(nid));
      n.g.classList.toggle("is-pulse", st.pulse.has(nid));
      setLabel(n.text, st.labels.get(nid) ?? nid, n.w);
    }
    fx.innerHTML = "";
    let i = 0;
    for (const { m, g, path } of msgs) {
      g.classList.toggle("is-hidden", m.step > step);
      const now = m.step === step;
      g.classList.toggle("is-active", now);
      path.setAttribute("marker-end", `url(#${id}-${now ? "arrow-on" : "arrow"})`);
      if (now && !reduced()) {
        const len = path.getTotalLength();
        path.style.transition = "none";
        path.style.strokeDasharray = `${len}`;
        path.style.strokeDashoffset = `${len}`;
        const delay = i * 300;
        requestAnimationFrame(() => {
          path.style.transition = `stroke-dashoffset 1100ms cubic-bezier(.45,0,.2,1) ${delay}ms`;
          path.style.strokeDashoffset = "0";
        });
        travel(fx, path, undefined, delay, rafs, 1100);
        i++;
      } else { path.style.strokeDasharray = ""; path.style.strokeDashoffset = ""; path.style.transition = ""; }
    }
    for (const { n, g } of notes) {
      g.classList.toggle("is-hidden", n.step > step);
      g.classList.toggle("is-active", n.step === step);
    }
  };
}

// ---------------------------------------------------------------- player
export function mountAnimation(host: HTMLElement, src: string) {
  const scene: Scene = parseScene(src);
  const id = `anim${++uid}`;
  host.classList.add("anim");
  host.innerHTML = "";

  const stage = document.createElement("div");
  stage.className = "anim-stage";
  const svg = el("svg", { role: "img", class: `anim-svg mode-${scene.mode}` });
  defs(svg, id);
  const avail = (host.clientWidth || host.parentElement?.clientWidth || 0) - 32;
  const draw = scene.mode === "seq" ? seqRenderer(scene, svg, id, scene.steps.length) : graphRenderer(scene, svg, id, avail);
  stage.appendChild(svg);

  const caption = document.createElement("div");
  caption.className = "anim-caption";
  caption.setAttribute("aria-live", "polite");
  const controls = document.createElement("div");
  controls.className = "anim-controls";
  controls.innerHTML = `<button data-act="prev" title="Previous step (←)" aria-label="Previous step"><svg viewBox="0 0 16 16"><path d="M10 3 5 8l5 5"/></svg></button>`
    + `<button data-act="play" class="anim-play" title="Play / pause (space)" aria-label="Play"><svg viewBox="0 0 16 16"><path class="i-play" d="M5 3v10l8-5z"/><path class="i-pause" d="M5 3h2v10H5zM9 3h2v10H9z"/></svg></button>`
    + `<button data-act="next" title="Next step (→)" aria-label="Next step"><svg viewBox="0 0 16 16"><path d="m6 3 5 5-5 5"/></svg></button>`
    + `<div class="anim-track" role="tablist"></div><span class="anim-count"></span>`;
  const track = controls.querySelector(".anim-track") as HTMLElement;
  scene.steps.forEach((s, i) => {
    const d = document.createElement("button");
    d.className = "anim-seg"; d.dataset.step = String(i);
    d.title = `${i + 1}. ${s.caption}`;
    d.setAttribute("aria-label", `Step ${i + 1}: ${s.caption}`);
    d.innerHTML = `<i></i>`;
    track.appendChild(d);
  });
  host.append(stage, caption, controls);
  if (scene.errors.length) {
    const errs = document.createElement("details");
    errs.className = "anim-errors";
    errs.innerHTML = `<summary>${scene.errors.length} scene warning${scene.errors.length > 1 ? "s" : ""}</summary>`;
    const pre = document.createElement("pre"); pre.textContent = scene.errors.join("\n");
    errs.appendChild(pre); host.appendChild(errs);
  }

  const STEP_MS = 2600;
  let step = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let rafs: number[] = [];
  const count = controls.querySelector(".anim-count") as HTMLElement;
  const playBtn = controls.querySelector(".anim-play") as HTMLButtonElement;

  const setCaption = (text: string) => {
    if (caption.textContent === text) return;
    caption.classList.remove("is-in");
    void caption.offsetWidth; // restart the fade
    caption.textContent = text;
    caption.classList.add("is-in");
  };

  const render = () => {
    rafs.forEach(cancelAnimationFrame); rafs = [];
    const st = frameAt(scene, step);
    draw(st, rafs, step);
    setCaption(st.caption);
    track.querySelectorAll<HTMLElement>(".anim-seg").forEach((d, i) => {
      d.classList.toggle("is-done", i < step);
      d.classList.toggle("is-on", i === step);
      d.setAttribute("aria-selected", String(i === step));
    });
    count.textContent = `${step + 1} / ${scene.steps.length}`;
    (controls.querySelector('[data-act="prev"]') as HTMLButtonElement).disabled = step === 0;
    (controls.querySelector('[data-act="next"]') as HTMLButtonElement).disabled = step === scene.steps.length - 1;
  };

  const go = (i: number) => { step = Math.max(0, Math.min(scene.steps.length - 1, i)); render(); };
  const stop = () => {
    if (timer) clearInterval(timer);
    timer = null;
    host.classList.remove("is-playing");
    playBtn.setAttribute("aria-label", "Play");
  };
  const play = () => {
    if (step >= scene.steps.length - 1) go(0);
    host.classList.add("is-playing");
    host.style.setProperty("--step-ms", `${STEP_MS}ms`);
    playBtn.setAttribute("aria-label", "Pause");
    timer = setInterval(() => { if (step >= scene.steps.length - 1) stop(); else go(step + 1); }, STEP_MS);
  };

  controls.addEventListener("click", ev => {
    const btn = (ev.target as HTMLElement).closest("button");
    if (!btn) return;
    if (btn.dataset.step) { stop(); go(Number(btn.dataset.step)); }
    else if (btn.dataset.act === "prev") { stop(); go(step - 1); }
    else if (btn.dataset.act === "next") { stop(); go(step + 1); }
    else if (btn.dataset.act === "play") timer ? stop() : play();
  });
  host.tabIndex = 0;
  host.addEventListener("keydown", ev => {
    if (ev.key === "ArrowRight") { stop(); go(step + 1); ev.preventDefault(); ev.stopPropagation(); }
    else if (ev.key === "ArrowLeft") { stop(); go(step - 1); ev.preventDefault(); ev.stopPropagation(); }
    else if (ev.key === " ") { timer ? stop() : play(); ev.preventDefault(); ev.stopPropagation(); }
    else if (ev.key === "Home") { stop(); go(0); ev.preventDefault(); }
    else if (ev.key === "End") { stop(); go(scene.steps.length - 1); ev.preventDefault(); }
  });

  const handle: AnimHandle = {
    svg, step: () => step, total: () => scene.steps.length, caption: () => scene.steps[step]?.caption ?? "",
    png: () => svgToPng(svg),
  };
  (host as any).__anim = handle;
  render();
}

// ---------------------------------------------------------------- export a frame as PNG
const STYLE_PROPS = ["fill", "fill-opacity", "stroke", "stroke-width", "stroke-dasharray", "stroke-opacity", "opacity", "font-family", "font-size", "font-weight", "font-style", "visibility", "paint-order", "stop-color"];

/** Rasterizes an inline SVG (with computed styles inlined) to a PNG data URL. */
export async function svgToPng(svg: SVGSVGElement, scale = 2): Promise<string> {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  const src = [svg, ...svg.querySelectorAll("*")] as Element[];
  const dst = [clone, ...clone.querySelectorAll("*")] as Element[];
  src.forEach((s, i) => {
    const cs = getComputedStyle(s);
    const d = dst[i] as SVGElement;
    d.setAttribute("style", STYLE_PROPS.map(p => `${p}:${cs.getPropertyValue(p)}`).join(";"));
  });
  const vb = svg.viewBox.baseVal;
  const w = vb?.width || svg.clientWidth, h = vb?.height || svg.clientHeight;
  clone.setAttribute("width", String(w)); clone.setAttribute("height", String(h));
  const bg = getComputedStyle(svg.closest(".anim, .diagram") ?? document.body).backgroundColor;
  const rect = document.createElementNS(SVG, "rect");
  rect.setAttribute("width", "100%"); rect.setAttribute("height", "100%"); rect.setAttribute("fill", bg || "#fff");
  clone.insertBefore(rect, clone.firstChild);
  const xml = new XMLSerializer().serializeToString(clone);
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`;
  await img.decode();
  const c = document.createElement("canvas");
  c.width = Math.round(w * scale); c.height = Math.round(h * scale);
  const ctx = c.getContext("2d")!;
  ctx.scale(scale, scale);
  ctx.drawImage(img, 0, 0, w, h);
  return c.toDataURL("image/png");
}
