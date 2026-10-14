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
  const { clampPosition, snapToEdge, nearestEdge, dockLayout, dockCentre, viewportBounds, waveRadius } = pluginHalf.__internals;
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

  // Opening the orb breaks it into four droplets that dock against the nearest
  // edge, in a line parallel to it. The exclusion pass is gone: spacing alone
  // separates them, and a line that does not fit is tightened and slid as a whole.
  const BEAD = 44;
  const placements = [
    { position: { x: MARGIN, y: 400 }, edge: 'left' },
    { position: { x: bounds.width - ORB - MARGIN, y: 400 }, edge: 'right' },
    { position: { x: 400, y: MARGIN }, edge: 'top' },
    { position: { x: 400, y: bounds.height - ORB - MARGIN }, edge: 'bottom' },
  ];
  for (const { position, edge } of placements) {
    const where = JSON.stringify(position);
    assert.equal(nearestEdge(position, bounds), edge, `nearest edge at ${where}`);
    const docked = dockLayout(position, bounds, 4);
    assert.equal(docked.length, 4, `all four beads must be placed at ${where}`);
    const vertical = edge === 'left' || edge === 'right';
    const centreX = position.x + ORB / 2;
    const centreY = position.y + ORB / 2;
    // One column alongside a vertical edge, one row along a horizontal one.
    assert.equal(new Set(docked.map((offset) => (vertical ? offset.tx : offset.ty))).size, 1,
      `docked beads must share one ${vertical ? 'column' : 'row'} at ${where}`);
    for (const offset of docked) {
      assert.equal(offset.edge, edge, `every docked bead must carry its edge at ${where}`);
      const left = centreX + offset.tx - BEAD;
      const right = centreX + offset.tx;
      const top = centreY + offset.ty - BEAD;
      const bottom = centreY + offset.ty;
      // Flush means flush: no margin at all, exactly like the orb when it snaps.
      if (edge === 'left') assert.ok(Math.abs(left - bounds.x) < 1e-6, `a left-docked bead must touch the left edge at ${where}`);
      if (edge === 'right') assert.ok(Math.abs(right - (bounds.x + bounds.width)) < 1e-6, `a right-docked bead must touch the right edge at ${where}`);
      if (edge === 'top') assert.ok(Math.abs(top - bounds.y) < 1e-6, `a top-docked bead must touch the top edge at ${where}`);
      if (edge === 'bottom') assert.ok(Math.abs(bottom - (bounds.y + bounds.height)) < 1e-6, `a bottom-docked bead must touch the bottom edge at ${where}`);
      assert.ok(left >= bounds.x - 1e-6 && right <= bounds.x + bounds.width + 1e-6, `a bead escaped sideways at ${where}`);
      assert.ok(top >= bounds.y - 1e-6 && bottom <= bounds.y + bounds.height + 1e-6, `a bead escaped vertically at ${where}`);
      // Mid-flight it is already on the edge and level with the orb: out first,
      // then the edge pulls it along. That is what bends the splash.
      if (vertical) {
        assert.ok(Math.abs(offset.mx - offset.tx) < 1e-6, `a vertical-edge splash must fly straight out at ${where}`);
        assert.ok(Math.abs(offset.my - BEAD / 2) < 1e-6, `and start level with the orb at ${where}`);
      } else {
        assert.ok(Math.abs(offset.my - offset.ty) < 1e-6, `a horizontal-edge splash must fly straight out at ${where}`);
        assert.ok(Math.abs(offset.mx - BEAD / 2) < 1e-6, `and start level with the orb at ${where}`);
      }
    }
    const centres = docked
      .map((offset) => (vertical ? centreY + offset.ty - BEAD / 2 : centreX + offset.tx - BEAD / 2))
      .sort((a, b) => a - b);
    for (let index = 1; index < centres.length; index += 1) {
      assert.ok(centres[index] - centres[index - 1] >= BEAD - 1e-6,
        `docked beads must not overlap at ${where}`);
    }
    // With room to spare the line stays centred on where the orb was, and the orb
    // comes back to the middle of that line once the beads merge.
    const along = docked.map((offset) => (vertical ? offset.ty : offset.tx));
    const middle = along.reduce((sum, value) => sum + value, 0) / along.length;
    assert.ok(Math.abs(middle - BEAD / 2) < 1e-6, `the line must be centred on the orb at ${where}`);
    const back = dockCentre(position, bounds, docked);
    if (vertical) {
      assert.ok(Math.abs(back.y - centreY) < 1e-6, `the orb must return to the middle of the column at ${where}`);
      assert.ok(Math.abs(back.x - (centreX + docked[0].tx - BEAD / 2)) < 1e-6, `and onto the bead line at ${where}`);
    } else {
      assert.ok(Math.abs(back.x - centreX) < 1e-6, `the orb must return to the middle of the row at ${where}`);
      assert.ok(Math.abs(back.y - (centreY + docked[0].ty - BEAD / 2)) < 1e-6, `and onto the bead line at ${where}`);
    }
  }

  // A cramped area tightens the line and slides it as a whole: nothing escapes,
  // even though nothing bounces off an edge any more.
  const small = { x: 0, y: 0, width: 200, height: 200 };
  const cramped = dockLayout({ x: 100, y: 100 }, small, 4);
  assert.equal(cramped.length, 4, 'a cramped area must still place every bead');
  for (const offset of cramped) {
    const centreX = 100 + ORB / 2;
    const centreY = 100 + ORB / 2;
    const left = centreX + offset.tx - BEAD;
    const right = centreX + offset.tx;
    const top = centreY + offset.ty - BEAD;
    const bottom = centreY + offset.ty;
    assert.ok(left >= -1e-6 && right <= small.width + 1e-6, 'a cramped bead escaped sideways');
    assert.ok(top >= -1e-6 && bottom <= small.height + 1e-6, 'a cramped bead escaped vertically');
  }

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

