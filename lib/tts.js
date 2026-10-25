/**
 * Online text-to-speech adapters.
 *
 * The default provider is Xiaomi's MiMo open platform. It is *not* an
 * OpenAI-compatible `/v1/audio/speech` service: synthesis borrows the chat
 * completions route, the text to speak must arrive as the `assistant` message,
 * and the audio comes back base64-encoded on the message. Voice cloning is
 * zero-shot — the reference sample travels as a `data:` URI in `audio.voice`,
 * so no enrolment step or voice id exists.
 *
 * A second, conventional adapter covers OpenAI-style `/audio/speech`
 * endpoints so the plugin is not locked to one vendor.
 *
 * Providers are data, not code: each one names a `kind` (which adapter speaks
 * for it) and carries its own endpoint, model, voice and credentials. A user
 * can therefore add a provider the plugin has never heard of, as long as it
 * speaks one of the two supported wire formats.
 */
import { encodeWavPcm16, fail } from './util.js';

/** Xiaomi MiMo preset voices, kept for the settings UI. */
export const MIMO_PRESET_VOICES = [
  { id: 'mimo_default', label: '默认（冰糖 / Mia）' },
  { id: '冰糖', label: '冰糖 · 中文女声' },
  { id: '茉莉', label: '茉莉 · 中文女声' },
  { id: '苏打', label: '苏打 · 中文男声' },
  { id: '白桦', label: '白桦 · 中文男声' },
  { id: 'Mia', label: 'Mia · English' },
  { id: 'Chloe', label: 'Chloe · English' },
  { id: 'Milo', label: 'Milo · English' },
  { id: 'Dean', label: 'Dean · English' },
];

/** Voices accepted by `mimo-v2.5-tts`; anything else must be a clone URI. */
const MIMO_PRESETS = new Set(MIMO_PRESET_VOICES.map((voice) => voice.id.toLowerCase()));

/** Upper bound the MiMo API documents for a clone reference. */
export const CLONE_DATA_URI_LIMIT = 10 * 1024 * 1024;

/** MIME types MiMo accepts for a clone reference. */
const CLONE_MIME = new Set(['audio/wav', 'audio/x-wav', 'audio/mpeg', 'audio/mp3']);

/**
 * Build the `data:` URI a clone request carries.
 * @param reference - absolute path of the reference audio.
 * @param bytes - its contents.
 */
export function cloneDataUri(reference, bytes) {
  const extension = reference.toLowerCase().slice(reference.lastIndexOf('.'));
  const mime = extension === '.wav' ? 'audio/wav' : extension === '.mp3' ? 'audio/mpeg' : null;
  if (mime === null || !CLONE_MIME.has(mime)) {
    throw fail('bad-reference', '参考音频必须是 .wav 或 .mp3');
  }
  const encoded = bytes.toString('base64');
  if (encoded.length > CLONE_DATA_URI_LIMIT) {
    throw fail('reference-too-large', `参考音频 base64 后超过 ${Math.round(CLONE_DATA_URI_LIMIT / 1024 / 1024)} MB，请换更短或更小的样本`);
  }
  return `data:${mime};base64,${encoded}`;
}

/**
 * Resolve the API key for a provider from configuration or the environment.
 *
 * The key belongs to the provider, not to the plugin: two providers need two
 * different keys, so a single global slot would make switching providers
 * overwrite the previous one's credentials. The old flat `tts.apiKey` is still
 * honoured for the provider it belonged to — MiMo, the only one there was
 * before providers became extensible — so a configuration written by an
 * earlier version keeps working.
 *
 * The fallback deliberately stops at the provider boundary. Letting one
 * provider fall back to another provider's key would hand, say, the MiMo key
 * to an unrelated third-party endpoint.
 * @param config - the plugin configuration.
 * @param provider - the resolved provider record, or null when unknown.
 */
