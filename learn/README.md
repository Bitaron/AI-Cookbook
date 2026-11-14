# learn

A visual tutor for Claude Code. Run `/learn <topic>` in Claude Code, or `learn <topic>` in a terminal, and a browser page opens. That page is the chat for a real Claude Code session. Claude teaches on a **lesson canvas** using step-through animations, diagrams, code walkthroughs, quizzes, comparisons and callouts. Every lesson is saved as a self-contained HTML file that you can open offline at any time, or continue live later.

## Install

Needs [Bun](https://bun.sh) and Claude Code. Claude Code must be logged in, or `ANTHROPIC_API_KEY` must be set.

```sh
./install.sh            # puts `learn` on PATH (~/.local/bin) and adds the /learn skill
./install.sh --service  # also starts the server at login (systemd user service)
./install.sh --uninstall
```

## Use

```sh
learn "how DNS resolution works"     # new lesson, Claude works in the current folder
learn --scratch "binary search"      # new lesson in an empty scratch folder
learn --model opus "CRDTs"           # pick the model for this lesson
learn --library                      # browse past lessons
learn --resume <id>                  # continue a lesson live
learn stop                           # stop the background server
```

Inside Claude Code, `/learn <topic>` writes a short summary of what you're working on and passes it to the tutor. The lesson then starts from your real context.

### In the browser
- **Canvas** (centre): Claude adds, edits and reorders sections. Hover a section for *Simpler*, *Deeper*, *Example*, *Quiz me* and *Ask…*.
- **Chat** (right):
  - Claude's replies are kept short, and tool calls show as small chips.
  - Shortcuts: *Analogy*, *Quiz me*, *Example*, *Go deeper*, *Wrap up*.
  - Type `@` to mention a file. Paste or drop images (they're downscaled to 1024px before sending).
  - **Stop** interrupts Claude. **Undo** reverts Claude's last canvas change.
- **Transcript** tab: the full raw log, including every tool call and result.
- **Permissions:** your Claude Code settings (`settings.json` allow and deny rules) apply as usual. Anything else shows an approval dialog in the page.
- **Meter:** the context size, output tokens, cache hit rate and cost of the last turn.

### Saved lessons
Lessons live in `~/.learn/lessons/<id>/`:
- `lesson.json` is the source of truth.
- `lesson.html` is a self-contained offline copy, around 100 KB. Diagrams are pre-rendered, and animations, quizzes and code walkthroughs still work without a server.

`~/.learn/index.html` is an offline library page. When the server is running, saved pages offer **Continue this lesson live**. When it isn't, they show the `learn --resume` command to run.

When you resume after a while, choose how to continue:
- **Lesson outline** (the default once the prompt cache has expired) starts a fresh session seeded with the outline. It's cheap.
- **Full history** reloads the whole conversation.

## How it works

```
learn CLI / skill ──POST──▶ Bun server (127.0.0.1:4747, token) ──Agent SDK──▶ claude (your settings, tools, CLAUDE.md)
                                 ▲   │                                   │
                       WebSocket │   │ canvas tool (in-process MCP)  ◀───┘
                                 ▼
                      browser: canvas + chat + transcript ──▶ ~/.learn/lessons/<id>/lesson.{json,html}
```

- **One tool.** Claude edits the canvas through a single tool, `mcp__learn__canvas`, which makes patch operations (add, update, append, delete, move). Its results are tiny (`ok +s3 · outline: …`), so tool output doesn't fill the context.
- **Compact animation format.** Claude writes only the meaning of an animation. Layout, styling and timing are computed by the player:
  ```
  A = Call stack
  B = Web APIs (round)
  !C = Task queue (db)
  A -> B "setTimeout"
  > Timer fires
  show C
  pkt B->C "cb"
  ```
- **Token efficiency.**
  - Chat replies are short and the canvas holds the content.
  - Quick actions refer to a section by id instead of resending it.
  - Multiple-choice quizzes are graded in the browser.
  - Images are downscaled before sending, and `@` mentions send only the path.
  - Long tool output is cut off in the transcript.
  - A resume can be seeded from the outline instead of the full history.
- **Security.**
  - The server listens on 127.0.0.1 only, and every request needs the per-install token in `~/.learn/token`. The browser gets it as an HttpOnly, SameSite=Strict cookie.
  - Host and Origin headers are checked, to block DNS rebinding and cross-site requests.
  - Markdown is escaped.
  - Sandbox demos run in `sandbox="allow-scripts"` iframes with a strict CSP and no network. A demo can message Claude only after you confirm.

## Authentication and terms

`learn` drives your installed `claude` binary through the Claude Agent SDK. It never handles credentials itself.
- If `ANTHROPIC_API_KEY` is set, it is used. This is Anthropic's recommended mode for tools built on the Agent SDK.
- Otherwise, your own Claude Code login is used for your own personal use.

Read Anthropic's [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance) page before sharing or publishing this tool. Third-party apps may not route other users' requests through Claude.ai subscription logins. The page shows the auth mode in use.

## Develop

```sh
bun install
bun run build       # browser bundles → web/dist
bun run test        # unit tests + Playwright e2e (scripted fake agent, no tokens)
bun run typecheck
LEARN_FAKE_AGENT=1 LEARN_HOME=/tmp/lh bun server/index.ts   # UI work without spending tokens
```

The e2e tests need a Playwright browser: `bunx playwright install chromium-headless-shell`.

| Path | What |
|---|---|
| `bin/learn` | CLI: starts the server, creates lessons and opens the browser |
| `server/` | HTTP + WebSocket server, Agent SDK session, canvas tool, store, offline export |
| `web/runtime/` | Shared by the live page and saved files: data types, renderer, widgets, animation format, layout and player |
| `web/app.ts` | Live page (chat, canvas, permissions, library) |
| `web/offline.ts`, `web/index-offline.ts` | Runtimes inlined into saved HTML files |
| `skills/learn/` | The `/learn` skill. `.claude-plugin/` makes the repo installable as a plugin |
