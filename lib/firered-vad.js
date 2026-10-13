/**
 * FireRedVAD, run directly from its official ONNX graph.
 *
 * sherpa-onnx cannot load this model — its C API only wires Silero and
 * TEN-VAD, and the FireRedVAD support PR was never merged — so this module
 * reproduces the surrounding pipeline in JavaScript instead:
 *
 *   waveform → Kaldi-compatible 80-dim log-mel fbank → CMVN
 *            → FSMN streaming graph (cached, 10 ms frames)
 *            → per-frame speech probability → endpoint state machine
 *
 * The graph is self-describing and needs no LFR or context stacking: it
 * consumes one feature frame per output frame. That is what makes a faithful
 * port tractable rather than a research project.
 *
 * Every numeric convention below is taken from the upstream sources rather
 * than guessed: `fireredvad/core/audio_feat.py` (fbank + CMVN),
 * `fireredvad/core/stream_vad_postprocessor.py` (endpointing) and the exported
 * ONNX signatures.
 */
import fs from 'node:fs';
import { loadModule } from './sherpa.js';
import { fail, log } from './util.js';

const SAMPLE_RATE = 16000;
const FRAME_LENGTH = 400; // 25 ms
const FRAME_SHIFT = 160; // 10 ms
const FFT_SIZE = 512;
const MEL_BINS = 80;
const MEL_LOW_HZ = 20;
const MEL_HIGH_HZ = 8000;
const PREEMPHASIS = 0.97;
/** Kaldi's fbank floors the mel energy at FLT_EPSILON before the log. */
const FLT_EPSILON = 1.1920929e-7;
/**
 * Kaldi's feature front end is calibrated for samples in the int16 amplitude
 * range, not for floats normalised to [-1, 1]: kaldi's own wave reader hands it
 * raw PCM values, and its energy floor only makes sense in that domain. Feeding
 * normalised floats shifts every log-mel value down by `ln(32768^2) ≈ 20.8`
 * and the model then reports "not speech" for everything. This was measured,
 * not assumed — with normalised floats the non-streaming graph peaked at 0.004
 * on clear speech.
 */
const SAMPLE_SCALE = 32768;
const FRAMES_PER_SECOND = 100;
/** Frames per ONNX call; bounds peak memory on a long recording. */
const MAX_CHUNK_FRAMES = 3000;

const melScale = (hertz) => 1127 * Math.log(1 + hertz / 700);

/**
 * Parse a Kaldi binary CMVN matrix (`cmvn.ark`).
 *
 * The shipped file is 1311 bytes: a 15-byte ark header (`\0B` marker, `DM `
 * for a double matrix, then the little-endian row and column counts) followed
 * by 2 x 81 little-endian float64 values. Row 0 holds the per-dimension sums
 * plus the frame count, row 1 the sums of squares.
 *
 * @param bytes - the whole file.
 * @returns per-dimension means and inverse standard deviations.
 */
export function parseCmvnArk(bytes) {
  const HEADER = 15;
  const ROWS = 2;
  const COLS = MEL_BINS + 1;
  const expected = HEADER + ROWS * COLS * 8;
  if (bytes.length < expected) {
    throw fail('bad-cmvn', `cmvn.ark is ${bytes.length} bytes, expected at least ${expected}`);
  }
  const values = new Float64Array(ROWS * COLS);
  for (let i = 0; i < values.length; i++) values[i] = bytes.readDoubleLE(HEADER + i * 8);
  const count = values[MEL_BINS];
  if (!(count >= 1)) throw fail('bad-cmvn', 'cmvn.ark frame count is not positive');
  const means = new Float64Array(MEL_BINS);
  const istd = new Float64Array(MEL_BINS);
  for (let d = 0; d < MEL_BINS; d++) {
    const mean = values[d] / count;
    let variance = values[COLS + d] / count - mean * mean;
    if (variance < 1e-20) variance = 1e-20;
    means[d] = mean;
    istd[d] = 1 / Math.sqrt(variance);
  }
  return { means, istd, count };
}

