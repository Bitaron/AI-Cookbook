# learn: handoff

Status as of 2026-11-15. `learn` is a working v0.1 visual tutor for Claude Code. All tests pass, and it has been checked end to end against real Claude sessions. It isn't published as a plugin yet.

README.md covers what the tool does and how to use it. This file covers what someone continuing the work needs to know.

## What it is

You run `/learn <topic>` in Claude Code, or `learn <topic>` in a terminal. A local Bun server starts a real Claude Code session through the Claude Agent SDK and opens a browser page that is the chat for that session.

Claude teaches on a **lesson canvas**: a document of sections it edits with patches. Sections hold step-through animations (graph or sequence mode), Mermaid diagrams, code walkthroughs, formulas, quizzes, comparison tables, callouts, sandboxed demos, and a lesson-wide glossary.

Every lesson autosaves to `~/.learn/lessons/<id>/` as `lesson.json` plus a self-contained offline `lesson.html` (about 100–130 KB), and can be continued live later.

## How it was built (decisions and why)

| Decision | Choice | Why |
|---|---|---|
| Browser ↔ Claude | Browser is the chat; server runs the Agent SDK | You asked to interact through the page; it's a real Claude Code session (your settings, tools, CLAUDE.md) |
| Trigger | `/learn` skill and `learn` CLI | You asked for both |
| Persistence | `lesson.json` is the source of truth; offline `lesson.html` is regenerated every turn; live resume | Lessons can be opened any time, even without a server |
| Permissions | Full Claude Code tools, using your `settings.json` rules; anything else asks in the page | Your choice |
| Runtime | Bun + TypeScript, no framework, no build step for the server | Simple; Bun serves HTTP and WebSockets |
| Canvas page | A living document plus chat, with an optional raw transcript | Saved lessons read like lessons, not chat logs |
| Visuals | One `canvas` tool (in-process MCP) with typed blocks; compact animation format; sandbox as a last resort | Consistent quality, few tokens |
| Token efficiency | Short chat replies, canvas holds the content, tiny tool results, references by section id, quizzes graded in the browser, images shrunk to 1024px, outline-seeded resume, token meter | Lessons cost about half what they otherwise would |
| Auth | Uses `ANTHROPIC_API_KEY` if set, otherwise the user's own `claude` login; never touches credentials | Anthropic's Agent SDK terms (see Risks) |
| Design | Night-lab dark / daylight light themes; amber marks attention, mint marks motion; section ids in the left margin | One loud element (the animation stage), the rest quiet |

User research came from your "5g-PTP" Claude Code session. Its patterns:
- very short "explain X" prompts that drill into terms from the previous answer;
- topics dense with acronyms;
- tables, message-exchange diagrams and formulas as the most useful forms;
- material turned into posts, PDFs and pages to share.

This research drove the glossary, the sequence animation mode, formulas, right-click quoting, and the Save or share menu.

## Repository map

```
bin/learn                 CLI: ensures the server is running, creates or resumes lessons, opens the browser
server/
  index.ts                server entry (LEARN_FAKE_AGENT=1 → scripted agent, no tokens)
  server.ts               Bun.serve: auth (token/cookie), Host/Origin checks, REST, WebSocket
  session.ts              LiveSession: one Agent SDK query per lesson, input queue, permission bridge,
                          transcript, usage, undo snapshots, resume (full vs outline)
  canvas.ts               the canvas tool: zod schema, CANVAS_DESCRIPTION (sent every turn), applyOps
  prompt.ts               tutor system-prompt addition (sent every turn), first message, outline seed
  store.ts                lesson CRUD on disk (atomic writes), library index
  export.ts               self-contained lesson.html and index.html (inlines web/dist offline runtime and CSS)
  fake-agent.ts           scripted agent for e2e tests and UI work
  config.ts               paths (LEARN_HOME, LEARN_PORT), token file
web/
  app.html, app.ts        live page: canvas, chat, chips, right-click menu, shortcuts, permissions, export
  offline.ts              runtime inlined into saved lesson.html
  index-offline.ts        runtime for the static ~/.learn/index.html
  library.ts, ui.ts       shared library list, theme, outline, chat, transcript helpers
  mermaid.ts              lazy Mermaid, SVG labels so CSS can re-colour it by theme
  styles.css              entire design system (tokens for both themes)
  runtime/                shared by live page, saved files and server (no DOM at import, no Node APIs)
    types.ts              Lesson / Section / Block model
    render.ts             block → HTML, safe markdown (raw HTML escaped, unsafe links dropped)
    widgets.ts            hydrates anim / code / quiz / sandbox; sandbox bridge
    anim-dsl.ts           animation format parser, frame state, sequence timeline
    layout.ts             layered auto-layout and sequence layout
    anim.ts               player: graph and sequence renderers, controls, frame → PNG
    glossary.ts           term marking and hover cards
skills/learn/SKILL.md     the /learn skill
.claude-plugin/plugin.json  plugin manifest (repo is plugin-shaped)
scripts/build.ts          bundles web/ → web/dist (gitignored)
tests/                    unit (anim, canvas/render) and Playwright e2e
install.sh                symlinks CLI + skill; --service adds a systemd user unit
```

## Run, test, develop