export function apiKeyFor(config, provider = null) {
  const legacy = provider === null || provider.id === LEGACY_PROVIDER_ID;
  const explicit = provider?.apiKey ?? (legacy ? config.tts?.apiKey : undefined);
  if (typeof explicit === 'string' && explicit.trim().length > 0) return explicit.trim();
  const envName = provider?.apiKeyEnv ?? (legacy ? config.tts?.apiKeyEnv : null);
  const names = typeof envName === 'string' && envName !== '' ? [envName] : [];
  if (legacy) names.push('MIMO_API_KEY', 'XIAOMI_MIMO_API_KEY');
  for (const name of names) {
    const value = process.env[name];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return null;
}

/** Header set for a MiMo call, honouring the configured auth style. */
function mimoHeaders(config, key) {
  const style = config.tts?.authStyle ?? 'auto';
  const headers = { 'content-type': 'application/json' };
  if (style === 'api-key' || style === 'auto') headers['api-key'] = key;
  if (style === 'bearer' || style === 'auto') headers.authorization = `Bearer ${key}`;
  return headers;
}

/**
 * Synthesize through the MiMo chat-completions audio route.
 * @param options - text, resolved voice (preset id or `data:` URI), config and signal.
 */
async function synthesizeMimo({ text, voice, instruction, config, signal, fetchImpl, provider }) {
  const key = apiKeyFor(config, provider);
  if (!key) {
    throw fail('no-api-key', '未配置小米 MiMo API Key：请设置环境变量 MIMO_API_KEY，或在插件设置里填写');
  }
  const cloning = typeof voice === 'string' && voice.startsWith('data:');
  const model = cloning
    ? provider?.cloneModel || config.tts?.cloneModel || 'mimo-v2.5-tts-voiceclone'
    : provider?.model || config.tts?.model || 'mimo-v2.5-tts';
  const format = provider?.format || config.tts?.format || 'wav';
  const base = (provider?.baseUrl || config.tts?.baseUrl || 'https://api.xiaomimimo.com/v1').replace(/\/+$/, '');
  const body = {
    model,
    messages: [
      { role: 'user', content: instruction ?? provider?.instruction ?? config.tts?.instruction ?? '' },
      { role: 'assistant', content: text },
    ],
    audio: { format, voice: cloning ? voice : voice || provider?.voice || config.tts?.voice || 'mimo_default' },
    // Voice cloning is documented as non-streaming only.
    stream: false,
  };
  const timeout = AbortSignal.timeout(provider?.timeoutMs ?? config.tts?.timeoutMs ?? 120000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const response = await fetchImpl(`${base}/chat/completions`, {
    method: 'POST',
    headers: mimoHeaders(config, key),
    body: JSON.stringify(body),
    signal: combined,
  });
  const raw = await response.text();
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw fail('bad-response', `MiMo 返回了非 JSON 响应（HTTP ${response.status}）：${raw.slice(0, 200)}`);
  }
  if (!response.ok) {
    const detail = payload?.error?.message || payload?.message || raw.slice(0, 200);
    throw fail('upstream', `MiMo TTS 失败（HTTP ${response.status}）：${detail}`);
  }
  const data = payload?.choices?.[0]?.message?.audio?.data;
  if (typeof data !== 'string' || data.length === 0) {
    throw fail('bad-response', 'MiMo 响应里没有音频数据（choices[0].message.audio.data）');
  }
  const audio = Buffer.from(data, 'base64');
  if (audio.length === 0) throw fail('bad-response', 'MiMo 返回了空音频');
  return { audio, contentType: format === 'mp3' ? 'audio/mpeg' : 'audio/wav', model };
}

/**
 * Synthesize through an OpenAI-compatible `/audio/speech` endpoint.
 *
 * The `response_format` is passed through as configured, because vendors do not
 * agree on what they accept: OpenRouter answers `wav` with a 400 and takes
 * `mp3` or `pcm` only, while SiliconFlow takes all four. A bare `pcm` reply
 * is headerless PCM, so it is wrapped in a WAV container here — the browser
 * cannot decode raw PCM.
 * @param options - text, voice and config.
 */
async function synthesizeOpenAiSpeech({ text, voice, config, signal, fetchImpl, provider }) {
  const key = apiKeyFor(config, provider);
  if (!key) throw fail('no-api-key', '未配置该 TTS 服务的 API Key');
  const base = (provider?.baseUrl || config.tts?.baseUrl || '').replace(/\/+$/, '');
  if (base === '') throw fail('bad-config', 'OpenAI 兼容 TTS 需要配置 baseUrl');
  const format = provider?.format || config.tts?.format || 'wav';
  const responseFormat = format === 'mp3' ? 'mp3' : format === 'pcm' ? 'pcm' : 'wav';
  const timeout = AbortSignal.timeout(provider?.timeoutMs ?? config.tts?.timeoutMs ?? 120000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const response = await fetchImpl(`${base}/audio/speech`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: provider?.model || config.tts?.model || 'tts-1',
      input: text,
      voice: voice || provider?.voice || config.tts?.voice || 'alloy',
      response_format: responseFormat,
    }),
    signal: combined,
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw fail('upstream', `TTS 失败（HTTP ${response.status}）：${detail.slice(0, 200)}`);
  }
  const raw = Buffer.from(await response.arrayBuffer());
  if (raw.length === 0) throw fail('bad-response', 'TTS 返回了空音频');
  if (responseFormat === 'pcm') {
    // The sample rate differs between vendors; the WAV header has to state
    // the right one or the browser plays the clip at the wrong speed.
    const rate = provider?.sampleRate ?? config.tts?.sampleRate ?? 24000;
    return { audio: pcmToWav(raw, rate), contentType: 'audio/wav', model: provider?.model || config.tts?.model || 'tts-1' };
  }
  return {
    audio: raw,
    contentType: responseFormat === 'mp3' ? 'audio/mpeg' : 'audio/wav',
    model: provider?.model || config.tts?.model || 'tts-1',
  };
}

