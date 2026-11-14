// Glossary terms: underline the first mention of each term per section and show a definition card on hover/focus.
import { esc } from "./render";

const SKIP = new Set(["CODE", "PRE", "A", "SVG", "MATH", "ABBR", "BUTTON", "TEXTAREA", "SCRIPT", "STYLE", "FIGCAPTION"]);

export function markTerms(root: HTMLElement, glossary: Record<string, string> | undefined) {
  const terms = Object.keys(glossary ?? {}).filter(t => t.trim().length > 1).sort((a, b) => b.length - a.length);
  if (!terms.length) return;
  const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(^|[^\\w-])(${terms.map(escRe).join("|")})(?![\\w-])`);
  root.querySelectorAll<HTMLElement>(".sec-body").forEach(body => {
    const seen = new Set<string>();
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, {
      acceptNode: n => {
        for (let p = n.parentElement; p && p !== body; p = p.parentElement) {
          if (SKIP.has(p.tagName.toUpperCase()) || p.classList.contains("w") || p.classList.contains("mermaid-svg")) return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const texts: Text[] = [];
    while (walker.nextNode()) texts.push(walker.currentNode as Text);
    for (const t of texts) {
      let node: Text | null = t;
      while (node) {
        const m = re.exec(node.data);
        if (!m) break;
        const term = m[2]!;
        const start = m.index + m[1]!.length;
        if (seen.has(term)) {
          // Only the first mention per section is marked; keep scanning after this one.
          const rest: Text = node.splitText(start + term.length);
          node = rest;
          continue;
        }
        seen.add(term);
        const after = node.splitText(start);
        const tail = after.splitText(term.length);
        const abbr = document.createElement("abbr");
        abbr.className = "term";
        abbr.tabIndex = 0;
        abbr.dataset.term = term;
        abbr.textContent = term;
        after.replaceWith(abbr);
        node = tail;
      }
    }
  });
}

/** One floating definition card shared by all terms. */
export function initTermCards(getGlossary: () => Record<string, string> | undefined, onExplain?: (term: string) => void) {
  const card = document.createElement("div");
  card.className = "term-card";
  card.setAttribute("role", "tooltip");
  card.hidden = true;
  document.body.appendChild(card);
  let hideTimer: ReturnType<typeof setTimeout> | null = null;
  let current: HTMLElement | null = null;

  const show = (abbr: HTMLElement) => {
    const term = abbr.dataset.term!;
    const def = getGlossary()?.[term];
    if (!def) return;
    if (hideTimer) clearTimeout(hideTimer);
    current = abbr;
    card.innerHTML = `<div class="term-name">${esc(term)}</div><div class="term-def">${esc(def)}</div>${onExplain ? `<button class="term-more">Explain ${esc(term)}</button>` : ""}`;
    card.hidden = false;
    const r = abbr.getBoundingClientRect();
    const cw = Math.min(320, innerWidth - 24);
    card.style.width = `${cw}px`;
    card.style.left = `${Math.max(12, Math.min(innerWidth - cw - 12, r.left + r.width / 2 - cw / 2))}px`;
    const below = r.bottom + 10 + card.offsetHeight < innerHeight;
    card.style.top = `${below ? r.bottom + 8 : r.top - card.offsetHeight - 8}px`;
    card.classList.toggle("is-above", !below);
    requestAnimationFrame(() => card.classList.add("is-in"));
  };
  const hide = (delay = 160) => {
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => { card.classList.remove("is-in"); card.hidden = true; current = null; }, delay);
  };

  document.addEventListener("mouseover", ev => {
    const abbr = (ev.target as HTMLElement).closest?.("abbr.term") as HTMLElement | null;
    if (abbr) show(abbr);
    else if ((ev.target as HTMLElement).closest?.(".term-card")) { if (hideTimer) clearTimeout(hideTimer); }
    else if (current) hide();
  });
  document.addEventListener("focusin", ev => {
    const abbr = (ev.target as HTMLElement).closest?.("abbr.term") as HTMLElement | null;
    if (abbr) show(abbr); else if (!(ev.target as HTMLElement).closest?.(".term-card")) hide(0);
  });
  document.addEventListener("keydown", ev => { if (ev.key === "Escape" && !card.hidden) hide(0); });
  card.addEventListener("click", ev => {
    if ((ev.target as HTMLElement).closest(".term-more") && current) { onExplain?.(current.dataset.term!); hide(0); }
  });
}
