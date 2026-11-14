// Step-through animation player for the compact scene DSL.
import { parseScene, frameAt, edgeKey, type Scene, type FrameState } from "./anim-dsl";
import { layoutScene, allEdges, type Box } from "./layout";

const SVG = "http://www.w3.org/2000/svg";
const svgEl = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}) => {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
};

function center(b: Box) { return { x: b.x + b.w / 2, y: b.y + b.h / 2 }; }

/** Point where the segment from the box center toward (tx,ty) exits the box. */
function exitPoint(b: Box, tx: number, ty: number) {
  const c = center(b);
  const dx = tx - c.x, dy = ty - c.y;
  if (dx === 0 && dy === 0) return c;
  const sx = dx !== 0 ? (b.w / 2) / Math.abs(dx) : Infinity;
  const sy = dy !== 0 ? (b.h / 2) / Math.abs(dy) : Infinity;
  const s = Math.min(sx, sy);
  return { x: c.x + dx * s, y: c.y + dy * s };
}

function edgeGeom(a: Box, b: Box) {
  const ca = center(a), cb = center(b);
  const p1 = exitPoint(a, cb.x, cb.y), p2 = exitPoint(b, ca.x, ca.y);
  return { p1, p2 };
}

let uid = 0;

export function mountAnimation(host: HTMLElement, src: string) {
  const scene: Scene = parseScene(src);
  const layout = layoutScene(scene);
  const id = `anim${++uid}`;
  host.classList.add("anim");
  host.innerHTML = "";

  const stage = document.createElement("div");
  stage.className = "anim-stage";
  const svg = svgEl("svg", { viewBox: `0 0 ${layout.width} ${layout.height}`, role: "img" });
  svg.style.maxWidth = `${Math.max(layout.width, 320)}px`;
  const defs = svgEl("defs");
  const marker = svgEl("marker", { id: `${id}-arrow`, viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse" });
  marker.appendChild(svgEl("path", { d: "M0,0 L10,5 L0,10 z", class: "anim-arrowhead" }));
  defs.appendChild(marker);
  svg.appendChild(defs);

  const edgeLayer = svgEl("g", { class: "anim-edges" });
  const nodeLayer = svgEl("g", { class: "anim-nodes" });
  const fxLayer = svgEl("g", { class: "anim-fx" });
  svg.append(edgeLayer, nodeLayer, fxLayer);

  const declared = new Map(scene.edges.map(e => [edgeKey(e.from, e.to), e]));
  const edgeEls = new Map<string, SVGGElement>();
  for (const e of allEdges(scene)) {
    const a = layout.boxes.get(e.from), b = layout.boxes.get(e.to);
    if (!a || !b) continue;
    const meta = declared.get(edgeKey(e.from, e.to));
    const { p1, p2 } = edgeGeom(a, b);
    const g = svgEl("g", { class: "anim-edge" });
    const line = svgEl("line", { x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y });
    if (meta?.directed !== false) line.setAttribute("marker-end", `url(#${id}-arrow)`);
    g.appendChild(line);
    if (meta?.label) {
      const t = svgEl("text", { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 - 7, "text-anchor": "middle", class: "anim-edge-label" });
      t.textContent = meta.label;
      g.appendChild(t);
    }
    edgeLayer.appendChild(g);
    edgeEls.set(edgeKey(e.from, e.to), g);
  }

  const nodeEls = new Map<string, { g: SVGGElement; text: SVGTextElement; note: SVGTextElement }>();
  for (const n of scene.nodes) {
    const b = layout.boxes.get(n.id)!;
    const g = svgEl("g", { class: `anim-node shape-${n.shape}`, transform: `translate(${b.x},${b.y})` });
    let shape: SVGElement;
    if (n.shape === "circle") shape = svgEl("ellipse", { cx: b.w / 2, cy: b.h / 2, rx: b.w / 2, ry: b.h / 2 });
    else if (n.shape === "db") {
      shape = svgEl("path", { d: `M0,7 a${b.w / 2},7 0 0,0 ${b.w},0 a${b.w / 2},7 0 0,0 -${b.w},0 v${b.h - 14} a${b.w / 2},7 0 0,0 ${b.w},0 v-${b.h - 14}` });
    } else shape = svgEl("rect", { width: b.w, height: b.h, rx: n.shape === "round" ? b.h / 2 : n.shape === "note" ? 2 : 9 });
    shape.setAttribute("class", "anim-shape");
    const text = svgEl("text", { x: b.w / 2, y: b.h / 2 + 5, "text-anchor": "middle", class: "anim-label" });
    const note = svgEl("text", { x: b.w / 2, y: b.h + 16, "text-anchor": "middle", class: "anim-note" });
    g.append(shape, text, note);
    nodeLayer.appendChild(g);
    nodeEls.set(n.id, { g, text, note });
  }

  stage.appendChild(svg);
  const caption = document.createElement("div");
  caption.className = "anim-caption";
  const controls = document.createElement("div");
  controls.className = "anim-controls";
  controls.innerHTML = `<button data-act="prev" title="Previous (←)">‹</button><button data-act="play" title="Play/pause (space)">▶</button><button data-act="next" title="Next (→)">›</button><div class="anim-dots"></div>`;
  const dots = controls.querySelector(".anim-dots") as HTMLElement;
  scene.steps.forEach((_, i) => {
    const d = document.createElement("button");
    d.className = "anim-dot"; d.title = `Step ${i + 1}`; d.dataset.step = String(i);
    dots.appendChild(d);
  });
  host.append(stage, caption, controls);
  if (scene.errors.length) {
    const errs = document.createElement("details");
    errs.className = "anim-errors";
    errs.innerHTML = `<summary>${scene.errors.length} scene warning(s)</summary>`;
    const pre = document.createElement("pre"); pre.textContent = scene.errors.join("\n");
    errs.appendChild(pre); host.appendChild(errs);
  }

  let step = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let rafs: number[] = [];

  const runPackets = (st: FrameState) => {
    rafs.forEach(cancelAnimationFrame); rafs = [];
    fxLayer.innerHTML = "";
    st.pkts.forEach((p, i) => {
      const a = layout.boxes.get(p.from), b = layout.boxes.get(p.to);
      if (!a || !b) return;
      const { p1, p2 } = edgeGeom(a, b);
      const g = svgEl("g", { class: "anim-pkt" });
      g.appendChild(svgEl("circle", { r: 7 }));
      if (p.label) { const t = svgEl("text", { y: -12, "text-anchor": "middle" }); t.textContent = p.label; g.appendChild(t); }
      fxLayer.appendChild(g);
      const dur = 1100, delay = i * 250;
      const t0 = performance.now() + delay;
      const tick = (now: number) => {
        const k = Math.min(1, Math.max(0, (now - t0) / dur));
        const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
        g.setAttribute("transform", `translate(${p1.x + (p2.x - p1.x) * e},${p1.y + (p2.y - p1.y) * e})`);
        g.style.opacity = k >= 1 ? "0.0" : "1";
        if (k < 1) rafs.push(requestAnimationFrame(tick));
      };
      rafs.push(requestAnimationFrame(tick));
    });
  };

  const render = () => {
    const st = frameAt(scene, step);
    for (const [nid, el] of nodeEls) {
      el.g.classList.toggle("is-hidden", !st.visible.has(nid));
      el.g.classList.toggle("is-hl", st.hl.has(nid));
      el.g.classList.toggle("is-dim", st.dim.has(nid));
      el.g.classList.toggle("is-pulse", st.pulse.has(nid));
      el.text.textContent = st.labels.get(nid) ?? nid;
      el.note.textContent = st.notes.get(nid) ?? "";
    }
    for (const [k, el] of edgeEls) {
      const [f, t] = k.split(">");
      el.classList.toggle("is-hidden", !st.edges.has(k) || !st.visible.has(f!) || !st.visible.has(t!));
      el.classList.toggle("is-active", st.pkts.some(p => p.from === f && p.to === t) || (st.hl.has(f!) && st.hl.has(t!)));
    }
    caption.textContent = st.caption;
    dots.querySelectorAll(".anim-dot").forEach((d, i) => d.classList.toggle("is-on", i === step));
    (controls.querySelector('[data-act="prev"]') as HTMLButtonElement).disabled = step === 0;
    (controls.querySelector('[data-act="next"]') as HTMLButtonElement).disabled = step === scene.steps.length - 1;
    runPackets(st);
  };

  const go = (i: number) => { step = Math.max(0, Math.min(scene.steps.length - 1, i)); render(); };
  const stop = () => { if (timer) clearInterval(timer); timer = null; (controls.querySelector('[data-act="play"]') as HTMLElement).textContent = "▶"; };
  const play = () => {
    if (step >= scene.steps.length - 1) go(0);
    (controls.querySelector('[data-act="play"]') as HTMLElement).textContent = "❚❚";
    timer = setInterval(() => { if (step >= scene.steps.length - 1) stop(); else go(step + 1); }, 2400);
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
    if (ev.key === "ArrowRight") { stop(); go(step + 1); ev.preventDefault(); }
    else if (ev.key === "ArrowLeft") { stop(); go(step - 1); ev.preventDefault(); }
    else if (ev.key === " ") { timer ? stop() : play(); ev.preventDefault(); }
  });
  render();
}
