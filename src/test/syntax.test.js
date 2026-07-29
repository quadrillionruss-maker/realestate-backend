// syntax.test.js — every JavaScript file in the project must parse.
//
//     npm run test:syntax
//
// This exists because of a real escape: smoke.js shipped with an unescaped
// apostrophe inside a single-quoted string. Nothing caught it, because
// smoke.js needs a live server and a real database, so it is never executed
// by the offline suite — a file that is never run is also never parsed.
//
// `node --check` parses without executing, so it costs milliseconds and needs
// no environment. It catches only syntax, not behaviour, which is exactly the
// class of error that otherwise waits until someone runs the script by hand.
//
// frontend/ IS included. It is plain browser script — no modules, no JSX, no
// build step — so `node --check` parses it exactly as a browser would, and
// those files have no test of their own. A typo there is a blank page rather
// than a stack trace, which makes it the code most worth parsing cheaply.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '../..');
const SKIP = new Set(['node_modules', '.git']);

function collect(dir) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...collect(full));
    else if (entry.name.endsWith('.js')) found.push(full);
  }
  return found;
}

const files = collect(ROOT).sort();
const failures = [];

for (const file of files) {
  const relative = path.relative(ROOT, file).replace(/\\/g, '/');
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    console.log(`  ok   ${relative}`);
  } catch (err) {
    const detail = (err.stderr?.toString() || err.message).split('\n')
      .find((line) => /Error/.test(line)) || 'parse failed';
    failures.push({ relative, detail });
    console.log(`  FAIL ${relative}\n       ${detail.trim()}`);
  }
}

console.log(`\n${files.length - failures.length} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
