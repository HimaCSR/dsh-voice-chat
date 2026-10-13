/**
 * The recognizer and its segmentation, confined to the dedicated worker
 * process.
 *
 * One recording is processed as: the VAD segments the utterance, each segment
 * is decoded by SenseVoiceSmall, and the pieces are joined. Running the
 * detector before recognition is what keeps a cough, a door slam or keyboard
 * clatter from turning into a message: with no speech segment there is nothing
 * to recognize, and the caller receives an empty transcript instead.
 */
import { createVad } from './vad.js';
import { createFireRedVad } from './firered-vad.js';
import { loadModule, loadSherpa, sherpaOrigin } from './sherpa.js';
import { log } from './util.js';

/** SenseVoice language hints understood by both the provider and the model. */
export const LANGUAGES = ['auto', 'zh', 'en', 'yue', 'ja', 'ko'];

/** SenseVoice emits `<|zh|><|NEUTRAL|><|Speech|>` style markers; drop them. */
const SENSEVOICE_TAGS = /<\|[^|]*\|>/g;

/** Scripts that do not use spaces between words. */
const CJK = '\\u3000-\\u303f\\u3040-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\\uff00-\\uffef';
const CJK_JOIN = new RegExp(`([${CJK}])\\s+(?=[${CJK}])`, 'g');

/** Join per-segment transcripts without inventing spaces between CJK glyphs. */
function joinTranscripts(texts) {
  return texts
    .filter((text) => text.length > 0)
    .join(' ')
    .replace(CJK_JOIN, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Build the inference engine for one worker process.
 * @param config - validated worker configuration (paths plus tuning).
 * @param options - `{ fireredFactory }` to override the FireRedVAD factory.
 */
export async function createEngine(config, options = {}) {
  // Load order is load-bearing on Windows, and getting it wrong fails late and
  // cryptically. Both sherpa-onnx and onnxruntime-node ship a file named
  // `onnxruntime.dll`, and Windows binds a native addon's dependent DLLs by base
  // name against whatever is already loaded in the process. Loading sherpa
  // first pins its older copy, after which onnxruntime-node's binding aborts
  // with ERR_DLOPEN_FAILED ("The operating system cannot run %1") — reproduced
  // in a spawned child, and absent when ONNX Runtime is loaded first. The sherpa
  // recognizer is verified to keep working against the newer runtime.
  if (config.resolved?.vad?.backend === 'firered' && typeof options.fireredFactory !== 'function') {
    try {
      loadModule('onnxruntime-node');
    } catch (error) {
      // createVad reports this properly and falls back; do not fail here.
      log(`preloading ONNX Runtime failed: ${String(error.message).split('\n')[0]}`);
    }
  }
  const sherpa = loadSherpa();
  const fireredFactory = options.fireredFactory === undefined ? createFireRedVad : options.fireredFactory;
  const vad = await createVad(config, config.resolved, fireredFactory);

  const nativeConfig = {
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      senseVoice: {
        model: config.paths.model,
        language: 'auto',
        useInverseTextNormalization: 1,
      },
      tokens: config.paths.tokens,
      numThreads: config.stt.threads,
      provider: 'cpu',
      debug: 0,
    },
  };
  const recognizer = new sherpa.OfflineRecognizer(nativeConfig);

  /**
   * Transcribe one utterance.
   * @param samples - 16 kHz mono Float32 samples.
   * @param language - SenseVoice language hint.
   */
  async function transcribe(samples, language) {
    const hint = LANGUAGES.includes(language) ? language : 'auto';
    const started = performance.now();
    const audioSeconds = samples.length / 16000;
    const segments = await vad.segmentSamples(samples);
    const texts = [];
    let speechSeconds = 0;
    nativeConfig.modelConfig.senseVoice.language = hint;
    recognizer.setConfig(nativeConfig);
    for (const segment of segments) {
      speechSeconds += segment.samples.length / 16000;
      const stream = recognizer.createStream();
      stream.acceptWaveform({ sampleRate: 16000, samples: segment.samples });
      recognizer.decode(stream);
      const text = String(recognizer.getResult(stream).text ?? '')
        .replace(SENSEVOICE_TAGS, '')
        .trim();
      if (text.length > 0) texts.push(text);
    }
    return {
      text: joinTranscripts(texts),
      language: hint,
      audioSeconds,
      speechSeconds,
      segments: segments.map((segment) => ({
        start: Number(segment.startSeconds.toFixed(3)),
        end: Number(segment.endSeconds.toFixed(3)),
      })),
      inferenceSeconds: Number(((performance.now() - started) / 1000).toFixed(3)),
    };
  }

  return {
    transcribe,
    describe() {
      return {
        vad: vad.backend,
        vadNote: vad.note ?? null,
        sherpa: sherpaOrigin(),
        threads: config.stt.threads,
        model: config.paths.model,
      };
    },
    dispose() {
      vad.dispose?.();
    },
  };
}
