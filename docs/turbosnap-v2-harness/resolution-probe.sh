#!/usr/bin/env bash
# resolution-probe.sh [package]   e.g. resolution-probe.sh ui
# Measures whether v2 notices a `package.json` change that alters dependency *resolution* rather than
# file bytes — the one class that is neither a content change nor a changed package name, and so the
# only class where "v2 needs no `changedPackageFiles` counterpart" was inference rather than measurement.
#
# The probe removes `jsnext:main` from the *installed* `moment/package.json`, so Vite falls back to
# `main` and resolves a different build of the same package (./dist/moment.js -> ./moment.js). No
# install, no lockfile change, nothing tracked by git touched; the manifest is restored with a trap.
#
# Expected: `storybookHash` moves and exactly one story (Button, the sole importer) moves, with no
# `storybookFiles` entry moving — i.e. v2 catches it *and* scopes it, where v1's `changedPackageFiles`
# Path A bails the whole Storybook.
#
# Note: roll-ups were path-independent when this probe was written, so it changes the resolved file's
# *content* rather than only its path. Roll-ups are path-sensitive now (`rollUpEntryHashes`,
# v2/graph.ts), so a byte-identical file at a new path would also be caught — but a content change is
# what a real `resolutions`/`overrides` pin does, so the probe is unchanged.
#
# Env overrides:
#   CHROMATIC_CLI  path to the built CLI entry (default: <this repo>/dist/bin.cjs)
#   MONOREPO       path to the fixture repo    (default: ~/Projects/turbosnap-monorepo)
set -euo pipefail

PKG="${1:-ui}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLI="${CHROMATIC_CLI:-$HERE/../../dist/bin.cjs}"
MONOREPO="${MONOREPO:-$HOME/Projects/turbosnap-monorepo}"
WORK="$(mktemp -d)"

PKG_JSON="$MONOREPO/node_modules/moment/package.json"
STATS="packages/$PKG/storybook-static/preview-stats.json"
# Cleared between builds so the Vite dep optimizer re-resolves instead of serving a cached entry.
CACHE="$MONOREPO/packages/$PKG/node_modules/.cache/storybook"

RESTORED=0
restore() {
  set +e
  if [[ "$RESTORED" != "1" && -f "$WORK/moment-package.json.backup" ]]; then
    cp "$WORK/moment-package.json.backup" "$PKG_JSON"
    RESTORED=1
    echo "restored $PKG_JSON"
  fi
}
trap 'restore; rm -rf "$WORK"' EXIT

if [[ "$PKG" != "ui" && "$PKG" != *"sb8" && "$PKG" != *"sb9" ]]; then
  echo "This probe needs a Vite fixture whose Button story imports moment; got '$PKG'." >&2
  exit 2
fi
if [[ ! -f "$CLI" ]]; then
  echo "CLI not found at $CLI - run \`yarn build\` in chromatic-cli, or set CHROMATIC_CLI." >&2
  exit 1
fi
if [[ ! -f "$PKG_JSON" ]]; then
  echo "Installed moment not found at $PKG_JSON." >&2
  exit 1
fi
if ! node -e 'process.exit(require(process.argv[1])["jsnext:main"] ? 0 : 1)' "$PKG_JSON"; then
  echo "Installed moment has no \`jsnext:main\` field, so there is no resolution to change." >&2
  exit 1
fi

build() { (cd "$MONOREPO" && rm -rf "$CACHE" && yarn nx run "$PKG:build-storybook" >"$1" 2>&1); }
gen() { bash "$HERE/gen.sh" "$PKG" "$1" "$2"; }
snap() {
  cp "$MONOREPO/$STATS" "$1"
  echo "  stats sha: $(shasum -a 256 "$1" | cut -c1-12)  size: $(wc -c <"$1" | tr -d ' ') bytes"
}
moment_modules() {
  node -e '
    const stats = require(process.argv[1]);
    const hits = (stats.modules ?? []).filter((mod) => (mod.name ?? "").includes("node_modules/moment/"));
    console.log(`  moment modules in stats: ${hits.length}`);
    for (const mod of hits.slice(0, 6)) {
      console.log(`    ${mod.name}`);
      const reasons = (mod.reasons ?? []).map((reason) => reason.moduleName).filter(Boolean);
      for (const reason of reasons.slice(0, 3)) console.log(`      reason: ${reason}`);
    }
  ' "$1"
}

