/**
 * Voice-activity backends.
 *
 * Three engines are supported behind one interface:
 *
 *   `firered`  the official FireRedVAD ONNX graph, driven by our own feature
 *              pipeline (`./firered-vad.js`). sherpa-onnx cannot load it — its
 *              C API only accepts Silero and TEN-VAD — so this engine talks to
 *              ONNX Runtime directly.
 *   `ten`      TEN-VAD through sherpa-onnx.
 *   `silero`   Silero VAD through sherpa-onnx.
 *
 * Every engine exposes the same shape: feed 16 kHz mono Float32 samples once,
 * and read back the speech segments the detector emitted. Extraction is async
 * because the FireRedVAD engine awaits ONNX inference.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ASSETS } from './assets.js';
import { loadSherpa } from './sherpa.js';
import { log } from './util.js';

/** Sherpa-backed detector (Silero or TEN-VAD). */
function createSherpaVad(config, resolved) {
  // Check the model before handing it to sherpa-onnx: its C++ layer calls
  // `exit(-1)` when the configured VAD file is missing, which would kill the
  // whole worker instead of raising a catchable error and letting the Host
  // report a clear reason.
  if (!fs.existsSync(resolved.vad.model)) {
    const error = new Error(`${resolved.vad.backend} VAD 模型不存在：${resolved.vad.model}`);
    error.code = 'missing-vad-model';
    throw error;
  }
  const sherpa = loadSherpa();
  const backend = resolved.vad.backend === 'ten' ? 'tenVad' : 'sileroVad';
  const windowSize = backend === 'tenVad' ? 256 : 512;
  const nativeConfig = {
    sileroVad: {
      model: '',
      threshold: config.stt.vadThreshold,
      minSilenceDuration: config.stt.minSilenceSeconds,
      minSpeechDuration: config.stt.minSpeechSeconds,
      maxSpeechDuration: config.stt.maxSpeechSeconds,
      windowSize: 512,
    },
    tenVad: {
      model: '',
      threshold: config.stt.vadThreshold,
      minSilenceDuration: config.stt.minSilenceSeconds,
      minSpeechDuration: config.stt.minSpeechSeconds,
      maxSpeechDuration: config.stt.maxSpeechSeconds,
      windowSize: 256,
    },
    sampleRate: 16000,
    numThreads: config.stt.threads,
    provider: 'cpu',
    debug: 0,
  };
  nativeConfig[backend].model = resolved.vad.model;
  const detector = new sherpa.Vad(nativeConfig, config.stt.maxSpeechSeconds + config.stt.minSilenceSeconds + 1);

  return {
    backend: resolved.vad.backend,
    note: null,
    /**
     * Feed one utterance and return its speech segments.
     * @param samples - 16 kHz mono Float32 samples.
     */
    segmentSamples(samples) {
      detector.reset();
      const segments = [];
      const drain = () => {
        while (!detector.isEmpty()) {
          const segment = detector.front(false);
          segments.push(segment);
          detector.pop();
        }
      };
      for (let offset = 0; offset < samples.length; offset += windowSize) {
        detector.acceptWaveform(samples.subarray(offset, offset + windowSize));
        drain();
      }
      detector.flush();
      drain();
      return segments.map((segment) => ({
        startSeconds: segment.start / 16000,
        endSeconds: (segment.start + segment.samples.length) / 16000,
        samples: segment.samples,
      }));
    },
    dispose() {},
  };
}

/**
 * Build the configured detector.
 *
 * A `firered` request that cannot be satisfied falls back to `ten` and then to
 * `silero`, and the replacement is reported through the returned `note` so the
 * UI can say which detector is actually running instead of silently pretending.
 * @param config - resolved plugin configuration.
 * @param resolved - asset paths from `resolveAssets`.
 * @param fireredFactory - `createFireRedVad` from `./firered-vad.js`, or null
 *   when the optional ONNX Runtime dependency is not installed.
 */
export async function createVad(config, resolved, fireredFactory) {
  if (resolved.vad.backend !== 'firered') return createSherpaVad(config, resolved);
  if (typeof fireredFactory === 'function') {
    try {
      const engine = await fireredFactory(config, resolved);
      engine.note = null;
      return engine;
    } catch (error) {
      // Logged in full: the note surfaced to the UI is short, but a maintainer
      // needs the actual stack to tell a missing model from a broken runtime.
      log(`FireRedVAD failed: ${error?.stack ?? error?.message ?? error}`);
      return sherpaFallback(config, resolved, `FireRedVAD 初始化失败（${error.message}）`);
    }
  }
  return sherpaFallback(config, resolved, 'FireRedVAD 运行时不可用（未安装 onnxruntime-node）');
}

/**
 * Substitute a sherpa-onnx detector and explain the substitution.
 *
 * The fallback must recompute the model path for its own backend. Carrying the
 * FireRedVAD path over would hand sherpa a graph that is not a VAD model at
 * all, and its C++ layer answers that with `exit(-1)` — killing the recognizer
 * process instead of raising something catchable. Silero is tried first because
 * its file is pinned and checksum-verified in `assets.js`.
 */
function sherpaFallback(config, resolved, reason) {
  const wanted = config.stt?.vadFallback ?? 'silero';
  const order = wanted === 'ten' ? ['ten', 'silero'] : ['silero', 'ten'];
  const attempts = [];
  for (const backend of order) {
    try {
      const asset = ASSETS.vad[backend].model;
      const engine = createSherpaVad(config, {
        ...resolved,
        vad: { backend, dir: resolved.vadDir, model: path.join(resolved.vadDir, asset.name), asset },
      });
      engine.note = `${reason}，已改用 ${backend}`;
      return engine;
    } catch (error) {
      attempts.push(`${backend}: ${String(error?.message ?? error).split('\n')[0]}`);
    }
  }
  const error = new Error(`${reason}；备用 VAD 也不可用（${attempts.join('; ')}）`);
  error.code = 'no-vad';
  throw error;
}
