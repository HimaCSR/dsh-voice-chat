/**
 * Host-side lifecycle for the recognizer worker.
 *
 * The worker is started on first use rather than at plugin activation: loading
 * a 240 MB ONNX model into memory is not something a user should pay for just
 * because the plugin is enabled, and most sessions never touch the microphone.
 *
 * Requests are serialized because the worker decodes on its single thread;
 * concurrent audio would only queue inside it anyway, and serializing keeps the
 * cancellation story simple. An idle timer releases the process — and with it
 * the resident model — after a quiet period.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { decodeAudioBody, fail, encodeWavPcm16, log, warn } from './util.js';

const WORKER = fileURLToPath(new URL('./worker.js', import.meta.url));

/**
 * The WAV container header the encoded body carries.
 *
 * The body the worker reads is a WAV file, so the header is part of it and
 * counts towards the limit.
 */
const WAV_HEADER_BYTES = 44;

/**
 * Per-utterance ceiling; a 30 s recording at 16 kHz mono PCM16 is ~960 KB.
 *
 * The ceiling covers the body that is actually sent — the samples plus the
 * 44-byte WAV header — so the worker is told how much a body may be.
 * Counting the samples alone would refuse a recording that fills the limit
 * exactly: the audio would fit, and the header would not.
 */
const MAX_AUDIO_BYTES = 8 * 1024 * 1024 + WAV_HEADER_BYTES;

/**
 * The failures the shared decoder reports on its own.
 *
 * They are already classified, and the route turns them into 400. Anything
 * else that comes out of the decoder is a crash inside it — a truncated file
 * makes it read past the end of the buffer — and that is the client's
 * mistake rather than a fault of the Host.
 */
const DECODER_CODES = new Set(['invalid-wav', 'invalid-audio']);

/**
 * Read a request body as 16 kHz mono audio.
 *
 * The shared decoder reads the fields of a WAV header without first
 * checking that the chunk they live in is complete: a file whose last chunk
 * is a truncated `fmt ` chunk makes the buffer read past its end, and that
 * failure carries no code of the plugin's own — Node's own error code
 * (`ERR_OUT_OF_RANGE`) is not one the route knows, so it was reported as a
 * Host fault (HTTP 500). A truncated upload is the client's mistake and has
 * to be a 400. The decoder's own failures keep their code.
 * @param buffer - the request body.
 * @param contentType - the request content type.
 * @returns `{ sampleRate, samples }`.
 */
export function decodeSttAudioBody(buffer, contentType = '') {
  try {
    return decodeAudioBody(buffer, contentType);
  } catch (error) {
    if (DECODER_CODES.has(error?.code)) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw fail('bad-request', `音频数据无法解析：${detail}`);
  }
}

/** Manage one recognizer child process. */
export class SttService {
  /**
   * @param config - the resolved plugin configuration.
   * @param resolvePaths - `async () => ({ model, tokens, resolved })`.
   */
  constructor(config, resolvePaths) {
    this.config = config;
    this.resolvePaths = resolvePaths;
    this.child = null;
    this.port = null;
    this.token = null;
    this.starting = null;
    this.describe = null;
    this.lastError = null;
    this.idleTimer = null;
    this.queue = Promise.resolve();
    this.disposed = false;
  }

  /** Snapshot for the settings UI and the readiness route. */
  status() {
    return {
      running: this.child !== null,
      ready: this.port !== null,
      port: this.port,
      engine: this.describe,
      lastError: this.lastError,
    };
  }

  /** Release the worker and stop accepting work. */
  dispose() {
    this.disposed = true;
    this.stop();
  }

  /** Kill the worker if it is running. */
  stop() {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    const child = this.child;
    this.child = null;
    this.port = null;
    this.token = null;
    this.starting = null;
    if (child !== null) {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    }
  }

