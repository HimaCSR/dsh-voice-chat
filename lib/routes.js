/**
 * The plugin's HTTP surface on the DSH web server.
 *
 * One prefix route (`/dsh-voice`) is registered and dispatched internally, so
 * the plugin never collides with another route owner and every endpoint lands
 * on the same origin the page is already talking to. That means no second port,
 * no CORS preflight, and the API key never has to be handed to the browser.
 *
 * Requests are accepted from loopback only. The web server itself carries no
 * authentication or origin policy, so this route refuses anything that is not
 * a local caller: exposing a TTS key and a cloned voice library to the LAN
 * would be a real vulnerability, not a theoretical one.
 *
 * `GET /dsh-voice/diag` lives here too, because native-module resolution is the
 * one thing that varies per deployment and cannot be checked from outside.
 */
import fs from 'node:fs/promises';
import { decodeAudioBody, fail, readBody, sendBytes, sendJson } from './util.js';
import { MIMO_PRESET_VOICES, PROVIDERS, cloneDataUri, describeRequest, synthesize } from './tts.js';
import { deleteVoice, listVoices, normalizeVoiceName, readVoice, saveVoice } from './voices.js';
import { inspectAssets } from './assets.js';
import { anchorList, probeModule } from './sherpa.js';

/** Largest JSON control body accepted (a base64 reference sample fits). */
const MAX_JSON_BYTES = 24 * 1024 * 1024;

/** Largest raw audio body accepted by the recognition route. */
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;

/** Addresses treated as local. */
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** True when the request came from this machine. */
function isLocal(request) {
  const address = request.socket?.remoteAddress ?? '';
  return LOOPBACK.has(address) || address.startsWith('127.');
}

/** Parse a JSON body with a byte ceiling. */
async function readJsonBody(request) {
  const bytes = await readBody(request, MAX_JSON_BYTES);
  if (bytes.length === 0) return {};
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw fail('bad-json', '请求体不是合法 JSON');
  }
}

/**
 * Reject a request whose `Origin` belongs to another site.
 * @param request - the inbound request.
 * @returns `{ ok, reason }` — why the caller is refused, if it is.
 */
function sameSite(request) {
  const origin = request.headers.origin;
  if (typeof origin !== 'string' || origin === '') return { ok: true, reason: null };
  const host = request.headers.host;
  try {
    const originHost = new URL(origin).host;
    if (originHost === host) return { ok: true, reason: null };
    // The same machine under another name — `localhost` for `127.0.0.1` — is
    // still this machine. Refusing it makes the plugin fail for a reason the
    // user cannot see.
    const names = new Set([originHost, host].map((value) => value.split(':')[0].toLowerCase()));
    const localNames = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
    const allLocal = [...names].every((name) => localNames.has(name));
    if (allLocal) return { ok: true, reason: null };
    return { ok: false, reason: `请求来源 ${origin} 与宿主 ${host} 不一致` };
  } catch {
    // `Origin: null` is what a page loaded outside a normal origin sends —
    // an Electron shell, for one. The request still came from this machine.
    if (origin === 'null') return { ok: true, reason: null };
    return { ok: false, reason: `无法解析请求来源 ${origin}` };
  }
}

/**
 * Describe what the host sees of the caller.
 * @param request - the inbound request.
 * @returns the caller's origin, host and address, and whether it is allowed.
 */
export function describeCaller(request) {
  const address = request.socket?.remoteAddress ?? '';
  const site = sameSite(request);
  return {
    origin: request.headers.origin ?? null,
    host: request.headers.host ?? null,
    address,
    local: isLocal(request),
    allowed: isLocal(request) && site.ok,
    reason: site.reason,
  };
}

/**
 * Build the route handler.
 * @param context - live plugin state:
 *   `config`, `stt`, `updateConfig`, `prepareState`, `startPrepare`,
 *   `configPath`, `describeConfig`.
 */
