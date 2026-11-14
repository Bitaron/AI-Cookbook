import { test, expect } from "bun:test";
import { parseScene, frameAt, seqTimeline, wrapLabel } from "../web/runtime/anim-dsl";
import { layoutScene } from "../web/runtime/layout";

test("seq mode: messages get rows, notes sit beside them", () => {
  const s = parseScene(`mode seq\nM = Master\nS = Slave\n> sync\nmsg M->S "Sync"\nnote M "t1"\n> reply\npkt S->M "Delay_Req"\nnote S "t3"`);
  expect(s.mode).toBe("seq");
  const tl = seqTimeline(s);
  expect(tl.messages.map(m => [m.label, m.row, m.step])).toEqual([["Sync", 0, 0], ["Delay_Req", 1, 1]]);
  expect(tl.notes.map(n => [n.text, n.row])).toEqual([["t1", 0], ["t3", 1]]);
});

test("groups and new shapes parse", () => {
  const s = parseScene(`A = Grandmaster (person)\nB = Decide (diamond)\nC = Router (hex)\ngroup G "Core": A B\n!group H "Edge": C`);
  expect(s.errors).toEqual([]);
  expect(s.nodes.map(n => n.shape)).toEqual(["person", "diamond", "hex"]);
  expect(s.groups).toEqual([{ id: "G", label: "Core", members: ["A", "B"], hidden: false }, { id: "H", label: "Edge", members: ["C"], hidden: true }]);
  expect(frameAt(s, 0).visible.has("G")).toBe(true);
  expect(frameAt(s, 0).visible.has("H")).toBe(false);
});

test("labels wrap into at most two balanced lines", () => {
  expect(wrapLabel("Short")).toEqual(["Short"]);
  expect(wrapLabel("Telecom boundary clock router")).toEqual(["Telecom boundary", "clock router"]);
});

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
