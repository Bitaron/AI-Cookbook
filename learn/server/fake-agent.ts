// Scripted stand-in for the Agent SDK, used by e2e tests (LEARN_FAKE_AGENT=1). Costs no tokens.
import type { QueryFn } from "./session";

const SCENE = `A = Call stack
B = Web APIs (round)
!C = Task queue (db)
A -> B "setTimeout"
group R "Runtime": A B
!B -> C
> Script calls setTimeout
hl A
pkt A->B "cb"
> Timer fires; callback is queued
show C
edge B->C
pkt B->C "cb"
> Event loop moves it back
pulse C
pkt C->A "cb"`;

const SEQ = `mode seq
M = Grandmaster
S = Boundary clock (hex)
> Master sends Sync and stamps t1
msg M->S "Sync"
note M "t1"
note S "t2"
> Slave asks back with Delay_Req
msg S->M "Delay_Req"
note S "t3"
note M "t4"
> Master replies with t4
msg M->S "Delay_Resp"`;

export const fakeQuery: QueryFn = ({ prompt }, ctx) => {
  let interrupted = false;
  async function* run() {
    let turn = 0;
    for await (const m of prompt) {
      turn++;
      const text = (m.message.content as any[]).map(c => c.text ?? "").join(" ");
      if (turn === 1) yield { type: "system", subtype: "init", session_id: "fake-session", model: "fake-model", apiKeySource: "none" };
      const usage = { input_tokens: 12, cache_read_input_tokens: 9000, cache_creation_input_tokens: 300, output_tokens: 180 };
      if (/perm/i.test(text)) {
        yield { type: "assistant", parent_tool_use_id: null, message: { usage, content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls -la" } }] } };
        const r: any = await ctx.canUseTool("Bash", { command: "ls -la" }, { signal: new AbortController().signal, toolUseID: "t1", title: "Claude wants to run ls -la", suggestions: [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "ls:*" }], behavior: "allow", destination: "session" }] } as any);
        yield { type: "user", parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: "t1", content: r.behavior === "allow" ? "file-a\nfile-b" : "denied" }] } };
        yield { type: "assistant", parent_tool_use_id: null, message: { usage, content: [{ type: "text", text: r.behavior === "allow" ? "Permission granted." : "Permission denied." }] } };
      } else if (turn === 1) {
        const ops = [{
          op: "add" as const, title: "The event loop in one picture",
          blocks: [
            { t: "md" as const, text: "JavaScript runs on **one thread** and hands slow work to Web APIs. PTP is unrelated but has a glossary entry. Inline math: $O(1)$." },
            { t: "anim" as const, scene: SCENE, caption: "Step through it" },
            { t: "callout" as const, kind: "analogy" as const, text: "A single chef with a ticket rail." },
          ],
        }, {
          op: "add" as const, title: "Code walkthrough",
          blocks: [
            { t: "code" as const, lang: "js", code: "console.log('a');\nsetTimeout(() => {\n  console.log('b');\n}, 0);\nconsole.log('c');", steps: "1: Runs right away\n2-4: Schedules a callback\n5: Runs before the callback" },
            { t: "diagram" as const, mermaid: "flowchart LR\n  S[Stack] --> W[Web APIs] --> Q[Queue] --> S" },
            { t: "anim" as const, scene: SEQ, caption: "Two-way time transfer" },
            { t: "formula" as const, tex: "\\text{offset} = \\frac{(t_2 - t_1) - (t_4 - t_3)}{2}", vars: [["t_1", "Sync sent", "ns"], ["t_2", "Sync received", "ns"]] },
            { t: "callout" as const, kind: "project" as const, text: "Your PTP router needs hardware timestamps." },
          ],
        }, {
          op: "add" as const, title: "Check yourself",
          blocks: [
            { t: "quiz" as const, q: "What prints last?", options: ["a", "b", "c"], answer: 1, why: "The callback waits for the stack to empty." },
            { t: "compare" as const, cols: ["Microtask", "Macrotask"], rows: [["Promise.then", "setTimeout"]] },
            { t: "sandbox" as const, html: "<button id=b>Ask Claude</button><script>b.onclick=()=>learn.send('sandbox says hi')</script>", height: 80 },
          ],
        }];
        yield { type: "assistant", parent_tool_use_id: null, message: { usage, content: [{ type: "tool_use", id: "c1", name: "mcp__learn__canvas", input: { ops, lesson_title: "The JavaScript event loop", glossary: { PTP: "…" } } }] } };
        const summary = await ctx.canvas({ ops, lesson_title: "The JavaScript event loop", glossary: { PTP: "Precision Time Protocol: syncs clocks over a network.", "Web APIs": "Browser features that run outside the JS thread." } });
        yield { type: "user", parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: "c1", content: summary }] } };
        yield { type: "assistant", parent_tool_use_id: null, message: { usage, content: [{ type: "text", text: "Added s1–s3: the event loop, a walkthrough and a quiz." }] } };
      } else {
        const id = /\[(s\d+)\]/.exec(text)?.[1];
        const ops = id
          ? [{ op: "append" as const, id, blocks: [{ t: "md" as const, text: `Simpler take for ${id}.` }] }]
          : [{ op: "add" as const, title: `Follow-up ${turn}`, blocks: [{ t: "md" as const, text: `You said: ${text.slice(0, 80)}` }] }];
        const summary = await ctx.canvas({ ops });
        yield { type: "assistant", parent_tool_use_id: null, message: { usage, content: [{ type: "tool_use", id: `c${turn}`, name: "mcp__learn__canvas", input: { ops } }] } };
        yield { type: "user", parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: `c${turn}`, content: summary }] } };
        yield { type: "assistant", parent_tool_use_id: null, message: { usage, content: [{ type: "text", text: interrupted ? "Stopped." : `Updated ${id ?? "canvas"}.` }] } };
      }
      yield { type: "result", subtype: "success", usage, total_cost_usd: 0.01 * turn };
    }
  }
  const it = run();
  return Object.assign(it, { interrupt: async () => { interrupted = true; } });
};