/** Iterative radix-2 complex FFT with precomputed twiddles and bit reversal. */
function createFft(size) {
  const levels = Math.round(Math.log2(size));
  const half = size >> 1;
  const cos = new Float64Array(half);
  const sin = new Float64Array(half);
  for (let i = 0; i < half; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / size);
    sin[i] = Math.sin((2 * Math.PI * i) / size);
  }
  const reversed = new Uint16Array(size);
  for (let i = 0; i < size; i++) {
    let value = i;
    let result = 0;
    for (let bit = 0; bit < levels; bit++) {
      result = (result << 1) | (value & 1);
      value >>= 1;
    }
    reversed[i] = result;
  }
  return function transform(real, imag) {
    for (let i = 0; i < size; i++) {
      const j = reversed[i];
      if (j > i) {
        let swap = real[i];
        real[i] = real[j];
        real[j] = swap;
        swap = imag[i];
        imag[i] = imag[j];
        imag[j] = swap;
      }
    }
    for (let span = 2; span <= size; span <<= 1) {
      const spanHalf = span >> 1;
      const step = size / span;
      for (let start = 0; start < size; start += span) {
        for (let j = start, k = 0; j < start + spanHalf; j++, k += step) {
          const other = j + spanHalf;
          const tre = real[other] * cos[k] + imag[other] * sin[k];
          const tim = -real[other] * sin[k] + imag[other] * cos[k];
          real[other] = real[j] - tre;
          imag[other] = imag[j] - tim;
          real[j] += tre;
          imag[j] += tim;
        }
      }
    }
  };
}

/**
 * Build the sparse triangular mel filterbank.
 *
 * Reproduces Kaldi's `MelBanks`: filters are equally spaced on the mel scale
 * between `MEL_LOW_HZ` and `MEL_HIGH_HZ` with `MEL_BINS + 1` intervals, bin
 * centres are the FFT bin frequencies, and a weight is applied only where the
 * bin's mel falls strictly inside the triangle.
 */
export function createMelFilters() {
  const numFftBins = FFT_SIZE / 2; // Kaldi reads bins 0..255
  const fftBinWidth = SAMPLE_RATE / FFT_SIZE;
  const melLow = melScale(MEL_LOW_HZ);
  const melHigh = melScale(MEL_HIGH_HZ);
  const delta = (melHigh - melLow) / (MEL_BINS + 1);
  const filters = [];
  for (let bin = 0; bin < MEL_BINS; bin++) {
    const left = melLow + bin * delta;
    const center = melLow + (bin + 1) * delta;
    const right = melLow + (bin + 2) * delta;
    const indices = [];
    const weights = [];
    for (let i = 0; i < numFftBins; i++) {
      const mel = melScale(fftBinWidth * i);
      if (mel > left && mel < right) {
        indices.push(i);
        weights.push(mel <= center ? (mel - left) / (center - left) : (right - mel) / (right - center));
      }
    }
    filters.push({ indices: Uint16Array.from(indices), weights: Float32Array.from(weights) });
  }
  return filters;
}

/**
 * Kaldi-compatible log-mel filterbank extractor.
 *
 * `snip_edges` is on (upstream sets it explicitly), so only whole frames count
 * and the frame count is `1 + floor((N - 400) / 160)`.
 */
export function createFbank(options = {}) {
  const epsilon = options.epsilon ?? FLT_EPSILON;
  const useDcRemoval = options.removeDcOffset !== false;
  const preemphasis = options.preemphasis ?? PREEMPHASIS;
  const sampleScale = options.sampleScale ?? SAMPLE_SCALE;
  const fft = createFft(FFT_SIZE);
  const filters = createMelFilters();
  const window = new Float64Array(FRAME_LENGTH);
  for (let i = 0; i < FRAME_LENGTH; i++) {
    window[i] = Math.pow(0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FRAME_LENGTH - 1)), 0.85);
  }
  const real = new Float64Array(FFT_SIZE);
  const imag = new Float64Array(FFT_SIZE);
  const power = new Float64Array(FFT_SIZE / 2);

  /** Number of complete frames in a recording. */
  const frameCount = (length) => (length >= FRAME_LENGTH ? 1 + Math.floor((length - FRAME_LENGTH) / FRAME_SHIFT) : 0);

  /**
   * Extract features for an entire recording.
   * @param samples - 16 kHz mono Float32 samples.
   * @returns `{ frames, count }` where `frames` is `count * 80` row-major log-mel values.
   */
  function extract(samples) {
    const count = frameCount(samples.length);
    const frames = new Float32Array(count * MEL_BINS);
    const scratch = new Float64Array(FRAME_LENGTH);
    for (let frame = 0; frame < count; frame++) {
      const offset = frame * FRAME_SHIFT;
      for (let i = 0; i < FRAME_LENGTH; i++) scratch[i] = samples[offset + i] * sampleScale;
      if (useDcRemoval) {
        let sum = 0;
        for (let i = 0; i < FRAME_LENGTH; i++) sum += scratch[i];
        const mean = sum / FRAME_LENGTH;
        for (let i = 0; i < FRAME_LENGTH; i++) scratch[i] -= mean;
      }
      if (preemphasis !== 0) {
        // Applied within this frame only, matching the Python reference path
        // (`kaldi_native_fbank`), not the stateful C++ sliding-window variant.
        for (let i = FRAME_LENGTH - 1; i > 0; i--) scratch[i] -= preemphasis * scratch[i - 1];
        scratch[0] -= preemphasis * scratch[0];
      }
      for (let i = 0; i < FFT_SIZE; i++) {
        real[i] = i < FRAME_LENGTH ? scratch[i] * window[i] : 0;
        imag[i] = 0;
      }
      fft(real, imag);
      for (let i = 0; i < power.length; i++) power[i] = real[i] * real[i] + imag[i] * imag[i];
      const base = frame * MEL_BINS;
      for (let bin = 0; bin < MEL_BINS; bin++) {
        const filter = filters[bin];
        let energy = 0;
        for (let k = 0; k < filter.indices.length; k++) {
          energy += power[filter.indices[k]] * filter.weights[k];
        }
        frames[base + bin] = Math.log(energy > 0 ? Math.max(energy, epsilon) : epsilon);
      }
    }
    return { frames, count };
  }

  return { extract, frameCount };
}

