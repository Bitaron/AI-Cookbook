import { test, expect } from "bun:test";
import { applyOps } from "../server/canvas";
import { sanitizeRendered } from "../server/session";
import { md, renderBlock, splitHighlightedLines, safeUrl } from "../web/runtime/render";
import { parseCodeSteps } from "../web/runtime/widgets";

test("add / update / append / move / delete", () => {
  let r = applyOps([], [
    { op: "add", title: "Intro", blocks: [{ t: "md", text: "hi" }] },
    { op: "add", title: "Second", blocks: [] },
  ]);
  expect(r.sections.map(s => s.id)).toEqual(["s1", "s2"]);
  r = applyOps(r.sections, [{ op: "add", title: "Top", after: "^" }]);
  expect(r.sections.map(s => s.id)).toEqual(["s3", "s1", "s2"]);
  r = applyOps(r.sections, [{ op: "append", id: "s1", blocks: [{ t: "md", text: "more" }] }, { op: "update", id: "s2", title: "Renamed" }]);
  expect(r.sections.find(s => s.id === "s1")!.blocks).toHaveLength(2);
  expect(r.sections.find(s => s.id === "s2")!.title).toBe("Renamed");
  r = applyOps(r.sections, [{ op: "move", id: "s3", after: "s2" }, { op: "delete", id: "s1" }]);
  expect(r.sections.map(s => s.id)).toEqual(["s2", "s3"]);
  expect(r.summary).toStartWith("ok >s3 -s1");
});

test("never reuses ids and stays immutable", () => {
  const a = applyOps([], [{ op: "add", title: "A" }, { op: "add", title: "B" }]);
  const b = applyOps(a.sections, [{ op: "delete", id: "s1" }, { op: "add", title: "C" }]);
  expect(b.sections.map(s => s.id)).toEqual(["s2", "s3"]);
  expect(a.sections).toHaveLength(2);
});

test("reports errors compactly", () => {
  const r = applyOps([], [
    { op: "update", id: "s9", title: "x" },
    { op: "add", title: "Q", blocks: [{ t: "quiz", q: "?", options: ["a"], answer: 3 }, { t: "anim", scene: "A = a\n> s\nbogus A" }] },
  ]);
  expect(r.errors.some(e => e.includes("no section s9"))).toBe(true);
  expect(r.errors.some(e => e.includes("quiz answer out of range"))).toBe(true);
  expect(r.errors.some(e => e.includes("unknown action"))).toBe(true);
  expect(r.summary.length).toBeLessThan(400);
});

test("markdown escapes raw HTML and unsafe links", () => {
  const html = md("<img src=x onerror=alert(1)> [x](javascript:alert(1)) [ok](https://a.b)");
  expect(html).not.toContain("<img");
  expect(html).not.toContain("javascript:");
  expect(html).toContain('href="https://a.b"');
  expect(safeUrl("JaVaScRiPt:alert(1)")).toBe("#");
  expect(safeUrl("docs/a.md")).toBe("docs/a.md");
});

test("math survives markdown via placeholders", () => {
  const html = md("Area is $a_b * c_d$ and `$not$`", { math: (t) => `<math>${t}</math>` });
  expect(html).toContain("<math>a_b * c_d</math>");
  expect(html).toContain("<code>$not$</code>");
});

test("highlighted lines re-open spans across newlines", () => {
  const lines = splitHighlightedLines('<span class="c">/* a\nb */</span>x');
  expect(lines).toEqual(['<span class="c">/* a</span>', '<span class="c">b */</span>x']);
});

test("code steps parse", () => {
  expect(parseCodeSteps("1: a\n2-4: b\nnope")).toEqual([{ from: 1, to: 1, note: "a" }, { from: 2, to: 4, note: "b" }]);
});

test("sandbox block is a placeholder, never inline HTML", () => {
  const html = renderBlock({ t: "sandbox", html: "<script>alert(1)</script>" }, "s1:0");
  expect(html).not.toContain("<script>");
});

test("sanitizeRendered strips scripts and handlers", () => {
  const out = sanitizeRendered(`<div onclick="x()">a</div><script>bad()</script><a href="javascript:x">l</a><iframe src=x></iframe><svg><g onload=y></g></svg>`);
  expect(out).not.toMatch(/onclick|onload|<script|javascript:|<iframe/i);
  expect(out).toContain("<svg>");
});
