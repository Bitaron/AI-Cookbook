// Mermaid, loaded lazily. Diagrams render once with neutral colors; the stylesheet re-colors them with
// theme variables, so switching light/dark never re-renders and saved files follow the reader's theme.
import { esc } from "./runtime/render";

let mod: typeof import("mermaid").default | null = null;
let n = 0;

export function initMermaid() { /* lazy: first diagram triggers the import */ }

async function load() {
  if (mod) return mod;
  mod = (await import("mermaid")).default;
  mod.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: "base",
    htmlLabels: false, // pure SVG text: themable with CSS and exportable as an image
    fontFamily: "Inter, 'Segoe UI', system-ui, sans-serif",
    flowchart: { htmlLabels: false, curve: "basis", padding: 14, nodeSpacing: 46, rankSpacing: 56 },
    sequence: { mirrorActors: false, messageMargin: 38, boxMargin: 8, noteMargin: 10, actorMargin: 70 },
    themeVariables: { fontSize: "14px" },
  } as any);
  return mod;
}

export async function renderMermaid(root: HTMLElement) {
  const nodes = [...root.querySelectorAll<HTMLElement>("pre.mermaid")];
  if (!nodes.length) return;
  const m = await load();
  for (const node of nodes) {
    const src = node.textContent || "";
    try {
      const { svg } = await m.render(`mmd-${Date.now().toString(36)}-${++n}`, src);
      const div = document.createElement("div");
      div.className = "mermaid-svg";
      div.innerHTML = svg;
      // Drop mermaid's fixed max-width so the diagram scales with the column.
      const el = div.querySelector("svg");
      if (el) { el.removeAttribute("height"); el.style.maxWidth = `min(100%, ${el.style.maxWidth || "100%"})`; }
      node.replaceWith(div);
    } catch (e) {
      node.insertAdjacentHTML("afterend", `<div class="diagram-error">This diagram couldn't be drawn: ${esc(String((e as Error).message ?? e)).slice(0, 300)}</div>`);
      document.querySelectorAll(`#d${CSS.escape(`mmd-${n}`)}`).forEach(x => x.remove());
    }
  }
}