/**
 * Wrap headerless 16-bit little-endian PCM in a WAV container.
 *
 * The speech endpoints answer `pcm` with a bare sample stream: the format the
 * browser's decoder wants, minus the 44-byte header that says how to read it.
 * @param pcm - the raw sample bytes.
 * @param sampleRate - the sample rate of the stream; the header has to state
 *   it correctly or the browser plays the audio at the wrong speed.
 */
export function pcmToWav(pcm, sampleRate = 24000) {
  const rate = Number(sampleRate);
  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 2));
  const floats = new Float32Array(samples.length);
  for (let index = 0; index < samples.length; index++) floats[index] = samples[index] / 32768;
  return encodeWavPcm16(floats, Number.isFinite(rate) && rate > 0 ? Math.round(rate) : 24000);
}

/**
 * Offline stand-in used to exercise the whole speaking pipeline without an API
 * key: it returns a short tone whose length tracks the sentence, so sentence
 * splitting, the serial TTS chain, FIFO playback and barge-in can all be
 * verified end to end. It is never a default and never pretends to be speech.
 * @param options - `{ text, config }`.
 */
function synthesizeDevTone({ text, config }) {
  const sampleRate = 16000;
  const seconds = Math.min(4, Math.max(0.35, text.length * 0.055));
  const samples = new Float32Array(Math.round(sampleRate * seconds));
  for (let i = 0; i < samples.length; i++) {
    const t = i / sampleRate;
    // A two-note chirp makes sentence boundaries audible when several clips
    // play back to back.
    const frequency = t < seconds / 2 ? 660 : 880;
    const envelope = Math.min(1, Math.min(t, seconds - t) * 20);
    samples[i] = 0.18 * envelope * Math.sin(2 * Math.PI * frequency * t);
  }
  return { audio: encodeWavPcm16(samples, sampleRate), contentType: 'audio/wav', model: 'dev-tone' };
}

/**
 * Built-in providers.
 *
 * Each entry names the wire format it speaks (`kind`) and what it can do
 * (`clone`). The two free reference entries are the ones the settings panel
 * offers as one-click starting points: OpenRouter's free speech model and
 * SiliconFlow's CosyVoice. Both speak the OpenAI-compatible format, so a user
 * who prefers another vendor only has to fill in the endpoint and the model.
 */
export const BUILTIN_PROVIDERS = [
  {
    id: 'mimo',
    label: '小米 MiMo（默认，支持声音克隆）',
    kind: 'mimo',
    clone: true,
    baseUrl: 'https://api.xiaomimimo.com/v1',
    model: 'mimo-v2.5-tts',
    cloneModel: 'mimo-v2.5-tts-voiceclone',
    voice: 'mimo_default',
    format: 'wav',
    apiKeyEnv: 'MIMO_API_KEY',
  },
  {
    id: 'openai-speech',
    label: 'OpenAI 兼容 /audio/speech',
    kind: 'openai-speech',
    clone: false,
    baseUrl: '',
    model: 'tts-1',
    voice: 'alloy',
    format: 'wav',
    apiKeyEnv: 'OPENAI_API_KEY',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter（免费语音模型）',
    kind: 'openai-speech',
    clone: false,
    reference: true,
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'fish-audio/s2.1-pro-free:free',
    voice: 'default',
    format: 'mp3',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    hint: '该模型本身不收费，但需要 OpenRouter 账号密钥。',
  },
  {
    id: 'siliconflow',
    label: '硅基流动 SiliconFlow（中文音色）',
    kind: 'openai-speech',
    clone: false,
    reference: true,
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'FunAudioLLM/CosyVoice2-0.5B',
    voice: 'FunAudioLLM/CosyVoice2-0.5B:alex',
    format: 'mp3',
    apiKeyEnv: 'SILICONFLOW_API_KEY',
    hint: '国内直连；TTS 不在长期免费清单内，新用户通常有代金券。',
  },
  {
    id: 'dev-tone',
    label: '本地测试音（无需 Key，仅用于验证链路）',
    kind: 'dev-tone',
    clone: false,
    format: 'wav',
  },
];

