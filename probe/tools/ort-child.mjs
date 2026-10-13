/**
 * Can sherpa-onnx and onnxruntime-node coexist in a spawned child, and does
 * load order decide it?
 *
 * The parent process tolerates both; a spawned Electron-as-node child does not.
 * This pinpoints whether a reorder is enough or the two runtimes need separate
 * processes.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const self = fileURLToPath(import.meta.url);
const sherpaModule = new URL(`file://${path.join(here, '..', '..', 'dsh-voice-chat', 'lib', 'sherpa.js').replaceAll('\\', '/')}`).href;

const MODELS = 'C:/Users/74260/.dsh/voice-chat/models';

if (process.argv[2] === '--child') {
  const order = process.argv[3] ?? 'sherpa-first';
  const { loadModule } = await import(sherpaModule);

  const loadSherpa = () => {
    try {
      const sherpa = loadModule('sherpa-onnx-node');
      console.log('  sherpa-onnx-node: loaded');
      return sherpa;
    } catch (error) {
      console.log(`  sherpa-onnx-node: FAILED [${error.message.split('\n')[1] ?? ''}]`);
      return null;
    }
  };
  const loadOrt = () => {
    try {
      const ort = loadModule('onnxruntime-node');
      console.log('  onnxruntime-node: loaded', ort.env.versions?.node);
      return ort;
    } catch (error) {
      console.log(`  onnxruntime-node: FAILED [${error.message.split('\n')[1] ?? ''}]`);
      return null;
    }
  };

  console.log(`order = ${order}`);
  let sherpa = null;
  let ort = null;
  if (order === 'sherpa-first') {
    sherpa = loadSherpa();
    ort = loadOrt();
  } else {
    ort = loadOrt();
    sherpa = loadSherpa();
  }

  // Prove whichever runtime is present actually works, not merely imports.
  if (sherpa !== null) {
    try {
      const recognizer = new sherpa.OfflineRecognizer({
        featConfig: { sampleRate: 16000, featureDim: 80 },
        modelConfig: {
          senseVoice: { model: `${MODELS}/sensevoice.int8.onnx`, language: 'auto', useInverseTextNormalization: 1 },
          tokens: `${MODELS}/tokens.txt`,
          numThreads: 1,
          provider: 'cpu',
          debug: 0,
        },
      });
      const stream = recognizer.createStream();
      stream.acceptWaveform({ sampleRate: 16000, samples: new Float32Array(16000) });
      recognizer.decode(stream);
      console.log(`  sherpa recognizer usable -> ${JSON.stringify(recognizer.getResult(stream).text)}`);
    } catch (error) {
      console.log(`  sherpa recognizer FAILED: ${String(error.message).split('\n')[0]}`);
    }
  }
  if (ort !== null) {
    try {
      await ort.InferenceSession.create('C:/Users/74260/.dsh/voice-chat/vad/firered/fireredvad_stream_vad_with_cache.onnx', {
        executionProviders: ['cpu'],
        intraOpNumThreads: 1,
      });
      console.log('  ort session usable');
    } catch (error) {
      console.log(`  ort session FAILED: ${String(error.message).split('\n')[0]}`);
    }
  }
} else {
  for (const order of ['sherpa-first', 'ort-first']) {
    await new Promise((resolve) => {
      const child = spawn(process.execPath, [self, '--child', order], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: 'inherit',
      });
      child.on('exit', resolve);
    });
    console.log('');
  }
}
