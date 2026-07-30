#!/usr/bin/env bash
# attribution-matrix.sh <package>   e.g. ui | ui-webpack | ui-rsbuild | marketing-ui
# Attribution audit matrix: probes every manifest entry for over- and under-capture.
#
# Each probe mutates exactly one input, regenerates the manifest from a FIXED stats snapshot (so the
# module graph cannot move underneath the run), diffs against a baseline taken from that same
# snapshot, then restores. Emits one JSON line per probe.
set -uo pipefail

PKG="${1:?usage: attribution-matrix.sh <package>}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MONOREPO="${MONOREPO:-$HOME/Projects/turbosnap-monorepo}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

STATS="$MONOREPO/packages/$PKG/storybook-static/preview-stats.json"
if [[ ! -f "$STATS" ]]; then echo "{\"error\":\"no stats for $PKG\"}"; exit 1; fi
cp "$STATS" "$WORK/stats.json"
echo "# $PKG stats sha: $(shasum -a 256 "$WORK/stats.json" | cut -c1-16)" >&2

gen() { bash "$HERE/gen.sh" "$PKG" "$1" "$WORK/stats.json" >/dev/null 2>"$WORK/err"; }

gen "$WORK/base.json" || { echo "{\"error\":\"baseline gen failed: $(tail -2 "$WORK/err")\"}"; exit 1; }

# report <name> <expectation>
report() {
  local name="$1" expect="$2"
  if ! gen "$WORK/cur.json"; then
    printf '{"probe":%s,"expect":%s,"error":%s}\n' \
      "$(jq -Rn --arg v "$name" '$v')" "$(jq -Rn --arg v "$expect" '$v')" \
      "$(jq -Rn --arg v "$(tail -3 "$WORK/err" | tr '\n' ' ')" '$v')"
    return
  fi
  jq -n --slurpfile b "$WORK/base.json" --slurpfile c "$WORK/cur.json" \
     --arg name "$name" --arg expect "$expect" '
    ($b[0]) as $B | ($c[0]) as $C |
    {
      probe: $name, expect: $expect,
      hash: (if $B.storybookHash == $C.storybookHash then "SAME" else "CHANGED" end),
      storiesChanged: [ (($B.storyFiles + $C.storyFiles) | keys[]) as $k
                        | select($B.storyFiles[$k] != $C.storyFiles[$k])
                        | ($k | split("/") | last) ],
      sbFilesChanged: [ (($B.storybookFiles + $C.storybookFiles) | keys[]) as $k
                        | select($B.storybookFiles[$k] != $C.storybookFiles[$k])
                        | if ($B.storybookFiles[$k] == null) then "+" + $k
                          elif ($C.storybookFiles[$k] == null) then "-" + $k
                          else ($k | sub("^.*/\\.storybook/"; ".storybook/")) end ],
      configFileCount: ($C.storybookConfigFiles | length),
      staticFileCount: ($C.staticFiles | length)
    }'
}

# --- probe kinds ---------------------------------------------------------------

# tracked source file: append a comment, restore with git checkout
edit() { # <name> <expect> <repo-relative-file>
  local f="$3"
  [[ -f "$MONOREPO/$f" ]] || { printf '{"probe":"%s","expect":"%s","error":"missing file %s"}\n' "$1" "$2" "$f"; return; }
  printf '\n// attrtest %s\n' "$RANDOM$RANDOM" >> "$MONOREPO/$f"
  report "$1" "$2"
  git -C "$MONOREPO" checkout -- "$f"
}

# node_modules file: append a comment, restore from backup
edit_nm() { # <name> <expect> <node_modules-relative-file>
  local abs="$MONOREPO/node_modules/$3"
  [[ -f "$abs" ]] || { printf '{"probe":"%s","expect":"%s","error":"missing nm file %s"}\n' "$1" "$2" "$3"; return; }
  cp "$abs" "$WORK/nm.bak"
  printf '\n// attrtest\n' >> "$abs"
  report "$1" "$2"
  cp "$WORK/nm.bak" "$abs"
}

# bump the "version" field of an installed package.json
bump_version() { # <name> <expect> <package-name>
  local abs="$MONOREPO/node_modules/$3/package.json"
  [[ -f "$abs" ]] || { printf '{"probe":"%s","expect":"%s","error":"missing %s"}\n' "$1" "$2" "$3"; return; }
  cp "$abs" "$WORK/pj.bak"
  jq '.version = "99.99.99"' "$WORK/pj.bak" > "$abs"
  report "$1" "$2"
  cp "$WORK/pj.bak" "$abs"
}

# create a brand new untracked file, then delete it
add_file() { # <name> <expect> <repo-relative-path>
  local f="$3"
  mkdir -p "$(dirname "$MONOREPO/$f")"
  printf 'attrtest added file\n' > "$MONOREPO/$f"
  report "$1" "$2"
  rm -f "$MONOREPO/$f"
}

# delete a tracked file, then restore it
delete_file() { # <name> <expect> <repo-relative-file>
  local f="$3"
  [[ -f "$MONOREPO/$f" ]] || { printf '{"probe":"%s","expect":"%s","error":"missing %s"}\n' "$1" "$2" "$f"; return; }
  rm "$MONOREPO/$f"
  report "$1" "$2"
  git -C "$MONOREPO" checkout -- "$f"
}

