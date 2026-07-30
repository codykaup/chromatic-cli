#!/usr/bin/env bash
# static-identity-probe.sh [package]   (default: ui)
# Probes the cases where a static file's IDENTITY changes but its bytes don't, and the cases where the
# bytes exist but the walk never reaches them. These are the classes attribution-matrix.sh can't express:
# a content swap needs a matched pair, and a symlink can't be made by appending to a file.
#
#   1. rename an asset, bytes kept        -> <staticFiles> path-independent (accepted gap G1)
#   2. swap two assets' contents          -> same hash multiset, different URLs (accepted gap G1)
#   3. symlinked asset, target changes    -> hashed by target bytes (G2, fixed)
#   4. symlinked directory of assets      -> descended into (G2, fixed)
#
# Cases 1-2 are a KNOWN, ACCEPTED gap and must keep reporting UNDER-CAPTURES: rollUpHash is
# path-independent by design (graph.ts:29), which is right for modules (identical bytes render
# identically) and wrong for static files (the URL is the identity).
#
# Cases 3-4 were gap G2, a CONTENT miss rather than a path one, and are FIXED: the walk now follows
# symlinks. They must report `as expected`; a regression here shows up as UNDER-CAPTURES.
#
# Nothing tracked by git is touched: every asset this creates is untracked and removed by the trap.
# Env overrides: CHROMATIC_CLI, MONOREPO (see gen.sh).
set -uo pipefail

PKG="${1:-ui}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MONOREPO="${MONOREPO:-$HOME/Projects/turbosnap-monorepo}"
W="$(mktemp -d)"
S="$MONOREPO/packages/$PKG/.storybook/static"

cleanup() {
  rm -f "$S/probe-light.txt" "$S/probe-dark.txt" "$S/probe-link.txt" "$S/probe-linkdir" "$S/probe-renamed.js"
  # The rename probe stages the real asset outside the static dir; put it back if still displaced.
  [[ -f "$W/moved-aside" && ! -f "$S/mockServiceWorker.js" ]] && mv "$W/moved-aside" "$S/mockServiceWorker.js"
  rm -rf "$W"
}
trap cleanup EXIT

[[ -d "$S" ]] || { echo "$PKG has no .storybook/static — nothing to probe." >&2; exit 1; }

cp "$MONOREPO/packages/$PKG/storybook-static/preview-stats.json" "$W/stats.json"
gen() { bash "$HERE/gen.sh" "$PKG" "$1" "$W/stats.json" >/dev/null; }
h()   { jq -r '.storybookHash' "$1"; }
sf()  { jq -r '.storybookFiles["<staticFiles>"] // "ABSENT"' "$1"; }
cnt() { jq -r '.staticFiles | length' "$1"; }

verdict() { # <base> <cur> <expected-to-move: yes|no>
  local moved=CHANGED
  [[ "$(h "$1")" == "$(h "$2")" ]] && moved=SAME
  printf '  staticFiles hashed: %s -> %s\n' "$(cnt "$1")" "$(cnt "$2")"
  printf '  <staticFiles>:      %s -> %s\n' "$(sf "$1")" "$(sf "$2")"
  printf '  storybookHash:      %s -> %s  %s\n' "$(h "$1")" "$(h "$2")" "$moved"
  if [[ "$3" == yes && "$moved" == SAME ]]; then echo "  => UNDER-CAPTURES (expected the hash to move)"
  elif [[ "$3" == no && "$moved" == CHANGED ]]; then echo "  => moved unexpectedly"
  else echo "  => as expected ($3)"; fi
}

echo "### 1. asset renamed, bytes kept  [$PKG]"
gen "$W/1a.json"
# Stage the original OUTSIDE the static dir, or the probe measures an add rather than a rename.
mv "$S/mockServiceWorker.js" "$W/moved-aside"; cp "$W/moved-aside" "$S/probe-renamed.js"
gen "$W/1b.json"
rm -f "$S/probe-renamed.js"; mv "$W/moved-aside" "$S/mockServiceWorker.js"
verdict "$W/1a.json" "$W/1b.json" yes

echo
echo "### 2. two assets swap contents (same multiset, different URLs)"
printf 'light theme asset\n' > "$S/probe-light.txt"; printf 'dark theme asset\n' > "$S/probe-dark.txt"
gen "$W/2a.json"
printf 'dark theme asset\n' > "$S/probe-light.txt"; printf 'light theme asset\n' > "$S/probe-dark.txt"
gen "$W/2b.json"
rm -f "$S/probe-light.txt" "$S/probe-dark.txt"
verdict "$W/2a.json" "$W/2b.json" yes

echo
echo "### 3. symlinked asset — target's bytes change"
mkdir -p "$W/real"; printf 'v1 content\n' > "$W/real/asset.txt"
ln -s "$W/real/asset.txt" "$S/probe-link.txt"
gen "$W/3a.json"
printf 'v2 CONTENT CHANGED\n' > "$W/real/asset.txt"
gen "$W/3b.json"
rm -f "$S/probe-link.txt"
verdict "$W/3a.json" "$W/3b.json" yes

echo
echo "### 4. symlinked directory of assets added"
mkdir -p "$W/realdir"; printf 'nested a\n' > "$W/realdir/a.txt"; printf 'nested b\n' > "$W/realdir/b.txt"
gen "$W/4a.json"
ln -s "$W/realdir" "$S/probe-linkdir"
gen "$W/4b.json"
rm -f "$S/probe-linkdir"
verdict "$W/4a.json" "$W/4b.json" yes

echo
echo "### fixture repo clean?"
git -C "$MONOREPO" status --porcelain | sed 's/^/  /'