/**
 * The upstream streaming endpoint state machine.
 *
 * Reproduced from `StreamVadPostprocessor` so that the segments this plugin
 * reports match what FireRedVAD itself would report, including the backwards
 * start padding and the 20 s force-split.
 */
export class StreamVadPostprocessor {
  constructor(options = {}) {
    this.smoothWindowSize = Math.max(1, options.smoothWindowSize ?? 5);
    this.speechThreshold = options.speechThreshold ?? 0.5;
    this.padStartFrame = Math.max(this.smoothWindowSize, options.padStartFrame ?? 5);
    this.minSpeechFrame = options.minSpeechFrame ?? 8;
    this.maxSpeechFrame = options.maxSpeechFrame ?? 2000;
    this.minSilenceFrame = options.minSilenceFrame ?? 20;
    this.reset();
  }

  reset() {
    this.frameCount = 0;
    this.window = [];
    this.windowSum = 0;
    this.state = 'SILENCE';
    this.speechCount = 0;
    this.silenceCount = 0;
    this.hitMaxSpeech = false;
    this.lastSpeechStart = -1;
    this.lastSpeechEnd = -1;
  }

  /**
   * Feed one frame probability.
   * @param rawProb - the graph's sigmoid output for this frame.
   * @returns the per-frame decision, including start/end flags and boundaries.
   */
  process(rawProb) {
    this.frameCount += 1;
    this.window.push(rawProb);
    this.windowSum += rawProb;
    if (this.window.length > this.smoothWindowSize) this.windowSum -= this.window.shift();
    const smoothed = this.windowSum / this.window.length;
    const isSpeech = smoothed >= this.speechThreshold;

    const result = {
      frameIndex: this.frameCount,
      isSpeech,
      rawProb,
      smoothedProb: smoothed,
      isSpeechStart: false,
      isSpeechEnd: false,
      speechStartFrame: -1,
      speechEndFrame: -1,
    };

    if (this.hitMaxSpeech) {
      result.isSpeechStart = true;
      result.speechStartFrame = this.frameCount;
      this.lastSpeechStart = result.speechStartFrame;
      this.hitMaxSpeech = false;
    }

    if (this.state === 'SILENCE') {
      if (isSpeech) {
        this.state = 'POSSIBLE_SPEECH';
        this.speechCount += 1;
      } else {
        this.silenceCount += 1;
        this.speechCount = 0;
      }
    } else if (this.state === 'POSSIBLE_SPEECH') {
      if (isSpeech) {
        this.speechCount += 1;
        if (this.speechCount >= this.minSpeechFrame) {
          this.state = 'SPEECH';
          result.isSpeechStart = true;
          result.speechStartFrame = Math.max(
            1,
            this.frameCount - this.speechCount + 1 - this.padStartFrame,
            this.lastSpeechEnd + 1,
          );
          this.lastSpeechStart = result.speechStartFrame;
          this.silenceCount = 0;
        }
      } else {
        this.state = 'SILENCE';
        this.silenceCount = 1;
        this.speechCount = 0;
      }
    } else if (this.state === 'SPEECH') {
      this.speechCount += 1;
      if (isSpeech) {
        this.silenceCount = 0;
        if (this.speechCount >= this.maxSpeechFrame) {
          this.hitMaxSpeech = true;
          this.speechCount = 0;
          result.isSpeechEnd = true;
          result.speechEndFrame = this.frameCount;
          result.speechStartFrame = this.lastSpeechStart;
          this.lastSpeechStart = -1;
          this.lastSpeechEnd = result.speechEndFrame;
        }
      } else {
        this.state = 'POSSIBLE_SILENCE';
        this.silenceCount += 1;
      }
    } else if (this.state === 'POSSIBLE_SILENCE') {
      this.speechCount += 1;
      if (isSpeech) {
        this.state = 'SPEECH';
        this.silenceCount = 0;
        if (this.speechCount >= this.maxSpeechFrame) {
          this.hitMaxSpeech = true;
          this.speechCount = 0;
          result.isSpeechEnd = true;
          result.speechEndFrame = this.frameCount;
          result.speechStartFrame = this.lastSpeechStart;
          this.lastSpeechStart = -1;
          this.lastSpeechEnd = result.speechEndFrame;
        }
      } else {
        this.silenceCount += 1;
        if (this.silenceCount >= this.minSilenceFrame) {
          this.state = 'SILENCE';
          result.isSpeechEnd = true;
          result.speechEndFrame = this.frameCount;
          result.speechStartFrame = this.lastSpeechStart;
          this.lastSpeechEnd = result.speechEndFrame;
          this.lastSpeechStart = -1;
          this.speechCount = 0;
        }
      }
    }

    return result;
  }

