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
import { defaultDataRoot, expandPath, fail, log, readJson, warn, writeJsonAtomic } from './lib/util.js';
import { inspectAssets, prepareAssets, resolveAssets } from './lib/assets.js';
import { SttService } from './lib/stt.js';
import { createVoiceRoutes } from './lib/routes.js';
import { setModuleAnchors } from './lib/sherpa.js';
import { BUILTIN_PROVIDERS, PROVIDER_KINDS, mergeProviderRecord, normalizeProviders } from './lib/tts.js';
import { UpdateChecker, readPluginVersion } from './lib/version.js';
import { registerPersona, DEFAULT_PERSONA } from './lib/persona.js';
import { auditDependencies, installDependency, readManifest } from './lib/deps.js';

/** Services the Host half needs before it may register anything. */
export const inject = ['webServer'];

/** The path this plugin owns on the DSH web server. */
const ROUTE_PATH = '/dsh-voice';

/**
 * The only installation source this plugin will hand to the plugin manager.
 *
 * The value arrives in a request body, and the plugin manager would install
 * and enable whatever it names. Only this project's own tagged releases are
 * accepted.
 */
const RELEASE_SPEC_PATTERN = /^github:HimaCSR\/dsh-voice-chat@v\d+\.\d+\.\d+$/;

/** Provider ids are file- and log-safe: letters, digits, dots and dashes. */
const PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

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
    // The conversation persona, injected into the harness system prompt. It
    // shapes what the assistant says — not how the voice sounds. The default
    // is the one the plugin was asked for: one question, one answer, and a
    // summary when the answer would be long. Clearing the field turns it off.
    persona: DEFAULT_PERSONA,
    // Custom provider records, keyed by provider id.
    providers: {},
  },
  // Update checking. `manifestUrl` overrides the default GitHub Releases
  // lookup, which is what a self-hosted mirror would use.
  update: {
    manifestUrl: '',
  },
};

/** Keys the settings UI may change at runtime, and their allowed shape. */
/** The ways a reply can be read out. */
const SPEAK_MODES = ['head-tail', 'all', 'head', 'tail'];

/**
 * Put a stored provider table back through the rules it has to obey.
 *
 * The table can also arrive from `config.json` or a bundle patch, which do
 * not go through the /providers route and therefore never met the field
 * and environment-variable rules. The list of environment variables a key
 * may be read from is only worth something if it is applied on the way
 * in, and this is one of the ways in.
 * @param table - the stored table.
 * @returns the table with every record reduced to the known fields.
 */
function sanitizeProviderTable(table) {
  if (table === null || typeof table !== 'object' || Array.isArray(table)) return {};
  const out = {};
  for (const [id, record] of Object.entries(table)) {
    if (record === null || typeof record !== 'object' || Array.isArray(record)) continue;
    const kind = typeof record.kind === 'string' ? record.kind : 'openai-speech';
    out[id] = mergeProviderRecord({}, record, id, kind);
  }
  return out;
}

const MUTABLE = {
  voice: 'tts.voice',
  apiKey: 'tts.apiKey',
  // `tts.baseUrl` is deliberately not here. It is the legacy MiMo address:
  // it is still read (so old configurations keep working), but it is not
  // written from a request, because this is the address the API key is
  // sent to. A service the user added lives in the provider table, which
  // is written through /providers and checked there.
  provider: 'tts.provider',
  model: 'tts.model',
  cloneModel: 'tts.cloneModel',
  format: 'tts.format',
  instruction: 'tts.instruction',
  language: 'stt.language',
  vadBackend: 'stt.vadBackend',
  // The conversation persona, injected into the harness system prompt.
  persona: 'tts.persona',
  // Which parts of a reply are spoken out. The value is checked before it
  // is written, so a stray string cannot land in the configuration.
  speakMode: 'tts.speakMode',
  // A custom update source; empty means the default GitHub Releases lookup.
  updateUrl: 'update.manifestUrl',
};

/**
 * Keys whose value is a plain object rather than a string.
 *
 * Everything else stays a string or null, which keeps the persisted file
 * readable and stops a stray number from being written where a label is
 * expected.
 */
