/**
 * Static pre-flight for the bundle manifest and loader patch.
 *
 * Activation failures for a missing file or a malformed patch are avoidable and
 * expensive to debug live, so both are checked here first.
 *
 * Run under Electron-as-node (js-yaml comes from the DSH installation):
 *   ELECTRON_RUN_AS_NODE=1 "DeepSeek Harness.exe" probe/verify/manifest-check.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..', 'dsh-voice-chat');
const require = createRequire(path.join(process.resourcesPath ?? '', 'app.asar', 'dsh', 'package.json'));
const yaml = require('js-yaml');

const problems = [];
const notes = [];

const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
notes.push(`package name: ${manifest.name}@${manifest.version}`);

if (manifest.name !== '@local/dsh-voice-chat') problems.push('unexpected package name');
if (manifest.type !== 'module') problems.push('package must be an ES module ("type": "module")');
if (!manifest.dsh?.bundle?.patch) problems.push('dsh.bundle.patch is missing');
if (manifest.dsh?.client?.platform !== 'web') problems.push('dsh.client.platform must be "web"');
if (!Array.isArray(manifest.dsh?.client?.inject) || manifest.dsh.client.inject.length === 0) {
  problems.push('dsh.client.inject must list the browser modules this plugin requires');
}
if (!manifest.icon) problems.push('icon is missing (display metadata)');

// Every declared export must exist on disk; a missing entry fails activation.
for (const [subpath, target] of Object.entries(manifest.exports ?? {})) {
  const file = typeof target === 'string' ? target : target?.default;
  if (typeof file !== 'string') continue;
  if (file.includes('*')) continue;
  const resolved = path.join(root, file);
  if (!fs.existsSync(resolved)) problems.push(`exports["${subpath}"] points at a missing file: ${file}`);
}
for (const entry of ['index.js', 'client.js', 'lib/firered-vad.js', 'lib/worker.js']) {
  if (!fs.existsSync(path.join(root, entry))) problems.push(`missing source file: ${entry}`);
}
if (!fs.existsSync(path.join(root, 'locale', 'zh.json'))) notes.push('locale/zh.json is missing (falls back to package.json)');

// The loader patch must parse and insert a row whose name is the package name,
// because the browser half is attached only to that exact specifier.
const patchText = fs.readFileSync(path.join(root, manifest.dsh.bundle.patch), 'utf8');
let patch = null;
try {
  patch = yaml.load(patchText);
} catch (error) {
  problems.push(`cordis.patch.yml does not parse: ${error.message}`);
}
if (Array.isArray(patch)) {
  const rows = [];
  for (const layer of patch) {
    if (Array.isArray(layer?.insert)) rows.push(...layer.insert);
  }
  if (rows.length === 0) problems.push('cordis.patch.yml inserts no rows');
  for (const row of rows) {
    notes.push(`patch row: id=${row.id} name=${row.name}`);
    if (row.name !== manifest.name) {
      problems.push(`patch row name "${row.name}" must equal the package name "${manifest.name}" so the browser half attaches`);
    }
    const config = row.config ?? {};
    if (config.stt?.vadBackend && !['firered', 'ten', 'silero'].includes(config.stt.vadBackend)) {
      problems.push(`unknown stt.vadBackend "${config.stt.vadBackend}"`);
    }
    if (config.tts?.provider && !['mimo', 'openai-speech', 'dev-tone'].includes(config.tts.provider)) {
      problems.push(`unknown tts.provider "${config.tts.provider}"`);
    }
  }
} else if (patch !== null) {
  problems.push('cordis.patch.yml must be a top-level YAML array');
}

// Host module graph: every relative import must resolve.
const seen = new Set();
function walkImports(file) {
  if (seen.has(file)) return;
  seen.add(file);
  const source = fs.readFileSync(file, 'utf8');
  for (const match of source.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
    const target = path.resolve(path.dirname(file), match[1]);
    if (!fs.existsSync(target)) problems.push(`${path.relative(root, file)} imports missing ${match[1]}`);
    else walkImports(target);
  }
}
walkImports(path.join(root, 'index.js'));

const host = await import(new URL(`file://${path.join(root, 'index.js').replaceAll('\\', '/')}`).href);
if (typeof host.apply !== 'function') problems.push('index.js must export apply()');
if (!Array.isArray(host.inject) || !host.inject.includes('webServer')) problems.push('index.js must inject webServer');

for (const note of notes) console.log(`  note: ${note}`);
if (problems.length === 0) {
  console.log('\nmanifest and patch are consistent');
  process.exit(0);
}
console.log('');
for (const problem of problems) console.log(`PROBLEM: ${problem}`);
process.exit(1);
