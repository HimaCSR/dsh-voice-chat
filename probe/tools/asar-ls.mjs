// List entries inside a directory of an asar archive (or dump the head of a file).
// Usage: <exe> asar-ls.mjs <asarPath> <innerPath|-> [maxDepth]
import fs from 'node:fs';
import path from 'node:path';

const asar = process.argv[2];
const inner = process.argv[3] && process.argv[3] !== '-' ? process.argv[3] : '';
const maxDepth = process.argv[4] ? Number(process.argv[4]) : 2;

function walk(dir, depth, prefix) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    console.log(prefix + '<ERR ' + e.message + '>');
    return;
  }
  entries.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1));
  for (const e of entries) {
    const full = path.join(dir, e.name);
    let size = '';
    if (!e.isDirectory()) {
      try { size = ' ' + fs.statSync(full).size; } catch { size = ''; }
    }
    console.log(prefix + (e.isDirectory() ? '[D] ' : '    ') + e.name + size);
    if (e.isDirectory() && depth < maxDepth) walk(full, depth + 1, prefix + '  ');
  }
}

const target = inner ? path.join(asar, inner) : asar;
const st = fs.statSync(target);
if (st.isDirectory()) walk(target, 1, '');
else {
  const buf = fs.readFileSync(target);
  const probe = buf.slice(0, 600).toString('utf8');
  console.log('FILE bytes=' + buf.length);
  console.log(probe.replace(/[^\x09\x0a\x0d\x20-\x7e\u3000-\u9fff\uff00-\uffef]/g, '.'));
}
