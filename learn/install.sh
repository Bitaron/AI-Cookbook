#!/usr/bin/env bash
# Installs `learn` for the current user: CLI on PATH, /learn skill for Claude Code, optional systemd service.
#   ./install.sh            CLI + skill
#   ./install.sh --service  also keep the server running from login (systemd user service)
#   ./install.sh --uninstall
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="${HOME}/.local/bin"
SKILL_DIR="${HOME}/.claude/skills/learn"
UNIT="${HOME}/.config/systemd/user/learn.service"

if [[ "${1:-}" == "--uninstall" ]]; then
  rm -f "${BIN_DIR}/learn"
  [[ -L "${SKILL_DIR}" ]] && rm -f "${SKILL_DIR}"
  if [[ -f "${UNIT}" ]]; then systemctl --user disable --now learn.service || true; rm -f "${UNIT}"; systemctl --user daemon-reload || true; fi
  echo "learn uninstalled. Your lessons in ~/.learn were kept."
  exit 0
fi

command -v bun >/dev/null || { echo "learn needs Bun: https://bun.sh" >&2; exit 1; }
command -v claude >/dev/null || echo "warning: the claude CLI isn't on PATH; lessons need Claude Code installed and logged in (or ANTHROPIC_API_KEY set)." >&2

(cd "${ROOT}" && bun install --frozen-lockfile >/dev/null && bun scripts/build.ts)

mkdir -p "${BIN_DIR}" "$(dirname "${SKILL_DIR}")"
ln -sfn "${ROOT}/bin/learn" "${BIN_DIR}/learn"
if [[ -e "${SKILL_DIR}" && ! -L "${SKILL_DIR}" ]]; then
  echo "warning: ${SKILL_DIR} exists and isn't a symlink; leaving it alone." >&2
else
  ln -sfn "${ROOT}/skills/learn" "${SKILL_DIR}"
fi
echo "Installed: ${BIN_DIR}/learn and the /learn skill."
case ":${PATH}:" in *":${BIN_DIR}:"*) ;; *) echo "Add ${BIN_DIR} to your PATH to use 'learn' from any terminal.";; esac

if [[ "${1:-}" == "--service" ]]; then
  mkdir -p "$(dirname "${UNIT}")"
  cat > "${UNIT}" <<EOF
[Unit]
Description=learn: visual Claude Code tutor server

[Service]
ExecStart=$(command -v bun) ${ROOT}/server/index.ts
Restart=on-failure
Environment=PATH=${PATH}

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable --now learn.service
  echo "Service enabled: the server now starts at login (systemctl --user status learn)."
fi
