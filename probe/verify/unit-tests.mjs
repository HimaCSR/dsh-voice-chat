/**
 * Host-side unit tests for the voice plugin. No models, no network.
 * Run: node probe/verify/unit-tests.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const plugin = path.join(here, '..', '..', 'dsh-voice-chat');
const url = (relative) => new URL(`file://${path.join(plugin, relative).replaceAll('\\', '/')}`).href;

const {
  parseWav, encodeWavPcm16, decodeAudioBody, expandPath, defaultDataRoot, readJson, writeJsonAtomic,
} = await import(url('lib/util.js'));
const { parseCmvnArk, INTERNALS, StreamVadPostprocessor, decisionsToSegments } = await import(url('lib/firered-vad.js'));
const { describeRequest, cloneDataUri, CLONE_DATA_URI_LIMIT, isPresetVoice } = await import(url('lib/tts.js'));
const { normalizeVoiceName } = await import(url('lib/voices.js'));

const results = [];
async function test(name, body) {
  try {
    await body();
    results.push([name, true, null]);
  } catch (error) {
    results.push([name, false, error.message]);
  }
}

// ── CMVN ────────────────────────────────────────────────────────────────────
await test('cmvn.ark parses to the documented fixture', () => {
  const bytes = fs.readFileSync('C:/Users/74260/.dsh/voice-chat/vad/firered/cmvn.ark');
  assert.equal(bytes.length, 1311);
  const { means, istd, count } = parseCmvnArk(bytes);
  assert.equal(count, 1694418954);
  const expectMeans = [10.42295, 10.8621, 11.76454, 12.49016, 13.25983];
  const expectIstd = [0.2495, 0.23563, 0.23145, 0.23322, 0.23183];
  for (let i = 0; i < 5; i++) {
    assert.ok(Math.abs(means[i] - expectMeans[i]) < 1e-4, `mean[${i}] ${means[i]} != ${expectMeans[i]}`);
    assert.ok(Math.abs(istd[i] - expectIstd[i]) < 1e-4, `istd[${i}] ${istd[i]} != ${expectIstd[i]}`);
  }
});

await test('cmvn.ark rejects a truncated buffer', () => {
  assert.throws(() => parseCmvnArk(Buffer.alloc(100)), /expected at least/);
});

// ── fbank ───────────────────────────────────────────────────────────────────
await test('fbank frame count follows snip_edges', () => {
  const fbank = INTERNALS.createFbank({});
  assert.equal(fbank.frameCount(16000), 98);
  assert.equal(fbank.frameCount(400), 1);
  assert.equal(fbank.frameCount(399), 0);
});

await test('fbank of digital silence is the log floor on every dimension', () => {
  const { frames, count } = INTERNALS.createFbank({}).extract(new Float32Array(16000));
  assert.equal(count, 98);
  const floor = Math.log(INTERNALS.FLT_EPSILON);
  for (let i = 0; i < frames.length; i++) {
    assert.ok(Number.isFinite(frames[i]), `non-finite feature at ${i}`);
    assert.ok(Math.abs(frames[i] - floor) < 1e-4, `feature ${i} = ${frames[i]}, expected ${floor}`);
  }
});

await test('fbank scales samples into the int16 domain the model expects', () => {
  // A tone at 1 kHz: one sample amplitude. With the scaling in place the mel
  // energy must land near the model's own mean range (ln units), not near the
  // log floor.
  const tone = new Float32Array(16000);
  for (let i = 0; i < tone.length; i++) tone[i] = 0.5 * Math.sin((2 * Math.PI * 1000 * i) / 16000);
  const { frames } = INTERNALS.createFbank({}).extract(tone);
  let max = -Infinity;
  for (const value of frames) if (value > max) max = value;
  assert.ok(max > 5, `loudest mel bin was ${max}; expected well above the log floor`);
});

// ── WAV round trip ──────────────────────────────────────────────────────────
await test('WAV encode -> parse round trip preserves samples', () => {
  const samples = new Float32Array(1000);
  for (let i = 0; i < samples.length; i++) samples[i] = Math.sin(i / 7) * 0.8;
  const parsed = parseWav(encodeWavPcm16(samples, 16000));
  assert.equal(parsed.sampleRate, 16000);
  assert.equal(parsed.channels, 1);
  assert.equal(parsed.samples.length, 1000);
  for (let i = 0; i < samples.length; i++) {
    assert.ok(Math.abs(parsed.samples[i] - samples[i]) < 1e-4, `sample ${i} drifted`);
  }
});

await test('decodeAudioBody accepts bare PCM16 and WAV, rejects 8 kHz', () => {
  const pcm = Buffer.alloc(320);
  for (let i = 0; i < 160; i++) pcm.writeInt16LE(i * 100, i * 2);
  assert.equal(decodeAudioBody(pcm, 'application/octet-stream').samples.length, 160);
  assert.equal(decodeAudioBody(encodeWavPcm16(new Float32Array(160), 16000), 'audio/wav').samples.length, 160);
  assert.throws(() => decodeAudioBody(encodeWavPcm16(new Float32Array(160), 8000), 'audio/wav'), /expected 16 kHz/);
  assert.throws(() => decodeAudioBody(Buffer.alloc(0), 'application/octet-stream'), /empty audio/);
});

// ── endpoint state machine ──────────────────────────────────────────────────
await test('endpoint machine pads the start and closes the trailing segment', () => {
  const post = new StreamVadPostprocessor({ speechThreshold: 0.5, minSpeechFrame: 8, minSilenceFrame: 20 });
  const results = [];
  // 50 quiet frames, 100 loud frames, 50 quiet frames.
  for (let i = 0; i < 50; i++) results.push(post.process(0.01));
  for (let i = 0; i < 100; i++) results.push(post.process(0.99));
  for (let i = 0; i < 50; i++) results.push(post.process(0.01));
  const trailing = post.finalize(results.length);
  if (trailing !== null) results.push(trailing);
  const segments = decisionsToSegments(results);
  assert.equal(segments.length, 1, `expected one segment, got ${segments.length}`);
  // Start is padded back by pad_start_frame (5) from the first speech frame.
  assert.ok(segments[0].startFrame < 51, `start frame ${segments[0].startFrame} was not padded back`);
  assert.ok(segments[0].endFrame >= 150, `end frame ${segments[0].endFrame} closed too early`);
});

await test('endpoint machine emits nothing for continuous silence', () => {
  const post = new StreamVadPostprocessor({});
  const results = [];
  for (let i = 0; i < 500; i++) results.push(post.process(0.001));
  assert.equal(decisionsToSegments(results).length, 0);
});

// ── TTS request description ─────────────────────────────────────────────────
const baseConfig = {
  tts: { provider: 'mimo', model: 'mimo-v2.5-tts', cloneModel: 'mimo-v2.5-tts-voiceclone', format: 'wav', voice: 'mimo_default' },
};

await test('describeRequest reports a preset voice request', () => {
  const plan = describeRequest({ text: '测试一下。', voice: '冰糖', config: baseConfig });
  assert.equal(plan.model, 'mimo-v2.5-tts');
  assert.equal(plan.path, '/chat/completions');
  assert.equal(plan.audio.voice.kind, 'preset');
  assert.equal(plan.audio.voice.id, '冰糖');
  // The text must ride on the assistant message; the user message is style only.
  assert.equal(plan.messages[1].role, 'assistant');
  assert.equal(plan.messages[1].contentLength, 5);
  assert.equal(plan.ready, false, 'no key is configured in this test process');
});

await test('describeRequest reports a clone request as a bounded data URI', () => {
  const uri = `data:audio/wav;base64,${Buffer.alloc(64).toString('base64')}`;
  const plan = describeRequest({ text: '你好', voice: uri, config: baseConfig });
  assert.equal(plan.model, 'mimo-v2.5-tts-voiceclone');
  assert.equal(plan.audio.voice.kind, 'data-uri');
  assert.equal(plan.audio.voice.mime, 'audio/wav');
  assert.equal(plan.audio.voice.withinLimit, true);
  assert.ok(plan.audio.voice.base64Chars < CLONE_DATA_URI_LIMIT);
});

await test('cloneDataUri enforces the format and size rules', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-clone-'));
  const wav = path.join(dir, 'ref_audio.wav');
  fs.writeFileSync(wav, Buffer.alloc(1024));
  assert.ok(cloneDataUri(wav, fs.readFileSync(wav)).startsWith('data:audio/wav;base64,'));
  const bad = path.join(dir, 'ref_audio.flac');
  fs.writeFileSync(bad, Buffer.alloc(16));
  assert.throws(() => cloneDataUri(bad, fs.readFileSync(bad)), /wav 或 \.mp3/);
  const big = path.join(dir, 'ref_audio.mp3');
  assert.throws(() => cloneDataUri(big, Buffer.alloc(Math.ceil(CLONE_DATA_URI_LIMIT * 0.8))), /10 MB/);
  fs.rmSync(dir, { recursive: true, force: true });
});

await test('isPresetVoice distinguishes presets from clone ids', () => {
  assert.equal(isPresetVoice('mimo_default'), true);
  assert.equal(isPresetVoice('冰糖'), true);
  assert.equal(isPresetVoice('clone:纳西妲'), false);
});

// ── voice library safety ────────────────────────────────────────────────────
await test('voice names cannot escape the library directory', () => {
  assert.equal(normalizeVoiceName('纳西妲'), '纳西妲');
  assert.equal(normalizeVoiceName('a/b\\c'), 'a_b_c');
  assert.throws(() => normalizeVoiceName('..'), /不合法/);
  assert.throws(() => normalizeVoiceName('   '), /不能为空/);
  assert.throws(() => normalizeVoiceName('x'.repeat(65)), /64 个字符/);
});

// ── client half pure helpers ────────────────────────────────────────────────
await test('client text helpers split, clean and drop trivia', async () => {
  let spec = null;
  globalThis.window = { __ModuleLoader__: { load: (value) => { spec = value; } } };
  await import(`${url('client.js')}?unit=1`);
  assert.ok(spec !== null, 'client bundle never registered a module');
  assert.equal(spec.id, '@local/dsh-voice-chat');
  const reactStub = {
    createElement: () => null,
    useCallback: (fn) => fn,
    useEffect: () => {},
    useLayoutEffect: () => {},
    useRef: (value) => ({ current: value }),
    useState: (value) => [value, () => {}],
  };
  const pluginHalf = spec.factory((name) => {
    if (name === 'react') return reactStub;
    throw new Error(`unexpected require(${name})`);
  });
  const { splitSentences, cleanReplyText } = pluginHalf.__internals;

  const split = splitSentences('你好。世界！这是第三句');
  assert.deepEqual(split.sentences, ['你好。', '世界！']);
  assert.equal(split.partial, '这是第三句');
  assert.deepEqual(splitSentences('。！？').sentences, [], 'punctuation-only input must not be spoken');

  const cleaned = cleanReplyText('## 标题\n\n看这段代码`x=1` 和这个链接https://example.com/a\n\n```js\nconst a = 1\n```\n最后一句。');
  assert.ok(!cleaned.includes('```'), 'code fence survived cleaning');
  assert.ok(!cleaned.includes('http'), 'URL survived cleaning');
  assert.ok(!cleaned.includes('`'), 'inline code survived cleaning');
  assert.ok(cleaned.includes('最后一句。'));
  assert.ok(cleanReplyText('字'.repeat(100), 20).length <= 21);
});

await test('the client half applies and registers both of its seats', async () => {
  let spec = null;
  globalThis.window = { __ModuleLoader__: { load: (value) => { spec = value; } } };
  await import(`${url('client.js')}?unit=2`);
  const reactStub = {
    createElement: () => null,
    useCallback: (fn) => fn,
    useEffect: () => {},
    useLayoutEffect: () => {},
    useRef: (value) => ({ current: value }),
    useState: (value) => [value, () => {}],
  };
  const pluginHalf = spec.factory((name) => {
    if (name === 'react') return reactStub;
    throw new Error(`unexpected require(${name})`);
  });
  assert.deepEqual(pluginHalf.inject, ['slots', 'locale', 'sessions']);

  const seen = [];
  const ctx = {
    effect: (body, label) => {
      const disposer = body();
      seen.push(['effect', label, typeof disposer]);
      return () => {};
    },
    locale: { register: (namespace, dictionary) => {
      seen.push(['locale', namespace, Object.keys(dictionary).join(',')]);
      return () => {};
    } },
    slots: {
      inject: (key, callback) => {
        seen.push(['inject', key]);
        const dispose = callback();
        assert.equal(typeof dispose, 'function', `slots.inject(${key}) must return a disposer`);
        return () => {};
      },
      register: (options, component) => {
        seen.push(['register', options.name, options.id, options.locale, typeof component, typeof options.inject]);
        return () => {};
      },
    },
    sessions: { binding: () => undefined },
  };
  pluginHalf.apply(ctx);

  const locale = seen.find((entry) => entry[0] === 'locale');
  assert.equal(locale?.[1], 'voiceChat', 'locale namespace was not registered');
  for (const seat of ['conversation.input.dock', 'conversation.input.left']) {
    assert.ok(seen.some((entry) => entry[0] === 'inject' && entry[1] === seat), `seat ${seat} was not injected`);
    const row = seen.find((entry) => entry[0] === 'register' && entry[1] === seat);
    assert.ok(row !== undefined, `seat ${seat} was not registered`);
    assert.equal(row[3], 'voiceChat', `seat ${seat} must bind the locale namespace`);
    assert.equal(row[5], 'function', `seat ${seat} must supply an inject face`);
  }
  // The inject face is what gives each seat its session scope.
  assert.ok(seen.some((entry) => entry[0] === 'effect' && entry[1].includes('microphone')), 'microphone cleanup effect missing');
});

await test('the orb hugs an edge and its fan never overlaps or escapes', async () => {
  let spec = null;
  globalThis.window = { __ModuleLoader__: { load: (value) => { spec = value; } } };
  await import(`${url('client.js')}?unit=3`);
  const pluginHalf = spec.factory((name) => {
    if (name === 'react') return { createElement: () => null };
    throw new Error(`unexpected require(${name})`);
  });
  const { clampPosition, snapToEdge, layoutFan, viewportBounds, waveRadius } = pluginHalf.__internals;
  const ORB = 52;
  const MARGIN = 6;
  const bounds = { x: 0, y: 0, width: 1000, height: 800 };

  // Outside a browser the fallback area must still be usable, never NaN.
  assert.deepEqual(viewportBounds(), { x: 0, y: 0, width: 1024, height: 768 });

  // Clamping keeps the bead fully inside its movable area.
  assert.deepEqual(clampPosition({ x: -50, y: -50 }, bounds), { x: MARGIN, y: MARGIN });
  assert.deepEqual(clampPosition({ x: 9999, y: 9999 }, bounds),
    { x: bounds.width - ORB - MARGIN, y: bounds.height - ORB - MARGIN });

  // Within one bead diameter of an edge it sticks flush to it, so the flattened
  // side of the droplet actually touches the surface, and reports which edge.
  assert.deepEqual(snapToEdge({ x: 4, y: 300 }, bounds), { x: bounds.x, y: 300, edge: 'left' });
  assert.deepEqual(snapToEdge({ x: bounds.width - ORB - 4, y: 300 }, bounds),
    { x: bounds.x + bounds.width - ORB, y: 300, edge: 'right' });
  assert.deepEqual(snapToEdge({ x: 500, y: 20 }, bounds), { x: 500, y: bounds.y, edge: 'top' });
  assert.deepEqual(snapToEdge({ x: 500, y: bounds.height - ORB - 20 }, bounds),
    { x: 500, y: bounds.y + bounds.height - ORB, edge: 'bottom' });
  // The reach is exactly one bead diameter: a hair past it, nothing happens.
  assert.equal(snapToEdge({ x: MARGIN + ORB, y: 300 }, bounds).edge, 'left');
  assert.equal(snapToEdge({ x: MARGIN + ORB + 2, y: 300 }, bounds), null,
    'beyond one bead diameter the bead must stay where it was dropped');
  assert.equal(snapToEdge({ x: 500, y: 300 }, bounds), null, 'open space must not snap');

  const base = [
    { tx: -138, ty: -8 }, { tx: -94, ty: -46 }, { tx: -46, ty: -68 }, { tx: 4, ty: -72 },
  ];
  const spots = [
    { x: MARGIN, y: MARGIN },
    { x: bounds.width - ORB - MARGIN, y: MARGIN },
    { x: MARGIN, y: bounds.height - ORB - MARGIN },
    { x: bounds.width - ORB - MARGIN, y: bounds.height - ORB - MARGIN },
    { x: 400, y: 600 },
    { x: 500, y: 400 },
    { x: 20, y: 380 },
  ];
  for (const position of spots) {
    const fan = layoutFan(base, position, bounds);
    const where = JSON.stringify(position);
    assert.equal(fan.length, 4, `the fan must keep all four beads at ${where}`);
    const centreX = position.x + ORB / 2;
    const centreY = position.y + ORB / 2;
    for (const { tx, ty } of fan) {
      assert.ok(centreX + tx - 48 >= bounds.x + MARGIN, `bead left edge escaped at ${where}`);
      assert.ok(centreX + tx <= bounds.x + bounds.width - MARGIN, `bead right edge escaped at ${where}`);
      assert.ok(centreY + ty - 68 >= bounds.y + MARGIN, `bead top edge escaped at ${where}`);
      assert.ok(centreY + ty <= bounds.y + bounds.height - MARGIN, `bead bottom edge escaped at ${where}`);
    }
    for (let a = 0; a < fan.length; a += 1) {
      for (let b = a + 1; b < fan.length; b += 1) {
        const overlapX = 48 - Math.abs(fan[b].tx - fan[a].tx);
        const overlapY = 68 - Math.abs(fan[b].ty - fan[a].ty);
        assert.ok(overlapX <= 0 || overlapY <= 0, `beads ${a} and ${b} overlap at ${where}`);
      }
    }
  }

  // A cramped area forces the reflection path rather than a clamp.
  const small = { x: 0, y: 0, width: 200, height: 200 };
  const cramped = layoutFan(base, { x: 100, y: 100 }, small);
  assert.ok(cramped.some((offset, index) => offset.tx !== base[index].tx || offset.ty !== base[index].ty),
    'a cramped area must move the beads inward');

  // Stuck to a vertical edge the beads line up in a column alongside it.
  const column = layoutFan(base, { x: MARGIN, y: 300, edge: 'left' }, bounds, 'left');
  assert.equal(new Set(column.map((offset) => offset.tx)).size, 1,
    'beads clinging to a vertical edge must share one column');
  const stacked = column.map((offset) => offset.ty).sort((a, b) => a - b);
  for (let index = 1; index < stacked.length; index += 1) {
    assert.ok(Math.abs(stacked[index] - stacked[index - 1]) >= 68,
      'stacked beads must not overlap');
  }
  // Stuck to a horizontal edge they line up in a row instead.
  const row = layoutFan(base, { x: 400, y: MARGIN, edge: 'top' }, bounds, 'top');
  assert.equal(new Set(row.map((offset) => offset.ty)).size, 1,
    'beads clinging to a horizontal edge must share one row');

  // The silhouette goes flat against the wet surface and stays round away from
  // it; left/right and top/bottom are mirror pairs.
  const radii = (edge) => waveRadius(0, 0, edge);
  const corners = (edge, axis) => radii(edge).split('/')[axis === 'h' ? 0 : 1].trim()
    .split(/\s+/).map((value) => Number.parseFloat(value));
  const left = corners('left', 'h');
  assert.ok(left[0] < 25 && left[3] < 25, 'the side touching a left edge must flatten');
  assert.ok(left[1] > 75 && left[2] > 75, 'the side facing away must stay round');
  assert.deepEqual(corners('right', 'h'), [left[1], left[0], left[3], left[2]],
    'right must be the mirror of left');
  const top = corners('top', 'v');
  assert.ok(top[0] < 25 && top[1] < 25, 'the side touching a top edge must flatten');
  assert.ok(top[2] > 75 && top[3] > 75, 'the side facing away must stay round');
  assert.deepEqual(corners('bottom', 'v'), [top[2], top[3], top[0], top[1]],
    'bottom must be the mirror of top');
  // Free-floating stays a circle.
  assert.deepEqual(corners(null, 'h'), [50, 50, 50, 50]);
  assert.deepEqual(corners(null, 'v'), [50, 50, 50, 50]);
});

await test('config path helpers are stable', async () => {
  assert.ok(defaultDataRoot().endsWith('voice-chat'));
  assert.ok(expandPath('~').length > 0);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-cfg-'));
  const file = path.join(dir, 'config.json');
  assert.equal(await readJson(file, 'missing'), 'missing');
  await writeJsonAtomic(file, { voice: '冰糖' });
  assert.deepEqual(await readJson(file), { voice: '冰糖' });
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── report ──────────────────────────────────────────────────────────────────
let failures = 0;
for (const [name, ok, message] of results) {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        ${message}`}`);
}
console.log(`\n${results.length - failures}/${results.length} passed`);
process.exit(failures === 0 ? 0 : 1);
