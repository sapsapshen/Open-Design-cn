#!/bin/zsh

set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
cd "$ROOT_DIR"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required. Install Node 24 with Corepack enabled, then try again."
  echo
  read '?Press Enter to close...'
  exit 1
fi

if command -v pnpm >/dev/null 2>&1; then
  pnpm_cmd=(pnpm)
elif command -v corepack >/dev/null 2>&1; then
  echo "pnpm not found on PATH. Falling back to Corepack."
  pnpm_cmd=(corepack pnpm)
else
  echo "pnpm is required. Install pnpm or enable Corepack, then try again."
  echo
  read '?Press Enter to close...'
  exit 1
fi

daemon_port="${OD_DAEMON_PORT:-17456}"
web_port="${OD_WEB_PORT:-17573}"

echo "==> Open Design startup"
echo "Repo: $ROOT_DIR"
echo "Daemon port: $daemon_port"
echo "Web port: $web_port"
echo

if [[ ! -d "$ROOT_DIR/node_modules" ]]; then
  echo "node_modules not found. Running pnpm install first..."
  "${pnpm_cmd[@]}" install
  echo
fi

echo "Stopping any stale default runtime..."
"${pnpm_cmd[@]}" tools-dev stop >/dev/null 2>&1 || true

echo "Starting Open Design..."
echo "Web will be available at: http://127.0.0.1:$web_port/"
echo

exit_code=0
"${pnpm_cmd[@]}" tools-dev run web --daemon-port "$daemon_port" --web-port "$web_port" || exit_code=$?

echo
if [[ "$exit_code" -eq 0 ]]; then
  echo "Open Design stopped normally."
else
  echo "Open Design exited with code $exit_code."
fi

read '?Press Enter to close...'
exit "$exit_code"