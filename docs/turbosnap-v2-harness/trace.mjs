#!/usr/bin/env node
// trace.mjs <manifest> <story-substring>
// Prints the transitive dependency set of the story whose key contains <story-substring>.
// Splits first-party (non-node_modules) deps from node_modules, so you can see exactly what a story
// depends on and how much of node_modules a given builder pulls into the graph.
import { readFileSync } from 'fs';

const [file, sub] = process.argv.slice(2);
if (!file || !sub) {
  console.error('usage: node trace.mjs <manifest.json> <story-substring>');
  process.exit(2);
}

const m = JSON.parse(readFileSync(file, 'utf8'));
const story = Object.keys(m.storyFiles).find((k) => k.includes(sub));
if (!story) {
  console.error(`no story matched "${sub}". stories: ${Object.keys(m.storyFiles).join(', ')}`);
  process.exit(1);
}

const seen = new Set();
(function walk(f) {
  if (seen.has(f)) return;
  seen.add(f);
  for (const d of m.files[f]?.dependencies ?? []) walk(d);
})(story);

const local = [...seen].filter((f) => !f.includes('node_modules')).sort();
const nm = [...seen].filter((f) => f.includes('node_modules')).sort();

console.log(`story: ${story}`);
console.log(`local transitive deps (${local.length}):`);
for (const f of local) console.log(`   ${f}`);
console.log(`node_modules deps in set (${nm.length}):`);
for (const f of nm) console.log(`   ${f}`);