cp "$PKG_JSON" "$WORK/moment-package.json.backup"

echo "=== BASELINE (moment resolves via jsnext:main) ==="
build "$WORK/build-base.log"
if [[ ! -f "$MONOREPO/$STATS" ]]; then
  echo "Stats file not found after build at $MONOREPO/$STATS." >&2
  exit 1
fi
snap "$WORK/stats-base.json"
moment_modules "$WORK/stats-base.json"
gen "$WORK/base.json" "$WORK/stats-base.json"

echo
echo "=== EDIT: remove jsnext:main (resolution changes, no source byte changes) ==="
node -e '
  const fs = require("fs");
  const [file] = process.argv.slice(1);
  const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
  delete pkg["jsnext:main"];
  fs.writeFileSync(file, JSON.stringify(pkg, undefined, 2) + "\n");
' "$PKG_JSON"
build "$WORK/build-cur.log"
snap "$WORK/stats-cur.json"
moment_modules "$WORK/stats-cur.json"
gen "$WORK/cur.json" "$WORK/stats-cur.json"

echo
echo "=== DIFF ==="
node "$HERE/tsdiff.mjs" "$WORK/base.json" "$WORK/cur.json" | sed 's/^/  /'

echo
echo "=== moment attribution, before / after ==="
node "$HERE/bucket.mjs" "$WORK/base.json" moment | sed 's/^/  base: /'
node "$HERE/bucket.mjs" "$WORK/cur.json" moment | sed 's/^/  cur:  /'

node - "$WORK/base.json" "$WORK/cur.json" <<'NODE'
const fs = require('fs');

const [baseFile, curFile] = process.argv.slice(2);
const base = JSON.parse(fs.readFileSync(baseFile, 'utf8'));
const cur = JSON.parse(fs.readFileSync(curFile, 'utf8'));

const stories = new Set([...Object.keys(base.storyFiles), ...Object.keys(cur.storyFiles)]);
const changedStories = [...stories].filter((story) => base.storyFiles[story] !== cur.storyFiles[story]);
const storybookFiles = new Set([
  ...Object.keys(base.storybookFiles ?? {}),
  ...Object.keys(cur.storybookFiles ?? {}),
]);
const changedStorybookFiles = [...storybookFiles].filter(
  (key) => (base.storybookFiles ?? {})[key] !== (cur.storybookFiles ?? {})[key]
);

if (base.storybookHash === cur.storybookHash) {
  console.error('Expected storybookHash to move; a resolution change was invisible to v2.');
  process.exit(1);
}
if (changedStorybookFiles.length > 0) {
  console.error(`Expected no storybookFiles changes; got ${changedStorybookFiles.join(', ')}`);
  process.exit(1);
}
if (changedStories.length !== 1 || !changedStories[0].includes('/Button/Button.stories.')) {
  console.error(`Expected only the Button story file to change; got ${changedStories.join(', ') || '(none)'}`);
  process.exit(1);
}

console.log(`ASSERTION OK: storybookHash moved, ${changedStories[0]} changed, no storybookFiles entry moved.`);
NODE

restore

echo
echo "=== RESTORE: rebuild and confirm the manifest returns to baseline ==="
build "$WORK/build-restore.log"
snap "$WORK/stats-restore.json"
gen "$WORK/restore.json" "$WORK/stats-restore.json"
node "$HERE/tsdiff.mjs" "$WORK/base.json" "$WORK/restore.json" | sed 's/^/  /'