/** Providers this plugin can talk to. */
export const PROVIDERS = BUILTIN_PROVIDERS;

/** Wire formats a provider may declare. */
export const PROVIDER_KINDS = ['mimo', 'openai-speech', 'dev-tone'];

/**
 * The provider the old flat `tts.*` fields belong to.
 *
 * Before providers became user-extensible there was exactly one of them, so
 * those fields describe MiMo and only MiMo. Folding them into whichever
 * provider happens to be selected would silently repoint, say, the OpenRouter
 * entry at the MiMo endpoint.
 */
export const LEGACY_PROVIDER_ID = 'mimo';

/**
 * The fields a stored provider record may hold.
 *
 * Anything else is dropped rather than written. The record ends up in
 * `config.json`, and a browser form has no business deciding what that file
 * contains — it sends its own bookkeeping along with the real values.
 */
export const PROVIDER_FIELDS = [
  'label', 'clone', 'baseUrl', 'model', 'cloneModel', 'voice', 'format',
  'apiKey', 'apiKeyEnv', 'instruction', 'timeoutMs', 'maxChars', 'sampleRate',
  'hint', 'reference',
];

/** The audio containers a provider may return. */
export const PROVIDER_FORMATS = ['wav', 'mp3', 'pcm'];

/**
 * The environment variables a provider may read its key from.
 *
 * The list is closed on purpose. An open `apiKeyEnv` would let a stored
 * provider name any variable in the Host's environment and have its value
 * sent to whatever address that provider points at.
 */
export const ALLOWED_API_KEY_ENV = [
  'MIMO_API_KEY',
  'XIAOMI_MIMO_API_KEY',
  'OPENAI_API_KEY',
  'OPENROUTER_API_KEY',
  'SILICONFLOW_API_KEY',
];

/**
 * Check that a base URL is one the plugin is willing to talk to.
 *
 * Only http and https are allowed, and the host has to be a real one: a
 * provider pointing at a file:// or data: URL is not a speech service.
 * @returns an error message, or null when the URL is acceptable.
 */
export function checkBaseUrl(value) {
  const text = String(value ?? '').trim();
  if (text === '') return null;
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    return 'baseUrl 不是合法的网址';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return 'baseUrl 只支持 http 或 https';
  }
  if (parsed.hostname === '') return 'baseUrl 缺少主机名';
  return null;
}

/**
 * Merge an incoming provider record onto the one already stored.
 *
 * The field names are filtered, and so are the values: a number that is not
 * a number, a format nobody speaks, an environment variable outside the
 * closed list — all of them are rejected rather than stored.
 * @param base - the stored record, or the built-in definition.
 * @param record - the incoming fields.
 * @param id - the provider id.
 * @param kind - the resolved provider kind.
 * @returns the record to store, carrying only the known and valid fields.
 * @throws when a field carries a value the plugin will not accept.
 */
