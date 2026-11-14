# learn: project notes

Visual tutor for Claude Code. See README.md for usage and architecture.

- Runtime: Bun. Use `bun <file>`, `bun test`, and `Bun.serve` (no express, vite or jest).
- Build browser bundles with `bun run build` → `web/dist`, which is gitignored. Saved lessons inline `web/dist/offline.js` and `styles.css`, so rebuild after changing anything under `web/`.
- Tests: `bun run test`. The e2e tests use `server/fake-agent.ts` (no tokens) and Playwright chromium-headless-shell.
- `web/runtime/*` runs in three places: the live page, saved offline HTML, and the server (canvas validation). Keep it free of DOM access at import time and free of Node APIs.
- Token budget matters:
  - `server/prompt.ts` and `CANVAS_DESCRIPTION` in `server/canvas.ts` are sent on every turn, so keep them short.
  - Canvas tool results must stay tiny.
- Security invariants:
  - Bind to 127.0.0.1 only.
  - Every API and WebSocket call requires the token (header or cookie).
  - Keep the Host and Origin checks.
  - Markdown stays HTML-escaped.
  - Sandbox iframes never get `allow-same-origin`.
