#!/usr/bin/env bash
# cjs-edge-probe.sh [package]   e.g. cjs-edge-probe.sh ui
# Measures Vite attribution for an ESM story file importing a CJS-only dependency.
#
# The probe makes a temporary structural fixture edit, so it rebuilds Storybook stats once with the
# dependency present, then diffs manifests across a content-only edit to that dependency. The fixture
# source file and temporary package are restored with a trap.
#
# Env overrides:
#   CHROMATIC_CLI  path to the built CLI entry (default: <this repo>/dist/bin.cjs)
#   MONOREPO       path to the fixture repo    (default: ~/Projects/turbosnap-monorepo)
#   BUCKET_OUT     optional file to copy the final patched-builder bucket listing into
set -euo pipefail

PKG="${1:-ui}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLI="${CHROMATIC_CLI:-$HERE/../../dist/bin.cjs}"
MONOREPO="${MONOREPO:-$HOME/Projects/turbosnap-monorepo}"
WORK="$(mktemp -d)"

CJS_PKG="${CJS_PROBE_PACKAGE:-cjs-edge-probe}"
PROBE_DIR="$MONOREPO/node_modules/$CJS_PKG"
STORY="packages/$PKG/src/lib/Button/Button.stories.tsx"
STATS="packages/$PKG/storybook-static/preview-stats.json"
BUILDER_DIST="$MONOREPO/node_modules/@storybook/builder-vite/dist/index.js"

HAD_EXISTING_PROBE=0
FIXTURE_CLEANED=0

cleanup_fixture() {
  set +e
  if [[ "$FIXTURE_CLEANED" == "1" ]]; then
    return
  fi
  if [[ -f "$WORK/Button.stories.tsx.backup" ]]; then
    cp "$WORK/Button.stories.tsx.backup" "$MONOREPO/$STORY"
  fi
  rm -rf "$PROBE_DIR"
  if [[ "$HAD_EXISTING_PROBE" == "1" && -d "$WORK/existing-probe-package" ]]; then
    mv "$WORK/existing-probe-package" "$PROBE_DIR"
  fi
  FIXTURE_CLEANED=1
}

cleanup_all() {
  cleanup_fixture
  rm -rf "$WORK"
}
trap cleanup_all EXIT

if [[ "$PKG" != "ui" && "$PKG" != "marketing-ui" && "$PKG" != *"sb8" && "$PKG" != *"sb9" ]]; then
  echo "This probe is intended for Vite fixture packages; got '$PKG'." >&2
  exit 2
fi
if [[ ! -f "$CLI" ]]; then
  echo "CLI not found at $CLI - run \`yarn build\` in chromatic-cli, or set CHROMATIC_CLI." >&2
  exit 1
fi
if [[ ! -f "$MONOREPO/$STORY" ]]; then
  echo "Story file not found at $MONOREPO/$STORY." >&2
  exit 1
fi
if [[ ! -f "$BUILDER_DIST" ]]; then
  echo "builder-vite dist file not found at $BUILDER_DIST." >&2
  exit 1
fi
if ! grep -q "commonjs-es-import" "$BUILDER_DIST" || grep -q 'moduleName !== "react/jsx-runtime"' "$BUILDER_DIST"; then
  echo "Installed @storybook/builder-vite is not patched." >&2
  echo "Apply the parked builder-vite patch to $BUILDER_DIST, then rerun this probe." >&2
  exit 1
fi

cp "$MONOREPO/$STORY" "$WORK/Button.stories.tsx.backup"
if [[ -e "$PROBE_DIR" ]]; then
  HAD_EXISTING_PROBE=1
  mv "$PROBE_DIR" "$WORK/existing-probe-package"
fi

mkdir -p "$PROBE_DIR"
cat > "$PROBE_DIR/package.json" <<JSON
{
  "name": "$CJS_PKG",
  "version": "1.0.0",
  "main": "index.cjs"
}
JSON
cat > "$PROBE_DIR/index.cjs" <<'JS'
exports.probeLabel = function probeLabel(label) {
  return label;
};
JS

node - "$MONOREPO/$STORY" "$CJS_PKG" <<'NODE'
const fs = require('fs');

const [storyFile, packageName] = process.argv.slice(2);
let source = fs.readFileSync(storyFile, 'utf8');

if (!source.includes(`from '${packageName}'`) && !source.includes(`from "${packageName}"`)) {
  source = source.replace(
    "import { Button } from './Button';",
    `import { probeLabel } from '${packageName}';\nimport { Button } from './Button';`
  );
}

source = source.replace(
  "export const Primary: Story = { args: { label: 'click me', variant: 'primary' } };",
  "export const Primary: Story = { args: { label: probeLabel('click me'), variant: 'primary' } };"
);

fs.writeFileSync(storyFile, source);
NODE

node - "$MONOREPO/packages/$PKG/src" "$CJS_PKG" "$MONOREPO/$STORY" <<'NODE'
const fs = require('fs');
const path = require('path');

const [root, packageName, expectedStory] = process.argv.slice(2);
const matches = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
    } else if (/\.[cm]?[jt]sx?$/.test(entry.name)) {
      const source = fs.readFileSync(full, 'utf8');
      if (source.includes(`from '${packageName}'`) || source.includes(`from "${packageName}"`)) {
        matches.push(full);
      }
    }
  }
}

