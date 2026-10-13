/**
 * Host half of the voice-chat plugin.
 *
 * Owns three things and nothing else:
 *   • the local speech models on disk (download, verify, report readiness),
 *   • the recognizer worker that runs SenseVoiceSmall behind a local VAD, and
 *   • the `/dsh-voice` HTTP surface the browser half talks to — which is also
 *     where the TTS API key stays, so it never reaches the page.
 *
 * All of it is registered through `ctx.effect`, so disabling the plugin
 * unregisters the route and kills the worker without leaving a listener behind.
 */
import path from 'node:path';
import { defaultDataRoot, expandPath, log, readJson, writeJsonAtomic } from './lib/util.js';
import { inspectAssets, prepareAssets, resolveAssets } from './lib/assets.js';
import { SttService } from './lib/stt.js';
import { createVoiceRoutes } from './lib/routes.js';
import { anchorList, probeModule, setModuleAnchors } from './lib/sherpa.js';

/** Services the Host half needs before it may register anything. */
export const inject = ['webServer'];

/** The path this plugin owns on the DSH web server. */
const ROUTE_PATH = '/dsh-voice';

/** Baseline configuration; every field is overridable from the bundle patch. */
const DEFAULTS = {
  dataRoot: defaultDataRoot(),
  stt: {
    enabled: true,
    // `firered` is the requested detector; `ten` and `silero` are the
    // sherpa-onnx alternatives it degrades to when ONNX Runtime is absent.
    vadBackend: 'firered',
    vadFallback: 'ten',
    language: 'auto',
    precision: 'int8',
    threads: 2,
    vadThreshold: 0.5,
    minSpeechSeconds: 0.25,
    minSilenceSeconds: 0.35,
    maxSpeechSeconds: 30,
    idleTimeoutMs: 300000,
    startupTimeoutMs: 300000,
    inferenceTimeoutMs: 120000,
    modelDirectory: null,
    vadModelPath: null,
    fireRedDirectory: null,
    // FireRedVAD feature front end. `kaldi` selects FLT_EPSILON, which is what
    // upstream's Python frontend uses; `fbankEpsilonValue` overrides it for
    // A/B work. These are diagnostics knobs, not user settings.
    fbankEpsilon: 'kaldi',
    fbankRemoveDcOffset: true,
    /** Extra frames appended to a detected segment before recognition. */
    tailPadFrames: 10,
  },
  tts: {
    provider: 'mimo',
    model: 'mimo-v2.5-tts',
    cloneModel: 'mimo-v2.5-tts-voiceclone',
    baseUrl: 'https://api.xiaomimimo.com/v1',
    voice: 'mimo_default',
    format: 'wav',
    authStyle: 'auto',
    instruction: '',
    maxChars: 1200,
    timeoutMs: 120000,
    apiKey: null,
    apiKeyEnv: 'MIMO_API_KEY',
  },
};

/** Keys the settings UI may change at runtime, and their allowed shape. */
const MUTABLE = {
  voice: 'tts.voice',
  apiKey: 'tts.apiKey',
  baseUrl: 'tts.baseUrl',
  provider: 'tts.provider',
  model: 'tts.model',
  cloneModel: 'tts.cloneModel',
  format: 'tts.format',
  instruction: 'tts.instruction',
  language: 'stt.language',
  vadBackend: 'stt.vadBackend',
};

/** Deep-merge plain objects; arrays and scalars from `source` win. */
function merge(base, source) {
  if (source === null || typeof source !== 'object' || Array.isArray(source)) return source === undefined ? base : source;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    out[key] = key in out && typeof out[key] === 'object' && out[key] !== null && !Array.isArray(out[key])
      ? merge(out[key], value)
      : value;
  }
  return out;
}

/** Read `a.b` from a nested object. */
function getPath(object, dotted) {
  return dotted.split('.').reduce((value, key) => (value === null || value === undefined ? undefined : value[key]), object);
}

/** Write `a.b` into a nested object. */
function setPath(object, dotted, value) {
  const keys = dotted.split('.');
  let cursor = object;
  for (const key of keys.slice(0, -1)) {
    if (typeof cursor[key] !== 'object' || cursor[key] === null) cursor[key] = {};
    cursor = cursor[key];
  }
  cursor[keys[keys.length - 1]] = value;
}

/**
 * Mount the plugin.
 * @param ctx - Host plugin context.
 * @param rawConfig - the row's `config` from the bundle patch.
 */
