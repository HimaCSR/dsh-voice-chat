/** Spawn the recognizer worker with inherited stdio to see its real error. */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const worker = path.join(here, '..', '..', 'dsh-voice-chat', 'lib', 'worker.js');
const payload = {
  token: 'a'.repeat(64),
  maxAudioBytes: 8 * 1024 * 1024,
  paths: {
    model: 'C:/Users/74260/.dsh/voice-chat/models/sensevoice.int8.onnx',
    tokens: 'C:/Users/74260/.dsh/voice-chat/models/tokens.txt',
  },
  resolved: {
    vad: {
      backend: 'firered',
      model: 'C:/Users/74260/.dsh/voice-chat/vad/firered/fireredvad_stream_vad_with_cache.onnx',
      cmvn: 'C:/Users/74260/.dsh/voice-chat/vad/firered/cmvn.ark',
    },
  },
  stt: {
    threads: 2,
    vadThreshold: 0.5,
    minSpeechSeconds: 0.25,
    minSilenceSeconds: 0.35,
    maxSpeechSeconds: 30,
    fbankEpsilon: 'kaldi',
    fbankRemoveDcOffset: true,
    tailPadFrames: 10,
  },
};

const child = spawn(process.execPath, [worker, JSON.stringify(payload)], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  stdio: 'inherit',
});
child.on('exit', (code) => console.log('worker exited with', code));