  /** Start the worker if needed and resolve once it reports readiness. */
  async ensure() {
    if (this.port !== null) return this.port;
    if (this.starting !== null) return this.starting;
    this.starting = this.spawnWorker().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  /** Spawn the child and wait for its readiness line. */
  async spawnWorker() {
    if (this.disposed) throw fail('disposed', '语音服务已关闭');
    const paths = await this.resolvePaths();
    const token = randomBytes(32).toString('hex');
    const payload = {
      token,
      maxAudioBytes: MAX_AUDIO_BYTES,
      paths: { model: paths.model, tokens: paths.tokens },
      // `resolveAssets` already returns the shape the VAD engines consume
      // (`resolved.vad.model`, `.cmvn`, `.backend`), so it is forwarded whole.
      resolved: paths,
      stt: this.config.stt,
      // Roots the child must consult to find the native runtimes. It cannot
      // work them out from its own location once the plugin is linked into a
      // profile from somewhere else on disk.
      moduleAnchors: this.config.moduleAnchors ?? [],
    };
    log('starting recognizer worker');
    const child = spawn(process.execPath, [WORKER, JSON.stringify(payload)], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });
    child.on('exit', (code) => {
      if (this.child === child) {
        this.child = null;
        this.port = null;
        this.token = null;
        if (code !== 0 && !this.disposed) {
          this.lastError = `识别进程退出（code ${code}）${stderr ? `：${stderr.trim().split('\n').slice(-3).join(' | ')}` : ''}`;
          warn(this.lastError);
        }
      }
    });

    const port = await new Promise((resolve, reject) => {
      let buffer = '';
      const timer = setTimeout(() => {
        cleanup();
        try {
          child.kill();
        } catch {
          /* ignore */
        }
        reject(fail('timeout', `识别进程启动超时${stderr ? `：${stderr.trim().split('\n').slice(-3).join(' | ')}` : ''}`));
      }, this.config.stt.startupTimeoutMs);
      const onData = (chunk) => {
        buffer += String(chunk);
        // The worker writes exactly one JSON readiness line, but a native
        // runtime can still print to stdout during model load. Scan for the
        // record instead of trusting the first line.
        for (;;) {
          const newline = buffer.indexOf('\n');
          if (newline < 0) return;
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line.length === 0) continue;
          let record = null;
          try {
            record = JSON.parse(line);
          } catch {
            log(`worker stdout: ${line.slice(0, 300)}`);
            continue;
          }
          if (record === null || typeof record !== 'object' || !Number.isInteger(record.port)) {
            log(`worker stdout (unexpected): ${line.slice(0, 300)}`);
            continue;
          }
          cleanup();
          this.describe = record;
          resolve(record.port);
          return;
        }
      };
      const onExit = (code) => {
        cleanup();
        reject(fail('spawn-failed', `识别进程启动失败（code ${code}）${stderr ? `：${stderr.trim().split('\n').slice(-3).join(' | ')}` : ''}`));
      };
      const cleanup = () => {
        clearTimeout(timer);
        child.stdout.off('data', onData);
        child.off('exit', onExit);
      };
      child.stdout.on('data', onData);
      child.on('exit', onExit);
    });
    this.port = port;
    this.token = token;
    this.lastError = null;
    log(`recognizer worker ready on 127.0.0.1:${port} (vad=${this.describe?.vad}${this.describe?.vadNote ? `, ${this.describe.vadNote}` : ''})`);
    this.touchIdle();
    return port;
  }

  /** Restart the idle countdown; the worker dies after a quiet period. */
  touchIdle() {
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    const idle = this.config.stt.idleTimeoutMs;
    if (!idle || idle <= 0) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.child !== null) {
        log('releasing idle recognizer worker');
        this.stop();
      }
    }, idle);
    this.idleTimer.unref?.();
  }

  /**
   * Transcribe one utterance.
   * @param samples - 16 kHz mono Float32 samples.
   * @param language - SenseVoice language hint.
   */
  transcribe(samples, language) {
    const run = async () => {
      const port = await this.ensure();
      this.touchIdle();
      const wav = encodeWavPcm16(samples, 16000);
      // The limit is on the body that is sent, and that body carries the
      // WAV header: the samples alone are not what the worker reads.
      if (wav.length > MAX_AUDIO_BYTES) {
        throw fail('too-large', `音频超过 ${Math.floor(MAX_AUDIO_BYTES / 1024 / 1024)} MB 上限`);
      }
      const response = await fetch(`http://127.0.0.1:${port}/transcribe?language=${encodeURIComponent(language)}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.token}`,
          'content-type': 'application/octet-stream',
          'content-length': String(wav.length),
        },
        body: wav,
        signal: AbortSignal.timeout(this.config.stt.inferenceTimeoutMs),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw fail('inference', payload.error ?? `识别失败（HTTP ${response.status}）`);
      this.touchIdle();
      return payload;
    };
    const result = this.queue.then(run, run);
    // Keep the chain alive after a failure so the next request still runs.
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
