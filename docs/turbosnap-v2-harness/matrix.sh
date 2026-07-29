#!/usr/bin/env bash
# matrix.sh <package>   e.g. matrix.sh ui | ui-webpack | ui-rsbuild
# Runs the change-detection test matrix for one builder package against the fixture monorepo.
#
# Each test makes a CONTENT-ONLY edit (appends a comment) and regenerates the manifest from the SAME
# stats file, so the module graph is unchanged and we isolate hash propagation. Edits are reverted
# with `git checkout` (source files) or backup/restore (node_modules, which isn't git-tracked).
#
# Env overrides: CHROMATIC_CLI, MONOREPO (see gen.sh).
set -euo pipefail

PKG="${1:?usage: matrix.sh <package>   (ui | ui-webpack | ui-rsbuild)}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MONOREPO="${MONOREPO:-$HOME/Projects/turbosnap-monorepo}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

gen()  { bash "$HERE/gen.sh" "$PKG" "$1"; }
diffm(){ node "$HERE/tsdiff.mjs" "$1" "$2"; }

gen "$WORK/base.json"

# run <name> <repo-relative-file> <expected>
run() {
  local name="$1" file="$2" expected="$3"
  echo "========================================================"
  echo "TEST: $name   [$PKG]"
  echo "  file: $file"
  echo "  expected: $expected"
  printf '\n// tstest %s\n' "$(od -An -N4 -tx4 /dev/urandom | tr -d ' ')" >> "$MONOREPO/$file"
  gen "$WORK/cur.json"
  diffm "$WORK/base.json" "$WORK/cur.json" | sed 's/^/  /'
  git -C "$MONOREPO" checkout -- "$file"
}

# run_nm <name> <node_modules-relative-file> <expected>  (backup/restore instead of git)
run_nm() {
  local name="$1" file="$2" expected="$3"
  local abs="$MONOREPO/node_modules/$file"
  echo "========================================================"
  echo "TEST: $name   [$PKG]"
  echo "  file: node_modules/$file"
  echo "  expected: $expected"
  cp "$abs" "$WORK/nm-backup"
  printf '\n// tstest node_modules edit\n' >> "$abs"
  gen "$WORK/cur.json"
  diffm "$WORK/base.json" "$WORK/cur.json" | sed 's/^/  /'
  cp "$WORK/nm-backup" "$abs"
}

run "Edit leaf component Badge.tsx"        "packages/$PKG/src/lib/Badge/Badge.tsx"          "Badge + UserCard"
run "Edit UserCard.tsx"                     "packages/$PKG/src/lib/UserCard/UserCard.tsx"    "UserCard only"
run "Edit Button.tsx"                       "packages/$PKG/src/lib/Button/Button.tsx"        "Button only"
run "Edit story file Badge.stories.tsx"     "packages/$PKG/src/lib/Badge/Badge.stories.tsx"  "Badge only"
run "Edit cross-pkg shared/src/index.ts"    "packages/shared/src/index.ts"                   "Button + UserCard (both import from shared barrel)"
run "Edit .storybook/preview.ts"            "packages/$PKG/.storybook/preview.ts"            "ALL stories (KNOWN BLIND SPOT -> expect 0)"
run "Edit .storybook/main.ts"              "packages/$PKG/.storybook/main.ts"                "ALL stories (main.ts not in graph -> expect 0)"
run_nm "Edit dependency react/index.js"     "react/index.js"                                 "ALL on webpack/rsbuild; 0 on vite (BLIND SPOT)"
run_nm "Edit dependency moment"             "moment/dist/moment.js"                          "Button (traced on all three builders)"
echo "========================================================"
