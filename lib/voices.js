/**
 * The cloned-voice library.
 *
 * One directory per voice under `<dataRoot>/voices`:
 *
 *   voices/纳西妲/ref_audio.mp3   the reference sample sent to the TTS provider
 *   voices/纳西妲/ref_text.txt    what the sample says (documented, not sent)
 *   voices/纳西妲/meta.json       created/updated timestamps and source
 *
 * MiMo's cloning is zero-shot and takes no reference transcript, but the text
 * is still stored: it documents the sample for the user and other providers do
 * require it.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fail, isFile, log, readJson, writeJsonAtomic } from './util.js';

/** Extensions the providers accept for a clone reference. */
const ALLOWED_EXTENSIONS = new Set(['.wav', '.mp3']);

/**
 * Turn a user-supplied label into a safe single-segment directory name.
 * @param name - raw label from the settings UI.
 */
export function normalizeVoiceName(name) {
  const trimmed = String(name ?? '').trim();
  if (trimmed.length === 0) throw fail('bad-name', '音色名不能为空');
  if (trimmed.length > 64) throw fail('bad-name', '音色名不能超过 64 个字符');
  const safe = trimmed.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+/, '').trim();
  if (safe.length === 0) throw fail('bad-name', '音色名不合法');
  if (safe === '.' || safe === '..') throw fail('bad-name', '音色名不合法');
  return safe;
}

/** Directory holding the whole voice library. */
export function voicesDir(config) {
  const root = config.dataRootResolved ?? config.dataRoot;
  if (typeof root !== 'string' || root.length === 0) throw fail('bad-config', 'voice library root is not configured');
  return path.join(root, 'voices');
}

/**
 * List every voice that has a usable reference sample.
 * @param config - plugin configuration with a resolved data root.
 */
export async function listVoices(config) {
  const root = voicesDir(config);
  let entries = [];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const voices = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    let sample = null;
    for (const extension of ALLOWED_EXTENSIONS) {
      const candidate = path.join(dir, `ref_audio${extension}`);
      if (await isFile(candidate)) {
        sample = candidate;
        break;
      }
    }
    if (sample === null) continue;
    const meta = (await readJson(path.join(dir, 'meta.json'), {})) ?? {};
    const text = await fs.readFile(path.join(dir, 'ref_text.txt'), 'utf8').catch(() => '');
    const stat = await fs.stat(sample).catch(() => null);
    voices.push({
      name: entry.name,
      sample,
      extension: path.extname(sample),
      bytes: stat?.size ?? 0,
      refText: text.trim(),
      createdAt: meta.createdAt ?? null,
      updatedAt: meta.updatedAt ?? null,
      source: meta.source ?? 'upload',
    });
  }
  voices.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
  return voices;
}

/**
 * Read one voice's reference sample by name.
 * @param config - plugin configuration with a resolved data root.
 * @param name - voice directory name.
 */
export async function readVoice(config, name) {
  const safe = normalizeVoiceName(name);
  const dir = path.join(voicesDir(config), safe);
  for (const extension of ALLOWED_EXTENSIONS) {
    const candidate = path.join(dir, `ref_audio${extension}`);
    if (await isFile(candidate)) {
      const bytes = await fs.readFile(candidate);
      const refText = await fs.readFile(path.join(dir, 'ref_text.txt'), 'utf8').catch(() => '');
      return { name: safe, sample: candidate, extension, bytes, refText: refText.trim() };
    }
  }
  throw fail('no-voice', `找不到音色「${safe}」的参考音频`);
}

/**
 * Create or replace a voice from uploaded bytes.
 * @param config - plugin configuration with a resolved data root.
 * @param name - voice label.
 * @param bytes - the uploaded sample.
 * @param filename - original filename, used only for its extension.
 * @param refText - optional transcript.
 * @param source - provenance label (`upload`, `recording`, `import`).
 */
export async function saveVoice(config, name, bytes, filename, refText, source = 'upload') {
  const safe = normalizeVoiceName(name);
  const extension = path.extname(filename ?? '').toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(extension)) {
    throw fail('bad-format', '参考音频必须是 .wav 或 .mp3');
  }
  if (bytes.length === 0) throw fail('bad-format', '参考音频是空文件');
  const dir = path.join(voicesDir(config), safe);
  await fs.mkdir(dir, { recursive: true });
  // A voice keeps exactly one sample; drop the other extension so the reader
  // never has to break a tie.
  for (const other of ALLOWED_EXTENSIONS) {
    if (other !== extension) await fs.rm(path.join(dir, `ref_audio${other}`), { force: true });
  }
  await fs.writeFile(path.join(dir, `ref_audio${extension}`), bytes);
  await fs.writeFile(path.join(dir, 'ref_text.txt'), `${refText ?? ''}\n`, 'utf8');
  const existing = await readJson(path.join(dir, 'meta.json'), null);
  await writeJsonAtomic(path.join(dir, 'meta.json'), {
    name: safe,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    source,
    bytes: bytes.length,
  });
  log(`voice "${safe}" saved (${bytes.length} bytes, ${extension})`);
  return { name: safe, extension, bytes: bytes.length };
}

/**
 * Remove a voice directory.
 * @param config - plugin configuration with a resolved data root.
 * @param name - voice directory name.
 */
export async function deleteVoice(config, name) {
  const safe = normalizeVoiceName(name);
  const dir = path.join(voicesDir(config), safe);
  if (!(await isFile(path.join(dir, 'meta.json'))) && !(await isFile(path.join(dir, 'ref_audio.wav'))) && !(await isFile(path.join(dir, 'ref_audio.mp3')))) {
    throw fail('no-voice', `找不到音色「${safe}」`);
  }
  await fs.rm(dir, { recursive: true, force: true });
  log(`voice "${safe}" removed`);
  return { name: safe };
}
