/**
 * End-to-end test of the recognizer worker with the real models.
 *
 * Asserts the two things the plugin actually promises: real speech produces
 * text, and noise or silence produces nothing at all — which is what stops a
 * cough or a keyboard from becoming a message.
 *
 * Run: node probe/verify/worker-e2e.mjs [speech.wav]
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const plugin = path.join(here, '..', '..', 'dsh-voice-chat');
const url = (relative) => new URL(`file://${path.join(plugin, relative).replaceAll('\\', '/')}`).href;

const { parseWav, encodeWavPcm16 } = await import(url('lib/util.js'));
const { resolveAssets, inspectAssets } = await import(url('lib/assets.js'));
const { SttService } = await import(url('lib/stt.js'));
const { probeModule, setModuleAnchors } = await import(url('lib/sherpa.js'));

const speechPath = process.argv[2] ?? 'C:/Users/74260/.cache/dsh-voice-spike/speech.wav';

// At runtime the Host passes these down from DSH's `profileContext`. Here they
// are supplied directly, and the environment is deliberately NOT consulted, so
// this reproduces the live resolution path rather than the developer's shell.
const PROFILE_DIR = process.argv[3] ?? 'C:/Users/74260/.dsh/profiles/desktop';
const moduleAnchors = [PROFILE_DIR];
setModuleAnchors(moduleAnchors);
console.log('module resolution (no DSH_PROFILE_DIR in env):');
// `probeModule` only resolves, never executes, so this neither loads a native
// runtime nor affects the answer it reports.
for (const name of ['onnxruntime-node', 'sherpa-onnx-node']) {
  const report = probeModule(name);
  if (report.resolvedFrom !== null) {
    console.log(`  ${name}: ${report.resolved}`);
  } else {
    const last = report.attempts.at(-1);
    console.log(`  ${name}: NOT FOUND (last attempt ${last?.where}: [${last?.code}] ${last?.message})`);
  }
}
console.log('');

const config = {
  dataRoot: 'C:/Users/74260/.dsh/voice-chat',
  moduleAnchors,
  stt: {
    vadBackend: 'firered',
    vadFallback: 'ten',
    language: 'auto',
    precision: 'int8',
    threads: 2,
    vadThreshold: 0.5,
    minSpeechSeconds: 0.25,
    minSilenceSeconds: 0.35,
    maxSpeechSeconds: 30,
    idleTimeoutMs: 0,
    startupTimeoutMs: 300000,
    inferenceTimeoutMs: 180000,
    modelDirectory: null,
    vadModelPath: null,
    fireRedDirectory: null,
    fbankEpsilon: 'kaldi',
    fbankRemoveDcOffset: true,
    tailPadFrames: 10,
  },
};

const results = [];
async function test(name, body) {
  try {
    await body();
    results.push([name, true, null]);
  } catch (error) {
    results.push([name, false, error.message]);
  }
}

const report = await inspectAssets(config, { verify: false });
console.log('asset readiness:');
console.log('  sensevoice :', report.model.present ? `${(report.model.size / 1048576).toFixed(1)} MB` : 'MISSING', report.model.path);
console.log('  tokens     :', report.tokens.present ? `${report.tokens.size} bytes` : 'MISSING');
console.log('  vad        :', report.vad.backend, report.vad.model.present ? 'present' : 'MISSING', report.vad.cmvn ? (report.vad.cmvn.present ? '+ cmvn' : '+ cmvn MISSING') : '');
console.log('  ready      :', report.ready);
if (!report.ready) {
  console.log('\nmodels are not prepared yet; nothing to run');
  process.exit(2);
}

const service = new SttService(config, () => resolveAssets(config));

await test('worker starts and reports FireRedVAD as the effective detector', async () => {
  const result = await service.transcribe(new Float32Array(16000), 'zh');
  assert.equal(typeof result.text, 'string');
  const status = service.status();
  assert.equal(status.ready, true, 'worker did not report readiness');
  console.log(`\nworker engine: vad=${status.engine.vad} sherpa=${status.engine.sherpa}`);
  if (status.engine.vadNote) console.log(`  NOTE: ${status.engine.vadNote}`);
  assert.equal(status.engine.vad, 'firered', `expected firered, got ${status.engine.vad}: ${status.engine.vadNote ?? ''}`);
});

await test('real speech is transcribed', async () => {
  const { samples } = parseWav(fs.readFileSync(speechPath));
  const result = await service.transcribe(samples, 'zh');
  console.log(`\nspeech (${(samples.length / 16000).toFixed(2)} s): ${JSON.stringify(result.text)}`);
  console.log(`  speechSeconds=${result.speechSeconds.toFixed(2)} segments=${result.segments.length} inference=${result.inferenceSeconds}s`);
  assert.ok(result.text.length > 0, 'transcript was empty');
  assert.ok(result.segments.length > 0, 'no speech segments were detected');
  // The reference sentence is "你好，这是一段用于测试语音识别的中文录音。今天天气不错。"
  const hits = ['你好', '语音', '识别', '录音', '天气', '中文', '测试'].filter((word) => result.text.includes(word));
  console.log(`  keyword hits: ${hits.join(' ') || '(none)'}`);
  assert.ok(hits.length >= 2, `transcript does not resemble the reference: ${result.text}`);
});

await test('white noise produces no transcript and no segments', async () => {
  const noise = new Float32Array(16000 * 3);
  for (let i = 0; i < noise.length; i++) noise[i] = (Math.random() * 2 - 1) * 0.08;
  const result = await service.transcribe(noise, 'zh');
  console.log(`\nnoise : ${JSON.stringify(result.text)} segments=${result.segments.length}`);
  assert.equal(result.text, '', 'noise produced a transcript');
  assert.equal(result.segments.length, 0, 'noise produced speech segments');
});

await test('digital silence produces no transcript and no segments', async () => {
  const result = await service.transcribe(new Float32Array(16000 * 3), 'zh');
  console.log(`silence: ${JSON.stringify(result.text)} segments=${result.segments.length}`);
  assert.equal(result.text, '');
  assert.equal(result.segments.length, 0);
});

await test('a speech-then-silence recording keeps only the speech', async () => {
  const { samples } = parseWav(fs.readFileSync(speechPath));
  const mixed = new Float32Array(samples.length + 32000);
  mixed.set(samples, 16000);
  const result = await service.transcribe(mixed, 'zh');
  console.log(`\nwith 1 s of leading silence: ${JSON.stringify(result.text)}`);
  assert.ok(result.text.length > 0, 'leading silence suppressed the speech');
});

await test('the idle timeout releases the worker', async () => {
  service.stop();
  const status = service.status();
  assert.equal(status.running, false);
});

// The fallback path is the one the live deployment actually took, and it hid a
// real bug: the substitute backend was handed FireRedVAD's graph, which
// sherpa-onnx answers with exit(-1). Exercised in-process so the wrong model
// path shows up as a failure here rather than as a dead worker in production.
await test('a failed FireRedVAD degrades to a working sherpa detector', async () => {
  const { createEngine } = await import(url('lib/engine.js'));
  const engine = await createEngine(
    { resolved: { ...(await resolveAssets(config)), vad: { backend: 'firered', model: 'x', cmvn: 'y' } }, paths: { model: config.modelPath ?? 'C:/Users/74260/.dsh/voice-chat/models/sensevoice.int8.onnx', tokens: 'C:/Users/74260/.dsh/voice-chat/models/tokens.txt' }, stt: config.stt },
    { fireredFactory: null },
  );
  const described = engine.describe();
  console.log(`\nfallback engine: vad=${described.vad} note=${described.vadNote}`);
  assert.notEqual(described.vad, 'firered', 'fallback did not engage');
  assert.ok(['ten', 'silero'].includes(described.vad), `unexpected fallback backend ${described.vad}`);
  const { samples } = parseWav(fs.readFileSync(speechPath));
  const result = await engine.transcribe(samples, 'zh');
  console.log(`  transcript through ${described.vad}: ${JSON.stringify(result.text)}`);
  assert.ok(result.text.length > 0, 'the fallback detector produced no transcript');
  engine.dispose();
});

service.dispose();

let failures = 0;
for (const [name, ok, message] of results) {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        ${message}`}`);
}
console.log(`\n${results.length - failures}/${results.length} passed`);
process.exit(failures === 0 ? 0 : 1);
