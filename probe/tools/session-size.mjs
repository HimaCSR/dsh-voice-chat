/**
 * Measure this session's transcript and show where the context weight is.
 * Run: node probe/tools/session-size.mjs <path-to-session.v4.jsonl.zstd>
 */
import fs from 'node:fs';
import zlib from 'node:zlib';

const file = process.argv[2];
const compressed = fs.readFileSync(file);
let text;
try {
  text = zlib.zstdDecompressSync(compressed).toString('utf8');
} catch (error) {
  console.log('zstd unavailable or failed:', error.message);
  process.exit(1);
}

const lines = text.split('\n').filter((line) => line.trim().length > 0);
const records = [];
for (const line of lines) {
  try {
    records.push(JSON.parse(line));
  } catch {
    records.push({ type: 'unparsed', bytes: Buffer.byteLength(line) });
  }
}

const byType = new Map();
let total = 0;
for (let i = 0; i < records.length; i++) {
  const size = Buffer.byteLength(lines[i]);
  total += size;
  const type = records[i].type ?? 'unknown';
  const entry = byType.get(type) ?? { count: 0, bytes: 0 };
  entry.count += 1;
  entry.bytes += size;
  byType.set(type, entry);
}

const mb = (bytes) => `${(bytes / 1048576).toFixed(2)} MB`;
const kb = (bytes) => `${(bytes / 1024).toFixed(0)} KB`;

console.log(`session       : ${file.split(/[\\/]/).slice(-2)[0]}`);
console.log(`compressed    : ${mb(compressed.length)}`);
console.log(`uncompressed  : ${mb(total)}   (${records.length} records)`);
console.log('');
console.log('by record type (bytes / share):');
for (const [type, entry] of [...byType.entries()].sort((a, b) => b[1].bytes - a[1].bytes)) {
  console.log(`  ${type.padEnd(22)} ${String(entry.count).padStart(5)}x  ${kb(entry.bytes).padStart(9)}  ${((entry.bytes / total) * 100).toFixed(1)}%`);
}

console.log('');
console.log('largest single records:');
const sized = lines.map((line, index) => ({ index, bytes: Buffer.byteLength(line), record: records[index] }));
sized.sort((a, b) => b.bytes - a.bytes);
for (const entry of sized.slice(0, 10)) {
  const record = entry.record;
  const label = record.type ?? '?';
  const hint =
    record.toolName ??
    record.name ??
    record.tool?.name ??
    (record.role ? `role=${record.role}` : '') ??
    '';
  console.log(`  #${String(entry.index).padStart(4)}  ${kb(entry.bytes).padStart(9)}  ${label}${hint ? ` (${hint})` : ''}`);
}

// Rough token estimate: mixed Chinese/code averages below 4 chars per token.
console.log('');
console.log(`rough token estimate: ${(total / 3.2 / 1000).toFixed(0)}k tokens if replayed in full`);
