# learn

A visual tutor for Claude Code. Run `/learn <topic>` in Claude Code, or `learn <topic>` in a terminal, and a browser page opens. That page is the chat for a real Claude Code session. Claude teaches on a **lesson canvas** using step-through animations, diagrams, code walkthroughs, quizzes, comparisons and callouts. Every lesson is saved as a self-contained HTML file that you can open offline at any time, or continue live later.

## Install

Needs [Bun](https://bun.sh) and Claude Code. Claude Code must be logged in, or `ANTHROPIC_API_KEY` must be set.

```sh
./install.sh            # puts `learn` on PATH (~/.local/bin) and adds the /learn skill
./install.sh --service  # also starts the server at login (systemd user service)
./install.sh --uninstall
```

### Update

```sh
learn update --check    # show what's new, change nothing
learn update            # pull, rebuild and restart the server
```

`learn update` is safe to run at any time:
- It only fast-forwards. It stops without changing anything if you have local edits in this folder or your branch has diverged.
- If Claude is in the middle of a turn, it waits for the turn to finish. Add `--force` to skip the wait.
- It reinstalls dependencies only when they changed, and rebuilds the web app.
- If that fails, it rolls back to the version you had, and the running server keeps working.
- It restarts the server, or the systemd service if you installed with `--service`. Open lesson pages reconnect by themselves.
- Your lessons in `~/.learn` are never touched.

If you update with plain `git pull` instead, run `learn update` afterwards to rebuild and restart the server.

## Use

```sh
learn "how DNS resolution works"     # new lesson, Claude works in the current folder
learn --scratch "binary search"      # new lesson in an empty scratch folder
learn --model opus "CRDTs"           # pick the model for this lesson
learn --library                      # browse past lessons
learn --resume <id>                  # continue a lesson live
learn stop                           # stop the background server (refuses mid-turn; --force to override)
learn update                         # update learn safely (see Update above)
```

Inside Claude Code, `/learn <topic>` writes a short summary of what you're working on and passes it to the tutor. The lesson then starts from your real context.

### In the browser
- **Canvas** (centre): Claude adds, edits and reorders sections. Hover a section for *Simpler*, *Deeper*, *Example* and *Ask…*.
- **What Claude can draw:**
  - step-through animations: boxes and arrows (graph mode), or lifelines with timed messages for protocols (sequence mode);
  - Mermaid diagrams, which follow the light/dark theme;
  - code walkthroughs, formulas with a legend for each variable, comparison tables;
  - callouts, including *In your project*;
  - quizzes;
  - sandboxed what-if demos.
- **Glossary:** every acronym Claude defines is underlined wherever it appears. Hover it for the definition and an *Explain* button. The full list is under the outline.
- **Right-click** anything in the lesson. Shift+right-click gives the browser's own menu.
  - **Selected text:** *Ask about this* quotes it into your next message. *Explain this simply* and *Define the terms in this* send right away.
  - **An animation:** ask about the current step, optionally with a picture of that frame attached.
  - **A diagram:** ask about it, by its source or as a picture.
  - **Code or an image:** quote it into your next message.
  - **A section:** simpler, deeper, example, quiz.
- **Chat** (right):
  - Claude's replies are kept short; tool calls show as small chips, and a status line shows what Claude is doing.
  - Quoted context appears as chips above the message box. Backspace on an empty box removes the last chip.
  - Shortcuts: *Analogy*, *Example*, *Go deeper*, *Quiz me*, *Wrap up*.
  - Type `@` to mention a file. Paste or drop images (they're downscaled to 1024px before sending).
  - **Stop** interrupts Claude. **Undo** reverts Claude's last canvas change.
- **Save or share** (top bar): download the offline copy, print or save as PDF (the lesson only), or ask Claude for a one-page summary or a short post to share.
- **Transcript** tab: the full raw log, including every tool call and result.
- **Permissions:** your Claude Code settings (`settings.json` allow and deny rules) apply as usual. Anything else shows an approval dialog in the page (<kbd>Y</kbd> allow once, <kbd>A</kbd> allow for the session, <kbd>N</kbd> deny).
- **Meter:** the context size, output tokens, cache hit rate and cost of the last turn.
- **Light/dark:** <kbd>T</kbd> or the top-right button. The new theme spreads out in a circle from the button; diagrams and running animations keep their state.

### Keyboard shortcuts

Press <kbd>?</kbd> in the page for this list.

| Key | Action |
|---|---|
| <kbd>/</kbd> | Focus the message box (<kbd>Enter</kbd> sends, <kbd>Shift</kbd>+<kbd>Enter</kbd> adds a new line, <kbd>Esc</kbd> leaves it) |
| <kbd>J</kbd> / <kbd>K</kbd> | Next / previous section |
| <kbd>S</kbd> <kbd>D</kbd> <kbd>E</kbd> <kbd>A</kbd> | Simpler / Deeper / Example / Ask, for the section in view |
| <kbd>Q</kbd> | Quote the selected text into the next message |
| <kbd>←</kbd> <kbd>→</kbd> <kbd>Space</kbd> <kbd>Home</kbd> <kbd>End</kbd> | Step, play and pause the focused animation |
| <kbd>U</kbd> | Undo Claude's last canvas change |
| <kbd>Esc</kbd> <kbd>Esc</kbd> | Stop Claude |
| <kbd>T</kbd> | Switch light / dark |
| <kbd>G</kbd> | Switch between the lesson and transcript tabs |
| <kbd>L</kbd> | Open the library |

### Saved lessons
Lessons live in `~/.learn/lessons/<id>/`:
- `lesson.json` is the source of truth.
- `lesson.html` is a self-contained offline copy, usually 130–200 KB. Diagrams are pre-rendered, and animations, quizzes and code walkthroughs still work without a server.

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
- **Compact animation format.** Claude writes only the meaning of an animation. Layout, curved edges, styling and timing are computed by the player. In graph mode, a wide chain is stacked top to bottom automatically.
  ```
  A = Call stack
  B = Web APIs (round)
  !C = Task queue (db)
  A -> B "setTimeout"
  group R "Runtime": A B
  > Timer fires
  show C
  pkt B->C "cb"
  ```
  Sequence mode for protocols:
  ```
  mode seq
  M = Grandmaster
  S = Boundary clock (hex)
  > Sync, stamped t1
  msg M->S "Sync"
  note M "t1"
  note S "t2"
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