export function mergeProviderRecord(base, record, id, kind) {
  const merged = { ...(base ?? {}) };
  // Whether a provider is built-in is decided by the built-in table, not by
  // the stored record.
  delete merged.builtin;
  merged.id = id;
  merged.kind = kind;
  for (const field of PROVIDER_FIELDS) {
    if (record?.[field] === undefined) continue;
    const value = record[field];
    if (field === 'clone') {
      merged.clone = value === true;
      continue;
    }
    if (field === 'timeoutMs') {
      const timeout = Number(value);
      if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 600000) {
        throw fail('bad-request', 'timeoutMs 必须是 1 到 600000 之间的数字');
      }
      merged.timeoutMs = Math.round(timeout);
      continue;
    }
    if (field === 'maxChars') {
      const limit = Number(value);
      if (!Number.isFinite(limit) || limit <= 0 || limit > 20000) {
        throw fail('bad-request', 'maxChars 必须是 1 到 20000 之间的数字');
      }
      merged.maxChars = Math.round(limit);
      continue;
    }
    if (field === 'sampleRate') {
      const rate = Number(value);
      if (!Number.isFinite(rate) || rate < 8000 || rate > 96000) {
        throw fail('bad-request', 'sampleRate 必须是 8000 到 96000 之间的数字');
      }
      merged.sampleRate = Math.round(rate);
      continue;
    }
    if (field === 'format') {
      const format = String(value).trim().toLowerCase();
      if (!PROVIDER_FORMATS.includes(format)) {
        throw fail('bad-request', `format 只支持 ${PROVIDER_FORMATS.join(' / ')}`);
      }
      merged.format = format;
      continue;
    }
    if (field === 'apiKeyEnv') {
      const name = String(value).trim();
      if (name !== '' && !ALLOWED_API_KEY_ENV.includes(name)) {
        throw fail('bad-request', `apiKeyEnv 只允许 ${ALLOWED_API_KEY_ENV.join(' / ')}`);
      }
      merged.apiKeyEnv = name;
      continue;
    }
    if (field === 'baseUrl') {
      const url = String(value).trim();
      const problem = checkBaseUrl(url);
      if (problem) throw fail('bad-request', problem);
      merged.baseUrl = url;
      continue;
    }
    if (typeof value === 'string') {
      merged[field] = value.trim();
      continue;
    }
    merged[field] = value;
  }
  // Only the MiMo endpoint can clone a voice; the flag is not the caller's to
  // set on an arbitrary provider.
  if (merged.clone === true && kind !== 'mimo') merged.clone = false;
  // A blank key field clears the stored key instead of storing an empty one.
  if (typeof merged.apiKey === 'string') {
    merged.apiKey = merged.apiKey.trim() === '' ? null : merged.apiKey.trim();
  }
  return merged;
}

/**
 * Normalize the stored configuration into a provider map.
 *
 * A configuration written before providers became user-extensible keeps its
 * flat `tts.baseUrl` / `tts.model` / `tts.apiKey` fields. Those are folded
 * into the currently selected provider so an existing installation keeps
 * working, while the flat fields themselves are left untouched on disk.
 * @param config - the plugin configuration.
 * @returns `{ providers, currentId }` where `providers` maps id to record.
 */
export function normalizeProviders(config) {
  const tts = config?.tts ?? {};
  const stored = tts.providers && typeof tts.providers === 'object' ? tts.providers : null;
  const providers = {};
  // The values the user configured, kept apart from the built-in defaults so
  // that "is this value set?" can be answered about the user's own choice
  // rather than about a default that happens to have a value.
  const configured = {};
  for (const builtin of BUILTIN_PROVIDERS) {
    providers[builtin.id] = { ...builtin, builtin: true };
    configured[builtin.id] = {};
  }
  if (stored) {
    for (const [id, record] of Object.entries(stored)) {
      if (!id || !record || typeof record !== 'object') continue;
      providers[id] = { ...providers[id], ...record, id, builtin: providers[id]?.builtin === true };
      configured[id] = { ...record };
    }
  }
  const currentId = typeof tts.provider === 'string' && tts.provider.length > 0 ? tts.provider : LEGACY_PROVIDER_ID;
  // Fold the legacy flat fields into the provider they belong to. These fields
  // are the user's own configuration — they come from the bundle patch or from
  // an older version's settings file — so they win over a built-in default,
  // but they never overwrite a value the user already stored per provider.
  const legacy = {
    baseUrl: tts.baseUrl,
    model: tts.model,
    cloneModel: tts.cloneModel,
    voice: tts.voice,
    format: tts.format,
    apiKey: tts.apiKey,
    apiKeyEnv: tts.apiKeyEnv,
    instruction: tts.instruction,
    timeoutMs: tts.timeoutMs,
    maxChars: tts.maxChars,
  };
  // The flat fields describe the provider that existed when they were written.
  // They are folded into that one, never into whichever provider happens to
  // be selected now — otherwise selecting OpenRouter would repoint it at the
  // MiMo endpoint.
  const target = providers[LEGACY_PROVIDER_ID];
  if (target) {
    const own = configured[LEGACY_PROVIDER_ID] ?? {};
    for (const [key, value] of Object.entries(legacy)) {
      if (value === undefined || value === null) continue;
      // A value the user stored for this provider wins, including an empty
      // one: clearing a field has to stay cleared.
      if (own[key] !== undefined) continue;
      target[key] = value;
    }
  }
  return { providers, currentId };
}

