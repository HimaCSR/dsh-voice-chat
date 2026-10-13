/**
 * Gate spike for the FireRedVAD engine.
 *
 * Answers, with numbers rather than opinion, the one question the whole plan
 * hinges on: does our JavaScript feature pipeline feed the official ONNX graph
 * well enough that speech and silence are separable?
 *
 * Run:
 *   node probe/verify/firered-spike.mjs <speech.wav>
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const plugin = path.join(here, '..', '..', 'dsh-voice-chat');

const { parseWav } = await import(new URL(`file://${plugin.replaceAll('\\', '/')}/lib/util.js`).href);
const { createFireRedVad, parseCmvnArk, INTERNALS } = await import(
  new URL(`file://${plugin.replaceAll('\\', '/')}/lib/firered-vad.js`).href
);

const VAD_DIR = 'C:/Users/74260/.dsh/voice-chat/vad/firered';
const speechPath = process.argv[2];

// ── 1. CMVN fixture ─────────────────────────────────────────────────────────
const cmvn = parseCmvnArk(fs.readFileSync(`${VAD_DIR}/cmvn.ark`));
const expectMeans = [10.42295, 10.8621, 11.76454, 12.49016, 13.25983];
const expectIstd = [0.2495, 0.23563, 0.23145, 0.23322, 0.23183];
const fmt = (values) => Array.from(values).map((value) => value.toFixed(5)).join(' ');
console.log('CMVN count        :', cmvn.count);
console.log('CMVN means[0..4]  :', fmt(cmvn.means.subarray(0, 5)), '  expect', expectMeans.join(' '));
console.log('CMVN istd[0..4]   :', fmt(cmvn.istd.subarray(0, 5)), '  expect', expectIstd.join(' '));
const cmvnOk =
  expectMeans.every((value, index) => Math.abs(value - cmvn.means[index]) < 1e-3) &&
  expectIstd.every((value, index) => Math.abs(value - cmvn.istd[index]) < 1e-3);
console.log('CMVN fixture      :', cmvnOk ? 'PASS' : 'FAIL');
console.log('');

// ── 2. fbank sanity ─────────────────────────────────────────────────────────
const fbank = INTERNALS.createFbank({});
const silence = new Float32Array(16000);
const silenceFrames = fbank.extract(silence);
// snip_edges: 1 + floor((16000 - 400) / 160) = 98.
console.log('fbank frames (1 s silence):', silenceFrames.count, 'expected 98');
console.log('fbank value (silence)     :', silenceFrames.frames[0].toFixed(4), '≈ ln(1.19e-7) =', Math.log(INTERNALS.FLT_EPSILON).toFixed(4));
console.log('');

// ── 3. the real question ────────────────────────────────────────────────────
const resolved = {
  vad: { backend: 'firered', model: `${VAD_DIR}/fireredvad_stream_vad_with_cache.onnx`, cmvn: `${VAD_DIR}/cmvn.ark` },
};

async function runVariant(label, overrides) {
  const config = {
    stt: {
      threads: 1,
      vadThreshold: 0.5,
      minSpeechSeconds: 0.25,
      minSilenceSeconds: 0.35,
      maxSpeechSeconds: 30,
      ...overrides,
    },
  };
  const engine = await createFireRedVad(config, resolved);

  const speech = parseWav(fs.readFileSync(speechPath)).samples;
  const speechProbs = await engine.frameProbabilities(speech);
  const noisy = new Float32Array(16000 * 2);
  for (let i = 0; i < noisy.length; i++) noisy[i] = (Math.random() * 2 - 1) * 0.05;
  const noiseProbs = await engine.frameProbabilities(noisy);
  const silenceProbs = await engine.frameProbabilities(new Float32Array(16000 * 2));

  const stats = (values) => {
    if (values.length === 0) return { mean: 0, max: 0, min: 0, frames: 0 };
    let sum = 0;
    let max = -Infinity;
    let min = Infinity;
    for (const value of values) {
      sum += value;
      if (value > max) max = value;
      if (value < min) min = value;
    }
    return { mean: sum / values.length, max, min, frames: values.length };
  };

  const speechStats = stats(speechProbs);
  const noiseStats = stats(noiseProbs);
  const silenceStats = stats(silenceProbs);
  const segments = await engine.segmentSamples(speech);
  const noiseSegments = await engine.segmentSamples(noisy);
  const silenceSegments = await engine.segmentSamples(new Float32Array(16000 * 2));
  const speechSeconds = parseWav(fs.readFileSync(speechPath)).samples.length / 16000;
  const covered = segments.reduce((total, segment) => total + (segment.endSeconds - segment.startSeconds), 0);
  const coverage = covered / speechSeconds;

  console.log(`── ${label} ──`);
  console.log(`  speech  : frames=${speechStats.frames} mean=${speechStats.mean.toFixed(3)} max=${speechStats.max.toFixed(3)} min=${speechStats.min.toFixed(3)}`);
  console.log(`  noise   : mean=${noiseStats.mean.toFixed(3)} max=${noiseStats.max.toFixed(3)} segments=${noiseSegments.length}`);
  console.log(`  silence : mean=${silenceStats.mean.toFixed(3)} max=${silenceStats.max.toFixed(3)} segments=${silenceSegments.length}`);
  console.log(`  segments: ${segments.length} over ${speechSeconds.toFixed(2)} s -> ${segments.map((s) => `${s.startSeconds.toFixed(2)}-${s.endSeconds.toFixed(2)}`).join(', ')}`);
  console.log(`  speech frames>0.5 : ${(speechProbs.filter((p) => p > 0.5).length / Math.max(1, speechProbs.length) * 100).toFixed(1)}%   coverage=${(coverage * 100).toFixed(1)}%`);
  // The gate: speech is detected and covered, while noise and silence produce
  // nothing to recognize — which is what stops phantom messages.
  const verdict =
    speechStats.mean > 0.4 &&
    speechStats.max > 0.9 &&
    coverage > 0.6 &&
    segments.length >= 1 &&
    noiseSegments.length === 0 &&
    silenceSegments.length === 0;
  console.log(`  VERDICT : ${verdict ? 'PASS' : 'FAIL'}`);
  console.log('');
  engine.dispose();
  return verdict;
}

if (!speechPath || !fs.existsSync(speechPath)) {
  console.log('no speech wav supplied; skipping model run');
  process.exit(cmvnOk ? 0 : 1);
}

// Baseline first, then the two documented divergences if it fails.
const results = [];
results.push(['baseline (kaldi epsilon, DC removal on)', {}, await runVariant('baseline', {})]);
if (!results[0][2]) {
  results.push(['no DC removal', { fbankRemoveDcOffset: false }, await runVariant('no-dc-removal', { fbankRemoveDcOffset: false })]);
  results.push(['fire-red epsilon 1e-20', { fbankEpsilonValue: 1e-20 }, await runVariant('epsilon-1e-20', { fbankEpsilonValue: 1e-20 })]);
}

console.log('SUMMARY');
for (const [label, , ok] of results) console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
