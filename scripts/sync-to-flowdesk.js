#!/usr/bin/env node
// sync-to-flowdesk.js — push this module into a FlowDesk checkout.
//
//   node scripts/sync-to-flowdesk.js ../../flowdesk-backend
//   node scripts/sync-to-flowdesk.js ../../flowdesk-backend --check
//
// The module is integrated by COPYING (see CLAUDE.md), which means two copies
// can drift. This script makes re-syncing one command, and --check reports
// differences without writing anything, so a stale graft is visible.
//
// It only touches files this module owns:
//   src/**            → <flowdesk>/src/re/**
//   frontend/realestate.{html,css,js} → <flowdesk>/frontend/
//
// It never touches app.js, the Paystack controller, package.json or
// index.html — those integration edits are hand-made and must not be
// clobbered. See CLAUDE.md for that (short) list.

const fs = require('fs');
const path = require('path');

// The target is the first non-flag argument rather than argv[2], because
// `npm run sync:check -- <path>` appends the path after the --check flag.
const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const target = args.find((arg) => !arg.startsWith('--'));

if (!target) {
  console.error('Usage: node scripts/sync-to-flowdesk.js <path-to-flowdesk-backend> [--check]');
  process.exit(1);
}

const moduleRoot = path.resolve(__dirname, '..');
const flowdeskRoot = path.resolve(process.cwd(), target);

if (!fs.existsSync(path.join(flowdeskRoot, 'src', 'app.js'))) {
  console.error(`Not a FlowDesk checkout (no src/app.js): ${flowdeskRoot}`);
  process.exit(1);
}

const changed = [];
const unchanged = [];

function copyFile(from, to) {
  const source = fs.readFileSync(from);
  const exists = fs.existsSync(to);
  const identical = exists && Buffer.compare(source, fs.readFileSync(to)) === 0;

  if (identical) {
    unchanged.push(path.relative(flowdeskRoot, to));
    return;
  }

  changed.push(`${exists ? 'update' : 'create'}  ${path.relative(flowdeskRoot, to)}`);
  if (checkOnly) return;

  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.writeFileSync(to, source);
}

function copyTree(from, to) {
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const destination = path.join(to, entry.name);
    if (entry.isDirectory()) copyTree(source, destination);
    else copyFile(source, destination);
  }
}

copyTree(path.join(moduleRoot, 'src'), path.join(flowdeskRoot, 'src', 're'));

for (const file of ['realestate.html', 'realestate.css', 'realestate.js']) {
  copyFile(
    path.join(moduleRoot, 'frontend', file),
    path.join(flowdeskRoot, 'frontend', file)
  );
}

console.log(`\n${checkOnly ? 'Checking' : 'Syncing'} → ${flowdeskRoot}`);
console.log(`${unchanged.length} file(s) already in sync`);

if (!changed.length) {
  console.log('Nothing to do — the graft matches this module.\n');
  process.exit(0);
}

console.log(`\n${changed.length} file(s) ${checkOnly ? 'differ' : 'written'}:`);
for (const line of changed) console.log(`  ${line}`);

if (checkOnly) {
  console.log('\nRun without --check to apply.\n');
  process.exit(1); // non-zero so CI can fail on a stale graft
}

console.log('\nDone. Integration edits (app.js, paystack.controller.js, index.html,');
console.log('package.json) are hand-made and were left untouched — see CLAUDE.md.\n');
