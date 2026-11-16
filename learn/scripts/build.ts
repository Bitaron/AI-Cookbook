// Builds browser bundles into web/dist. Builds into a temp folder and swaps it in only on success,
// so a failed build (e.g. during `learn update`) never breaks the running server's assets.
import { rmSync, mkdirSync, copyFileSync, statSync, renameSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const dist = join(root, "web", "dist");
const out = join(root, "web", `.dist-${process.pid}.tmp`); // ignored by .gitignore (*.tmp)
const fail = (logs: unknown) => { console.error(logs); rmSync(out, { recursive: true, force: true }); process.exit(1); };
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

process.on("uncaughtException", fail); // Bun.build throws on syntax errors
const live = await Bun.build({
  entrypoints: [join(root, "web", "app.ts")],
  outdir: out, target: "browser", format: "esm", splitting: true, minify: true,
  naming: { entry: "[name].js", chunk: "chunk-[hash].js" },
});
if (!live.success) fail(live.logs);

// Offline runtimes are inlined into saved HTML files: one self-contained IIFE each.
for (const name of ["offline", "index-offline"]) {
  const r = await Bun.build({ entrypoints: [join(root, "web", `${name}.ts`)], outdir: out, target: "browser", format: "iife", minify: true });
  if (!r.success) fail(r.logs);
}
copyFileSync(join(root, "web", "styles.css"), join(out, "styles.css"));

const old = `${dist}.old-${process.pid}.tmp`;
try { renameSync(dist, old); } catch {} // no previous build
renameSync(out, dist);
rmSync(old, { recursive: true, force: true });

const kb = (f: string) => `${(statSync(join(dist, f)).size / 1024).toFixed(0)} KB`;
console.log(`built web/dist: app.js ${kb("app.js")}, offline.js ${kb("offline.js")}, index-offline.js ${kb("index-offline.js")}, styles.css ${kb("styles.css")}`);