export function createVoiceRoutes(context) {
  const { config, stt } = context;

  /** Resolve a UI voice id (`clone:<name>` or a preset id) to what TTS needs. */
  async function resolveVoice(voice) {
    const requested = typeof voice === 'string' && voice.length > 0
      ? voice
      : context.currentVoice();
    if (requested.startsWith('clone:')) {
      const name = requested.slice('clone:'.length);
      const record = await readVoice({ dataRootResolved: config.dataRoot }, name);
      return {
        kind: 'clone',
        name: record.name,
        dataUri: cloneDataUri(record.sample, record.bytes),
        // Some services register the sample and need the words it says; the
        // library has kept them all along for exactly this.
        refText: record.refText ?? '',
        bytes: record.bytes ?? 0,
      };
    }
    return { kind: 'preset', id: requested };
  }

  /** One readiness/catalogue snapshot for the settings UI. */
  async function statePayload() {
    const assets = await inspectAssets(config, { verify: false }).catch((error) => ({
      ready: false,
      error: error.message,
    }));
    const voices = await listVoices({ dataRootResolved: config.dataRoot }).catch(() => []);
    return {
      ready: assets.ready === true && assets.error === undefined,
      assetsError: assets.error ?? null,
      prepare: context.prepareState(),
      stt: stt.status(),
      // What the microphone actually produced, newest first — the only way to
      // tell "the mic never fired" from "it fired and heard nothing".
      recentStt: context.recentStt ?? [],
      // Failures the browser half reported; without this the reason for a
      // read-out that only ever fails in the browser is lost with the console.
      clientErrors: context.clientErrors ?? [],
      voices: voices.map((voice) => ({
        name: voice.name,
        bytes: voice.bytes,
        extension: voice.extension,
        refText: voice.refText,
      })),
      presets: MIMO_PRESET_VOICES,
      providers: context.describeProviders ? context.describeProviders() : PROVIDERS,
      config: context.describeConfig(),
    };
  }

  /** Dispatch one request; returns true when the path was handled. */
  async function handle(request, response) {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const route = url.pathname.replace(/^\/dsh-voice/, '').replace(/\/+$/, '') || '/';
    const method = request.method ?? 'GET';

    if (route === '/state' && method === 'GET') {
      sendJson(response, 200, await statePayload());
      return;
    }

    if (route === '/ping' && method === 'GET') {
      // Answers what the host sees of the caller, so a browser that cannot
      // reach the plugin can say why instead of only "it failed".
      sendJson(response, 200, describeCaller(request));
      return;
    }

    if (route === '/client-error' && method === 'POST') {
      const body = await readJsonBody(request);
      context.noteClientError?.({
        where: String(body.where ?? '').slice(0, 60),
        message: String(body.message ?? '').slice(0, 400),
        detail: String(body.detail ?? '').slice(0, 600),
      });
      sendJson(response, 200, { ok: true });
      return;
    }

    if (route === '/stt' && method === 'POST') {
      const bytes = await readBody(request, MAX_AUDIO_BYTES);
      const language = url.searchParams.get('language') ?? config.stt.language;
      const { samples } = decodeAudioBody(bytes, request.headers['content-type'] ?? '');
      const result = await stt.transcribe(samples, language);
      context.noteStt?.({
        audioSeconds: Number(Number(result.audioSeconds ?? 0).toFixed(2)),
        speechSeconds: Number(Number(result.speechSeconds ?? 0).toFixed(2)),
        segments: Array.isArray(result.segments) ? result.segments.length : 0,
        text: String(result.text ?? '').slice(0, 120),
      });
      sendJson(response, 200, result);
      return;
    }

    if ((route === '/tts' || route === '/tts/plan') && method === 'POST') {
      const body = await readJsonBody(request);
      const text = String(body.text ?? '').trim();
      if (text.length === 0) throw fail('bad-request', 'text 不能为空');
      if (text.length > (config.tts.maxChars ?? 1200)) {
        throw fail('too-long', `单次朗读文本不能超过 ${config.tts.maxChars ?? 1200} 个字符`);
      }
      const voice = await resolveVoice(body.voice);
      if (route === '/tts/plan') {
        // Answers "what would be sent" without contacting the provider, so the
        // clone wiring is verifiable while no API key exists.
        sendJson(response, 200, describeRequest({
          text,
          voice: voice.dataUri ?? voice.id,
          instruction: body.instruction,
          config,
        }));
        return;
      }
      const result = await synthesize({
        text,
        voice: voice.dataUri ?? voice.id,
        // Present only for a cloned voice, and only what the service needs to
        // register the sample: its name, its transcript and its size.
        cloneRef: voice.kind === 'clone'
          ? { name: voice.name, refText: voice.refText, bytes: voice.bytes, dataUri: voice.dataUri }
          : null,
        instruction: body.instruction,
        config,
        // The synthesis is bounded by the provider timeout instead of the
        // request's own signal: the runtime's request signal may already be
        // closed by the time the body has been read, and that would abort the
        // call before it ever reached the provider.
      });
      context.noteTts(voice.kind === 'clone' ? voice.name : voice.id);
      sendBytes(response, 200, result.audio, result.contentType);
      return;
    }

    if (route === '/voices' && method === 'GET') {
      const voices = await listVoices({ dataRootResolved: config.dataRoot });
      sendJson(response, 200, {
        voices: voices.map((voice) => ({
          name: voice.name,
          bytes: voice.bytes,
          extension: voice.extension,
          refText: voice.refText,
        })),
        presets: MIMO_PRESET_VOICES,
      });
      return;
    }

    if (route === '/voices' && method === 'POST') {
      const body = await readJsonBody(request);
      const bytes = Buffer.from(String(body.dataBase64 ?? ''), 'base64');
      if (bytes.length === 0) throw fail('bad-request', '缺少参考音频数据');
      const saved = await saveVoice(
        { dataRootResolved: config.dataRoot },
        normalizeVoiceName(body.name),
        bytes,
        body.filename ?? 'ref_audio.wav',
        body.refText ?? '',
        body.source ?? 'upload',
      );
      sendJson(response, 200, { ok: true, ...saved });
      return;
    }

    if (route === '/voices' && method === 'DELETE') {
      const name = url.searchParams.get('name') ?? '';
      const removed = await deleteVoice({ dataRootResolved: config.dataRoot }, name);
      sendJson(response, 200, { ok: true, ...removed });
      return;
    }

    if (route === '/voices/sample' && method === 'GET') {
      const name = url.searchParams.get('name') ?? '';
      const record = await readVoice({ dataRootResolved: config.dataRoot }, name);
      const type = record.extension === '.mp3' ? 'audio/mpeg' : 'audio/wav';
      sendBytes(response, 200, record.bytes, type);
      return;
    }

    if (route === '/prepare' && method === 'POST') {
      context.startPrepare();
      sendJson(response, 202, { started: true, ...context.prepareState() });
      return;
    }

    if (route === '/prepare/status' && method === 'GET') {
      sendJson(response, 200, context.prepareState());
      return;
    }

    if (route === '/diag' && method === 'GET') {
      // Native-module resolution is the one thing that differs per deployment
      // and cannot be checked from the outside, so it reports itself. The
      // dependency audit rides along: it answers the same question — where
      // did the module come from — and adds whether it is the right version
      // and how to install it when it is missing.
      const dependencies = context.describeDependencies ? await context.describeDependencies() : { entries: [] };
      sendJson(response, 200, {
        anchors: anchorList(),
        env: {
          DSH_HOME: process.env.DSH_HOME ?? null,
          DSH_PROFILE: process.env.DSH_PROFILE ?? null,
          DSH_PROFILE_DIR: process.env.DSH_PROFILE_DIR ?? null,
          resourcesPath: process.resourcesPath ?? null,
        },
        // Pure resolution: `probeModule` never executes the module, so asking
        // cannot change the answer it reports.
        modules: {
          onnxruntime: probeModule('onnxruntime-node'),
          sherpa: probeModule('sherpa-onnx-node'),
        },
        dependencies: dependencies.entries ?? [],
        worker: stt.status(),
      });
      return;
    }

    if (route === '/deps' && method === 'GET') {
      const report = context.describeDependencies ? await context.describeDependencies() : { entries: [] };
      sendJson(response, 200, report);
      return;
    }

    if (route === '/deps/install' && method === 'POST') {
      const body = await readJsonBody(request);
      const state = context.startDependencyInstall(body.name, body.range);
      sendJson(response, 202, state);
      return;
    }

    if (route === '/deps/install/status' && method === 'GET') {
      sendJson(response, 200, context.dependencyInstallState ? context.dependencyInstallState() : { running: false });
      return;
    }

    if (route === '/version' && method === 'GET') {
      sendJson(response, 200, await context.checkForUpdate());
      return;
    }

    if (route === '/version/install' && method === 'POST') {
      const body = await readJsonBody(request);
      const spec = String(body.spec ?? '').trim();
      if (spec === '') throw fail('bad-request', '缺少安装源');
      const result = await context.installRelease(spec, request.signal);
      sendJson(response, 200, result);
      return;
    }

    if (route === '/providers' && method === 'GET') {
      sendJson(response, 200, { providers: context.describeProviders() });
      return;
    }

    if (route === '/providers' && method === 'POST') {
      const body = await readJsonBody(request);
      const providers = await context.updateProvider('upsert', body);
      sendJson(response, 200, { ok: true, providers });
      return;
    }

    if (route === '/providers' && method === 'DELETE') {
      const id = url.searchParams.get('id') ?? '';
      const providers = await context.updateProvider('delete', { id });
      sendJson(response, 200, { ok: true, providers });
      return;
    }

    if (route === '/config' && method === 'POST') {
      const body = await readJsonBody(request);
      await context.updateConfig(body);
      sendJson(response, 200, { ok: true, config: context.describeConfig() });
      return;
    }

    if (route === '/log' && method === 'GET') {
      const stderr = await fs.readFile(context.config.logPath, 'utf8').catch(() => '');
      sendJson(response, 200, { log: stderr.slice(-20000) });
      return;
    }

    sendJson(response, 404, { error: `unknown voice route ${route}` });
  }

  /**
   * Node request listener handed to `ctx.webServer.register`.
   * @param request - inbound request.
   * @param response - outbound response.
   */
  return async function route(request, response) {
    try {
      if (!isLocal(request)) {
        sendJson(response, 403, { error: 'voice routes are loopback-only' });
        return;
      }
      const site = sameSite(request);
      if (!site.ok) {
        sendJson(response, 403, { error: `voice routes are loopback-only: ${site.reason}` });
        return;
      }
      await handle(request, response);
    } catch (error) {
      const code = error?.code ?? 'error';
      const message = error instanceof Error ? error.message : String(error);
      if (!response.headersSent) sendJson(response, statusFor(code), { error: message, code });
      else response.end();
      // Expected, user-facing conditions are not server faults and must not
      // masquerade as one in the Host log.
      if (!EXPLAINED.has(code)) console.error('[voice-chat] route failed:', error);
    }
  };
}

/** Codes that describe a client-side condition rather than a Host failure. */
const EXPLAINED = new Set([
  'too-large', 'bad-json', 'bad-request', 'invalid-wav', 'invalid-audio',
  'bad-format', 'bad-name', 'bad-reference', 'reference-too-large', 'too-long',
  'no-voice', 'no-api-key', 'bad-config', 'unknown-provider', 'clone-unsupported',
  'conflict', 'rate-limited',
]);

/** Map a failure code to an HTTP status. */
function statusFor(code) {
  if (code === 'too-large') return 413;
  if (code === 'no-voice') return 404;
  // A conflict is a valid request that clashes with the current state, such
  // as starting a second installation while one is already running.
  if (code === 'conflict') return 409;
  // A rate limit is the service's answer, not a bad request, and the browser
  // shows it as such.
  if (code === 'rate-limited') return 429;
  if (EXPLAINED.has(code)) return 400;
  return 500;
}