```sh
bun install && bun run build
bun run test                    # 17 unit + 15 e2e; e2e needs: bunx playwright install chromium-headless-shell
bun run typecheck
LEARN_FAKE_AGENT=1 LEARN_HOME=/tmp/lh LEARN_PORT=4799 bun server/index.ts   # UI work, no tokens
claude --plugin-dir ./ then /learn:learn <topic>                           # test the skill without installing
./install.sh [--service]        # real install (not done on the dev machine yet)
bin/learn stop                  # stop the background server
```

Rebuild (`bun run build`) after any change under `web/`. Saved lessons inline `web/dist/offline.js`, so existing `lesson.html` files only pick up changes the next time their lesson is saved.

## Verified

- Unit tests cover:
  - the animation format: graph mode, sequence mode, groups, shapes, label wrapping;
  - layout;
  - canvas ops and validation;
  - markdown safety, math placeholders, highlighted-line splitting, sanitizing.
- End-to-end tests, with a real server, a real browser and a scripted agent, cover:
  - security: token, Host, Origin and path traversal;
  - the canvas building up, and stepping through animations;
  - code walkthroughs and quizzes;
  - glossary hover cards, formulas and sequence mode;
  - the theme switch keeping diagram and animation state;
  - keyboard shortcuts and quick actions;
  - undo and the permission prompt;
  - sandbox to Claude messages;
  - right-click quoting of text and animation frames;
  - the transcript;
  - the saved lesson working offline;
  - the library.
- Real Claude runs:

  | Run | Model | Result |
  |---|---|---|
  | Hash maps | Sonnet | 6 sections, $0.16, 31 s |
  | Resume after a server restart | Sonnet | 89% cache hit |
  | TCP handshake through the real `/learn` skill (`--plugin-dir`) | default | 4 sections, $0.27 |
  | PTP boundary clock, 2 turns, 5g-PTP style | Opus | 16 glossary terms, both animation modes, $0.37, 96% cache hit on turn 2 |

## Known issues and limits

- **Wide graphs with hand-placed nodes** (`@col,row`) aren't auto-stacked, so they scroll sideways. Edges that skip a rank can pass behind boxes; the layout is simple.
- **Chat replies run long:** Claude still writes about 40 words, against a target of 35 or fewer.
- **Old lessons keep old instructions.** A resumed session keeps the system prompt it started with (the SDK records it), so lessons started before a prompt change use the old prompt.
- **AskUserQuestion is turned off** in lessons. The page has no UI for it yet; Claude asks in chat instead.
- **Saved lessons aren't refreshed.** Lessons saved before an update keep the old offline runtime until they're saved again.
- **Fonts are system fonts.** Webfonts would bloat offline files, so the look varies by OS. On Fedora the serif falls back to DejaVu or Liberation.
- **Untested environments:** touch screens (long-press opens the native menu) and Safari (no View Transitions, so the theme switch cross-fades).
- **`learn stop` is blunt:** it uses `pkill -f <repo>/server/index.ts`.
- **Single user, localhost only.** Phone or LAN access was deliberately left out.

## Risks

- **Terms of use.** Anthropic's [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance) page says Agent SDK products should use API keys, and third-party apps must not route other users through Claude.ai subscription logins.
  - Personal use with your own login is a grey area.
  - Before publishing, make API-key mode the documented default and keep the README note.
  - The page shows the active auth mode in the meter.
- **Naming.** Don't put "Claude" or Anthropic marks in the product name or logo.
- **Security invariants to keep:**
  - the server listens on 127.0.0.1 only;
  - every API and WebSocket call needs the token (header or HttpOnly SameSite=Strict cookie);
  - Host and Origin checks stay;
  - markdown stays HTML-escaped;
  - client-posted pre-rendered HTML stays sanitized;
  - sandbox iframes never get `allow-same-origin`, and keep their strict CSP.
- **Licences.** Don't copy code from CloudCLI or opcode (AGPL).

## Suggested next steps

1. **Publish as a plugin.** Add marketplace metadata, make API-key auth the default for distribution, and record a short demo.
2. **Glossary and abbreviations export.** Add a one-click "share page" (lesson plus glossary) for non-experts. This was the last thing you asked for in the 5g-PTP session.
3. **What-if widget.** Add a slider block bound to an animation or formula parameter, replacing most sandbox use. The 5g-PTP site used sliders like this.
4. **Attaching documents.** Make it obvious that `@datasheet.pdf` works, or add a document picker.
5. **Layout.** Avoid edges crossing nodes (e.g. route around boxes, or use elkjs if bundle size allows).
6. **AskUserQuestion.** Bridge it to an in-page choice dialog.
7. **Continuous integration.** Run `bun run test` on GitHub Actions with Playwright.

## Where things are

- **Code:** `learn/` in https://github.com/Bitaron/AI-Cookbook (merged from pull request #1). The original dev worktree was `explanation-harness/.claude/worktrees/learn-v1`, branch `worktree-learn-v1`.
- **Demo lesson:** `~/.learn/lessons/2026-11-14-explain-ptp-boundary-clock-819c`.
- **Not installed** on the dev machine. Run `./install.sh` from `learn/` to put `learn` on PATH and add `/learn` to Claude Code.
