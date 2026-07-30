#!/usr/bin/env bash
# cost-e2e.sh — end-to-end wall clock and absolute peak memory for the compiled CLI.
#
# cost-phases.mjs breaks the cost down but runs the TypeScript source in-process behind a Vite server,
# so its absolute memory figures are meaningless. This runs the real `dist/bin.cjs` under
# `/usr/bin/time -l`, which reports the process's maximum resident set size, N times. Use it to time
# `turbosnap-manifest` (v2) and `trace` (v1) the same way, so the two are comparable.
#
# Usage:
#   bash cost-e2e.sh <repo-root> <runs> -- <cli args...>
#
# Examples:
#   bash cost-e2e.sh ~/Projects/chromatic-cli 5 -- turbosnap-manifest -b . --static-dir static
#   bash cost-e2e.sh ~/Projects/chromatic-cli 5 -- trace --json node-src/lib/getFileHashes.ts
#
# Env overrides:
#   CHROMATIC_CLI  path to the built CLI entry (default: <this repo>/dist/bin.cjs)
#
# IMPORTANT: run `yarn build` in chromatic-cli first. A stale dist silently measures an older algorithm.
set -euo pipefail

REPO="${1:?usage: cost-e2e.sh <repo-root> <runs> -- <cli args...>}"
RUNS="${2:?usage: cost-e2e.sh <repo-root> <runs> -- <cli args...>}"
shift 2
[[ "${1:-}" == "--" ]] && shift

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLI="${CHROMATIC_CLI:-$HERE/../../dist/bin.cjs}"

if [[ ! -f "$CLI" ]]; then
  echo "CLI not found at $CLI — run \`yarn build\` in chromatic-cli, or set CHROMATIC_CLI." >&2
  exit 1
fi

echo "repo:    $REPO ($(git -C "$REPO" rev-parse --short HEAD))"
echo "cli:     $CLI (chromatic-cli $(git -C "$HERE" rev-parse --short HEAD))"
echo "args:    $*"
echo "runs:    $RUNS"
echo
printf '%5s  %9s  %14s  %14s\n' run wall_s max_rss_bytes stdout_bytes

cd "$REPO"
for ((i = 1; i <= RUNS; i++)); do
  TIMING=$(mktemp)
  OUT=$(mktemp)
  /usr/bin/time -l node "$CLI" "$@" >"$OUT" 2>"$TIMING" || true
  WALL=$(awk '/real/ {print $1}' "$TIMING" | head -1)
  RSS=$(awk '/maximum resident set size/ {print $1}' "$TIMING")
  printf '%5s  %9s  %14s  %14s\n' "$i" "$WALL" "$RSS" "$(wc -c <"$OUT" | tr -d ' ')"
  rm -f "$TIMING" "$OUT"
done