walk(root);
if (matches.length !== 1 || matches[0] !== expectedStory) {
  console.error(`Expected exactly one source importer (${expectedStory}); found ${matches.length}:`);
  for (const match of matches) console.error(`  ${match}`);
  process.exit(1);
}
NODE

echo "Building patched Vite stats with temporary $CJS_PKG import..."
(cd "$MONOREPO" && yarn nx run "$PKG:build-storybook")

if [[ ! -f "$MONOREPO/$STATS" ]]; then
  echo "Stats file not found after build at $MONOREPO/$STATS." >&2
  exit 1
fi
cp "$MONOREPO/$STATS" "$WORK/probe-preview-stats.json"

echo "probe stats snapshot: $STATS"
echo "  size: $(wc -c < "$WORK/probe-preview-stats.json" | tr -d ' ') bytes  sha: $(shasum -a 256 "$WORK/probe-preview-stats.json" | cut -c1-12)"

node - "$WORK/probe-preview-stats.json" "$CJS_PKG" <<'NODE'
const fs = require('fs');

const [statsFile, packageName] = process.argv.slice(2);
const stats = JSON.parse(fs.readFileSync(statsFile, 'utf8'));
const modules = stats.modules ?? [];
const matches = modules.filter((mod) => {
  const names = [mod.id, mod.name, ...(mod.modules ?? []).map((child) => child.name)];
  return names.some((name) => typeof name === 'string' && name.includes(`/node_modules/${packageName}/`));
});

if (matches.length === 0) {
  console.error(`No stats module found for node_modules/${packageName}.`);
  process.exit(1);
}

console.log(`stats modules for ${packageName}: ${matches.length}`);
for (const mod of matches) {
  console.log(`  ${mod.name}`);
  const reasons = (mod.reasons ?? []).map((reason) => reason.moduleName).filter(Boolean);
  for (const reason of reasons) console.log(`    reason: ${reason}`);
}
NODE

gen() { bash "$HERE/gen.sh" "$PKG" "$1" "$WORK/probe-preview-stats.json"; }
gen "$WORK/base.json"

echo
echo "Attribution for $CJS_PKG before edit:"
node "$HERE/bucket.mjs" "$WORK/base.json" "$CJS_PKG" | sed 's/^/  /'

cp "$PROBE_DIR/index.cjs" "$WORK/index.cjs.backup"
printf '\n// cjs edge probe edit\n' >> "$PROBE_DIR/index.cjs"
gen "$WORK/cur.json"
cp "$WORK/index.cjs.backup" "$PROBE_DIR/index.cjs"

echo
echo "Diff after editing $CJS_PKG:"
node "$HERE/tsdiff.mjs" "$WORK/base.json" "$WORK/cur.json" | sed 's/^/  /'

node - "$WORK/base.json" "$WORK/cur.json" <<'NODE'
const fs = require('fs');

const [baseFile, curFile] = process.argv.slice(2);
const base = JSON.parse(fs.readFileSync(baseFile, 'utf8'));
const cur = JSON.parse(fs.readFileSync(curFile, 'utf8'));

const allStories = new Set([...Object.keys(base.storyFiles), ...Object.keys(cur.storyFiles)]);
const changedStories = [...allStories].filter((story) => base.storyFiles[story] !== cur.storyFiles[story]);
const allStorybookFiles = new Set([
  ...Object.keys(base.storybookFiles ?? {}),
  ...Object.keys(cur.storybookFiles ?? {}),
]);
const changedStorybookFiles = [...allStorybookFiles].filter(
  (key) => (base.storybookFiles ?? {})[key] !== (cur.storybookFiles ?? {})[key]
);

if (changedStorybookFiles.length > 0) {
  console.error(`Expected no storybookFiles changes; got ${changedStorybookFiles.join(', ')}`);
  process.exit(1);
}
if (changedStories.length !== 1 || !changedStories[0].includes('/Button/Button.stories.')) {
  console.error(`Expected only the Button story file to change; got ${changedStories.join(', ') || '(none)'}`);
  process.exit(1);
}

console.log(`ASSERTION OK: ${changedStories[0]} changed, and no storybookFiles entry moved.`);
NODE

cleanup_fixture

echo
echo "Rebuilding patched Vite stats after restoring the fixture..."
(cd "$MONOREPO" && yarn nx run "$PKG:build-storybook")
cp "$MONOREPO/$STATS" "$WORK/patched-preview-stats.json"
gen "$WORK/patched-builder-base.json"

BUCKET_FILE="$WORK/patched-builder-bucket-$PKG.txt"
node "$HERE/bucket.mjs" "$WORK/patched-builder-base.json" > "$BUCKET_FILE"

echo
echo "Patched-builder <storybookGlobals> bucket listing:"
sed 's/^/  /' "$BUCKET_FILE"

if [[ -n "${BUCKET_OUT:-}" ]]; then
  cp "$BUCKET_FILE" "$BUCKET_OUT"
  echo
  echo "Copied bucket listing to $BUCKET_OUT"
fi
