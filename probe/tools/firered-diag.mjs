/**
 * Where is the FireRedVAD feature pipeline wrong?
 *
 * Three independent probes, cheapest first:
 *   1. my FFT against a naive DFT (arithmetic correctness)
 *   2. my pre-CMVN fbank means against the shipped CMVN means — the training
 *      set's own statistics are the best available ground truth for the front
 *      end, because a calibrated front end must reproduce them
 *   3. the non-streaming model, which has no caches, to separate "features are
 *      wrong" from "my streaming/cache handling is wrong"
 *
 * Run: node probe/tools/firered-diag.mjs <speech.wav>
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const plugin = path.join(here, '..', '..', 'dsh-voice-chat');
const url = (relative) => new URL(`file://${path.join(plugin, relative).replaceAll('\\', '/')}`).href;

const { parseWav } = await import(url('lib/util.js'));
const { createFireRedVad, parseCmvnArk, INTERNALS } = await import(url('lib/firered-vad.js'));
const { loadModule } = await import(url('lib/sherpa.js'));

const VAD_DIR = 'C:/Users/74260/.dsh/voice-chat/vad/firered';
const wav = parseWav(fs.readFileSync(process.argv[2])).samples;
const cmvn = parseCmvnArk(fs.readFileSync(`${VAD_DIR}/cmvn.ark`));

// ── probe 1: FFT ────────────────────────────────────────────────────────────
{
  const n = 512;
  const fft = INTERNALS.createFft(n);
  const signal = new Float64Array(n);
  for (let i = 0; i < n; i++) signal[i] = Math.sin(i * 0.37) + 0.4 * Math.cos(i * 0.11) + 0.05 * (i % 7);
  const re = Float64Array.from(signal);
  const im = new Float64Array(n);
  fft(re, im);
  let worst = 0;
  for (let k = 0; k < n; k++) {
    let sr = 0;
    let si = 0;
    for (let t = 0; t < n; t++) {
      const angle = (-2 * Math.PI * k * t) / n;
      sr += signal[t] * Math.cos(angle);
      si += signal[t] * Math.sin(angle);
    }
    const magnitude = Math.hypot(sr, si);
    const error = Math.abs(Math.hypot(re[k], im[k]) - magnitude) / Math.max(1, magnitude);
    if (error > worst) worst = error;
  }
  console.log('probe 1  FFT vs naive DFT   : max relative error', worst.toExponential(3), worst < 1e-9 ? 'PASS' : 'FAIL');
}

// ── probe 2: is the fbank calibrated to the model's own statistics? ─────────
{
  const fbank = INTERNALS.createFbank({});
  const { frames, count } = fbank.extract(wav);
  const sums = new Float64Array(80);
  for (let f = 0; f < count; f++) for (let d = 0; d < 80; d++) sums[d] += frames[f * 80 + d];
  const ours = Array.from(sums, (value) => value / count);
  // Skip the highest bins: they are near-silent in speech and dominated by the
  // log floor, so a small absolute error there swings the ratio.
  let worst = 0;
  let worstDim = 0;
  const rows = [];
  for (let d = 0; d < 80; d++) {
    const delta = ours[d] - cmvn.means[d];
    if (Math.abs(delta) > Math.abs(worst)) {
      worst = delta;
      worstDim = d;
    }
    if (d % 8 === 0 || d < 6) rows.push(`    d${String(d).padStart(2)}: ours=${ours[d].toFixed(3)} cmvnMean=${cmvn.means[d].toFixed(3)} delta=${delta.toFixed(3)}`);
  }
  console.log('probe 2  fbank vs CMVN means:');
  for (const row of rows) console.log(row);
  console.log(`    worst |delta| = ${Math.abs(worst).toFixed(3)} at dim ${worstDim}  ->`, Math.abs(worst) < 2 ? 'CALIBRATED' : 'MISCALIBRATED');
}

// ── probe 3: the non-streaming graph (no caches at all) ─────────────────────
{
  const ort = loadModule('onnxruntime-node');
  const fbank = INTERNALS.createFbank({});
  const { frames, count } = fbank.extract(wav);
  for (let f = 0; f < count; f++) {
    for (let d = 0; d < 80; d++) frames[f * 80 + d] = (frames[f * 80 + d] - cmvn.means[d]) * cmvn.istd[d];
  }
  const session = await ort.InferenceSession.create(`${VAD_DIR}/fireredvad_vad.onnx`, {
    executionProviders: ['cpu'],
    intraOpNumThreads: 1,
    graphOptimizationLevel: 'all',
  });
  console.log('probe 3  non-streaming model inputs/outputs:', session.inputNames.join(','), '->', session.outputNames.join(','));
  const out = await session.run({
    feat: new ort.Tensor('float32', frames, [1, count, 80]),
  });
  const probs = out[session.outputNames[0]].data;
  let sum = 0;
  let max = 0;
  let above = 0;
  for (const value of probs) {
    sum += value;
    if (value > max) max = value;
    if (value > 0.5) above++;
  }
  console.log(`    frames=${probs.length} mean=${(sum / probs.length).toFixed(3)} max=${max.toFixed(3)} frames>0.5=${above} (${((above / probs.length) * 100).toFixed(1)}%)`);
  console.log('    ->', max > 0.8 && above > probs.length * 0.2 ? 'FEATURES ARE GOOD (streaming/cache is the problem)' : 'FEATURES ARE WRONG');
  await session.release?.();
}

// ── reference: what the streaming engine reports ────────────────────────────
{
  const engine = await createFireRedVad(
    { stt: { threads: 1, vadThreshold: 0.5, minSpeechSeconds: 0.25, minSilenceSeconds: 0.35, maxSpeechSeconds: 30 } },
    { vad: { backend: 'firered', model: `${VAD_DIR}/fireredvad_stream_vad_with_cache.onnx`, cmvn: `${VAD_DIR}/cmvn.ark` } },
  );
  const probs = await engine.frameProbabilities(wav);
  let sum = 0;
  let max = 0;
  for (const value of probs) {
    sum += value;
    if (value > max) max = value;
  }
  console.log(`streaming model           : mean=${(sum / probs.length).toFixed(3)} max=${max.toFixed(3)}`);
  engine.dispose();
}