/**
 * Look up one provider by id.
 * @param config - the plugin configuration.
 * @param id - the provider id; defaults to the selected one.
 */
export function resolveProvider(config, id = null) {
  const { providers, currentId } = normalizeProviders(config);
  const wanted = id ?? currentId;
  return providers[wanted] ?? null;
}

/**
 * Describe the request that would be sent, without sending it.
 *
 * This is what makes the voice-clone wiring auditable while no API key exists:
 * the model, the message roles and the exact shape and size of the reference
 * payload are all reported, and nothing leaves the machine.
 * @param options - `{ text, voice, instruction, config }`.
 */
export function describeRequest({ text, voice, instruction, config }) {
  const provider = resolveProvider(config);
  const providerId = provider?.id ?? config.tts?.provider ?? 'mimo';
  const kind = provider?.kind ?? 'mimo';
  const cloning = typeof voice === 'string' && voice.startsWith('data:');
  const payload = String(text ?? '');
  const describeVoice = () => {
    if (!cloning) return { kind: 'preset', id: voice || provider?.voice || config.tts?.voice || 'mimo_default' };
    const comma = voice.indexOf(',');
    return {
      kind: 'data-uri',
      mime: voice.slice(5, voice.indexOf(';')),
      base64Chars: voice.length - comma - 1,
      withinLimit: voice.length - comma - 1 <= CLONE_DATA_URI_LIMIT,
    };
  };
  const format = provider?.format || config.tts?.format || 'wav';
  return {
    provider: providerId,
    ready: kind === 'dev-tone' ? true : apiKeyFor(config, provider) !== null,
    model: kind === 'dev-tone'
      ? 'dev-tone'
      : cloning
        ? provider?.cloneModel || config.tts?.cloneModel || 'mimo-v2.5-tts-voiceclone'
        : provider?.model || config.tts?.model || 'mimo-v2.5-tts',
    baseUrl: provider?.baseUrl ?? config.tts?.baseUrl ?? null,
    path: kind === 'mimo' ? '/chat/completions' : kind === 'openai-speech' ? '/audio/speech' : null,
    format,
    streaming: false,
    messages: kind === 'dev-tone'
      ? []
      : [
          { role: 'user', contentLength: String(instruction ?? provider?.instruction ?? config.tts?.instruction ?? '').length },
          { role: 'assistant', contentLength: payload.length, contentPreview: payload.slice(0, 60) },
        ],
    audio: kind === 'dev-tone' ? null : { format, voice: describeVoice() },
    headers: kind === 'mimo' ? ['content-type', 'api-key', 'authorization'] : ['content-type', 'authorization'],
  };
}

/**
 * Synthesize speech with the configured provider.
 *
 * An unknown provider id is reported instead of silently falling back to
 * MiMo: a typo in the configuration would otherwise speak through the wrong
 * service, with the wrong voice and the wrong bill.
 * @param options - `{ text, voice, instruction, config, signal, fetchImpl }`.
 *   `voice` is either a preset id or a `data:` URI for a cloned reference.
 */
export async function synthesize(options) {
  const provider = resolveProvider(options.config);
  if (!provider) {
    throw fail('unknown-provider', `未知的 TTS 服务：${options.config.tts?.provider ?? '(空)'}`);
  }
  const kind = provider.kind ?? 'mimo';
  const cloning = typeof options.voice === 'string' && options.voice.startsWith('data:');
  if (cloning && provider.clone !== true) {
    throw fail('clone-unsupported', `「${provider.label ?? provider.id}」不支持声音克隆`);
  }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const call = { ...options, fetchImpl, provider };
  if (kind === 'dev-tone') return synthesizeDevTone(call);
  if (kind === 'openai-speech') return synthesizeOpenAiSpeech(call);
  if (kind === 'mimo') return synthesizeMimo(call);
  throw fail('unknown-provider', `未知的 TTS 服务类型：${kind}`);
}

/** Whether a voice id is one of MiMo's built-in presets. */
export function isPresetVoice(id) {
  return typeof id === 'string' && MIMO_PRESETS.has(id.toLowerCase());
}
