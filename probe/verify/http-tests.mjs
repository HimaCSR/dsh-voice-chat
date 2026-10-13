/**
 * HTTP contract tests for `/dsh-voice`, against a real loopback server.
 *
 * The route handler is exercised exactly as the DSH web server calls it, so the
 * loopback guard, the same-site guard, the error mapping and the byte-level
 * responses are all real. No API key is present, which is the point: the
 * failure path and the request-plan endpoint are what get asserted.
 *
 * Run: node probe/verify/http-tests.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const plugin = path.join(here, '..', '..', 'dsh-voice-chat');
const url = (relative) => new URL(`file://${path.join(plugin, relative).replaceAll('\\', '/')}`).href;

const { createVoiceRoutes } = await import(url('lib/routes.js'));
const { encodeWavPcm16, parseWav, expandPath } = await import(url('lib/util.js'));

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-http-'));
const config = {
  dataRoot,
  stt: { vadBackend: 'firered', precision: 'int8', language: 'auto', modelDirectory: null, vadModelPath: null, fireRedDirectory: null },
  tts: {
    provider: 'mimo',
    model: 'mimo-v2.5-tts',
    cloneModel: 'mimo-v2.5-tts-voiceclone',
    baseUrl: 'https://api.xiaomimimo.com/v1',
    voice: 'mimo_default',
    format: 'wav',
    maxChars: 1200,
    apiKey: null,
    apiKeyEnv: 'VOICE_TEST_MISSING_KEY',
  },
};

const state = { voice: 'mimo_default' };
const calls = [];
const sttStub = {
  status: () => ({ running: true, ready: true, engine: { vad: 'firered', vadNote: null } }),
  transcribe: async (samples, language) => {
    calls.push({ samples: samples.length, language });
    return { text: '你好，世界', language, audioSeconds: samples.length / 16000, speechSeconds: 1, segments: [], inferenceSeconds: 0.1 };
  },
};

const routes = createVoiceRoutes({
  config,
  stt: sttStub,
  currentVoice: () => state.voice,
  noteTts: (voice) => calls.push({ tts: voice }),
  describeConfig: () => ({ provider: config.tts.provider, voice: config.tts.voice, hasKey: false, vadBackendEffective: 'firered' }),
  updateConfig: async (patch) => {
    if (patch.voice !== undefined) {
      state.voice = patch.voice;
      config.tts.voice = patch.voice;
    }
    if (patch.provider !== undefined) config.tts.provider = patch.provider;
    return { ok: true };
  },
  prepareState: () => ({ running: false, phase: 'idle' }),
  startPrepare: () => calls.push({ prepared: true }),
});

const server = http.createServer((request, response) => {
  void routes(request, response);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/dsh-voice`;

const results = [];
async function test(name, body) {
  try {
    await body();
    results.push([name, true, null]);
  } catch (error) {
    results.push([name, false, error.message]);
  }
}

const json = async (response) => ({ status: response.status, body: await response.json() });

await test('GET /state reports engine facts without downloading', async () => {
  const { status, body } = await json(await fetch(`${base}/state`));
  assert.equal(status, 200);
  assert.equal(body.stt.ready, true);
  assert.equal(body.config.provider, 'mimo');
  assert.ok(Array.isArray(body.presets) && body.presets.length > 0, 'preset voices missing');
  assert.ok(Array.isArray(body.voices));
  assert.equal(typeof body.ready, 'boolean');
});

await test('POST /stt forwards 16 kHz PCM and returns the transcript', async () => {
  const pcm = Buffer.alloc(16000 * 2);
  const { status, body } = await json(await fetch(`${base}/stt?language=zh`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: pcm,
  }));
  assert.equal(status, 200);
  assert.equal(body.text, '你好，世界');
  assert.equal(body.language, 'zh');
  assert.equal(calls.at(-1).language, 'zh');
});

await test('POST /stt rejects an 8 kHz WAV with a 400', async () => {
  const { status, body } = await json(await fetch(`${base}/stt`, {
    method: 'POST',
    headers: { 'content-type': 'audio/wav' },
    body: encodeWavPcm16(new Float32Array(1600), 8000),
  }));
  assert.equal(status, 400);
  assert.match(body.error, /16 kHz/);
});

await test('POST /tts without a key fails loudly instead of silently', async () => {
  const { status, body } = await json(await fetch(`${base}/tts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '你好' }),
  }));
  assert.equal(status, 400);
  assert.equal(body.code, 'no-api-key');
  assert.match(body.error, /API Key/);
});

await test('POST /tts/plan proves the clone request shape with no key', async () => {
  // Enrol a voice first, then plan a request that selects it.
  const wav = encodeWavPcm16(new Float32Array(8000), 16000);
  const saved = await json(await fetch(`${base}/voices`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: '测试音色', filename: 'ref_audio.wav', refText: '测试', dataBase64: wav.toString('base64') }),
  }));
  assert.equal(saved.status, 200);
  assert.equal(saved.body.name, '测试音色');

  const { status, body } = await json(await fetch(`${base}/tts/plan`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '念一句试试。', voice: 'clone:测试音色' }),
  }));
  assert.equal(status, 200);
  assert.equal(body.model, 'mimo-v2.5-tts-voiceclone');
  assert.equal(body.audio.voice.kind, 'data-uri');
  assert.equal(body.audio.voice.mime, 'audio/wav');
  assert.equal(body.audio.voice.withinLimit, true);
  assert.equal(body.messages[1].role, 'assistant');
  assert.equal(body.streaming, false);
});

await test('POST /tts/plan reports a preset request for a preset id', async () => {
  const { body } = await json(await fetch(`${base}/tts/plan`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '你好', voice: '冰糖' }),
  }));
  assert.equal(body.model, 'mimo-v2.5-tts');
  assert.equal(body.audio.voice.kind, 'preset');
});

await test('GET /voices lists the enrolled voice and serves its sample', async () => {
  const list = await json(await fetch(`${base}/voices`));
  assert.equal(list.status, 200);
  assert.ok(list.body.voices.some((voice) => voice.name === '测试音色'));
  const sample = await fetch(`${base}/voices/sample?name=${encodeURIComponent('测试音色')}`);
  assert.equal(sample.status, 200);
  assert.equal(sample.headers.get('content-type'), 'audio/wav');
  const bytes = Buffer.from(await sample.arrayBuffer());
  assert.equal(parseWav(bytes).sampleRate, 16000);
});

await test('DELETE /voices removes it, and a second delete reports 404 with no-voice', async () => {
  const first = await json(await fetch(`${base}/voices?name=${encodeURIComponent('测试音色')}`, { method: 'DELETE' }));
  assert.equal(first.status, 200);
  const second = await json(await fetch(`${base}/voices?name=${encodeURIComponent('测试音色')}`, { method: 'DELETE' }));
  assert.equal(second.status, 404);
  assert.equal(second.body.code, 'no-voice');
});

await test('a cross-origin request is refused with 403', async () => {
  const response = await fetch(`${base}/state`, { headers: { origin: 'http://evil.example' } });
  assert.equal(response.status, 403);
});

await test('an unknown sub-route answers 404', async () => {
  const { status } = await json(await fetch(`${base}/nope`));
  assert.equal(status, 404);
});

await test('POST /tts works end to end with the offline dev-tone provider', async () => {
  await fetch(`${base}/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: 'dev-tone' }),
  });
  const response = await fetch(`${base}/tts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '这一句话用来验证离线合成链路。' }),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'audio/wav');
  const wav = parseWav(Buffer.from(await response.arrayBuffer()));
  assert.equal(wav.sampleRate, 16000);
  assert.ok(wav.samples.length > 1600, `tone too short: ${wav.samples.length} samples`);
  assert.ok(calls.some((call) => call.tts !== undefined), 'the voice was not recorded');
});

await test('POST /config persists and echoes a whitelisted field', async () => {
  const { body } = await json(await fetch(`${base}/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ voice: 'clone:纳西妲', model: 'mimo-v2.5-tts' }),
  }));
  assert.equal(body.ok, true);
  assert.equal(state.voice, 'clone:纳西妲');
});

server.close();
fs.rmSync(dataRoot, { recursive: true, force: true });

let failures = 0;
for (const [name, ok, message] of results) {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        ${message}`}`);
}
console.log(`\n${results.length - failures}/${results.length} passed`);
process.exit(failures === 0 ? 0 : 1);
