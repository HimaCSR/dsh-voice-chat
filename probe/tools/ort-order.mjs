/**
 * Do sherpa-onnx and onnxruntime-node coexist in one process?
 *
 * Both ship a file named `onnxruntime.dll`. Windows resolves a native addon's
 * dependent DLLs by base name against what is already loaded, so the load
 * ORDER decides which copy a binding binds to — and a version mismatch shows up
 * as ERR_DLOPEN_FAILED ("The operating system cannot run %1").
 *
 * Run under Electron-as-node and under plain node and compare.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function attempt(label, body) {
  try {
    console.log(`${label}: ${body() ?? 'OK'}`);
    return true;
  } catch (error) {
    console.log(`${label}: FAIL [${error.code}] ${String(error.message).split('\n')[0]}`);
    return false;
  }
}

const order = process.argv[2] ?? 'sherpa-first';

if (order === 'sherpa-first') {
  attempt('load sherpa-onnx-node', () => {
    const sherpa = require('sherpa-onnx-node');
    return `v? keys=${Object.keys(sherpa).length}`;
  });
  attempt('load onnxruntime-node after sherpa', () => {
    const ort = require('onnxruntime-node');
    return `ort ${ort.env.versions?.node ?? '?'}`;
  });
} else {
  attempt('load onnxruntime-node', () => {
    const ort = require('onnxruntime-node');
    return `ort ${ort.env.versions?.node ?? '?'}`;
  });
  attempt('load sherpa-onnx-node after ort', () => {
    const sherpa = require('sherpa-onnx-node');
    // Prove the binding is actually usable, not merely imported.
    const vad = new sherpa.Vad(
      {
        sileroVad: { model: '', threshold: 0.5, minSilenceDuration: 0.5, minSpeechDuration: 0.25, maxSpeechDuration: 20, windowSize: 512 },
        tenVad: { model: '', threshold: 0.5, minSilenceDuration: 0.5, minSpeechDuration: 0.25, maxSpeechDuration: 20, windowSize: 256 },
        sampleRate: 16000,
        numThreads: 1,
        provider: 'cpu',
        debug: 0,
      },
      21,
    );
    return `sherpa Vad constructed (${typeof vad.acceptWaveform})`;
  });
}
