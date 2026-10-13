/**
 * Small dependency-free helpers shared by the Host half of the voice plugin.
 *
 * Everything here is deliberately plain Node: the plugin is installed into a
 * DSH profile as ordinary JavaScript, so it must not assume a build step, a
 * bundler, or that any DSH-internal package is importable by name.
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/**
 * Where diagnostics go. The recognizer worker reserves stdout for its single
 * readiness record, so it redirects diagnostics to stderr; everywhere else the
 * Host log is stdout.
 */
let diagnosticSink = null;

/** Redirect `log` output to stderr; used by the worker before it loads a model. */
export function useStderrDiagnostics() {
  diagnosticSink = (line) => process.stderr.write(`${line}\n`);
}

/** Prefix every diagnostic so the Host log identifies this plugin. */
export function log(...parts) {
  const line = `[voice-chat] ${parts.join(' ')}`;
  if (diagnosticSink !== null) diagnosticSink(line);
  else console.log(line);
}

/** Warn-level diagnostic (kept separate so log scraping can find real errors). */
export function warn(...parts) {
  console.warn('[voice-chat]', ...parts);
}

/** Expand a leading `~` and normalize separators. */
export function expandPath(input) {
  if (typeof input !== 'string' || input.length === 0) return input;
  let value = input;
  if (value === '~') value = os.homedir();
  else if (value.startsWith('~/') || value.startsWith('~\\')) value = path.join(os.homedir(), value.slice(2));
  return path.resolve(value);
}

/** Directory the local models and cloned voices live under. */
export function defaultDataRoot() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, 'voice-chat');
}

/** Read a JSON file, returning `fallback` for a missing or unreadable file. */
export async function readJson(file, fallback = undefined) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** Write JSON through a sibling temp file so readers never see a partial file. */
export async function writeJsonAtomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(temp, file);
}

/** True when the path exists and is a file. */
export async function isFile(file) {
  try {
    return (await fs.stat(file)).isFile();
  } catch {
    return false;
  }
}

/** Byte size of a file, or -1 when it is absent. */
export async function fileSize(file) {
  try {
    return (await fs.stat(file)).size;
  } catch {
    return -1;
  }
}

/** Streaming SHA-256 of a file as lowercase hex. */
export async function sha256File(file) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(file), hash);
  return hash.digest('hex');
}

/**
 * Collect a whole request body, refusing anything above `limit` bytes.
 * @param request - inbound `node:http` request.
 * @param limit - maximum accepted byte count.
 * @returns the request body.
 */
export async function readBody(request, limit) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > limit) {
      const error = new Error(`request body exceeds ${limit} bytes`);
      error.code = 'too-large';
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Reply with JSON and close the response. */
export function sendJson(response, status, value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  });
  response.end(body);
}

/** Reply with raw bytes and close the response. */
export function sendBytes(response, status, body, contentType) {
  response.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'cache-control': 'no-store',
  });
  response.end(body);
}

/** Reject with a classified error so route handlers can map it to a status. */
export function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * Download a file with progress reporting.
 *
 * The body is streamed to a temporary sibling and renamed on success, so an
 * interrupted download is never mistaken for a complete one.
 * @param url - absolute http(s) URL.
 * @param destination - final path.
 * @param options - `fetch` implementation, expected byte count and progress sink.
 */
export async function downloadToFile(url, destination, options = {}) {
  const { fetchImpl = globalThis.fetch, expectedBytes = -1, onProgress, signal, timeoutMs = 600000 } = options;
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const temp = `${destination}.${process.pid}.part`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('download timed out')), timeoutMs);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }
  try {
    const response = await fetchImpl(url, { redirect: 'follow', signal: controller.signal });
    if (!response.ok) throw fail('http', `HTTP ${response.status} for ${url}`);
    let received = 0;
    const sink = createWriteStream(temp);
    const body = Readable.fromWeb(response.body);
    body.on('data', (chunk) => {
      received += chunk.length;
      if (onProgress) onProgress(received, expectedBytes);
    });
    await pipeline(body, sink);
    if (expectedBytes >= 0 && received !== expectedBytes) {
      throw fail('size', `expected ${expectedBytes} bytes but received ${received}`);
    }
    await fs.rename(temp, destination);
    return received;
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => {});
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Parse a canonical 16 kHz mono PCM16 WAV.
 *
 * Only the shape this plugin produces and the browser produces is accepted;
 * anything else is rejected rather than silently misinterpreted.
 * @param buffer - complete WAV bytes.
 * @returns sample rate, channel count and decoded Float32 samples.
 */
export function parseWav(buffer) {
  if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw fail('invalid-wav', 'not a RIFF/WAVE file');
  }
  let offset = 12;
  let format = null;
  let data = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (id === 'fmt ') {
      format = {
        audioFormat: buffer.readUInt16LE(start),
        channels: buffer.readUInt16LE(start + 2),
        sampleRate: buffer.readUInt32LE(start + 4),
        bitsPerSample: buffer.readUInt16LE(start + 14),
      };
    } else if (id === 'data') {
      data = { start, size: Math.min(size, buffer.length - start) };
    }
    offset = start + size + (size % 2);
  }
  if (!format || !data) throw fail('invalid-wav', 'missing fmt or data chunk');
  if (format.audioFormat !== 1 || format.bitsPerSample !== 16) {
    throw fail('invalid-wav', 'only 16-bit PCM WAV is accepted');
  }
  if (format.channels < 1) throw fail('invalid-wav', 'invalid channel count');
  const frames = Math.floor(data.size / (2 * format.channels));
  const samples = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < format.channels; c++) {
      sum += buffer.readInt16LE(data.start + (i * format.channels + c) * 2);
    }
    samples[i] = sum / format.channels / 32768;
  }
  return { sampleRate: format.sampleRate, channels: format.channels, samples };
}

/**
 * Interpret a request body as 16 kHz mono audio.
 *
 * The browser posts either a WAV blob or bare little-endian PCM16 frames; both
 * are used by different call sites and neither is ambiguous.
 * @param buffer - request body.
 * @param contentType - request content type.
 * @returns `{ sampleRate, samples }`.
 */
export function decodeAudioBody(buffer, contentType = '') {
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF') {
    const parsed = parseWav(buffer);
    if (parsed.sampleRate !== 16000) throw fail('invalid-wav', `expected 16 kHz audio, got ${parsed.sampleRate} Hz`);
    return { sampleRate: 16000, samples: parsed.samples };
  }
  if (buffer.length < 2) throw fail('invalid-audio', 'empty audio body');
  if (contentType.includes('application/octet-stream') || contentType === '') {
    const count = Math.floor(buffer.length / 2);
    const samples = new Float32Array(count);
    for (let i = 0; i < count; i++) samples[i] = buffer.readInt16LE(i * 2) / 32768;
    return { sampleRate: 16000, samples };
  }
  throw fail('invalid-audio', `unsupported content type ${contentType}`);
}

/** Wrap Float32 samples in a 16-bit mono WAV container. */
export function encodeWavPcm16(samples, sampleRate = 16000) {
  const frames = samples.length;
  const buffer = Buffer.alloc(44 + frames * 2);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + frames * 2, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i++) {
    const value = Math.max(-1, Math.min(1, samples[i]));
    buffer.writeInt16LE(Math.round(value < 0 ? value * 0x8000 : value * 0x7fff), 44 + i * 2);
  }
  return buffer;
}
