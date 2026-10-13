/**
 * Why does sherpa-onnx refuse the downloaded ten-vad model, and does Silero
 * work? sherpa's C++ VAD layer calls exit(-1) on a bad model, so each case has
 * to run in its own child process to observe the outcome.
 *
 * Run under Electron-as-node: node probe/verify/vad-backends.mjs [--child <case>]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const self = fileURLToPath(import.meta.url);
const sherpaModule = new URL(`file://${path.join(here, '..', '..', 'dsh-voice-chat', 'lib', 'sherpa.js').replaceAll('\\', '/')}`).href;
const VAD = 'C:/Users/74260/.dsh/voice-chat/vad';

const CASES = {
  'ten-256': { backend: 'tenVad', model: `${VAD}/ten-vad.onnx`, windowSize: 256 },
  'ten-160': { backend: 'tenVad', model: `${VAD}/ten-vad.onnx`, windowSize: 160 },
  silero: { backend: 'sileroVad', model: `${VAD}/silero_vad.onnx`, windowSize: 512 },
};

if (process.argv[2] === '--child') {
  const spec = CASES[process.argv[3]];
  const { loadModule } = await import(sherpaModule);
  const sherpa = loadModule('sherpa-onnx-node');
  console.log(`model exists: ${fs.existsSync(spec.model)} (${fs.statSync(spec.model).size} bytes)`);
  const config = {
    sileroVad: { model: '', threshold: 0.5, minSilenceDuration: 0.35, minSpeechDuration: 0.25, maxSpeechDuration: 30, windowSize: 512 },
    tenVad: { model: '', threshold: 0.5, minSilenceDuration: 0.35, minSpeechDuration: 0.25, maxSpeechDuration: 30, windowSize: spec.windowSize },
    sampleRate: 16000,
    numThreads: 1,
    provider: 'cpu',
    debug: 1,
  };
  config[spec.backend].model = spec.model;
  const detector = new sherpa.Vad(config, 31);
  console.log('Vad constructed OK');
  detector.acceptWaveform(new Float32Array(spec.windowSize));
  console.log('acceptWaveform OK, isEmpty =', detector.isEmpty());
  console.log('RESULT: USABLE');
} else {
  for (const name of Object.keys(CASES)) {
    const code = await new Promise((resolve) => {
      const child = spawn(process.execPath, [self, '--child', name], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      child.stdout.on('data', (c) => { out += c; });
      child.stderr.on('data', (c) => { out += c; });
      child.on('exit', (status) => resolve({ status, out }));
    }).then(({ status, out }) => {
      const verdict = out.includes('RESULT: USABLE') ? 'USABLE' : `FAILED (exit ${status})`;
      console.log(`${name.padEnd(9)} -> ${verdict}`);
      if (!out.includes('RESULT: USABLE')) {
        const line = out.split('\n').map((l) => l.trim()).filter(Boolean).slice(-2).join(' | ');
        console.log(`          ${line.slice(0, 200)}`);
      }
      return status;
    });
    void code;
  }
}
