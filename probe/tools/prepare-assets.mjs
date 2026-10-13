/** Materialize the pinned speech assets. Run: node probe/tools/prepare-assets.mjs */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const plugin = path.join(here, '..', '..', 'dsh-voice-chat');
const url = (relative) => new URL(`file://${path.join(plugin, relative).replaceAll('\\', '/')}`).href;

const { prepareAssets, inspectAssets } = await import(url('lib/assets.js'));

const config = {
  dataRoot: 'C:/Users/74260/.dsh/voice-chat',
  stt: {
    precision: 'int8',
    vadBackend: 'firered',
    vadFallback: 'ten',
    modelDirectory: null,
    vadModelPath: null,
    fireRedDirectory: null,
  },
};

let lastPercent = -1;
const report = await prepareAssets(config, {
  onProgress: (received, total) => {
    if (total > 0) {
      const percent = Math.floor((received / total) * 100);
      if (percent !== lastPercent && percent % 5 === 0) {
        lastPercent = percent;
        console.log(`  downloading ${percent}% (${(received / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB)`);
      }
    }
  },
});
console.log(JSON.stringify(report, null, 2));
const after = await inspectAssets(config, { verify: false });
console.log('ready:', after.ready);
