// Builds browser bundles into web/dist.
import { rmSync, mkdirSync, copyFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const out = join(root, "web", "dist");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const live = await Bun.build({
  entrypoints: [join(root, "web", "app.ts")],
  outdir: out, target: "browser", format: "esm", splitting: true, minify: true,
  naming: { entry: "[name].js", chunk: "chunk-[hash].js" },
});
if (!live.success) { console.error(live.logs); process.exit(1); }

// Offline runtimes are inlined into saved HTML files: one self-contained IIFE each.
for (const name of ["offline", "index-offline"]) {
  const r = await Bun.build({ entrypoints: [join(root, "web", `${name}.ts`)], outdir: out, target: "browser", format: "iife", minify: true });
  if (!r.success) { console.error(r.logs); process.exit(1); }
}
copyFileSync(join(root, "web", "styles.css"), join(out, "styles.css"));

const kb = (f: string) => `${(statSync(join(out, f)).size / 1024).toFixed(0)} KB`;
console.log(`built web/dist: app.js ${kb("app.js")}, offline.js ${kb("offline.js")}, index-offline.js ${kb("index-offline.js")}, styles.css ${kb("styles.css")}`);
