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

namespace="${OD_NAMESPACE:-default}"

echo "==> Open Design stop"
echo "Repo: $ROOT_DIR"
echo "Namespace: $namespace"
echo

status=0
"${pnpm_cmd[@]}" tools-dev stop --namespace "$namespace" || status=$?

echo
if [[ "$status" -eq 0 ]]; then
  echo "Open Design runtime stopped."
else
  echo "Open Design stop exited with code $status."
fi

read '?Press Enter to close...'
exit "$status"