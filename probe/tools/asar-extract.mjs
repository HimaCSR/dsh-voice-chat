// Extract a directory from an asar archive to a real directory on disk.
// Usage: <exe> asar-extract.mjs <asarPath> <innerPath> <destDir>
import fs from 'node:fs';
import path from 'node:path';

const asar = process.argv[2];
const inner = process.argv[3] && process.argv[3] !== '-' ? process.argv[3] : '';
const dest = process.argv[4];
if (!dest) throw new Error('dest required');

const srcRoot = inner ? path.join(asar, inner) : asar;
let files = 0, bytes = 0;

function walk(srcDir, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  for (const e of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const s = path.join(srcDir, e.name);
    const d = path.join(destDir, e.name);
    if (e.isDirectory()) { walk(s, d); continue; }
    let buf;
    try { buf = fs.readFileSync(s); } catch (err) { console.log('SKIP ' + s + ': ' + err.message); continue; }
    fs.writeFileSync(d, buf);
    files++; bytes += buf.length;
  }
}
walk(srcRoot, dest);
console.log('extracted files=' + files + ' bytes=' + bytes + ' -> ' + dest);
