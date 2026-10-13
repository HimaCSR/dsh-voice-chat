/**
 * Live verification against the running DSH Web GUI.
 *
 * Everything here goes through the real Host process, the real route, the real
 * worker and the real models — it is the same surface the browser uses.
 *
 * Run: node probe/verify/live-verify.mjs [baseUrl]
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const plugin = path.join(here, '..', '..', 'dsh-voice-chat');
const BASE = (process.argv[2] ?? 'http://127.0.0.1:19387').replace(/\/$/, '');
const VOICE = `${BASE}/dsh-voice`;
// Fixture produced by tools/prepare-assets.mjs; point elsewhere on another host.
const SPEECH = process.env.DSH_VOICE_SPEECH ?? 'C:/Users/74260/.cache/dsh-voice-spike/speech.wav';

const results = [];
async function test(name, body) {
  try {
    await body();
    results.push([name, true, null]);
  } catch (error) {
    results.push([name, false, error.message]);
  }
}

const json = async (response) => {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`non-JSON response (HTTP ${response.status}): ${text.slice(0, 160)}`);
  }
};
const post = (path, body, type = 'application/json') =>
  fetch(`${VOICE}${path}`, {
    method: 'POST',
    headers: { 'content-type': type },
    body: type === 'application/json' ? JSON.stringify(body) : body,
  });

let engineInfo = null;

await test('the plugin is mounted and reports a ready, FireRedVAD-backed engine', async () => {
  const state = await json(await fetch(`${VOICE}/state`));
  assert.equal(state.ready, true, `models not ready: ${state.assetsError ?? ''}`);
  assert.equal(state.config.vadBackendEffective, 'firered', `effective VAD was ${state.config.vadBackendEffective} (${state.config.vadNote ?? 'no note'})`);
  assert.ok(state.presets.length > 0, 'no preset voices');
  assert.ok(state.providers.some((provider) => provider.id === 'mimo'), 'MiMo provider missing');
  engineInfo = state.config;
});

await test('native module resolution points at the profile and the DSH install', async () => {
  const diag = await json(await fetch(`${VOICE}/diag`));
  const ort = diag.modules.onnxruntime;
  const sherpa = diag.modules.sherpa;
  console.log(`\n  onnxruntime -> ${ort.resolved}`);
  console.log(`  sherpa      -> ${sherpa.resolved}`);
  assert.ok(ort.resolved?.includes('profiles'), 'onnxruntime should resolve from the profile node_modules');
  assert.ok(sherpa.resolved?.includes('app.asar'), 'sherpa should resolve from the DSH installation');
});

await test('speech is transcribed, and FireRedVAD segments it', async () => {
  const wav = fs.readFileSync(SPEECH);
  const result = await json(await post('/stt?language=zh', wav, 'application/octet-stream'));
  console.log(`\n  transcript: ${JSON.stringify(result.text)}`);
  console.log(`  segments: ${result.segments.map((s) => `${s.start}-${s.end}`).join(', ')}  inference=${result.inferenceSeconds}s`);
  assert.ok(result.text.length > 0, 'empty transcript');
  assert.ok(result.segments.length > 0, 'no speech segments');
  const hits = ['你好', '语音', '识别', '录音', '天气'].filter((word) => result.text.includes(word));
  assert.ok(hits.length >= 2, `transcript does not resemble the reference: ${result.text}`);
});

await test('the worker reports FireRedVAD as the detector actually in use', async () => {
  const state = await json(await fetch(`${VOICE}/state`));
  console.log(`  worker: running=${state.stt.running} ready=${state.stt.ready} vad=${state.stt.engine?.vad}`);
  assert.equal(state.stt.running, true, 'worker is not running after a transcription');
  assert.equal(state.stt.engine?.vad, 'firered', `worker used ${state.stt.engine?.vad}`);
  assert.equal(state.stt.engine?.vadNote, null, `unexpected note: ${state.stt.engine?.vadNote}`);
});

await test('white noise produces no transcript and no segments', async () => {
  const noise = Buffer.alloc(96000);
  for (let i = 0; i < noise.length; i += 2) noise.writeInt16LE(Math.round((Math.random() * 2 - 1) * 2600), i);
  const result = await json(await post('/stt?language=zh', noise, 'application/octet-stream'));
  console.log(`  noise   -> text=${JSON.stringify(result.text)} segments=${result.segments.length}`);
  assert.equal(result.text, '');
  assert.equal(result.segments.length, 0);
});

await test('digital silence produces no transcript and no segments', async () => {
  const result = await json(await post('/stt?language=zh', Buffer.alloc(96000), 'application/octet-stream'));
  console.log(`  silence -> text=${JSON.stringify(result.text)} segments=${result.segments.length}`);
  assert.equal(result.text, '');
  assert.equal(result.segments.length, 0);
});

await test('an 8 kHz WAV is rejected as invalid input', async () => {
  const wav = Buffer.alloc(44 + 3200);
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(36 + 3200, 4);
  wav.write('WAVE', 8, 'ascii');
  wav.write('fmt ', 12, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); // PCM
  wav.writeUInt16LE(1, 22); // mono
  wav.writeUInt32LE(8000, 24); // the point of the test: half the expected rate
  wav.writeUInt32LE(16000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34); // bits per sample — must be set, or it is rejected as non-PCM
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(3200, 40);
  const response = await post('/stt', wav, 'audio/wav');
  assert.equal(response.status, 400);
  assert.match((await json(response)).error, /16 kHz/);
});

await test('TTS behaves according to whether a key is configured', async () => {
  const response = await post('/tts', { text: '你好' });
  if (engineInfo.hasKey) {
    // A configured key must produce real audio, not an error page.
    assert.equal(response.status, 200, `expected audio, got HTTP ${response.status}`);
    assert.equal(response.headers.get('content-type'), 'audio/wav');
    const audio = Buffer.from(await response.arrayBuffer());
    console.log(`\n  live MiMo synthesis: ${audio.length} bytes, RIFF=${audio.toString('ascii', 0, 4)}, rate=${audio.readUInt32LE(24)}`);
    assert.equal(audio.toString('ascii', 0, 4), 'RIFF');
    assert.ok(audio.length > 4000, 'synthesized audio is implausibly small');
  } else {
    assert.equal(response.status, 400);
    const body = await json(response);
    assert.equal(body.code, 'no-api-key');
    assert.match(body.error, /API Key/);
  }
});

await test('the TTS request plan proves the MiMo preset shape', async () => {
  const plan = await json(await post('/tts/plan', { text: '念一句试试。', voice: '冰糖' }));
  console.log(`\n  plan: model=${plan.model} path=${plan.path} voice=${plan.audio.voice.kind}:${plan.audio.voice.id} ready=${plan.ready}`);
  assert.equal(plan.provider, 'mimo');
  assert.equal(plan.model, 'mimo-v2.5-tts');
  assert.equal(plan.path, '/chat/completions');
  assert.equal(plan.audio.voice.kind, 'preset');
  assert.equal(plan.audio.voice.id, '冰糖');
  // The text to speak must ride on the assistant message.
  assert.equal(plan.messages[1].role, 'assistant');
  assert.equal(plan.messages[1].contentLength, 6);
  // `ready` mirrors whether a key resolves, so the suite passes either way.
  assert.equal(plan.ready, engineInfo.hasKey);
});

await test('a cloned voice round-trips and plans a voiceclone request', async () => {
  const wav = fs.readFileSync(SPEECH).subarray(0, 32000 + 44);
  const saved = await json(await post('/voices', {
    name: '纳西妲测试',
    filename: 'ref_audio.wav',
    refText: '用于验证声音克隆链路的参考音频',
    dataBase64: wav.toString('base64'),
  }));
  assert.equal(saved.name, '纳西妲测试');

  const list = await json(await fetch(`${VOICE}/voices`));
  assert.ok(list.voices.some((voice) => voice.name === '纳西妲测试'), 'enrolled voice missing from the list');

  const sample = await fetch(`${VOICE}/voices/sample?name=${encodeURIComponent('纳西妲测试')}`);
  assert.equal(sample.status, 200);
  assert.equal(sample.headers.get('content-type'), 'audio/wav');
  const bytes = Buffer.from(await sample.arrayBuffer());
  assert.ok(bytes.length > 1000, 'served sample is too small');

  const plan = await json(await post('/tts/plan', { text: '你好呀。', voice: 'clone:纳西妲测试' }));
  console.log(`  clone plan: model=${plan.model} voice=${plan.audio.voice.kind} mime=${plan.audio.voice.mime} base64=${plan.audio.voice.base64Chars}`);
  assert.equal(plan.model, 'mimo-v2.5-tts-voiceclone');
  assert.equal(plan.audio.voice.kind, 'data-uri');
  assert.equal(plan.audio.voice.mime, 'audio/wav');
  assert.equal(plan.audio.voice.withinLimit, true);
  assert.equal(plan.streaming, false, 'voice cloning must not stream');
  assert.equal(plan.messages[1].role, 'assistant');

  const removed = await json(await fetch(`${VOICE}/voices?name=${encodeURIComponent('纳西妲测试')}`, { method: 'DELETE' }));
  assert.equal(removed.ok, true);
  const again = await fetch(`${VOICE}/voices?name=${encodeURIComponent('纳西妲测试')}`, { method: 'DELETE' });
  assert.equal(again.status, 404, 'deleting a missing voice should be 404');
});

await test('the offline dev-tone provider synthesizes playable audio', async () => {
  await post('/config', { provider: 'dev-tone' });
  const response = await post('/tts', { text: '这一句用来验证离线朗读链路。' });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'audio/wav');
  const audio = Buffer.from(await response.arrayBuffer());
  console.log(`  dev-tone: ${audio.length} bytes, RIFF=${audio.toString('ascii', 0, 4)}, rate=${audio.readUInt32LE(24)}`);
  assert.equal(audio.toString('ascii', 0, 4), 'RIFF');
  assert.equal(audio.readUInt32LE(24), 16000);
  assert.ok(audio.length > 16000, 'tone is shorter than a second of audio');
  await post('/config', { provider: 'mimo' });
});

await test('the settings API persists a whitelisted field', async () => {
  const body = await json(await post('/config', { voice: 'clone:纳西妲', language: 'zh' }));
  assert.equal(body.ok, true);
  assert.equal(body.config.voice, 'clone:纳西妲');
  assert.equal(body.config.language, 'zh');
  await post('/config', { voice: 'mimo_default', language: 'auto' });
});

await test('cross-origin requests are refused', async () => {
  const response = await fetch(`${VOICE}/state`, { headers: { origin: 'http://evil.example' } });
  assert.equal(response.status, 403);
});

await test('the browser half is registered as a client module', async () => {
  // The index and the bundle routes are token-gated, so this checks the wiring
  // that is observable without the page: the package declares a `./client`
  // export, that file registers a module factory, and its id is the package
  // name the loader keys on.
  const manifest = JSON.parse(fs.readFileSync(path.join(plugin, 'package.json'), 'utf8'));
  assert.equal(manifest.dsh.client.platform, 'web');
  const clientPath = manifest.exports['./client'];
  const source = fs.readFileSync(path.join(plugin, clientPath.replace('./', '')), 'utf8');
  assert.ok(source.includes('__ModuleLoader__.load'), 'client bundle does not register with the module loader');
  assert.ok(source.includes(`id: '${manifest.name}'`), 'client bundle id does not match the package name');
  for (const dependency of manifest.dsh.client.inject) {
    assert.ok(dependency.startsWith('@deepseek-ai/dsh-client-'), `unexpected client dependency ${dependency}`);
  }
  console.log(`\n  client module: ${manifest.name} -> ${clientPath} (${source.length} bytes), injects ${manifest.dsh.client.inject.length} packages`);
});

let failures = 0;
for (const [name, ok, message] of results) {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        ${message}`}`);
}
console.log(`\n${results.length - failures}/${results.length} passed against ${BASE}`);
if (engineInfo !== null) {
  console.log(`engine: vad=${engineInfo.vadBackendEffective} stt=${engineInfo.sttBackend}/${engineInfo.precision} provider=${engineInfo.provider} key=${engineInfo.hasKey}`);
}
process.exit(failures === 0 ? 0 : 1);
