import { test, expect } from "bun:test";
import { parseScene, frameAt } from "../web/runtime/anim-dsl";
import { layoutScene } from "../web/runtime/layout";

const SRC = `
dir LR
A = Call stack
B = Web APIs (round)
!C = Task queue (db)
A -> B "setTimeout"
!B -> C
> Script calls setTimeout
hl A
pkt A->B "cb"
> Timer fires, callback queued
show C
edge B->C
pkt B->C
label B "Timer done"
> Done
`;

test("parses nodes, edges, steps", () => {
  const s = parseScene(SRC);
  expect(s.errors).toEqual([]);
  expect(s.nodes.map(n => n.id)).toEqual(["A", "B", "C"]);
  expect(s.nodes[1]!.shape).toBe("round");
  expect(s.nodes[2]!.hidden).toBe(true);
  expect(s.edges[0]).toMatchObject({ from: "A", to: "B", label: "setTimeout", directed: true });
  expect(s.steps).toHaveLength(3);
});

test("transient vs persistent actions", () => {
  const s = parseScene(SRC);
  const f0 = frameAt(s, 0);
  expect(f0.hl.has("A")).toBe(true);
  expect(f0.visible.has("C")).toBe(false);
  expect(f0.pkts).toHaveLength(1);
  const f1 = frameAt(s, 1);
  expect(f1.hl.size).toBe(0);
  expect(f1.visible.has("C")).toBe(true);
  expect(f1.edges.has("B>C")).toBe(true);
  const f2 = frameAt(s, 2);
  expect(f2.labels.get("B")).toBe("Timer done");
  expect(f2.pkts).toHaveLength(0);
  expect(f2.caption).toBe("Done");
});

test("reports errors without throwing and auto-declares edge nodes", () => {
  const s = parseScene("X -> Y\n> go\nwiggle X\npkt nope");
  expect(s.nodes.map(n => n.id)).toEqual(["X", "Y"]);
  expect(s.errors.length).toBe(2);
});

test("layout ranks left to right and handles cycles and pins", () => {
  const s = parseScene("A = a\nB = b\nC = c\nA -> B\nB -> C\nC -> A\nP = pinned @0,5");
  const l = layoutScene(s);
  const x = (id: string) => l.boxes.get(id)!.x;
  expect(x("A")).toBeLessThan(x("B"));
  expect(x("B")).toBeLessThan(x("C"));
  expect(l.boxes.get("P")!.y).toBeGreaterThan(l.boxes.get("A")!.y);
  expect(l.width).toBeGreaterThan(0);
});

test("TB direction stacks vertically", () => {
  const l = layoutScene(parseScene("dir TB\nA = a\nB = b\nA -> B"));
  expect(l.boxes.get("A")!.y).toBeLessThan(l.boxes.get("B")!.y);
});
