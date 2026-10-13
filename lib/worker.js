/**
 * Private worker entry for the local recognizer.
 *
 * The Host starts one of these on demand and talks to it over an authenticated
 * loopback socket. Keeping native inference out of the Host process means a
 * model crash or an out-of-memory abort takes down a throwaway child instead of
 * the harness, and lets the Host reclaim the resident model memory by killing
 * the process after an idle period.
 *
 * stdout carries exactly one line — the readiness record — so the parent can
 * wait for a definite "the model is loaded" signal before forwarding audio.
 */
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { decodeAudioBody, fail, useStderrDiagnostics } from './util.js';
import { createEngine } from './engine.js';
import { setModuleAnchors } from './sherpa.js';

// stdout belongs to the readiness record and nothing else: a stray diagnostic
// line before it corrupts the parent's handshake.
useStderrDiagnostics();

const PAYLOAD = JSON.parse(process.argv[2] ?? '{}');
const TOKEN = String(PAYLOAD.token ?? '');
const MAX_AUDIO_BYTES = Number(PAYLOAD.maxAudioBytes ?? 8 * 1024 * 1024);

// The Host discovered where this plugin's dependencies actually live (its
// profile's node_modules, DSH's own installation) and passes the roots down,
// because a spawned child cannot infer them from its own file location.
setModuleAnchors(PAYLOAD.moduleAnchors);

if (TOKEN.length === 0) {
  process.stderr.write('voice-chat worker: missing token\n');
  process.exit(2);
}

/**
 * Build the engine, degrading rather than dying.
 *
 * A worker that exits during startup leaves the Host with an unhelpful
 * handshake failure and no way to show the reason. Reporting readiness with a
 * broken engine instead keeps the diagnosis inside `/state`, where the settings
 * panel can display it, and confines the failure to the recognition route.
 */
async function buildEngine() {
  try {
    return await createEngine(PAYLOAD);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`voice-chat worker: engine unavailable: ${error?.stack ?? message}\n`);
    return {
      transcribe() {
        throw fail('engine-unavailable', `语音引擎不可用：${message}`);
      },
      describe() {
        return { vad: 'unavailable', vadNote: message, failed: true };
      },
      dispose() {},
    };
  }
}

const engine = await buildEngine();
const expected = Buffer.from(`Bearer ${TOKEN}`);

/** Reply with JSON. */
function reply(response, status, value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length });
  response.end(body);
}

/** Collect the request body with a byte ceiling. */
async function readAudio(request) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > MAX_AUDIO_BYTES) throw fail('too-large', 'audio exceeds the worker limit');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const server = createServer((request, response) => {
  const authorization = Buffer.from(request.headers.authorization ?? '');
  if (authorization.length !== expected.length || !timingSafeEqual(authorization, expected)) {
    request.resume();
    reply(response, 401, { error: 'unauthorized' });
    return;
  }
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');

  if (request.method === 'GET' && url.pathname === '/health') {
    reply(response, 200, { ready: true, ...engine.describe() });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/transcribe') {
    void (async () => {
      try {
        const bytes = await readAudio(request);
        const { samples } = decodeAudioBody(bytes, request.headers['content-type'] ?? '');
        const language = url.searchParams.get('language') ?? 'auto';
        reply(response, 200, await engine.transcribe(samples, language));
      } catch (error) {
        reply(response, error?.code === 'invalid-wav' || error?.code === 'invalid-audio' ? 400 : 500, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();
    return;
  }

  if (request.method === 'POST' && url.pathname === '/shutdown') {
    reply(response, 200, { ok: true });
    setTimeout(() => process.exit(0), 20).unref();
    return;
  }

  request.resume();
  reply(response, 404, { error: 'not found' });
});

server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  process.stdout.write(`${JSON.stringify({ port: address.port, ...engine.describe() })}\n`);
});

process.on('SIGTERM', () => process.exit(0));
