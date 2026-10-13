/** Why does the native binding load from `-e` but not from a module? */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

const viaUrl = createRequire(import.meta.url);
for (const spec of ['onnxruntime-node']) {
  try {
    const module = viaUrl(spec);
    console.log(`import.meta.url createRequire(${spec}) -> OK`, Object.keys(module).slice(0, 3).join(','));
  } catch (error) {
    console.log(`import.meta.url createRequire(${spec}) -> FAIL [${error.code}] ${String(error.message).split('\n')[0]}`);
  }
}
try {
  const absolute = createRequire(path.join(here, '..', '..', 'dsh-voice-chat', 'lib', 'sherpa.js'));
  const module = absolute('onnxruntime-node');
  console.log('absolute-path createRequire -> OK', Object.keys(module).slice(0, 3).join(','));
} catch (error) {
  console.log(`absolute-path createRequire -> FAIL [${error.code}] ${String(error.message).split('\n')[0]}`);
}
console.log('import.meta.url =', import.meta.url);
console.log('cwd =', process.cwd());
console.log('execPath =', process.execPath);
console.log('resourcesPath =', process.resourcesPath);
console.log('noAsar =', process.noAsar);
