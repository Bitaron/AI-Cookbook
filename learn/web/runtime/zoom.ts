// Zoom and pan for animations, diagrams and images: a lightbox with wheel / drag / buttons.
// Shared by the live page and saved lessons, so no DOM access at import time.

export interface Zoomer { set: (k: number) => void; by: (f: number) => void; fit: () => void; scale: () => number }

/** Wheel to zoom (toward the cursor), drag to pan, double-click to toggle 2x. Transforms `target` inside `view`. */
export function attachZoom(view: HTMLElement, target: HTMLElement | SVGElement, onChange?: (k: number) => void): Zoomer {
  let k = 1, x = 0, y = 0;
  const apply = () => {
    target.style.transform = `translate(${x}px, ${y}px) scale(${k})`;
    target.style.transformOrigin = "0 0";
    view.classList.toggle("is-zoomed", k > 1.001);
    onChange?.(k);
  };
  const zoomAt = (nk: number, cx: number, cy: number) => {
    nk = Math.max(0.5, Math.min(8, nk));
    // Keep the point under the cursor fixed.
    x = cx - ((cx - x) * nk) / k;
    y = cy - ((cy - y) * nk) / k;
    k = nk;
    if (k <= 1.001) { k = 1; x = 0; y = 0; }
    apply();
  };
  const center = () => { const r = view.getBoundingClientRect(); return [r.width / 2, r.height / 2] as const; };
  view.addEventListener("wheel", ev => {
    ev.preventDefault();
    const r = view.getBoundingClientRect();
    zoomAt(k * Math.exp(-ev.deltaY * 0.0022), ev.clientX - r.left, ev.clientY - r.top);
  }, { passive: false });
  let drag: { px: number; py: number; x: number; y: number } | null = null;
  view.addEventListener("pointerdown", ev => {
    if (k <= 1 || ev.button !== 0 || (ev.target as Element).closest("button")) return;
    drag = { px: ev.clientX, py: ev.clientY, x, y };
    view.setPointerCapture(ev.pointerId);
    view.classList.add("is-dragging");
  });
  view.addEventListener("pointermove", ev => {
    if (!drag) return;
    x = drag.x + ev.clientX - drag.px; y = drag.y + ev.clientY - drag.py;
    apply();
  });
  const end = () => { drag = null; view.classList.remove("is-dragging"); };
  view.addEventListener("pointerup", end);
  view.addEventListener("pointercancel", end);
  view.addEventListener("dblclick", ev => {
    if ((ev.target as Element).closest("button")) return;
    const r = view.getBoundingClientRect();
    zoomAt(k > 1.001 ? 1 : 2, ev.clientX - r.left, ev.clientY - r.top);
  });
  apply();
  return {
    set: nk => { const [cx, cy] = center(); zoomAt(nk, cx, cy); },
    by: f => { const [cx, cy] = center(); zoomAt(k * f, cx, cy); },
    fit: () => { k = 1; x = 0; y = 0; apply(); },
    scale: () => k,
  };
}

const ICON = {
  out: `<svg viewBox="0 0 16 16"><path d="M3.5 8h9"/></svg>`,
  in: `<svg viewBox="0 0 16 16"><path d="M3.5 8h9M8 3.5v9"/></svg>`,
  fit: `<svg viewBox="0 0 16 16"><path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10"/></svg>`,
  close: `<svg viewBox="0 0 16 16"><path d="m4 4 8 8M12 4l-8 8"/></svg>`,
};
export const EXPAND_ICON = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9.5 2.5h4v4M13.5 2.5 9 7M6.5 13.5h-4v-4M2.5 13.5 7 9"/></svg>`;

export interface LightboxOpts {
  title?: string;
  /** Move the element into the lightbox (keeps live state, e.g. a playing animation) instead of cloning it. */
  move?: boolean;
  /** Element inside `content` to zoom (default: the content itself). */
  zoomTarget?: (content: HTMLElement) => HTMLElement | SVGElement;
  /** Element inside `content` that clips and receives wheel/drag (default: the lightbox viewport). */
  zoomView?: (content: HTMLElement) => HTMLElement;
  /** Extra class on the content wrapper (e.g. "mermaid-svg" so cloned diagrams keep their theme styling). */
  wrapClass?: string;
  onClose?: () => void;
}

let openBox: (() => void) | null = null;
export const lightboxOpen = () => !!openBox;