export function apply(ctx, rawConfig = {}) {
  const config = merge(DEFAULTS, rawConfig);
  config.dataRoot = expandPath(config.dataRoot);
  config.logPath = path.join(config.dataRoot, 'plugin.log');
  const overridesPath = path.join(config.dataRoot, 'config.json');

  // Ask DSH where this profile lives instead of guessing. A bundle installed by
  // `dsh plugin add <path>` is linked into `<profile>/node_modules` while its
  // real files stay wherever the user keeps them, so Node's own lookup — which
  // starts at the plugin's real path — never reaches the profile's
  // node_modules, and a dependency pnpm installed correctly looks missing.
  const profile = ctx.get('profileContext');
  const moduleAnchors = [];
  if (typeof profile?.dir === 'string') moduleAnchors.push(profile.dir);
  if (typeof profile?.installAnchor === 'string') {
    moduleAnchors.push(profile.installAnchor.endsWith('.json') ? path.dirname(profile.installAnchor) : profile.installAnchor);
  }
  if (typeof profile?.home === 'string') moduleAnchors.push(path.join(profile.home, 'profiles'));
  setModuleAnchors(moduleAnchors);
  config.moduleAnchors = moduleAnchors;
  log(`module anchors: ${moduleAnchors.join(' | ') || '(none)'}`);

  /** Runtime overrides persisted across restarts. */
  let overrides = {};
  /** Background model-preparation state. */
  let prepare = { running: false, phase: 'idle', received: 0, total: 0, error: null, startedAt: null, finishedAt: null };
  /** Last observed model/asset readiness, refreshed on activation and after preparation. */
  let assets = null;
  /** Small activity trail for diagnostics. */
  const recent = [];
  /** Recent recognitions: time, audio length, speech length and transcript. */
  const recentStt = [];

  const ready = readJson(overridesPath, {}).then(async (stored) => {
    if (stored && typeof stored === 'object') {
      overrides = stored;
      for (const [key, dotted] of Object.entries(MUTABLE)) {
        if (stored[key] !== undefined) setPath(config, dotted, stored[key]);
      }
      log('restored runtime overrides');
    }
    assets = await inspectAssets(config, { verify: false }).catch(() => null);
    return assets;
  });

  const stt = new SttService(config, () => resolveAssets(config));

  /** Refresh and return the cached asset report. */
  async function refreshAssets() {
    assets = await inspectAssets(config, { verify: false }).catch((error) => ({ ready: false, error: error.message }));
    return assets;
  }

  /** Snapshot of the settings the UI may display. */
  function describeConfig() {
    return {
      provider: config.tts.provider,
      model: config.tts.model,
      cloneModel: config.tts.cloneModel,
      baseUrl: config.tts.baseUrl,
      voice: config.tts.voice,
      format: config.tts.format,
      hasKey: typeof config.tts.apiKey === 'string' && config.tts.apiKey.length > 0
        ? true
        : Boolean(process.env[config.tts.apiKeyEnv] || process.env.MIMO_API_KEY),
      keySource: typeof config.tts.apiKey === 'string' && config.tts.apiKey.length > 0 ? 'settings' : 'environment',
      language: config.stt.language,
      sttBackend: 'sensevoice-small',
      precision: config.stt.precision,
      vadBackend: assets?.vad?.backend ?? config.stt.vadBackend,
      vadBackendEffective: stt.status().engine?.vad ?? assets?.vad?.backend ?? config.stt.vadBackend,
      vadNote: stt.status().engine?.vadNote ?? null,
      modelReady: assets?.ready === true,
      dataRoot: config.dataRoot,
      recent,
    };
  }

  /** The voice the UI should use when it does not send one explicitly. */
  function currentVoice() {
    return config.tts.voice || 'mimo_default';
  }

  /** Record which voice produced audio, for the settings screen. */
  function noteTts(voice) {
    recent.unshift({ at: new Date().toISOString(), voice });
    recent.length = Math.min(recent.length, 8);
  }

  /**
   * Record one recognition, so "did the microphone actually reach the
   * recognizer, and what did it hear?" is answerable after the fact. Kept in
   * memory only, capped, and never written to disk.
   */
  function noteStt(entry) {
    recentStt.unshift({ at: new Date().toISOString(), ...entry });
    recentStt.length = Math.min(recentStt.length, 8);
  }

  /** Apply a settings patch, persist it, and return the new summary. */
  async function updateConfig(patch) {
    const next = {};
    for (const [key, dotted] of Object.entries(MUTABLE)) {
      if (patch[key] === undefined) continue;
      const value = patch[key];
      if (key === 'apiKey' && typeof value === 'string' && value.trim() === '') {
        // An empty field clears a stored key so the environment can take over.
        next[key] = null;
        setPath(config, dotted, null);
        continue;
      }
      if (value !== null && typeof value !== 'string') continue;
      next[key] = value;
      setPath(config, dotted, value);
    }
    overrides = { ...overrides, ...next };
    await writeJsonAtomic(overridesPath, overrides);
    if (next.voice !== undefined) log(`default voice set to ${String(next.voice)}`);
    return describeConfig();
  }

  /** Current background-preparation state. */
  function prepareState() {
    return { ...prepare };
  }

  /** Start the one-shot model download if it is not already running. */
  function startPrepare() {
    if (prepare.running) return;
    prepare = { running: true, phase: 'checking', received: 0, total: 0, error: null, startedAt: Date.now(), finishedAt: null };
    void (async () => {
      try {
        await prepareAssets(config, {
          onProgress: (received, total) => {
            prepare = { ...prepare, phase: 'downloading', received, total };
          },
        });
        await refreshAssets();
        prepare = { ...prepare, running: false, phase: 'ready', finishedAt: Date.now() };
        log('speech models ready');
      } catch (error) {
        prepare = { ...prepare, running: false, phase: 'failed', error: error.message, finishedAt: Date.now() };
        log(`model preparation failed: ${error.message}`);
      }
    })();
  }

  const routes = createVoiceRoutes({
    config,
    stt,
    currentVoice,
    noteTts,
    noteStt,
    recentStt,
    describeConfig,
    updateConfig,
    prepareState,
    startPrepare,
  });

  ctx.effect(() => {
    const dispose = ctx.webServer.register({ kind: 'prefix', path: ROUTE_PATH, handler: routes });
    log(`routes registered at ${ROUTE_PATH}`);
    return () => {
      dispose();
      log('routes removed');
    };
  }, 'voice-chat: http routes');

  ctx.effect(() => () => {
    stt.dispose();
  }, 'voice-chat: recognizer worker');

  // Cache readiness (and kick off nothing) so `/state` can answer immediately.
  void ready.then((report) => {
    if (report && report.ready === false) log('speech models are not prepared yet');
  });
}
