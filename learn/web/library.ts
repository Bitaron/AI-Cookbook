// Library list, used both by the live server page (with actions) and the static ~/.learn/index.html.
import { esc } from "./runtime/render";

export interface Meta { id: string; title: string; topic: string; createdAt: number; updatedAt: number; cwd: string; tags: string[]; sections: number; costUsd: number }

export interface LibraryOpts {
  live: boolean;               // live server page (rename/tag/delete available)
  serverUp: boolean;           // static page: server reachable → offer "Continue live"
  port: number;
  hrefOffline: (id: string) => string;
  onRename?: (id: string, title: string) => Promise<void>;
  onTags?: (id: string, tags: string[]) => Promise<void>;
  onDelete?: (id: string) => Promise<void>;
}

const when = (ts: number) => new Date(ts).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

export function mountLibrary(root: HTMLElement, lessons: Meta[], opts: LibraryOpts) {
  const search = root.querySelector<HTMLInputElement>(".lib-search")!;
  const list = root.querySelector<HTMLElement>(".lib-list")!;
  let items = lessons;
  const liveHref = (id: string) => opts.live ? `/l/${encodeURIComponent(id)}` : `http://127.0.0.1:${opts.port}/l/${encodeURIComponent(id)}`;

  const draw = () => {
    const q = search.value.trim().toLowerCase();
    const shown = items.filter(l => !q || [l.title, l.topic, l.cwd, ...l.tags].join(" ").toLowerCase().includes(q));
    if (!items.length) {
      list.innerHTML = `<p class="lib-empty">No lessons yet. Start one with <code>learn "how DNS works"</code> in a terminal, or <code>/learn</code> inside Claude Code.</p>`;
      return;
    }
    if (!shown.length) { list.innerHTML = `<p class="lib-empty">No lessons match “${esc(q)}”.</p>`; return; }
    list.innerHTML = shown.map(l => `
      <div class="lib-item" data-id="${esc(l.id)}">
        <h2><a href="${opts.live || opts.serverUp ? liveHref(l.id) : opts.hrefOffline(l.id)}">${esc(l.title)}</a></h2>
        <div class="lib-actions">
          ${opts.live || opts.serverUp ? `<a href="${liveHref(l.id)}">Continue</a>` : ""}
          <a href="${opts.hrefOffline(l.id)}">Saved copy</a>
          ${opts.live ? `<button data-act="rename">Rename</button><button data-act="tags">Tags</button><button data-act="delete" class="danger">Delete</button>` : ""}
        </div>
        <div class="lib-sub"><span>${esc(when(l.updatedAt))}</span><span>${l.sections} section${l.sections === 1 ? "" : "s"}</span><span title="${esc(l.cwd)}">${esc(l.cwd.split("/").slice(-2).join("/"))}</span>${l.costUsd ? `<span>$${l.costUsd.toFixed(2)}</span>` : ""}</div>
        <div class="lib-tags">${l.tags.map(t => `<span>${esc(t)}</span>`).join("")}</div>
      </div>`).join("");
  };

  list.addEventListener("click", async ev => {
    const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>("button[data-act]");
    if (!btn) return;
    const id = btn.closest<HTMLElement>(".lib-item")!.dataset.id!;
    const l = items.find(x => x.id === id)!;
    if (btn.dataset.act === "rename") {
      const t = prompt("Rename lesson", l.title)?.trim();
      if (t) { await opts.onRename?.(id, t); l.title = t; draw(); }
    } else if (btn.dataset.act === "tags") {
      const t = prompt("Tags, separated by commas", l.tags.join(", "));
      if (t !== null) { const tags = t.split(",").map(s => s.trim()).filter(Boolean); await opts.onTags?.(id, tags); l.tags = tags; draw(); }
    } else if (btn.dataset.act === "delete") {
      if (confirm(`Delete “${l.title}”? This removes its saved files.`)) { await opts.onDelete?.(id); items = items.filter(x => x.id !== id); draw(); }
    }
  });
  search.addEventListener("input", draw);
  draw();
}