/** Opens a full-window viewer for `el` with zoom controls. Esc or the backdrop closes it. */
export function openLightbox(el: HTMLElement, opts: LightboxOpts = {}) {
  openBox?.();
  const back = document.createElement("div");
  back.className = "lb-back";
  back.innerHTML = `<div class="lb" role="dialog" aria-modal="true" aria-label="${(opts.title ?? "Zoom").replace(/"/g, "&quot;")}">
    <div class="lb-bar"><span class="lb-title"></span>
      <button data-z="out" title="Zoom out (−)" aria-label="Zoom out">${ICON.out}</button>
      <span class="lb-pct">100%</span>
      <button data-z="in" title="Zoom in (+)" aria-label="Zoom in">${ICON.in}</button>
      <button data-z="fit" title="Fit (0)" aria-label="Fit to window">${ICON.fit}</button>
      <button data-z="close" class="lb-close" title="Close (Esc)" aria-label="Close">${ICON.close}</button>
    </div>
    <div class="lb-view"><div class="lb-content"></div></div>
    <div class="lb-hint">Scroll to zoom · drag to pan · double-click for 2×</div>
  </div>`;
  (back.querySelector(".lb-title") as HTMLElement).textContent = opts.title ?? "";
  const wrap = back.querySelector(".lb-content") as HTMLElement;
  if (opts.wrapClass) wrap.classList.add(...opts.wrapClass.split(" "));
  let placeholder: Comment | null = null;
  let content: HTMLElement;
  if (opts.move) {
    placeholder = document.createComment("lightbox");
    el.replaceWith(placeholder);
    content = el;
  } else {
    content = el.cloneNode(true) as HTMLElement;
    content.querySelectorAll(".zoom-btn").forEach(b => b.remove());
  }
  wrap.appendChild(content);
  document.body.appendChild(back);
  document.body.classList.add("lb-open");
  const view = opts.zoomView?.(content) ?? (back.querySelector(".lb-view") as HTMLElement);
  const target = opts.zoomTarget?.(content) ?? wrap;
  const pct = back.querySelector(".lb-pct") as HTMLElement;
  const z = attachZoom(view, target, k => { pct.textContent = `${Math.round(k * 100)}%`; });

  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === "Escape") { close(); ev.preventDefault(); ev.stopImmediatePropagation(); return; }
    if ((ev.target as HTMLElement).closest?.("input, textarea")) return;
    if (ev.key === "+" || ev.key === "=") { z.by(1.25); ev.preventDefault(); ev.stopImmediatePropagation(); }
    else if (ev.key === "-") { z.by(0.8); ev.preventDefault(); ev.stopImmediatePropagation(); }
    else if (ev.key === "0") { z.fit(); ev.preventDefault(); ev.stopImmediatePropagation(); }
    else if (!["ArrowLeft", "ArrowRight", " ", "Home", "End", "Tab"].includes(ev.key)) ev.stopImmediatePropagation(); // page shortcuts stay off
  };
  document.addEventListener("keydown", onKey, true);
  back.addEventListener("click", ev => {
    const b = (ev.target as HTMLElement).closest<HTMLButtonElement>("button[data-z]");
    if (b) {
      const a = b.dataset.z;
      if (a === "in") z.by(1.25); else if (a === "out") z.by(0.8); else if (a === "fit") z.fit(); else close();
      return;
    }
    if (ev.target === back) close();
  });
  function close() {
    if (!back.isConnected) return;
    document.removeEventListener("keydown", onKey, true);
    target.style.transform = "";
    if (placeholder) placeholder.replaceWith(content);
    back.remove();
    document.body.classList.remove("lb-open");
    openBox = null;
    opts.onClose?.();
    if (opts.move) content.focus?.({ preventScroll: true });
  }
  openBox = close;
  requestAnimationFrame(() => back.classList.add("is-in"));
  if (opts.move) content.focus?.({ preventScroll: true });
  else (back.querySelector(".lb-close") as HTMLButtonElement).focus();
  return close;
}

/** Adds a zoom button to rendered diagrams and makes images open in the lightbox. */
export function enhanceZoom(root: ParentNode) {
  root.querySelectorAll<HTMLElement>(".mermaid-svg").forEach(d => {
    if (d.dataset.zoom || !d.querySelector("svg")) return;
    d.dataset.zoom = "1";
    const b = document.createElement("button");
    b.className = "zoom-btn"; b.type = "button"; b.title = "Zoom (or double-click)"; b.setAttribute("aria-label", "Zoom diagram");
    b.innerHTML = EXPAND_ICON;
    const open = () => openLightbox(d, { title: "Diagram", wrapClass: "mermaid-svg lb-diagram" });
    b.addEventListener("click", open);
    d.addEventListener("dblclick", ev => { if (!(ev.target as Element).closest("button")) open(); });
    d.appendChild(b);
  });
  root.querySelectorAll<HTMLImageElement>(".sec-body img").forEach(img => {
    if (img.dataset.zoom || img.closest(".chip")) return;
    img.dataset.zoom = "1";
    img.classList.add("is-zoomable");
    img.addEventListener("click", () => openLightbox(img, { title: img.alt || "Image", wrapClass: "lb-image" }));
  });
}