const MUTABLE_OBJECTS = {
  // The provider table. It is written from inside the plugin only: through
  // /config a whole-table write could drop every custom provider, key
  // included, in one call. Adding and removing a provider goes through
  // /providers, which checks the record and writes only the known fields.
  providers: 'tts.providers',
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
  /**
   * Failures the browser half ran into.
   *
   * The client cannot write to the disk, so it reports them here. Without
   * this a failed read-out looks the same as a failed synthesis, and the
   * reason for it is lost with the console.
   */
  const clientErrors = [];
  /** The plugin's own version, read once at start-up. */
  let pluginVersion = null;
  /** The dispose handle of the registered persona prompt section. */
  let personaDispose = null;
  /** Whether the persona reached the system prompt, and why not if it did not. */
  const personaState = { applied: false, reason: '尚未注册' };
  /** The most recent dependency audit, refreshed on demand. */
  let depsReport = null;
  /** The state of the running dependency installation, if any. */
  let depsInstall = null;
  /** The update checker, holding the cached release lookup. */
  const updateChecker = new UpdateChecker({ manifestUrl: config.update?.manifestUrl ?? '' });
  /** The tail of the configuration queue; see `enqueueConfig`. */
  let configTail = Promise.resolve();

  /**
   * Register the conversation persona as a system prompt section.
   *
   * This runs once, while the plugin is being applied. The section's text
   * is read from the live configuration every time the harness assembles a
   * prompt, so an edit takes effect on the next reply without touching the
   * registration.
   *
   * Nothing here may throw: this runs while the host is booting, and an
   * exception here would be a fatal load failure that leaves the user with
   * no application at all. A persona that cannot be placed is logged and
   * skipped; the rest of the plugin keeps working.
   */
  function registerConversationPersona() {
    let result;
    try {
      result = registerPersona(ctx, () => config.tts.persona ?? '');
    } catch (error) {
      result = { applied: false, reason: `人设注入异常：${error?.message ?? error}`, dispose: null };
    }
    if (result.applied) {
      personaDispose = result.dispose;
      personaState.applied = true;
      personaState.reason = null;
      log('conversation persona registered');
    } else {
      personaState.applied = false;
      personaState.reason = result.reason;
      log(`conversation persona not applied: ${result.reason}`);
    }
    return result;
  }

  const ready = readJson(overridesPath, {}).then(async (stored) => {
    if (stored && typeof stored === 'object') {
      overrides = stored;
      for (const [key, dotted] of Object.entries(MUTABLE)) {
        if (stored[key] !== undefined) setPath(config, dotted, stored[key]);
      }
      for (const [key, dotted] of Object.entries(MUTABLE_OBJECTS)) {
        if (stored[key] === undefined) continue;
        if (key === 'providers') {
          // The stored table did not come through the /providers route, so
          // it never met the field and environment-variable rules. Run it
          // through them again: the closed list of environment variables is
          // only worth anything if it is applied on the way in, and this is
          // the way in.
          setPath(config, dotted, sanitizeProviderTable(stored[key]));
          continue;
        }
        setPath(config, dotted, stored[key]);
      }
      log('restored runtime overrides');
    }
    assets = await inspectAssets(config, { verify: false }).catch(() => null);
    pluginVersion = await readPluginVersion();
    return assets;
  }).catch((error) => {
    // The boot sequence must not fail as a whole: without the model report
    // the settings panel says "not prepared" and the user can still fix it.
    log(`startup preparation failed: ${error?.message ?? error}`);
    return null;
  });

  const stt = new SttService(config, () => resolveAssets(config));

  /** Refresh and return the cached asset report. */
  async function refreshAssets() {
    assets = await inspectAssets(config, { verify: false }).catch((error) => ({ ready: false, error: error.message }));
    return assets;
  }

  /** Snapshot of the settings the UI may display. */
  function describeConfig() {
    const { providers, currentId } = normalizeProviders(config);
    const selected = providers[currentId] ?? null;
    // The key state is reported for the provider that is actually in use.
    // Reading the old flat fields instead would say "no key" while the
    // selected provider has one of its own.
    const hasStoredKey = typeof selected?.apiKey === 'string' && selected.apiKey.length > 0;
    const hasEnvKey = Boolean(selected?.apiKeyEnv && process.env[selected.apiKeyEnv]);
    return {
      provider: currentId,
      model: selected?.model ?? config.tts.model,
      cloneModel: selected?.cloneModel ?? config.tts.cloneModel,
      baseUrl: selected?.baseUrl ?? config.tts.baseUrl,
      voice: selected?.voice ?? config.tts.voice,
      format: selected?.format ?? config.tts.format,
      hasKey: hasStoredKey || hasEnvKey,
      keySource: hasStoredKey ? 'settings' : hasEnvKey ? 'environment' : 'none',
      language: config.stt.language,
      // The tone instruction, so the settings panel can show what is in
      // effect instead of an empty box that would overwrite it on save.
      instruction: selected?.instruction ?? config.tts.instruction ?? '',
      persona: config.tts.persona ?? '',
      // Which parts of a reply are spoken out. The default reads the
      // opening and the closing sentence only.
      speakMode: SPEAK_MODES.includes(config.tts.speakMode) ? config.tts.speakMode : 'head-tail',
      // Whether the persona actually reached the system prompt, and why not
      // if it did not: a persona that silently fails to register looks
      // exactly like a persona the model is ignoring.
      personaApplied: personaState.applied,
      personaReason: personaState.reason,
      sttBackend: 'sensevoice-small',
      precision: config.stt.precision,
      vadBackend: assets?.vad?.backend ?? config.stt.vadBackend,
      vadBackendEffective: stt.status().engine?.vad ?? assets?.vad?.backend ?? config.stt.vadBackend,
      vadNote: stt.status().engine?.vadNote ?? null,
      modelReady: assets?.ready === true,
      dataRoot: config.dataRoot,
      version: pluginVersion,
      recent,
    };
  }

  /**
   * The provider list for the settings UI.
   *
   * A stored API key never leaves the Host: each entry reports whether a key
   * exists and where it came from, never the key itself.
   */
  function describeProviders() {
    const { providers, currentId } = normalizeProviders(config);
    return Object.values(providers).map((record) => {
      const hasStoredKey = typeof record.apiKey === 'string' && record.apiKey.length > 0;
      const hasEnvKey = Boolean(record.apiKeyEnv && process.env[record.apiKeyEnv]);
      return {
        id: record.id,
        label: record.label || record.id,
        kind: record.kind ?? 'mimo',
        clone: record.clone === true,
        // SiliconFlow matches the words against the sample, so a clone needs
        // the transcript; MiMo does not.
        cloneNeedsTranscript: record.kind === 'siliconflow',
        builtin: record.builtin === true,
        reference: record.reference === true,
        hint: record.hint ?? null,
        baseUrl: record.baseUrl ?? '',
        model: record.model ?? '',
        cloneModel: record.cloneModel ?? '',
        voice: record.voice ?? '',
        format: record.format ?? 'wav',
        apiKeyEnv: record.apiKeyEnv ?? '',
        hasKey: hasStoredKey || hasEnvKey,
        keySource: hasStoredKey ? 'settings' : hasEnvKey ? 'environment' : 'none',
        selected: record.id === currentId,
      };
    });
  }

  /**
   * Add, change or remove a provider.
   *
   * A built-in provider can be re-pointed but not deleted: it is the fallback
   * the plugin falls back to when a custom one fails.
   * @param action - `'upsert'` or `'delete'`.
   * @param record - the provider id, plus the fields to write.
   */
  async function updateProvider(action, record) {
    const id = typeof record?.id === 'string' ? record.id.trim() : '';
    if (id === '') throw fail('bad-request', '缺少供应商 id');
    // The id becomes a key in the stored map and is written into the log, so
    // it is restricted to characters that are safe in both.
    if (!PROVIDER_ID_PATTERN.test(id)) {
      throw fail('bad-request', '供应商 id 只能包含字母、数字、点和短横线，且以字母或数字开头');
    }
    return enqueueConfig(async () => {
    const { providers, currentId } = normalizeProviders(config);
    const existing = providers[id] ?? null;
    if (action === 'delete') {
      if (existing?.builtin) throw fail('bad-request', `内置供应商「${existing.label ?? id}」不能删除`);
      const next = { ...(config.tts.providers ?? {}) };
      delete next[id];
      // The selection falls back to MiMo when the provider in use is removed.
      await applyConfigPatch(
        currentId === id ? { providers: next, provider: 'mimo' } : { providers: next },
        { trusted: true },
      );
      log(`provider removed: ${id}`);
      return describeProviders();
    }
    const kind = record.kind ?? existing?.kind ?? 'openai-speech';
    if (!PROVIDER_KINDS.includes(kind)) {
      throw fail('bad-request', `不支持的供应商类型：${kind}`);
    }
    const builtin = BUILTIN_PROVIDERS.find((entry) => entry.id === id) ?? null;
    const next = { ...(config.tts.providers ?? {}) };
    // Only the known fields are written. The request comes from a browser form,
    // and spreading it wholesale would store its bookkeeping — and whatever
    // else it happens to carry — into the configuration file.
    const merged = mergeProviderRecord(existing ?? builtin ?? {}, record, id, kind);
    next[id] = merged;
    await applyConfigPatch({ providers: next }, { trusted: true });
    log(`provider saved: ${id}`);
    return describeProviders();
    });
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

  /**
   * Record a failure the browser half ran into.
   *
   * The message the user sees is the same one the client shows, so the
   * reason for a failure that only ever appears in the browser is still
   * answerable after the fact.
   */
  function noteClientError(entry) {
    clientErrors.unshift({ at: new Date().toISOString(), ...entry });
    clientErrors.length = Math.min(clientErrors.length, 8);
    log(`client failure at ${entry.where}: ${entry.message}`);
  }

  /**
   * Serialize the configuration writes.
   *
   * Reading the current state, changing it and writing it back is three
   * steps, and the write yields to the event loop. Two requests arriving
   * together would both read the same old state, and the second write would
   * silently drop the first one's change. Running the whole sequence in a
   * queue keeps the updates in order.
   */
  function enqueueConfig(task) {
    const run = configTail.then(task, task);
    configTail = run.then(() => undefined, () => undefined);
    return run;
  }

  /**
   * Apply a settings patch, persist it, and return the new summary.
   *
   * This is the inner half; it expects the caller to already hold the
   * configuration queue. `updateConfig` is the entry point for everyone else.
   */
  async function applyConfigPatch(patch, options = {}) {
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
      if (key === 'speakMode' && !SPEAK_MODES.includes(value)) continue;
      next[key] = value;
      setPath(config, dotted, value);
    }
    for (const [key, dotted] of Object.entries(MUTABLE_OBJECTS)) {
      if (patch[key] === undefined) continue;
      // The provider table is the plugin's own business: it is only written
      // when the plugin itself asks for it, never from a request body.
      if (key === 'providers' && options.trusted !== true) continue;
      const value = patch[key];
      if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
      next[key] = value;
      setPath(config, dotted, value);
    }
    overrides = { ...overrides, ...next };
    await writeJsonAtomic(overridesPath, overrides);
    if (next.voice !== undefined) log(`default voice set to ${String(next.voice)}`);
    if (next.provider !== undefined) log(`tts provider set to ${String(next.provider)}`);
    if (next.persona !== undefined) log('conversation persona updated');
    return describeConfig();
  }

  /** Apply a settings patch, persist it, and return the new summary. */
  function updateConfig(patch) {
    return enqueueConfig(() => applyConfigPatch(patch));
  }

  /** Current background-preparation state. */
  function prepareState() {
    return { ...prepare };
  }

  /**
   * Audit the native modules the plugin relies on.
   *
   * The report merges the dependency view with the diagnostics already
   * collected, so one section answers both "what is broken?" and "how do I
   * fix it?".
   */
  async function dependencyReport() {
    const manifest = await readManifest().catch(() => ({}));
    const entries = await auditDependencies(manifest);
    depsReport = { entries, at: Date.now() };
    return depsReport;
  }

  /** The cached dependency report, computed on first use. */
  async function describeDependencies() {
    return depsReport ?? dependencyReport();
  }

  /**
   * Start installing one dependency into the profile.
   *
   * The installation is a background job: it reports its output through the
   * state endpoint rather than holding the request open.
   */
  function startDependencyInstall(name, range) {
    if (depsInstall?.running) throw fail('conflict', '已有依赖正在安装');
    // The name is an npm package name. A leading dash would let it be read
    // as an option by the package manager rather than as a package.
    if (typeof name !== 'string' || !/^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i.test(name)) {
      throw fail('bad-request', '依赖名不合法');
    }
    // The range becomes part of the spec handed to pnpm, so it is checked as
    // strictly as the name: a version, and nothing that could point at
    // another location.
    const wanted = typeof range === 'string' ? range.trim() : '';
    if (wanted !== '' && !/^(?:\^|~|>=|<=|>|<|=)?\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z.-]+)?(?:\s*\|\|\s*(?:\^|~|>=|<=|>|<|=)?\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z.-]+)?)*$/.test(wanted)) {
      throw fail('bad-request', '版本范围不合法');
    }
    depsInstall = installDependency({
      name,
      range: wanted,
      profileDir: profile?.dir ?? '',
      // The harness knows which package manager it ships with; that one is
      // used rather than a guess at where it lives.
      packageManager: profile?.packageManager ?? null,
      onState: (state) => {
        depsInstall = state;
        // A finished install changes what is on disk, so the cached audit is
        // stale from that moment on.
        if (state?.phase === 'done' || state?.error) depsReport = null;
      },
    });
    return { ...depsInstall };
  }

  /** The state of the running dependency installation. */
  function dependencyInstallState() {
    return depsInstall ? { ...depsInstall } : { running: false, phase: 'idle', output: [], error: null };
  }

  /**
   * Check whether a newer release exists.
   *
   * The lookup needs no server of our own: it asks GitHub's public releases
   * API and falls back to a mirror.
   */
  async function checkForUpdate() {
    const current = pluginVersion ?? (await readPluginVersion());
    pluginVersion = current;
    // The custom source is read at lookup time, not at construction: the
    // checker is created once, but the setting may change later.
    return updateChecker.check(current, config.update?.manifestUrl ?? '');
  }

  /**
   * Install a released version through the DSH plugin manager.
   *
   * The plugin is installed with `link:` on a development machine, so
   * unpacking the release archive over it would destroy the working copy.
   * The plugin manager is the supported way to put a published version in
   * place: it runs pnpm in the profile and leaves the profile consistent.
   * @param spec - the install spec, e.g. `github:HimaCSR/dsh-voice-chat@v1.1.0`.
   * @param signal - an abort signal, as the service requires.
   */
  async function installRelease(spec, signal) {
    // The installation source is not taken on trust: the request body could
    // name any package, and the plugin manager would install and enable it.
    // Only this project's own releases are installable here.
    const source = String(spec ?? '').trim();
    if (!RELEASE_SPEC_PATTERN.test(source)) {
      throw fail('bad-request', `只允许安装本项目的发布版（${RELEASE_SPEC_PATTERN.source}）`);
    }
    const manager = ctx.get('pluginManager');
    if (!manager || typeof manager.installBundle !== 'function') {
      return {
        applied: false,
        error: '当前运行时没有插件管理服务，无法自动安装',
        manual: `dsh plugin --profile desktop add ${source}`,
      };
    }
    try {
      const result = await manager.installBundle(source, { enabled: true, signal });
      log(`update install finished: ${JSON.stringify(result?.application ?? result)}`);
      // The manager's own answer is passed on, with a plain marker added so
      // the panel can tell a finished install from a failed one.
      const payload = result && typeof result === 'object' ? { ...result } : {};
      return { ...payload, applied: true };
    } catch (error) {
      // The error path must not be able to fail itself: a throw here would
      // replace the real reason with something far less useful.
      try {
        warn(`update install failed: ${error?.message ?? error}`);
      } catch {
        // Nothing left to do but report the failure to the caller.
      }
      return {
        applied: false,
        error: String(error?.message ?? error),
        manual: `dsh plugin --profile desktop add ${source}`,
      };
    }
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
    noteClientError,
    clientErrors,
    describeConfig,
    updateConfig,
    prepareState,
    startPrepare,
    describeProviders,
    updateProvider,
    describeDependencies,
    startDependencyInstall,
    dependencyInstallState,
    checkForUpdate,
    installRelease,
  });

  ctx.effect(() => {
    const dispose = ctx.webServer.register({ kind: 'prefix', path: ROUTE_PATH, handler: routes });
    log(`routes registered at ${ROUTE_PATH}`);
    return () => {
      dispose();
      log('routes removed');
    };
  }, 'voice-chat: http routes');

  // The persona section is registered here, while the plugin is being
  // applied and the context is still alive. Registering it later — from the
  // asynchronous startup path — either collides with the built-in persona
  // section or creates an effect on a context that is already gone, and the
  // host treats both as a fatal load failure: the application would refuse
  // to start at all.
  registerConversationPersona();

  ctx.effect(() => () => {
    stt.dispose();
  }, 'voice-chat: recognizer worker');

  // The persona section lives as long as the plugin does.
  ctx.effect(() => () => {
    if (personaDispose) {
      try {
        personaDispose();
      } catch {
        // Already gone.
      }
      personaDispose = null;
    }
  }, 'voice-chat: persona prompt section');

  // Cache readiness (and kick off nothing) so `/state` can answer immediately.
  void ready.then((report) => {
    if (report && report.ready === false) log('speech models are not prepared yet');
  });
}