await test('a reshaped area takes a stuck bead with it, and the sheet stays inside', async () => {
  let spec = null;
  globalThis.window = { __ModuleLoader__: { load: (value) => { spec = value; } } };
  await import(`${url('client.js')}?unit=4`);
  const pluginHalf = spec.factory((name) => {
    if (name === 'react') return { createElement: () => null };
    throw new Error(`unexpected require(${name})`);
  });
  const { attachTo, refit, clampPosition, panelLimits, alertPlacement } = pluginHalf.__internals;
  const ORB = 52;
  const bounds = { x: 0, y: 0, width: 1000, height: 800 };

  // The movable area changes shape without the window changing size — dragging
  // the divider beside the conversation does exactly that — so a bead wetted to
  // an edge has to follow that edge instead of being left behind.
  const reshaped = {
    left: { x: 120, y: 0, width: 700, height: 800 },
    right: { x: 0, y: 0, width: 640, height: 600 },
    top: { x: 0, y: 40, width: 1000, height: 700 },
    bottom: { x: 0, y: 0, width: 900, height: 520 },
  };
  const flush = {
    left: (area) => area.x,
    right: (area) => area.x + area.width - ORB,
    top: (area) => area.y,
    bottom: (area) => area.y + area.height - ORB,
  };
  for (const edge of ['left', 'right', 'top', 'bottom']) {
    const from = { x: 300, y: 260, edge };
    const area = reshaped[edge];
    const settled = refit(from, area);
    assert.equal(settled.edge, edge, `refit must keep the edge it had (${edge})`);
    assert.deepEqual(settled, attachTo(edge, from, area), `refit must agree with attachTo (${edge})`);
    const along = edge === 'left' || edge === 'right' ? settled.x : settled.y;
    assert.equal(along, flush[edge](area), `a ${edge}-stuck bead must touch the new ${edge} edge`);
  }

  // A free bead is only kept inside, and must not silently become attached.
  assert.deepEqual(refit({ x: 4000, y: 4000, edge: null }, bounds),
    { ...clampPosition({ x: 4000, y: 4000 }, bounds), edge: null });

  // The sheet is bounded by the movable area, so a bead parked near the bottom
  // cannot push it off screen; both callers read their numbers from here.
  assert.deepEqual(panelLimits({ x: 0, y: 0, width: 300, height: 240 }, false, bounds),
    { width: 284, maxHeight: 224 }, 'the sheet must fit inside a narrow area');
  assert.deepEqual(panelLimits(bounds, true, bounds), { width: 420, maxHeight: 656 },
    'a wide sheet caps at 420 wide and 82% of the viewport');

  // The error bubble goes to whichever side of the bead has room, so a bead in
  // the right half can no longer push the message off screen.
  assert.equal(alertPlacement({ x: 900, y: 300 }, bounds).side, 'left');
  assert.equal(alertPlacement({ x: 20, y: 300 }, bounds).side, 'right');
  const tight = { x: 0, y: 0, width: 200, height: 300 };
  assert.equal(alertPlacement({ x: 20, y: 100 }, tight).maxWidth, 118);
  assert.equal(alertPlacement({ x: 60, y: 100 }, tight).maxWidth, 96);
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
