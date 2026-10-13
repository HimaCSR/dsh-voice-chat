/** Numeric dissection of one fbank frame. Run: node probe/tools/fbank-probe.mjs <speech.wav> */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const plugin = path.join(here, '..', '..', 'dsh-voice-chat');
const url = (relative) => new URL(`file://${path.join(plugin, relative).replaceAll('\\', '/')}`).href;
const { parseWav } = await import(url('lib/util.js'));
const { INTERNALS, parseCmvnArk } = await import(url('lib/firered-vad.js'));

const parsed = parseWav(fs.readFileSync(process.argv[2]));
const samples = parsed.samples;
const cmvn = parseCmvnArk(fs.readFileSync('C:/Users/74260/.dsh/voice-chat/vad/firered/cmvn.ark'));

let sum = 0;
let peak = 0;
for (const value of samples) {
  sum += value * value;
  if (Math.abs(value) > peak) peak = Math.abs(value);
}
console.log(`wav: rate=${parsed.sampleRate} channels=${parsed.channels} samples=${samples.length} duration=${(samples.length / 16000).toFixed(2)}s`);
console.log(`wav: rms=${Math.sqrt(sum / samples.length).toFixed(5)} peak=${peak.toFixed(5)}`);

const fbank = INTERNALS.createFbank({});
const { frames, count } = fbank.extract(samples);
console.log(`\nfbank frames=${count}`);
console.log('our log-mel dims 0..5 of frame 300:', Array.from(frames.subarray(300 * 80, 300 * 80 + 6)).map((v) => v.toFixed(3)).join(' '));
console.log('cmvn mean    dims 0..5            :', Array.from(cmvn.means.subarray(0, 6)).map((v) => v.toFixed(3)).join(' '));

// Reproduce one frame by hand, printing every intermediate stage.
const frame = 300;
const offset = frame * 160;
const raw = new Float64Array(400);
for (let i = 0; i < 400; i++) raw[i] = samples[offset + i];
let frameSum = 0;
for (let i = 0; i < 400; i++) frameSum += raw[i];
const mean = frameSum / 400;
const dc = Float64Array.from(raw, (value) => value - mean);
const pre = Float64Array.from(dc);
for (let i = 399; i > 0; i--) pre[i] -= 0.97 * pre[i - 1];
pre[0] -= 0.97 * pre[0];
let energyRaw = 0;
let energyPre = 0;
for (let i = 0; i < 400; i++) {
  energyRaw += raw[i] * raw[i];
  energyPre += pre[i] * pre[i];
}
console.log(`\nframe ${frame}: sum=${frameSum.toFixed(6)} mean=${mean.toExponential(3)}`);
console.log(`  sum of squares  raw=${energyRaw.toExponential(4)}  after dc+preemph=${energyPre.toExponential(4)}`);

// Same frame, scaled to the int16 amplitude range the reference uses.
const scaled = Float32Array.from(samples, (value) => value * 32768);
const scaledFbank = INTERNALS.createFbank({}).extract(scaled);
console.log('\nafter scaling samples by 32768:');
console.log('  log-mel dims 0..5            :', Array.from(scaledFbank.frames.subarray(300 * 80, 300 * 80 + 6)).map((v) => v.toFixed(3)).join(' '));
const sums = new Float64Array(80);
for (let f = 0; f < scaledFbank.count; f++) for (let d = 0; d < 80; d++) sums[d] += scaledFbank.frames[f * 80 + d];
let worst = 0;
for (let d = 0; d < 80; d++) worst = Math.max(worst, Math.abs(sums[d] / scaledFbank.count - cmvn.means[d]));
console.log(`  worst |mean - cmvnMean| = ${worst.toFixed(3)}`);
console.log(`  implied constant offset  = ${(Math.log(32768 * 32768)).toFixed(3)} (ln(32768^2))`);
