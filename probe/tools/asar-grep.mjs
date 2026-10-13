// Find regular-expression matches inside the files of an asar archive.
// Unlike a line-oriented search this reports every match in a file, because the
// built browser bundles are minified onto a single enormous line.
// Usage: <exe> asar-grep.mjs <asarPath> <innerPath|-> <regex> [maxMatches] [extensions]
import fs from 'node:fs';
import path from 'node:path';

const [asar, innerArg = '', pattern] = process.argv.slice(2);
if (!asar || !pattern) {
  throw new Error('usage: asar-grep.mjs <asarPath> <innerPath|-> <regex> [maxMatches] [ext]');
}
const max = process.argv[5] ? Number(process.argv[5]) : 120;
const ext = process.argv[6] ?? 'css|js|mjs|cjs|json|html';
const re = new RegExp(pattern, 'g');
const root = innerArg && innerArg !== '-' ? path.join(asar, innerArg) : asar;

const seen = new Set();
let matches = 0;

function walk(dir) {
  if (matches >= max) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    console.log('<ERR ' + dir + ': ' + error.message + '>');
    return;
  }
  for (const entry of entries) {
    if (matches >= max) return;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
      continue;
    }
    if (!new RegExp('\\.(' + ext + ')$').test(entry.name)) continue;
    let text;
    try {
      text = fs.readFileSync(full, 'utf8');
    } catch {
      continue;
    }
    const where = path.relative(asar, full);
    for (const match of text.matchAll(re)) {
      const value = match[0].replace(/\s+/g, ' ').trim().slice(0, 220);
      const key = value;
      if (seen.has(key)) continue;
      seen.add(key);
      matches++;
      console.log(where + ' :: ' + value);
      if (matches >= max) return;
    }
  }
}

walk(root);
console.log('MATCHES ' + matches);