  /**
   * Close any segment still open at the end of the stream.
   * @param lastFrame - the final frame index that carried audio.
   */
  finalize(lastFrame) {
    if (this.state === 'SPEECH' || this.state === 'POSSIBLE_SILENCE') {
      const result = {
        frameIndex: lastFrame,
        isSpeechEnd: true,
        speechEndFrame: lastFrame,
        speechStartFrame: this.lastSpeechStart,
      };
      this.state = 'SILENCE';
      this.lastSpeechEnd = lastFrame;
      this.lastSpeechStart = -1;
      return result;
    }
    return null;
  }
}

/**
 * Turn per-frame decisions into second-based segments.
 * @param results - decisions from the state machine, in order.
 * @returns `[{ startSeconds, endSeconds, startFrame, endFrame }]`.
 */
export function decisionsToSegments(results) {
  const segments = [];
  let current = null;
  for (const result of results) {
    if (result.isSpeechStart && result.speechStartFrame > 0) {
      if (current !== null && result.speechStartFrame > current.startFrame) {
        current.endFrame = Math.max(current.startFrame, result.speechStartFrame - 1);
        segments.push(current);
      }
      current = { startFrame: result.speechStartFrame, endFrame: -1 };
    }
    if (result.isSpeechEnd && current !== null) {
      current.endFrame = result.speechEndFrame;
      segments.push(current);
      current = null;
    }
  }
  if (current !== null) {
    current.endFrame = results.length > 0 ? results[results.length - 1].frameIndex : current.startFrame;
    segments.push(current);
  }
  return segments
    .filter((segment) => segment.endFrame >= segment.startFrame)
    .map((segment) => ({
      // Upstream reports `(frame - 1) / 100` seconds.
      startSeconds: Math.max(0, segment.startFrame - 1) / FRAMES_PER_SECOND,
      endSeconds: Math.max(0, segment.endFrame - 1) / FRAMES_PER_SECOND,
      startFrame: segment.startFrame,
      endFrame: segment.endFrame,
    }));
}

/** Frame index to a sample offset, matching the reported seconds. */
const frameToSample = (frame) => Math.max(0, frame - 1) * FRAME_SHIFT;

/**
 * Build the FireRedVAD engine.
 *
 * @param config - resolved plugin configuration (`stt.*` is used).
 * @param resolved - asset paths (`resolved.vad.model` / `.cmvn`).
 * @returns the shared VAD engine interface, plus diagnostics used by the
 *   settings panel and the self-test.
 */