# rename a tracked file, preserving its bytes, then move it back
rename_file() { # <name> <expect> <from> <to>
  local from="$3" to="$4"
  [[ -f "$MONOREPO/$from" ]] || { printf '{"probe":"%s","expect":"%s","error":"missing %s"}\n' "$1" "$2" "$from"; return; }
  mkdir -p "$(dirname "$MONOREPO/$to")"
  mv "$MONOREPO/$from" "$MONOREPO/$to"
  report "$1" "$2"
  mv "$MONOREPO/$to" "$MONOREPO/$from"
}

P="packages/$PKG"

# --- the probe list ------------------------------------------------------------

# Vite resolves moment to dist/moment.js; webpack and rspack to moment.js.
case "$PKG" in
  ui|marketing-ui) MOMENT=moment/dist/moment.js ;;
  *) MOMENT=moment/moment.js ;;
esac

# --- A. graph-derived story hashes ---------------------------------------------
if [[ "$PKG" == "marketing-ui" ]]; then
  edit "graph: leaf component HeroBanner.tsx"   "HeroBanner only"          "$P/src/lib/HeroBanner/HeroBanner.tsx"
  edit "graph: story file HeroBanner.stories"   "HeroBanner only"          "$P/src/lib/HeroBanner/HeroBanner.stories.tsx"
  edit "graph: unreferenced src/index.ts"       "nothing (not a preview input)" "$P/src/index.ts"
else
  edit "graph: leaf component Badge.tsx"        "Badge + UserCard"         "$P/src/lib/Badge/Badge.tsx"
  edit "graph: UserCard.tsx"                    "UserCard only"            "$P/src/lib/UserCard/UserCard.tsx"
  edit "graph: Button.tsx"                      "Button only"              "$P/src/lib/Button/Button.tsx"
  edit "graph: story file Badge.stories.tsx"    "Badge only"               "$P/src/lib/Badge/Badge.stories.tsx"
  edit "graph: cross-package shared barrel"     "Button + UserCard"        "packages/shared/src/index.ts"
  edit "graph: unreferenced src/index.ts"       "nothing (not a preview input)" "$P/src/index.ts"
  edit "graph: theme.ts (preview + story dual importer)" "Button + preview entry" "$P/src/theme.ts"
fi

# --- B. installed dependencies -------------------------------------------------
edit_nm "dep: moment (ESM-resolved)"            "Button only"              "$MOMENT"
edit_nm "dep: react/index.js"                   "webpack all 3; vite bucket" "react/index.js"
edit_nm "dep: react/jsx-runtime.js"             "all stories (JSX edge)"   "react/jsx-runtime.js"
edit_nm "bucket: @storybook/react-dom-shim"     "<storybookGlobals> only, 0 stories" "@storybook/react-dom-shim/dist/react-18.js"

# --- C. <storybookConfig> ------------------------------------------------------
edit "config: main.ts bytes"                    "<storybookConfig> only, 0 stories" "$P/.storybook/main.ts"
edit "config: preview.ts bytes"                 "<storybookConfig> + preview entry" "$P/.storybook/preview.ts"
if [[ -f "$MONOREPO/$P/.storybook/test.ts" ]]; then
  edit "config: test.ts (preview import)"       "<storybookConfig> + preview entry" "$P/.storybook/test.ts"
fi
add_file "config: new file added to config dir" "<storybookConfig> moves"  "$P/.storybook/attrtest-new.ts"
delete_file "config: main.ts deleted"           "<storybookConfig> moves"  "$P/.storybook/main.ts"
add_file "config: nested subdir file added"     "<storybookConfig> moves"  "$P/.storybook/nested/deep/thing.ts"

# --- D. <staticFiles> ----------------------------------------------------------
if [[ -d "$MONOREPO/$P/.storybook/static" ]]; then
  edit "static: existing asset bytes"           "<staticFiles> only, 0 stories" "$P/.storybook/static/mockServiceWorker.js"
  add_file "static: new asset added"            "<staticFiles> moves"      "$P/.storybook/static/attrtest-asset.txt"
  delete_file "static: only asset deleted"      "<staticFiles> key disappears" "$P/.storybook/static/mockServiceWorker.js"
  rename_file "static: asset renamed, bytes kept" "URL changes — does the hash?" \
    "$P/.storybook/static/mockServiceWorker.js" "$P/.storybook/static/attrtest-renamed.js"
fi

# Path-independence (rename / content-swap / symlink) is probed by static-identity-probe.sh instead:
# swapping main.ts's bytes makes the config unparseable, so those cases need their own driver.

# --- F. <storybookVersion> ----------------------------------------------------
bump_version "version: storybook core bumped"   "<storybookVersion> moves" "storybook"
bump_version "version: @storybook/react bumped" "nothing (deliberately narrow)" "@storybook/react"
bump_version "version: @storybook/react-dom-shim bumped" "nothing via version; bytes unchanged" "@storybook/react-dom-shim"
