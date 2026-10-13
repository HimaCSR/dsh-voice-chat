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

/** Resolve the API key for a provider from configuration or the environment. */
export function apiKeyFor(config) {
  const explicit = config.tts?.apiKey;
  if (typeof explicit === 'string' && explicit.trim().length > 0) return explicit.trim();
  const envName = config.tts?.apiKeyEnv || 'MIMO_API_KEY';
  for (const name of [envName, 'MIMO_API_KEY', 'XIAOMI_MIMO_API_KEY']) {
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
 * @returns `{ audio, contentType }`.
 */
async function synthesizeMimo({ text, voice, instruction, config, signal, fetchImpl }) {
  const key = apiKeyFor(config);
  if (!key) {
    throw fail('no-api-key', '未配置小米 MiMo API Key：请设置环境变量 MIMO_API_KEY，或在插件设置里填写');
  }
  const cloning = typeof voice === 'string' && voice.startsWith('data:');
  const model = cloning
    ? config.tts?.cloneModel || 'mimo-v2.5-tts-voiceclone'
    : config.tts?.model || 'mimo-v2.5-tts';
  const format = config.tts?.format || 'wav';
  const base = (config.tts?.baseUrl || 'https://api.xiaomimimo.com/v1').replace(/\/+$/, '');
  const body = {
    model,
    messages: [
      { role: 'user', content: instruction ?? config.tts?.instruction ?? '' },
      { role: 'assistant', content: text },
    ],
    audio: { format, voice: cloning ? voice : voice || config.tts?.voice || 'mimo_default' },
    // Voice cloning is documented as non-streaming only.
    stream: false,
  };
  const timeout = AbortSignal.timeout(config.tts?.timeoutMs ?? 120000);
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
 * @param options - text, voice and config.
 */
async function synthesizeOpenAiSpeech({ text, voice, config, signal, fetchImpl }) {
  const key = apiKeyFor(config);
  if (!key) throw fail('no-api-key', '未配置该 TTS 服务的 API Key');
  const base = (config.tts?.baseUrl || '').replace(/\/+$/, '');
  if (base === '') throw fail('bad-config', 'OpenAI 兼容 TTS 需要配置 baseUrl');
  const format = config.tts?.format || 'wav';
  const timeout = AbortSignal.timeout(config.tts?.timeoutMs ?? 120000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const response = await fetchImpl(`${base}/audio/speech`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: config.tts?.model || 'tts-1',
      input: text,
      voice: voice || config.tts?.voice || 'alloy',
      response_format: format === 'mp3' ? 'mp3' : 'wav',
    }),
    signal: combined,
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw fail('upstream', `TTS 失败（HTTP ${response.status}）：${detail.slice(0, 200)}`);
  }
  const audio = Buffer.from(await response.arrayBuffer());
  if (audio.length === 0) throw fail('bad-response', 'TTS 返回了空音频');
  return { audio, contentType: format === 'mp3' ? 'audio/mpeg' : 'audio/wav' };
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

/** Providers this plugin can talk to. */
export const PROVIDERS = [
  { id: 'mimo', label: '小米 MiMo（默认，支持声音克隆）', clone: true },
  { id: 'openai-speech', label: 'OpenAI 兼容 /audio/speech', clone: false },
  { id: 'dev-tone', label: '本地测试音（无需 Key，仅用于验证链路）', clone: false },
];

/**
 * Describe the request that would be sent, without sending it.
 *
 * This is what makes the voice-clone wiring auditable while no API key exists:
 * the model, the message roles and the exact shape and size of the reference
 * payload are all reported, and nothing leaves the machine.
 * @param options - `{ text, voice, instruction, config }`.
 */
export function describeRequest({ text, voice, instruction, config }) {
  const provider = config.tts?.provider || 'mimo';
  const cloning = typeof voice === 'string' && voice.startsWith('data:');
  const payload = String(text ?? '');
  const describeVoice = () => {
    if (!cloning) return { kind: 'preset', id: voice || config.tts?.voice || 'mimo_default' };
    const comma = voice.indexOf(',');
    return {
      kind: 'data-uri',
      mime: voice.slice(5, voice.indexOf(';')),
      base64Chars: voice.length - comma - 1,
      withinLimit: voice.length - comma - 1 <= CLONE_DATA_URI_LIMIT,
    };
  };
  return {
    provider,
    ready: provider === 'dev-tone' ? true : apiKeyFor(config) !== null,
    model: provider === 'dev-tone'
      ? 'dev-tone'
      : cloning
        ? config.tts?.cloneModel || 'mimo-v2.5-tts-voiceclone'
        : config.tts?.model || 'mimo-v2.5-tts',
    baseUrl: config.tts?.baseUrl ?? null,
    path: provider === 'mimo' ? '/chat/completions' : provider === 'openai-speech' ? '/audio/speech' : null,
    format: config.tts?.format || 'wav',
    streaming: false,
    messages: provider === 'dev-tone'
      ? []
      : [
          { role: 'user', contentLength: String(instruction ?? config.tts?.instruction ?? '').length },
          { role: 'assistant', contentLength: payload.length, contentPreview: payload.slice(0, 60) },
        ],
    audio: provider === 'dev-tone' ? null : { format: config.tts?.format || 'wav', voice: describeVoice() },
    headers: provider === 'mimo' ? ['content-type', 'api-key', 'authorization'] : ['content-type', 'authorization'],
  };
}

/**
 * Synthesize speech with the configured provider.
 * @param options - `{ text, voice, instruction, config, signal, fetchImpl }`.
 *   `voice` is either a preset id or a `data:` URI for a cloned reference.
 */
export async function synthesize(options) {
  const provider = options.config.tts?.provider || 'mimo';
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const call = { ...options, fetchImpl };
  if (provider === 'dev-tone') return synthesizeDevTone(call);
  if (provider === 'openai-speech') return synthesizeOpenAiSpeech(call);
  return synthesizeMimo(call);
}

/** Whether a voice id is one of MiMo's built-in presets. */
export function isPresetVoice(id) {
  return typeof id === 'string' && MIMO_PRESETS.has(id.toLowerCase());
}