export async function createFireRedVad(config, resolved) {
  const ort = loadModule('onnxruntime-node');
  const modelPath = resolved.vad.model;
  const cmvnPath = resolved.vad.cmvn;

  if (!fs.existsSync(modelPath)) throw fail('missing-model', `FireRedVAD model not found: ${modelPath}`);
  if (!fs.existsSync(cmvnPath)) throw fail('missing-cmvn', `FireRedVAD CMVN not found: ${cmvnPath}`);

  const cmvn = parseCmvnArk(fs.readFileSync(cmvnPath));
  const fbank = createFbank({
    epsilon: config.stt?.fbankEpsilon === 'kaldi' ? FLT_EPSILON : config.stt?.fbankEpsilonValue ?? FLT_EPSILON,
    removeDcOffset: config.stt?.fbankRemoveDcOffset !== false,
  });

  const session = await ort.InferenceSession.create(modelPath, {
    executionProviders: ['cpu'],
    intraOpNumThreads: config.stt?.threads ?? 1,
    interOpNumThreads: 1,
    graphOptimizationLevel: 'all',
  });
  const inputNames = session.inputNames;
  const outputNames = session.outputNames;
  const FEAT = inputNames.includes('feat') ? 'feat' : inputNames[0];
  const CACHES_IN = inputNames.includes('caches_in') ? 'caches_in' : inputNames[1];
  const PROBS = outputNames.includes('probs') ? 'probs' : outputNames[0];
  const CACHES_OUT = outputNames.includes('caches_out') ? 'caches_out' : outputNames[1];
  log(`FireRedVAD session ready (${inputNames.join(',')} → ${outputNames.join(',')})`);

  /** Cached FSMN state; re-created per utterance. */
  const newCaches = () => new Float32Array(8 * 128 * 19);

  /** Apply CMVN in place over `count * 80` frame values. */
  function normalise(frames, count) {
    for (let frame = 0; frame < count; frame++) {
      const base = frame * MEL_BINS;
      for (let d = 0; d < MEL_BINS; d++) {
        frames[base + d] = (frames[base + d] - cmvn.means[d]) * cmvn.istd[d];
      }
    }
  }

  /**
   * Run the graph over a whole recording.
   * @param samples - 16 kHz mono Float32 samples.
   * @returns per-frame speech probabilities.
   */
  async function probabilities(samples) {
    const { frames, count } = fbank.extract(samples);
    if (count === 0) return new Float32Array(0);
    normalise(frames, count);
    const probs = new Float32Array(count);
    let caches = newCaches();
    for (let start = 0; start < count; start += MAX_CHUNK_FRAMES) {
      const size = Math.min(MAX_CHUNK_FRAMES, count - start);
      const chunk = frames.subarray(start * MEL_BINS, (start + size) * MEL_BINS);
      const feeds = {
        [FEAT]: new ort.Tensor('float32', chunk, [1, size, MEL_BINS]),
        [CACHES_IN]: new ort.Tensor('float32', caches, [8, 1, 128, 19]),
      };
      const outputs = await session.run(feeds);
      const chunkProbs = outputs[PROBS].data;
      probs.set(chunkProbs.subarray(0, size), start);
      caches = new Float32Array(outputs[CACHES_OUT].data);
    }
    return probs;
  }

  return {
    backend: 'firered',
    note: null,
    model: modelPath,
    async segmentSamples(samples) {
      const probs = await probabilities(samples);
      if (probs.length === 0) return [];
      const post = new StreamVadPostprocessor({
        speechThreshold: config.stt.vadThreshold,
        minSpeechFrame: Math.max(1, Math.round((config.stt.minSpeechSeconds ?? 0.25) * FRAMES_PER_SECOND)),
        minSilenceFrame: Math.max(1, Math.round((config.stt.minSilenceSeconds ?? 0.35) * FRAMES_PER_SECOND)),
        maxSpeechFrame: Math.max(1, Math.round((config.stt.maxSpeechSeconds ?? 30) * FRAMES_PER_SECOND)),
      });
      const results = [];
      for (let i = 0; i < probs.length; i++) results.push(post.process(probs[i]));
      const trailing = post.finalize(probs.length);
      if (trailing !== null) results.push(trailing);
      const segments = decisionsToSegments(results);
      const tailFrames = config.stt?.tailPadFrames ?? 10;
      return segments.map((segment) => {
        const startSample = frameToSample(segment.startFrame);
        const endSample = Math.min(samples.length, frameToSample(segment.endFrame) + FRAME_SHIFT * (1 + tailFrames));
        return {
          startSeconds: segment.startSeconds,
          endSeconds: segment.endSeconds,
          samples: samples.subarray(startSample, endSample),
        };
      });
    },
    /** Diagnostics: raw per-frame probabilities for a recording. */
    async frameProbabilities(samples) {
      const probs = await probabilities(samples);
      return Array.from(probs);
    },
    dispose() {
      void session.release?.();
    },
  };
}

/** Exported for the numeric self-test. */
export const INTERNALS = {
  SAMPLE_RATE,
  FRAME_LENGTH,
  FRAME_SHIFT,
  FFT_SIZE,
  MEL_BINS,
  FLT_EPSILON,
  createFft,
  createFbank,
  createMelFilters,
};
