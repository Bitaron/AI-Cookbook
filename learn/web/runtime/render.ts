// Block → static HTML. Interactive widgets are emitted as placeholders and hydrated by widgets.ts.
import { marked } from "marked";
import type { Block, Section } from "./types";

export interface RenderOpts {
  /** Syntax highlighter returning HTML (live app passes highlight.js). */
  highlight?: (code: string, lang?: string) => string;
  /** Math renderer for $...$ / $$...$$ (live app passes KaTeX → MathML). */
  math?: (tex: string, display: boolean) => string;
}

export const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function safeUrl(u: string): string {
  const t = u.trim();
  if (/^(javascript|data|vbscript|file):/i.test(t)) return "#";
  return /^(https?:|mailto:|#)/i.test(t) || !/^[a-z][\w+.-]*:/i.test(t) ? t : "#";
}

/** Replace math with placeholders (restored after markdown parsing so marked can't mangle it). */
function extractMath(text: string, opts: RenderOpts): { text: string; math: string[] } {
  const math: string[] = [];
  if (!opts.math) return { text, math };
  const stash: string[] = [];
  let t = text.replace(/```[\s\S]*?```|`[^`\n]*`/g, m => { stash.push(m); return `\u0000${stash.length - 1}\u0000`; });
  const put = (html: string) => { math.push(html); return `\u0001${math.length - 1}\u0001`; };
  t = t.replace(/\$\$([\s\S]+?)\$\$/g, (_, tex) => put(opts.math!(tex, true)));
  t = t.replace(/(^|[^\\$])\$([^$\n]+?)\$/g, (_, pre, tex) => pre + put(opts.math!(tex, false)));
  return { text: t.replace(/\u0000(\d+)\u0000/g, (_, i) => stash[Number(i)]!), math };
}

export function md(text: string, opts: RenderOpts = {}): string {
  const renderer = new marked.Renderer();
  renderer.code = ({ text: code, lang }) => {
    if (lang === "mermaid") return `<div class="diagram"><pre class="mermaid">${esc(code)}</pre></div>`;
    const body = opts.highlight ? opts.highlight(code, lang) : esc(code);
    return `<pre class="code"><code class="hljs">${body}</code></pre>`;
  };
  // Raw HTML in markdown is escaped: only sandbox blocks may carry HTML.
  renderer.html = ({ text: h }) => esc(h);
  renderer.link = function ({ href, title, tokens }) {
    const inner = this.parser.parseInline(tokens);
    return `<a href="${esc(safeUrl(href))}" target="_blank" rel="noopener noreferrer"${title ? ` title="${esc(title)}"` : ""}>${inner}</a>`;
  };
  renderer.image = ({ href, text: alt }) =>
    /^https?:/i.test(href) ? `<img src="${esc(href)}" alt="${esc(alt)}" loading="lazy">` : esc(alt);
  const { text: t, math } = extractMath(text, opts);
  const html = marked.parse(t, { renderer, async: false, gfm: true }) as string;
  return math.length ? html.replace(/\u0001(\d+)\u0001/g, (_, i) => math[Number(i)]!) : html;
}

/** Split highlighted HTML into lines, re-opening spans that cross line breaks. */
export function splitHighlightedLines(html: string): string[] {
  const lines: string[] = [];
  const open: string[] = [];
  let cur = "";
  const re = /(<span[^>]*>)|(<\/span>)|(\n)|([^<\n]+|<)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    if (m[1]) { open.push(m[1]); cur += m[1]; }
    else if (m[2]) { open.pop(); cur += m[2]; }
    else if (m[3]) { cur += "</span>".repeat(open.length); lines.push(cur); cur = open.join(""); }
    else cur += m[4];
  }
  lines.push(cur);
  return lines;
}

export function renderBlock(b: Block, key: string, opts: RenderOpts = {}): string {
  switch (b.t) {
    case "md":
      return `<div class="b-md">${md(b.text, opts)}</div>`;
    case "diagram":
      return `<figure class="diagram"><pre class="mermaid">${esc(b.mermaid)}</pre>${b.caption ? `<figcaption>${md(b.caption, opts)}</figcaption>` : ""}</figure>`;
    case "anim":
      return `<figure class="b-anim"><div class="w" data-w="anim" data-k="${key}"></div>${b.caption ? `<figcaption>${md(b.caption, opts)}</figcaption>` : ""}</figure>`;
    case "code": {
      const hl = opts.highlight ? opts.highlight(b.code, b.lang) : esc(b.code);
      const lines = splitHighlightedLines(hl).map((l, i) => `<span class="ln" data-ln="${i + 1}">${l || " "}</span>`).join("");
      return `<div class="b-code w" data-w="code" data-k="${key}"><div class="code-head">${esc(b.lang || "code")}</div><pre class="code"><code class="hljs">${lines}</code></pre><div class="code-steps"></div></div>`;
    }
    case "quiz":
      return `<div class="b-quiz w" data-w="quiz" data-k="${key}"><div class="quiz-q">${md(b.q, opts)}</div></div>`;
    case "compare": {
      const head = b.cols.map(c => `<th>${md(c, opts)}</th>`).join("");
      const rows = b.rows.map(r => `<tr>${r.map(c => `<td>${md(c, opts)}</td>`).join("")}</tr>`).join("");
      return `<div class="b-compare"><table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
    }
    case "callout": {
      const kind = b.kind || "key";
      const label = { key: "Key idea", pitfall: "Pitfall", analogy: "Analogy", tip: "Tip" }[kind];
      return `<aside class="callout callout-${kind}"><div class="callout-label">${label}</div>${md(b.text, opts)}</aside>`;
    }
    case "sandbox":
      return `<div class="b-sandbox w" data-w="sandbox" data-k="${key}"></div>`;
  }
}

export function renderSection(s: Section, opts: RenderOpts = {}): string {
  return s.blocks.map((b, i) => renderBlock(b, `${s.id}:${i}`, opts)).join("\n");
}
