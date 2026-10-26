/**
 * Browser half of the voice-chat plugin.
 *
 * Registers two seats:
 *   `conversation.input.dock`   the compact voice bar above the input card
 *   `conversation.input.left`   a hidden per-session reply listener that speaks
 *                               finalized assistant text sentence by sentence
 *
 * Everything the page needs from the Host goes through the same-origin
 * `/dsh-voice/*` routes the Host half registers on the DSH web server, so no
 * second port, no CORS and no extra listener is involved.
 *
 * The browser artifact is loaded as a lazy CommonJS-style factory; React and
 * the other shared modules come from the page's module table, which is why
 * this file has no imports and no build step.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-voice-chat',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useLayoutEffect, useRef, useState } = React;

    const NS = 'voiceChat';
    const BASE = '/dsh-voice';
    const STORAGE = {
      enabled: 'dsh.voice.enabled',
      interrupt: 'dsh.voice.interrupt',
      voice: 'dsh.voice.voice',
      language: 'dsh.voice.language',
      pos: 'dsh.voice.pos',
      // The two microphone thresholds, kept as the same 0-100 numbers the
      // sliders show, so the stored value is readable on its own.
      sensitivity: 'dsh.voice.sensitivity',
      minRms: 'dsh.voice.minRms',
    };

    /**
     * What a provider id may look like.
     *
     * The id becomes a key in the stored map and is written into the Host's
     * log, so it is limited to characters that are safe in both.
     */
    const PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

    /**
     * The slider ranges, and the thresholds they stand for.
     *
     * The defaults are the values the plugin has always used, so a user who
     * never touches a slider keeps the behaviour they know.
     *
     * The sliders read as sensitivity, so they are mapped that way round: the
     * further right, the lower the threshold and the easier it is to trigger.
     * A higher threshold needs a louder voice, which is the opposite of what
     * a slider labelled "sensitivity" is expected to do.
     */
    const SENSITIVITY = {
      interrupt: { min: 0.012, max: 0.060, default: 0.035 },
      minRms: { min: 0.002, max: 0.020, default: 0.005 },
    };

    /** Map a 0-100 slider position onto a threshold. */
    function sliderToThreshold(range, position) {
      const value = Math.min(100, Math.max(0, Number(position) || 0));
      return range.max - (range.max - range.min) * (value / 100);
    }

    /** Map a threshold back onto the 0-100 slider position. */
    function thresholdToSlider(range, threshold) {
      const value = Number(threshold);
      if (!Number.isFinite(value)) return 50;
      const ratio = (range.max - value) / (range.max - range.min);
      return Math.round(Math.min(100, Math.max(0, ratio * 100)));
    }

    /** Read a stored slider position, falling back to the default threshold. */
    function readSlider(key, range) {
      const stored = readString(STORAGE[key], '');
      if (stored === '') return thresholdToSlider(range, range.default);
      const value = Number.parseInt(stored, 10);
      if (!Number.isFinite(value)) return thresholdToSlider(range, range.default);
      return Math.min(100, Math.max(0, value));
    }

    // ─────────────────────────────────────────────────────────────── settings

    function readFlag(key, fallback) {
      try {
        const value = localStorage.getItem(key);
        return value === null ? fallback : value !== '0';
      } catch {
        return fallback;
      }
    }

    function writeFlag(key, value) {
      try {
        localStorage.setItem(key, value ? '1' : '0');
      } catch {
        /* storage unavailable — the in-memory store still applies */
      }
    }

    function readString(key, fallback) {
      try {
        return localStorage.getItem(key) ?? fallback;
      } catch {
        return fallback;
      }
    }

    function writeString(key, value) {
      try {
        localStorage.setItem(key, value);
      } catch {
        /* storage unavailable */
      }
    }

    // ────────────────────────────────────────────────────────── host transport

    async function asJson(response) {
      const text = await response.text();
      try {
        return JSON.parse(text);
      } catch {
        throw new Error(text.slice(0, 200) || `HTTP ${response.status}`);
      }
    }

    /**
     * The reason an error response carries.
     *
     * The two calls that can fail — recognition and synthesis — read the same
     * shape, so they read it the same way: the host's own words when it gave
     * any, the status otherwise, and the prefix says which call it was.
     *
     * @param {Response} response - the response that was not okay.
     * @param {string} prefix - what the call is called, e.g. `TTS`.
     * @returns {Promise<string>} the message to show the user.
     */
    async function readError(response, prefix) {
      const label = String(prefix ?? 'HTTP');
      const body = await response.text();
      let reason = '';
      try {
        const parsed = JSON.parse(body);
        if (typeof parsed?.error === 'string') reason = parsed.error;
        else if (typeof parsed?.error?.message === 'string') reason = parsed.error.message;
        else if (typeof parsed?.message === 'string') reason = parsed.message;
      } catch {
        // Not JSON: the host answered with something else entirely.
      }
      if (reason === '') reason = body.slice(0, 200).trim();
      return reason === ''
        ? `${label} HTTP ${response.status}`
        : `${label} HTTP ${response.status}: ${reason}`;
    }

    const api = {
      /** Engine readiness, TTS provider facts and the voice catalogue. */
      async state() {
        return asJson(await fetch(`${BASE}/state`));
      },
      /** Raw 16 kHz mono PCM16 in, recognized text out. */
      async stt(pcm16, language) {
        const query = language && language !== 'auto' ? `?language=${encodeURIComponent(language)}` : '';
        const response = await fetch(`${BASE}/stt${query}`, {
          method: 'POST',
          headers: { 'content-type': 'application/octet-stream' },
          body: pcm16,
        });
        if (!response.ok) throw new Error(await readError(response, 'STT'));
        return asJson(response);
      },
      /**
       * Ask the host what it sees of this page.
       *
       * A read-out that fails only in the browser is almost always the host
       * refusing the request; asking it says why, in words.
       */
      async ping() {
        return asJson(await fetch(`${BASE}/ping`));
      },
      /** Tell the host about a failure the console would otherwise swallow. */
      async reportError(where, message, detail) {
        try {
          await fetch(`${BASE}/client-error`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ where, message, detail }),
          });
        } catch {
          // Reporting is best-effort; the original failure still stands.
        }
      },
      /** Synthesize one sentence; resolves with the audio bytes. */
      async tts(text, voice, signal) {
        const response = await fetch(`${BASE}/tts`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text, voice }),
          signal,
        });
        if (!response.ok) {
          // The same reader as the recognizer: the host's own words when it
          // gave any, the status otherwise.
          const error = new Error(await readError(response, 'TTS'));
          error.status = response.status;
          throw error;
        }
        return response.arrayBuffer();
      },
      /** Download the pinned local models; resolves when the run finishes. */
      async prepare() {
        return asJson(await fetch(`${BASE}/prepare`, { method: 'POST' }));
      },
      async saveVoice(payload) {
        const response = await fetch(`${BASE}/voices`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!response.ok) throw new Error((await asJson(response)).error ?? `HTTP ${response.status}`);
        return asJson(response);
      },
      async deleteVoice(name) {
        const response = await fetch(`${BASE}/voices?name=${encodeURIComponent(name)}`, { method: 'DELETE' });
        if (!response.ok) throw new Error((await asJson(response)).error ?? `HTTP ${response.status}`);
        return asJson(response);
      },
      sampleUrl(name) {
        return `${BASE}/voices/sample?name=${encodeURIComponent(name)}`;
      },
      /** Persist a runtime configuration patch (provider, key, voice, language). */
      async configure(patch) {
        const response = await fetch(`${BASE}/config`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(patch),
        });
        if (!response.ok) throw new Error((await asJson(response)).error ?? `HTTP ${response.status}`);
        return asJson(response);
      },
      /** The full provider list, each entry without its API key. */
      async providers() {
        return asJson(await fetch(`${BASE}/providers`));
      },
      /** Create or change one provider. */
      async saveProvider(record) {
        const response = await fetch(`${BASE}/providers`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(record),
        });
        if (!response.ok) throw new Error((await asJson(response)).error ?? `HTTP ${response.status}`);
        return asJson(response);
      },
      /** Remove a custom provider. */
      async deleteProvider(id) {
        const response = await fetch(`${BASE}/providers?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
        if (!response.ok) throw new Error((await asJson(response)).error ?? `HTTP ${response.status}`);
        return asJson(response);
      },
      /** The dependency audit: what is installed, from where, at which version. */
      async dependencies() {
        return asJson(await fetch(`${BASE}/deps`));
      },
      /** Start installing one dependency into the DSH profile. */
      async installDependency(name, range) {
        const response = await fetch(`${BASE}/deps/install`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name, range }),
        });
        if (!response.ok) throw new Error((await asJson(response)).error ?? `HTTP ${response.status}`);
        return asJson(response);
      },
      /** The progress of the running dependency installation. */
      async dependencyInstallStatus() {
        return asJson(await fetch(`${BASE}/deps/install/status`));
      },
      /** The newest published release, compared with the running version. */
      async version() {
        return asJson(await fetch(`${BASE}/version`));
      },
      /** Install a published release through the DSH plugin manager. */
      async installVersion(spec) {
        const response = await fetch(`${BASE}/version/install`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ spec }),
        });
        if (!response.ok) throw new Error((await asJson(response)).error ?? `HTTP ${response.status}`);
        return asJson(response);
      },
    };

    // ──────────────────────────────────────────────────────────────── playback

    /**
     * FIFO audio playback with generation-based interruption: `stop()` bumps a
     * counter that discards clips which were fetched but never started, so a
     * barge-in silences the rest of the reply immediately.
     */
    class Speaker {
      constructor() {
        this.ctx = null;
        this.analyserNode = null;
        this.analyserData = null;
        this.queue = [];
        this.playing = null;
        this.draining = false;
        this.generation = 0;
        this.disposed = false;
        this.listeners = new Set();
      }

      get speaking() {
        return this.playing !== null || this.queue.length > 0;
      }

      /**
       * Loudness of the audio currently being spoken, 0..1.
       * Low-frequency energy is what carries speech, so the first third of the
       * spectrum is averaged; the water ball's undulation rides on this.
       */
      level() {
        const node = this.analyserNode;
        if (node === null || this.disposed) return 0;
        node.getByteFrequencyData(this.analyserData);
        const bins = Math.max(1, Math.round(this.analyserData.length * 0.35));
        let sum = 0;
        for (let index = 0; index < bins; index += 1) sum += this.analyserData[index];
        // The analyser hands out bytes, and 255 is the loudest of them.
        // Dividing by less than that made the bead look as if it were
        // shouting long before the voice did.
        return Math.min(1, sum / bins / 255);
      }

      subscribe(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
      }

      emit() {
        for (const listener of [...this.listeners]) listener();
      }

      enqueue(bytes) {
        if (this.disposed) return;
        this.queue.push(bytes);
        this.emit();
        void this.drain();
      }

      async drain() {
        if (this.draining) return;
        this.draining = true;
        try {
          const ctx = this.ctx ?? (this.ctx = new AudioContext());
          if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
          while (this.queue.length > 0 && !this.disposed) {
            await this.playOne(ctx, this.queue.shift());
          }
        } finally {
          this.draining = false;
          this.emit();
        }
      }

      playOne(ctx, bytes) {
        const generation = this.generation;
        return new Promise((resolve) => {
          void ctx
            .decodeAudioData(bytes.slice(0))
            .then((buffer) => {
              if (this.disposed || generation !== this.generation) {
                resolve();
                return;
              }
              // Tap the spoken audio so the water ball can follow real loudness.
              // One analyser per context, wired straight through to the output.
              if (this.analyserNode === null) {
                const analyser = ctx.createAnalyser();
                analyser.fftSize = 256;
                analyser.smoothingTimeConstant = 0.72;
                this.analyserNode = analyser;
                this.analyserData = new Uint8Array(analyser.frequencyBinCount);
                analyser.connect(ctx.destination);
              }
              const source = ctx.createBufferSource();
              source.buffer = buffer;
              source.connect(this.analyserNode);
              this.playing = source;
              this.emit();
              source.onended = () => {
                if (this.playing === source) this.playing = null;
                this.emit();
                resolve();
              };
              source.start();
            })
            .catch((error) => {
              console.error('[voice-chat] decode failed:', error);
              resolve();
            });
        });
      }

      stop() {
        this.generation += 1;
        if (this.playing !== null) {
          try {
            this.playing.stop();
          } catch {
            /* already ended */
          }
          this.playing = null;
        }
        this.queue = [];
        this.emit();
      }

      dispose() {
        this.disposed = true;
        this.stop();
        if (this.ctx !== null) void this.ctx.close().catch(() => {});
        this.ctx = null;
        this.listeners.clear();
      }
    }

    // ───────────────────────────────────────────────────────────── mic capture

    /**
     * Resamples the AudioContext rate to 16 kHz, packs little-endian PCM16 in
     * ~40 ms frames, reports per-frame RMS for endpointing, and applies a
     * noise gate so ambient hum never reaches the recognizer.
     */
    const WORKLET_SOURCE = `
const TARGET_RATE = 16000;
const CHUNK_MS = 40;
const ATTACK = Math.exp(-1 / ((5 / 1000) * TARGET_RATE));
const RELEASE = Math.exp(-1 / ((80 / 1000) * TARGET_RATE));
const HOLD_SAMPLES = Math.round((250 / 1000) * TARGET_RATE);

class MicCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / TARGET_RATE;
    this.size = Math.round((TARGET_RATE * CHUNK_MS) / 1000);
    this.scratch = new Float32Array(0);
    this.frame = new Float32Array(this.size);
    this.gain = 1;
    this.hold = 0;
    this.gateEnabled = false;
    this.threshold = 0;
    this.port.onmessage = (event) => {
      const data = event.data;
      if (data && data.kind === 'gate') {
        this.gateEnabled = !!data.enabled;
        this.threshold = data.enabled ? Math.pow(10, data.thresholdDb / 20) : 0;
      }
    };
  }

  ingest(input) {
    const merged = new Float32Array(this.scratch.length + input.length);
    merged.set(this.scratch, 0);
    merged.set(input, this.scratch.length);
    this.scratch = merged;
    this.emit();
  }

  emit() {
    const n = this.size;
    const need = Math.ceil(n * this.ratio);
    while (this.scratch.length >= need) {
      let energy = 0;
      for (let i = 0; i < n; i++) {
        const position = i * this.ratio;
        const index = Math.floor(position);
        const fraction = position - index;
        const a = this.scratch[index];
        const b = this.scratch[index + 1] === undefined ? a : this.scratch[index + 1];
        const sample = a + (b - a) * fraction;
        this.frame[i] = sample;
        energy += sample * sample;
      }
      const rms = Math.sqrt(energy / n);
      let target = 1;
      if (this.gateEnabled) {
        if (rms >= this.threshold) this.hold = HOLD_SAMPLES;
        else if (this.hold > 0) this.hold -= n;
        else target = 0;
      }
      const out = new Int16Array(n);
      let gain = this.gain;
      for (let i = 0; i < n; i++) {
        gain = target + (gain - target) * (target > gain ? ATTACK : RELEASE);
        const value = Math.max(-1, Math.min(1, this.frame[i] * gain));
        out[i] = value < 0 ? value * 0x8000 : value * 0x7fff;
      }
      this.gain = gain;
      this.scratch = this.scratch.slice(Math.floor(n * this.ratio));
      this.port.postMessage({ kind: 'level', rms });
      this.port.postMessage(out.buffer, [out.buffer]);
    }
  }

  process(inputs) {
    const input = inputs[0];
    if (input && input[0] && input[0].length > 0) this.ingest(input[0]);
    return true;
  }
}

registerProcessor('voice-chat-mic', MicCapture);
`;

    /**
     * Frames held while waiting for a barge-in (~400 ms at the worklet's 40 ms
     * cadence). The detector needs 220 ms of sustained level before it commits,
     * so without this the opening syllable of the interrupting sentence is
     * already gone by the time accumulation starts.
     */
    const PRE_ROLL_FRAMES = 10;

    /**
     * Continuous microphone capture with silence endpointing and barge-in.
     *
     * Endpointing is deliberately local: waiting for a network round trip to
     * decide that a sentence ended would add hundreds of milliseconds to every
     * turn. The Host's VAD then runs on the captured utterance, so noise that
     * trips the local gate is dropped before recognition instead of becoming a
     * phantom message.
     */
    class MicCapture {
      constructor(options) {
        this.options = options;
        this.ctx = null;
        this.stream = null;
        this.source = null;
        this.node = null;
        this.chunks = [];
        this.bytes = 0;
        this.speaking = false;
        this.lastVoiceAt = 0;
        this.maxTimer = null;
        this.interruptMode = false;
        this.armedAt = 0;
        this.released = true;
        this.paused = false;
        /** Frames held while waiting for a barge-in, recovered when it fires. */
        this.preRoll = [];
      }

      get active() {
        return !this.released && this.ctx !== null;
      }

      async start() {
        this.released = false;
        const ctx = new AudioContext({ latencyHint: 'interactive' });
        this.ctx = ctx;
        try {
          await this.open(ctx);
        } catch (error) {
          // The audio context was already open when the permission was
          // refused. Left alone it would sit there for the rest of the
          // session — one per click — and the recorder would still look
          // active, so the guard against a second microphone would not
          // notice.
          this.released = true;
          this.ctx = null;
          this.stream = null;
          void ctx.close().catch(() => {});
          throw error;
        }
      }

      async open(ctx) {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
        this.stream = stream;
        const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'text/javascript' }));
        try {
          await ctx.audioWorklet.addModule(url);
        } finally {
          URL.revokeObjectURL(url);
        }
        const node = new AudioWorkletNode(ctx, 'voice-chat-mic', {
          numberOfInputs: 1,
          numberOfOutputs: 0,
        });
        const gate = this.options.noiseGateDb;
        if (typeof gate === 'number' && gate !== 0) {
          node.port.postMessage({ kind: 'gate', enabled: true, thresholdDb: gate });
        }
        node.port.onmessage = (event) => {
          if (this.released) return;
          const data = event.data;
          if (data instanceof ArrayBuffer) this.onFrame(data);
          else if (data && data.kind === 'level') this.onLevel(data.rms);
        };
        this.source = ctx.createMediaStreamSource(stream);
        this.source.connect(node);
        this.node = node;
      }

      stop() {
        if (this.released) return;
        this.released = true;
        this.clearTimer();
        try {
          this.node?.port.close();
        } catch {
          /* already gone */
        }
        this.source?.disconnect();
        this.stream?.getTracks().forEach((track) => track.stop());
        void this.ctx?.close().catch(() => {});
        this.node = null;
        this.source = null;
        this.stream = null;
        this.ctx = null;
        this.reset();
        this.interruptMode = false;
      }

      setPaused(paused) {
        if (this.paused === paused) return;
        this.paused = paused;
        if (paused) this.reset();
      }

      /** While a reply plays, only listen for the user starting to talk. */
      setInterruptMode(enabled) {
        if (this.interruptMode === enabled) return;
        this.interruptMode = enabled;
        this.reset();
      }

      reset() {
        this.clearTimer();
        this.chunks = [];
        this.bytes = 0;
        this.speaking = false;
        this.armedAt = 0;
        this.preRoll = [];
      }

      clearTimer() {
        if (this.maxTimer !== null) {
          clearTimeout(this.maxTimer);
          this.maxTimer = null;
        }
      }

      /** Latest frame loudness, 0..1 — also drives the bead while listening. */
      get level() {
        return this.released ? 0 : (this.lastRms ?? 0);
      }

      onLevel(rms) {
        if (this.released || this.paused) return;
        this.lastRms = rms;
        if (this.interruptMode) {
          const interruptAt = this.options.interruptThreshold;
          const now = performance.now();
          if (rms >= interruptAt) {
            if (this.armedAt === 0) this.armedAt = now;
            else if (now - this.armedAt >= this.options.interruptHoldMs) {
              this.armedAt = 0;
              this.interruptMode = false;
              // Keep the audio that tripped the barge-in. Discarding it clips
              // the first syllable of the interrupting sentence — measured
              // live as a mangled leading fragment reaching the recognizer.
              const preRoll = this.preRoll;
              this.reset();
              this.chunks = preRoll;
              this.bytes = preRoll.reduce((total, buffer) => total + buffer.byteLength, 0);
              this.speaking = true;
              this.lastVoiceAt = now;
              this.armMaxTimer();
              this.options.onBargeIn?.();
            }
          } else {
            this.armedAt = 0;
          }
          return;
        }
        const threshold = this.options.rmsThreshold;
        if (rms >= threshold) {
          this.lastVoiceAt = performance.now();
          if (!this.speaking) {
            this.speaking = true;
            this.armMaxTimer();
            this.options.onSpeakingChange?.(true);
          }
        }
      }

      onFrame(buffer) {
        if (this.released || this.paused) return;
        if (this.interruptMode) {
          // Hold the last few frames so the barge-in can keep them.
          this.preRoll.push(buffer);
          if (this.preRoll.length > PRE_ROLL_FRAMES) this.preRoll.shift();
          return;
        }
        this.chunks.push(buffer);
        this.bytes += buffer.byteLength;
        if (!this.speaking) {
          // The microphone is open most of the time, and the frames arrive
          // whether anyone is talking or not. Keeping every quiet frame
          // would grow without end — an hour of an open microphone is
          // about a hundred megabytes — and every recognition request
          // would carry all of it. Only the last moments are kept, because
          // the first syllable of a word often falls into them.
          while (this.chunks.length > PRE_ROLL_FRAMES) {
            const dropped = this.chunks.shift();
            this.bytes -= dropped.byteLength;
          }
          return;
        }
        if (performance.now() - this.lastVoiceAt >= (this.options.minSilenceMs ?? 900)) this.flush();
      }

      armMaxTimer() {
        this.clearTimer();
        this.maxTimer = setTimeout(() => this.flush(), this.options.maxUtteranceMs ?? 30000);
      }

      flush() {
        if (this.released) return;
        this.clearTimer();
        const pcm = this.bytes > 0 ? this.concat() : null;
        this.chunks = [];
        this.bytes = 0;
        if (this.speaking) {
          this.speaking = false;
          this.options.onSpeakingChange?.(false);
        }
        if (pcm !== null) this.options.onUtterance(pcm);
      }

      concat() {
        const out = new Uint8Array(this.bytes);
        let offset = 0;
        for (const chunk of this.chunks) {
          out.set(new Uint8Array(chunk), offset);
          offset += chunk.byteLength;
        }
        return out.buffer;
      }
    }

    // ───────────────────────────────────────────────────────────── text tools

    const TERMINATORS = new Set(['。', '！', '？', '!', '?', '…']);

    /**
     * The abbreviations whose full stop does not end a sentence.
     *
     * `Mr. Smith` is one sentence, not two: the full stop belongs to the
     * title, and the words after it carry on. The list is short on purpose —
     * it holds the forms that actually turn up in a reply.
     */
    const ABBREVIATIONS = new Set([
      'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'vs',
      'inc', 'ltd', 'co', 'dept', 'est', 'fig', 'vol',
      'e.g', 'i.e', 'a.m', 'p.m', 'u.s', 'u.k', 'ph.d', 'm.d', 'b.c', 'a.d',
    ]);

    /**
     * Whether the full stop at `index` really ends a sentence.
     *
     * A full stop only ends one when it is one: not a decimal point (`1.5`),
     * not a version (`v2.0`), not an initial (`A.`) and not the mark of an
     * abbreviation (`Mr.`). Everything else is a sentence of its own.
     */
    function isSentenceStop(text, index) {
      const next = text[index + 1];
      const before = text.slice(0, index);
      // A digit on either side of the point makes it a decimal point.
      if (next !== undefined && /\d/.test(next)) return false;
      if (/\d$/.test(before) && next !== undefined && /\d/.test(next)) return false;
      const word = /([A-Za-z][A-Za-z.]*)$/.exec(before);
      if (word !== null) {
        const token = word[1];
        const lower = token.toLowerCase();
        // A title or a written-out abbreviation.
        if (ABBREVIATIONS.has(lower)) return false;
        // An initial: `A. Smith` is one name, not two sentences.
        if (token.length === 1) return false;
        // An initialism: `U.S.A.` is one word, not three sentences.
        if (/^(?:[A-Za-z]\.)+[A-Za-z]?$/.test(token)) return false;
      }
      return true;
    }

    /**
     * The last reply that was already finished when the plugin mounted.
     *
     * This is the line between history and something new, and it has to
     * count only the replies that had *finished*. A reply that is still
     * being written when the plugin mounts is new: it is being written
     * now, for the user who is looking at the screen, and it is the one
     * reply they most expect to hear. Counting it as history would leave
     * the plugin silent exactly when the user is waiting for it.
     * @param nodes - the chat nodes.
     * @returns the anchor to skip up to; 0 when there is no history.
     */
    function historyAnchor(nodes) {
      let anchor = 0;
      for (const node of nodes) {
        if (node.kind !== 'assistant-step') continue;
        if (node.data?.status !== 'settled') continue;
        const seq = node.anchorSeq ?? 0;
        if (seq > anchor) anchor = seq;
      }
      return anchor;
    }

    /** Whether a finished sentence carries nothing worth speaking. */
    function isTrivial(sentence) {
      if (sentence.length <= 1) return true;
      return !/[\u4e00-\u9fff0-9a-zA-Z]/.test(sentence);
    }

    /**
     * Whether a chunk is nothing but punctuation.
     *
     * A finished sentence has to be a sentence, but the tail of a reply that
     * is still being written may be a single character: `这` is the beginning
     * of a word, and throwing it away would cut short the sentence the user
     * is listening to. Only the punctuation around it is noise.
     */
    function isPunctuationOnly(text) {
      return !/[\u4e00-\u9fff0-9a-zA-Z]/.test(text);
    }

    /** Split a reply into complete sentences plus a trailing partial chunk. */
    function splitSentences(text) {
      const sentences = [];
      let buffer = '';
      for (let index = 0; index < text.length; index += 1) {
        const character = text[index];
        buffer += character;
        // A full stop ends a sentence only when it really is one: a decimal
        // point, a version number and an abbreviation are not sentence ends.
        const stop = TERMINATORS.has(character)
          || (character === '.' && isSentenceStop(text, index));
        if (!stop) continue;
        const trimmed = buffer.trim();
        if (trimmed !== '' && !isTrivial(trimmed)) sentences.push(trimmed);
        buffer = '';
      }
      const partial = buffer.trim();
      return { sentences, partial: partial === '' || isPunctuationOnly(partial) ? null : partial };
    }

    /**
     * The identity of one sentence inside one reply.
     *
     * The same words can appear twice in one reply, so the place is part of
     * the identity: `好。` at the front and `好。` at the back are two
     * different sentences, and both of them are read out. The place also
     * keeps the opening sentence from being read a second time when the reply
     * settles and its closing sentence joins the list — the closing one is
     * appended, so the sentences in front of it keep their place.
     */
    function sentenceKey(sentence, index) {
      return `${index}::${sentence}`;
    }

    /**
     * Choose the sentences that are actually spoken, with the place each one
     * holds.
     *
     * The default reads only the opening and the closing sentence. A reply
     * is usually longer than it needs to be, and reading all of it out loud
     * makes the user wait for a voice that repeats what the screen already
     * says. The closing sentence is only known once the reply has settled,
     * so it is held back until then.
     *
     * @param {string[]} speakable - the sentences of the reply, in order.
     * @param {string} mode - one of head-tail, all, head, tail.
     * @param {boolean} settled - whether the reply has finished streaming.
     * @param {Set<string>} spoken - what was already spoken: the keys this
     *        version writes, and the plain sentences as well.
     * @returns {{key: string, index: number, text: string}[]} the sentences to
     *          speak now.
     */
    function pickEntries(speakable, mode, settled, spoken) {
      if (speakable.length === 0) return [];
      // An unknown mode falls back to the default rather than saying
      // nothing: the mode comes from the configuration file, and a value
      // this version does not know should still leave the user hearing the
      // reply instead of silence.
      const choice = ['all', 'head', 'tail', 'head-tail'].includes(mode) ? mode : 'head-tail';
      const known = spoken ?? new Set();
      const out = [];
      const picked = new Set();
      const take = (sentence, index) => {
        if (sentence === undefined) return;
        const key = sentenceKey(sentence, index);
        // The same words twice in one reply are two sentences: only the very
        // same one — same place, same words — is refused.
        if (picked.has(key)) return;
        if (known.has(key) || known.has(sentence)) return;
        picked.add(key);
        out.push({ key, index, text: sentence });
      };
      if (choice === 'all') {
        speakable.forEach((sentence, index) => take(sentence, index));
        return out;
      }
      const first = speakable[0];
      const last = speakable[speakable.length - 1];
      if (choice === 'head' || choice === 'head-tail') take(first, 0);
      // The closing sentence is only known once the reply has settled.
      if (choice === 'tail' || choice === 'head-tail') {
        if (settled) take(last, speakable.length - 1);
      }
      return out;
    }

    /**
     * Choose the sentences that are actually spoken.
     *
     * @param {string[]} speakable - the sentences of the reply, in order.
     * @param {string} mode - one of head-tail, all, head, tail.
     * @param {boolean} settled - whether the reply has finished streaming.
     * @param {Set<string>} spoken - what was already spoken.
     * @returns {string[]} the sentences to speak now.
     */
    function pickSpoken(speakable, mode, settled, spoken) {
      return pickEntries(speakable, mode, settled, spoken).map((entry) => entry.text);
    }

    /** How often one sentence may be tried at most. */
    const MAX_SPEECH_ATTEMPTS = 2;

    /** How long a failed sentence waits before it is tried again. */
    const SPEECH_RETRY_DELAY_MS = 5000;

    /**
     * The record of a sentence that is on its way to the speaker.
     *
     * @param {object} [entry] - what was known about the sentence before.
     */
    function pendingState(entry) {
      return { state: 'pending', attempts: entry?.attempts ?? 0, notBefore: 0 };
    }

    /**
     * The record of a sentence that was read out.
     *
     * @param {object} [entry] - what was known about the sentence before.
     */
    function spokenState(entry) {
      return { state: 'spoken', attempts: (entry?.attempts ?? 0) + 1, notBefore: 0 };
    }

    /**
     * The record of a sentence that failed.
     *
     * A failure is not the end of the sentence: the service may have been
     * busy for a moment, and the sentence is worth reading out once it
     * answers again. The tries are counted, so a sentence that keeps failing
     * is not retried for ever.
     *
     * @param {object} [entry] - what was known about the sentence before.
     * @param {number} [now] - the current time.
     */
    function failedState(entry, now = Date.now()) {
      const attempts = (entry?.attempts ?? 0) + 1;
      return {
        state: 'failed',
        attempts,
        notBefore: now + SPEECH_RETRY_DELAY_MS,
        exhausted: attempts >= MAX_SPEECH_ATTEMPTS,
      };
    }

    /**
     * The record of a sentence that was queued and then dropped.
     *
     * The user barged in, or the read-out was switched off: the sentence was
     * never spoken, so it stays free to be picked up again.
     *
     * @param {object} [entry] - what was known about the sentence before.
     */
    function releasedState(entry) {
      return { state: 'idle', attempts: entry?.attempts ?? 0, notBefore: 0 };
    }

    /**
     * Whether a failed sentence may be tried again.
     *
     * @param {object} [entry] - the record of the sentence.
     * @param {number} [now] - the current time.
     */
    function canRetry(entry, now = Date.now()) {
      if (entry === undefined || entry === null) return false;
      if (entry.state !== 'failed') return false;
      if ((entry.attempts ?? 0) >= MAX_SPEECH_ATTEMPTS) return false;
      return now >= (entry.notBefore ?? 0);
    }

    /** Strip markdown, code fences and URLs so the reader never speaks markup. */
    function cleanReplyText(text, maxChars) {
      const limit = maxChars ?? 600;
      const out = String(text)
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/`[^`\n]*`/g, ' ')
        .replace(/https?:\/\/[^\s)\]]+/g, ' ')
        .replace(/^#{1,6}\s+/gm, '')
        .replace(/^>\s?/gm, '')
        .replace(/^[-*+]\s+/gm, '')
        .replace(/[*_~]{1,3}/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (out.length <= limit) return out;
      const cut = out.slice(0, limit);
      const boundary = Math.max(
        cut.lastIndexOf('。'), cut.lastIndexOf('！'), cut.lastIndexOf('？'),
        cut.lastIndexOf('.'), cut.lastIndexOf('!'), cut.lastIndexOf('?'),
      );
      return boundary > limit * 0.5 ? `${cut.slice(0, boundary + 1)}…` : `${cut}…`;
    }

    /** Read chat nodes off a `useChat` snapshot, tolerating older shapes. */
    function chatNodes(chat) {
      try {
        return chat?.nodes?.values?.() ?? [];
      } catch {
        return [];
      }
    }

    // ─────────────────────────────────────────────────────────── dictionaries

    const zh = {
      title: 'DSH-Voice',
      mic: '麦克风',
      micStop: '停止聆听',
      micTitle: '连续聆听：说完停一下就自动发送',
      speak: '朗读',
      interrupt: '插话：我说话时打断朗读',
      queue: '排队：等当前回复说完再发',
      interruptShort: '插话',
      queueShort: '排队',
      settingsShort: '设置',
      notReady: '语音模型未就绪',
      prepare: '下载并准备本地模型',
      preparing: '正在准备模型…',
      ready: '语音引擎就绪',
      settings: '语音设置',
      voice: '音色',
      provider: 'TTS 服务',
      apiKey: 'MiMo API Key（留空则读 MIMO_API_KEY 环境变量）',
      save: '保存',
      close: '关闭',
      newVoice: '新建克隆音色',
      upload: '选择参考音频（wav/mp3，5~20 秒最稳）',
      voiceName: '音色名',
      refText: '参考音频说了什么（可选）',
      refTextRequired: '参考音频说了什么（必填）',
      refTextRequiredHint: '该服务靠这段文字与参考音频对齐，缺了它就无法克隆。',
      create: '创建',
      remove: '删除',
      sttBackend: '识别',
      vadBackend: '断句 VAD',
      listening: '聆听中…',
      recognizing: '识别中…',
      thinking: '正在说话…',
      noKey: '未配置 TTS API Key',
      diag: '诊断',
      downloadFailed: '下载失败',
      copyDiag: '复制诊断信息',
      copied: '已复制',
      languageLabel: '识别语言',
      lang_auto: '自动',
      lang_zh: '中文',
      lang_en: '英语',
      lang_yue: '粤语',
      lang_ja: '日语',
      lang_ko: '韩语',
      // ── settings tabs ──────────────────────────────────────────────────────
      tabVoices: '音色偏好',
      tabPersona: '人物设定',
      tabAdvanced: '高级设置',
      // ── voice preferences ──────────────────────────────────────────────────
      voicePrefs: '音色偏好',
      cloneVoice: '克隆音色',
      cloneVoiceHint: '克隆音色需要所选服务支持声音克隆；不支持的服务不能创建克隆音色。',
      noCloneSupport: '当前服务不支持声音克隆',
      sampleVoice: '试听',
      defaultVoice: '默认音色',
      // ── persona ────────────────────────────────────────────────────────────
      speakModeTitle: '语音播报',
      speakModeHeadTail: '只播首句和尾句',
      speakModeAll: '播报全文',
      speakModeHead: '只播首句',
      speakModeTail: '只播尾句',
      speakModeHint: '这一项只决定「读出来什么」：思考过程永远不读，回复的其余部分是否出声由这里决定。上面的人设文本仍然管「怎么回答」。',
      personaTitle: '对话人设',
      personaHint: '决定助手「怎么讲话、讲什么内容」。例如：用户问一句答一句；回答较长时先给一句总结。这是给对话模型的指示，不影响音色。',
      personaPlaceholder: '例如：这是语音对话，用户问一句你答一句；回答内容较多时，先用一两句话讲清要点，再补一句「你可以看看我总结的内容」。',
      personaApplied: '人设已生效',
      personaNotApplied: '人设未生效',
      ttsStyleTitle: '朗读语气',
      ttsStyleHint: '决定声音「怎么念」。这段文字会作为指令发给 TTS 服务，对克隆音色同样有效。建议按「角色 / 场景 / 指导」三段来写。',
      ttsStylePlaceholder: '例如：\n角色：耐心的技术顾问，语气沉稳。\n场景：向同事解释一个复杂问题。\n指导：语速偏慢，句末略作停顿，重点词稍作强调。',
      ttsStyleTags: '预置音色还可以直接在文本里加 (开心)、(温柔)、(东北话) 这类标签；克隆音色建议用上面的自然语言描述。',
      // ── advanced ───────────────────────────────────────────────────────────
      advancedTitle: '高级设置',
      providerSection: 'TTS 服务',
      providerHint: '选择朗读用的服务。可添加自定义服务，只要它使用 MiMo 或 OpenAI 兼容的接口格式。',
      addProvider: '添加服务',
      editCurrentProvider: '编辑当前服务',
      editProvider: '修改服务',
      providerId: '服务标识',
      providerIdHint: '只能用字母、数字、点和短横线，且以字母或数字开头；创建后不可更改。',
      providerIdInvalid: '标识不合法：需以字母或数字开头，只能包含字母、数字、点和短横线。',
      providerLabel: '显示名称',
      providerBaseUrl: '接口地址',
      providerModel: '模型',
      providerVoice: '音色',
      providerFormat: '返回格式',
      providerApiKey: '当前服务的 API Key',
      providerApiKeyEnv: '环境变量名',
      providerClone: '支持声音克隆',
      providerDelete: '删除',
      providerDeleteBuiltin: '内置服务不能删除',
      providerSaved: '已保存',
      providerDeleted: '已删除',
      providerKind: '接口格式',
      kind_mimo: 'MiMo（chat/completions）',
      kind_openaispeech: 'OpenAI 兼容（/audio/speech）',
      kind_siliconflow: '硅基流动（/audio/speech + 音色注册）',
      kind_devtone: '本地测试音',
      referenceProviders: '参考配置',
      referenceHint: '下面两项是已验证可用的免费参考配置，点一下即可填入表单。',
      sensitivityTitle: '麦克风灵敏度',
      interruptSensitivity: '打断灵敏度',
      interruptSensitivityHint: '调高后更容易打断正在朗读的回复，轻声插话也能插进去。代价是环境噪声更容易误触发；调低则需要更大的声音。',
      minRms: '最小音量',
      minRmsHint: '调高后更小的声音也会被当成「开始说话」，安静环境里更容易被误触发；调低则只有更响的声音才算开口，代价是说话太轻时整句可能被丢掉。',
      sensitivityValue: '实际阈值',
      sensitivityEffect: '立即生效',
      // ── diagnostics and dependencies ───────────────────────────────────────
      diagSection: '诊断与依赖',
      dependencyName: '依赖',
      dependencyStatus: '状态',
      dependencySource: '来源',
      dependencyVersion: '版本',
      dependencyRequired: '要求',
      depOk: '已安装',
      depMissing: '未安装',
      depMismatch: '版本不符',
      depProvided: '由 DSH 提供',
      depInstall: '安装',
      depInstalling: '安装中…',
      depInstalled: '安装完成，请重启 DSH 后生效',
      depInstallFailed: '安装失败',
      depRestartHint: '依赖装进 DSH 的 profile 后需要重启 DSH 才能生效。',
      depOptionalHint: 'onnxruntime-node 只影响断句检测（FireRedVAD）；缺少它会自动改用别的断句方式，识别和朗读仍然可用。',
      // ── messages ────────────────────────────────────────────────────────────
      errNoSession: '没有活动会话',
      errSessionGone: '会话不可用',
      errSendFailed: '发送失败',
      errSessionChanged: '会话已经切换，这句话没有发送',
      errServiceDown: '语音服务不可用',
      errModelPrepare: '模型准备失败',
      errModelTimeout: '模型准备超时：等了 30 分钟仍未完成，请重新开始。',
      errRecognize: '识别失败',
      errMicOpen: '无法打开麦克风',
      errSpeak: '朗读失败',
      errHostRefused: '宿主拒绝了本页面的请求',
      errHostRefusedReason: '来源不一致',
      errHostOriginUnknown: '未知',
      speakRetry: '稍后重试',
      speakRetrySpent: '已经试过两次，仍未成功',
      busyVoice: '音色',
      busyCreateVoice: '创建音色',
      busyDeleteVoice: '删除音色',
      busySavePersona: '保存人设',
      busyCheckUpdate: '检查更新',
      busyUpdate: '更新',
      busyInstallDep: '安装',
      busySaveProvider: '保存服务',
      busySwitchProvider: '切换服务',
      busyDeleteProvider: '删除服务',
      busySaveKey: '保存 Key',
      busySpeakMode: '保存播报方式',
      busyPrepareModels: '准备模型',
      pickRefAudio: '请先选择参考音频',
      pickRefText: '请填写参考音频对应的文字，该服务靠它与音频对齐',
      providerCloneHint: '由所选接口格式的能力决定，不能手动更改。',
      // ── version update ─────────────────────────────────────────────────────
      versionSection: '版本更新',
      currentVersion: '当前版本',
      latestVersion: '最新版本',
      checkUpdate: '检查更新',
      checking: '检查中…',
      upToDate: '已是最新版本',
      updateAvailable: '有新版本可用',
      updateNow: '立即更新',
      updateConfirm: '更新将通过 pnpm 重新安装到 DSH 的 profile，并可能需要重启 DSH。继续吗？',
      updateInstalling: '正在安装…',
      updateDone: '更新完成，请重启 DSH',
      updateFailed: '更新失败',
      updateUnreachable: '无法连接版本检查服务，请检查网络后重试',
      updateManual: '手动安装命令',
      updateNoServer: '版本检查直接读取 GitHub 公开 Release，不需要额外服务器。',
      // ── model preparation ──────────────────────────────────────────────────
      modelPrepTitle: '模型准备',
      modelPrepHint: '模型准备下载的是本地识别模型（SenseVoice + 断句检测），完全离线、不需要 Key。它让插件能听懂你说话；TTS 服务配置则负责把回复念出来，两者是独立的。',
      preparingModel: '正在准备模型…',
    };

    const en = {
      title: 'DSH-Voice',
      mic: 'Microphone',
      micStop: 'Stop listening',
      micTitle: 'Listen continuously; a pause sends the sentence',
      speak: 'Speak',
      interrupt: 'Barge-in: talking cuts the reply off',
      queue: 'Queue: let the current reply finish',
      interruptShort: 'Barge-in',
      queueShort: 'Queue',
      settingsShort: 'Settings',
      notReady: 'Speech models are not ready',
      prepare: 'Download and prepare local models',
      preparing: 'Preparing models…',
      ready: 'Speech engine ready',
      settings: 'Voice settings',
      voice: 'Voice',
      provider: 'TTS provider',
      apiKey: 'MiMo API key (falls back to the MIMO_API_KEY environment variable)',
      save: 'Save',
      close: 'Close',
      newVoice: 'New cloned voice',
      upload: 'Reference audio (wav/mp3, 5-20 s works best)',
      voiceName: 'Voice name',
      refText: 'What the reference says (optional)',
      refTextRequired: 'What the reference says (required)',
      refTextRequiredHint: 'This service matches the words against the sample; without them it cannot clone.',
      create: 'Create',
      remove: 'Delete',
      sttBackend: 'Recognition',
      vadBackend: 'Endpoint VAD',
      listening: 'Listening…',
      recognizing: 'Recognizing…',
      thinking: 'Speaking…',
      noKey: 'TTS API key is not configured',
      diag: 'Diagnostics',
      downloadFailed: 'Download failed',
      copyDiag: 'Copy diagnostics',
      copied: 'Copied',
      languageLabel: 'Language',
      lang_auto: 'Auto',
      lang_zh: 'Chinese',
      lang_en: 'English',
      lang_yue: 'Cantonese',
      lang_ja: 'Japanese',
      lang_ko: 'Korean',
      // ── settings tabs ──────────────────────────────────────────────────────
      tabVoices: 'Voice',
      tabPersona: 'Persona',
      tabAdvanced: 'Advanced',
      // ── voice preferences ──────────────────────────────────────────────────
      voicePrefs: 'Voice preferences',
      cloneVoice: 'Cloned voice',
      cloneVoiceHint: 'Cloning needs a provider that supports it; a provider without clone support cannot create one.',
      noCloneSupport: 'This provider does not support voice cloning',
      sampleVoice: 'Play',
      defaultVoice: 'Default voice',
      // ── persona ────────────────────────────────────────────────────────────
      speakModeTitle: 'What gets read out',
      speakModeHeadTail: 'First and last sentence only',
      speakModeAll: 'The whole reply',
      speakModeHead: 'First sentence only',
      speakModeTail: 'Last sentence only',
      speakModeHint: 'This decides what is spoken: the reasoning is never read, and this setting decides whether the rest of the reply is spoken. The persona above still decides how the reply is written.',
      personaTitle: 'Conversation persona',
      personaHint: 'Decides how the assistant talks and what it says — one answer per question, and a short summary when the answer would be long. It instructs the chat model; it does not change the voice.',
      personaPlaceholder: 'For example: this is a spoken conversation, answer one question at a time; when the answer is long, lead with a one or two sentence summary and add a line like "here is my summary".',
      personaApplied: 'Persona is in effect',
      personaNotApplied: 'Persona is not in effect',
      ttsStyleTitle: 'Speaking style',
      ttsStyleHint: 'Decides how the voice reads. This text is sent to the TTS service as an instruction and works for cloned voices too. Writing it as role / scene / direction tends to work best.',
      ttsStylePlaceholder: 'For example:\nRole: a patient technical adviser with a calm tone.\nScene: explaining a tricky problem to a colleague.\nDirection: slow pace, a slight pause at the end of a sentence, a little emphasis on key words.',
      ttsStyleTags: 'Preset voices also accept inline tags such as (happy), (gentle) or (Cantonese); for a cloned voice, describe the delivery in words instead.',
      // ── advanced ───────────────────────────────────────────────────────────
      advancedTitle: 'Advanced',
      providerSection: 'TTS service',
      providerHint: 'Choose the service that reads the replies. You can add your own as long as it speaks the MiMo or the OpenAI-compatible format.',
      addProvider: 'Add service',
      editCurrentProvider: 'Edit the service in use',
      editProvider: 'Edit service',
      providerId: 'Service id',
      providerIdHint: 'Letters, digits, dots and dashes, starting with a letter or a digit; it cannot be changed later.',
      providerIdInvalid: 'Not a valid id: it must start with a letter or a digit and may only contain letters, digits, dots and dashes.',
      providerLabel: 'Display name',
      providerBaseUrl: 'Endpoint',
      providerModel: 'Model',
      providerVoice: 'Voice',
      providerFormat: 'Response format',
      providerApiKey: 'API key of the current service',
      providerApiKeyEnv: 'Environment variable',
      providerClone: 'Supports voice cloning',
      providerDelete: 'Delete',
      providerDeleteBuiltin: 'A built-in service cannot be deleted',
      providerSaved: 'Saved',
      providerDeleted: 'Deleted',
      providerKind: 'Wire format',
      kind_mimo: 'MiMo (chat/completions)',
      kind_openaispeech: 'OpenAI-compatible (/audio/speech)',
      kind_siliconflow: 'SiliconFlow (/audio/speech + voice registration)',
      kind_devtone: 'Local test tone',
      referenceProviders: 'Reference setups',
      referenceHint: 'These two were verified to work. Click one to fill the form with it.',
      sensitivityTitle: 'Microphone sensitivity',
      interruptSensitivity: 'Barge-in sensitivity',
      interruptSensitivityHint: 'A higher value makes it easier to interrupt the reply being read, so a quiet interjection cuts in too. The trade-off is that background noise interrupts more easily; a lower value needs a louder voice.',
      minRms: 'Minimum volume',
      minRmsHint: 'A higher value treats even quieter sounds as the start of speech, which in a quiet room means more false starts; a lower value needs a louder voice, and a very quiet sentence may be dropped entirely.',
      sensitivityValue: 'Actual threshold',
      sensitivityEffect: 'Takes effect immediately',
      // ── diagnostics and dependencies ───────────────────────────────────────
      diagSection: 'Diagnostics and dependencies',
      dependencyName: 'Dependency',
      dependencyStatus: 'Status',
      dependencySource: 'Resolved from',
      dependencyVersion: 'Version',
      dependencyRequired: 'Required',
      depOk: 'Installed',
      depMissing: 'Not installed',
      depMismatch: 'Version mismatch',
      depProvided: 'Supplied by DSH',
      depInstall: 'Install',
      depInstalling: 'Installing…',
      depInstalled: 'Installed; restart DSH for it to take effect',
      depInstallFailed: 'Install failed',
      depRestartHint: 'A dependency installed into the DSH profile takes effect after DSH is restarted.',
      depOptionalHint: 'onnxruntime-node only affects the endpoint detector (FireRedVAD). Without it another detector is used instead; recognition and speech still work.',
      // ── messages ────────────────────────────────────────────────────────────
      errNoSession: 'There is no active session',
      errSessionGone: 'The session is not available',
      errSendFailed: 'Sending failed',
      errSessionChanged: 'The session changed, so the sentence was not sent',
      errServiceDown: 'The speech service is not available',
      errModelPrepare: 'Preparing the models failed',
      errModelTimeout: 'Preparing the models timed out: still not done after 30 minutes, please start again.',
      errRecognize: 'Recognition failed',
      errMicOpen: 'The microphone could not be opened',
      errSpeak: 'Reading out failed',
      errHostRefused: 'The host refused the requests from this page',
      errHostRefusedReason: 'the origin does not match',
      errHostOriginUnknown: 'unknown',
      speakRetry: 'it will be tried again shortly',
      speakRetrySpent: 'it was tried twice and still failed',
      busyVoice: 'Voice',
      busyCreateVoice: 'Creating the voice',
      busyDeleteVoice: 'Deleting the voice',
      busySavePersona: 'Saving the persona',
      busyCheckUpdate: 'Checking for updates',
      busyUpdate: 'Updating',
      busyInstallDep: 'Installing',
      busySaveProvider: 'Saving the service',
      busySwitchProvider: 'Switching service',
      busyDeleteProvider: 'Deleting the service',
      busySaveKey: 'Saving the key',
      busySpeakMode: 'Saving what gets read out',
      busyPrepareModels: 'Preparing the models',
      pickRefAudio: 'Choose a reference audio first',
      pickRefText: 'Write down what the reference audio says; this service matches it against the audio',
      providerCloneHint: 'Decided by what the wire format can do; it cannot be changed by hand.',
      // ── version update ─────────────────────────────────────────────────────
      versionSection: 'Version update',
      currentVersion: 'Current version',
      latestVersion: 'Latest version',
      checkUpdate: 'Check for updates',
      checking: 'Checking…',
      upToDate: 'Already up to date',
      updateAvailable: 'A new version is available',
      updateNow: 'Update now',
      updateConfirm: 'The update is installed into the DSH profile with pnpm and may need a DSH restart. Continue?',
      updateInstalling: 'Installing…',
      updateDone: 'Update complete; please restart DSH',
      updateFailed: 'Update failed',
      updateUnreachable: 'The version service could not be reached; check the network and try again',
      updateManual: 'Manual install command',
      updateNoServer: 'The check reads the public GitHub release directly; no extra server is needed.',
      // ── model preparation ──────────────────────────────────────────────────
      modelPrepTitle: 'Model preparation',
      modelPrepHint: 'Model preparation downloads the local recognition models (SenseVoice plus the endpoint detector). It runs offline, needs no key, and is what lets the plugin understand you. The TTS service settings are separate: they read the reply aloud.',
      preparingModel: 'Preparing models…',
    };

    /**
     * A translator for the messages the engine itself writes.
     *
     * The components get a `t` of their own from the Host. The engine's
     * messages are made outside a component, so they need a dictionary of
     * their own: they follow the language the browser asks for.
     *
     * @returns {(key: string) => string} the translator.
     */
    function localT() {
      const asked = typeof navigator === 'undefined' ? 'zh' : String(navigator.language ?? 'zh');
      const dictionary = /^zh/i.test(asked) ? zh : en;
      return (key) => dictionary[key] ?? key;
    }
    // ──────────────────────────────────────────────────────────────── styling

    const styles = {
      button: {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 5,
        // A button must never be squeezed by the field beside it: with a
        // `width: 100%` input in the same flex row it collapsed to nothing and
        // the label spilled out of the rounded box.
        flex: 'none',
        whiteSpace: 'nowrap',
        height: 28,
        padding: '0 11px',
        borderRadius: 10,
        border: '1px solid transparent',
        background: 'var(--dshv-field)',
        color: 'inherit',
        cursor: 'pointer',
        lineHeight: 1,
        font: 'inherit',
        fontSize: 12,
      },
      knob: { padding: '0 9px', height: 26, fontSize: 12 },
      iconKnob: { padding: 0, width: 28, height: 28, justifyContent: 'center' },
      // The panel is placed by `fitPanel()` next to wherever the bead happens to
      // sit, so only the material and the shape are declared here. Its width and
      // its height limit come from `panelLimits()`, which bounds both to the
      // movable area — a value here would silently win over that.
      panel: {
        position: 'fixed',
        zIndex: 60,
        overflowY: 'auto',
        padding: 14,
        borderRadius: 22,
        border: '1px solid var(--dshv-glass-stroke)',
        background: 'var(--dshv-glass)',
        backdropFilter: 'blur(30px) saturate(180%)',
        WebkitBackdropFilter: 'blur(30px) saturate(180%)',
        boxShadow: 'var(--dshv-glass-shadow), inset 0 1px 0 var(--dshv-glass-inner)',
        color: 'var(--dsw-alias-label-primary, inherit)',
        fontSize: 12,
        lineHeight: 1.6,
      },
      row: { display: 'flex', alignItems: 'center', gap: 6, margin: '6px 0' },
      field: {
        width: '100%',
        boxSizing: 'border-box',
        height: 30,
        padding: '0 10px',
        borderRadius: 10,
        border: '1px solid transparent',
        background: 'var(--dshv-field)',
        color: 'inherit',
        font: 'inherit',
        fontSize: 12,
      },
      label: { minWidth: 58, color: 'var(--dsw-alias-label-secondary, inherit)' },
      section: { marginTop: 10, paddingTop: 9, borderTop: '1px solid var(--dshv-sep)' },
      error: { color: 'var(--dshv-record)', marginTop: 6, whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
      note: { color: 'var(--dsw-alias-label-tertiary, inherit)', fontSize: 11 },
      // A dot plus a word is enough for readiness; the reason lives in the
      // details drawer so the first screen stays readable.
      statusRow: { display: 'flex', alignItems: 'center', gap: 7, marginBottom: 8, fontSize: 12.5 },
      sectionHead: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
        fontWeight: 600,
        fontSize: 12.5,
      },
    };

    function Button({ style, children, ...rest }) {
      return h('button', { type: 'button', style: { ...styles.button, ...style }, ...rest }, children);
    }

    // ─────────────────────────────────────────────── glass theme + icons

    /**
     * The orb needs keyframes, pseudo-elements and reduced-motion rules, none
     * of which an inline style object can express. One style tag is injected
     * for the plugin's lifetime and removed again on dispose.
     */
    const STYLE_ID = 'dsh-voice-styles';

    const CSS = `
.dshv{--dshv-glass:rgba(255,255,255,.58);--dshv-glass-strong:rgba(255,255,255,.86);
  --dshv-glass-stroke:rgba(255,255,255,.72);--dshv-glass-inner:rgba(255,255,255,.85);
  --dshv-glass-shadow:0 10px 32px rgba(0,0,0,.14);
  --dshv-field:rgba(120,120,128,.12);--dshv-sep:rgba(120,120,128,.22);
  --dshv-accent:#007aff;--dshv-record:#ff3b30;--dshv-warn:#ff9f0a;
  --dshv-bead-tint:rgba(150,162,178,.17);--dshv-bead-rim:rgba(255,255,255,.95);
  --dshv-bead-shade:rgba(60,70,90,.20);--dshv-ripple:rgba(96,132,176,.74);
  --dshv-ink:var(--dsw-alias-label-primary,currentColor);
  position:fixed;z-index:70;display:inline-flex;align-items:center;
  transition:left .26s cubic-bezier(.2,.9,.25,1),top .26s cubic-bezier(.2,.9,.25,1)}
/* No transition while the pointer owns the position, or the bead would lag. The
   same goes while the area around it is being dragged: the bead has to keep up
   with the edge it clings to, and a quarter-second ease reads as lag. */
.dshv[data-dragging="true"],
.dshv[data-following="true"]{transition:none}
body[data-ds-dark-theme] .dshv{--dshv-glass:rgba(255,255,255,.14);
  --dshv-glass-strong:rgba(255,255,255,.90);--dshv-glass-stroke:rgba(255,255,255,.18);
  --dshv-glass-inner:rgba(255,255,255,.22);--dshv-glass-shadow:0 12px 36px rgba(0,0,0,.44);
  --dshv-field:rgba(255,255,255,.12);--dshv-sep:rgba(255,255,255,.16);
  --dshv-accent:#0a84ff;--dshv-record:#ff453a;
  --dshv-bead-tint:rgba(255,255,255,.10);--dshv-bead-rim:rgba(255,255,255,.60);
  --dshv-bead-shade:rgba(0,0,0,.34);--dshv-ripple:rgba(205,235,255,.72)}
.dshv-panel button:hover:not(:disabled){background:rgba(120,120,128,.26)}
body[data-ds-dark-theme] .dshv-panel button:hover:not(:disabled){background:rgba(255,255,255,.20)}
.dshv-panel input:focus,.dshv-panel select:focus{outline:2px solid var(--dshv-accent);outline-offset:1px}

/* The ball is colourless on purpose: highlight, inner shadow and a bottom
   caustic define its shape, and whatever is behind shows through it. */
.dshv-orbwrap{position:relative;width:52px;height:52px}
/* Stuck to an edge the bead squashes against it and sags — a limp droplet, not
   a ball. The squash lives on the wrapper so it composes with the level-driven
   swell instead of fighting it over the transform property. */
.dshv-gel{
  position:absolute;inset:0;display:block;will-change:transform;
  transform:
    translateY(var(--dshv-sag,0px))
    rotate(var(--dshv-tilt,0deg))
    scale(
      calc(var(--dshv-sx,1) * (1 + var(--dshv-lvl,0) * .045)),
      calc(var(--dshv-sy,1) * (1 + var(--dshv-lvl,0) * .045)))}
/* Wetting an edge widens the contact area: the bead spreads slightly along the
   surface while its radius flattens against it (ATTACHED_RADII in JS). */
.dshv[data-attached="left"] .dshv-gel{
  --dshv-sx:1;--dshv-sy:1.07;--dshv-sag:0px;--dshv-tilt:0deg;transform-origin:left center}
.dshv[data-attached="right"] .dshv-gel{
  --dshv-sx:1;--dshv-sy:1.07;--dshv-sag:0px;--dshv-tilt:0deg;transform-origin:right center}
.dshv[data-attached="top"] .dshv-gel{
  --dshv-sx:1.07;--dshv-sy:1;--dshv-sag:0px;--dshv-tilt:0deg;transform-origin:center top}
.dshv[data-attached="bottom"] .dshv-gel{
  --dshv-sx:1.07;--dshv-sy:1;--dshv-sag:0px;--dshv-tilt:0deg;transform-origin:center bottom}
/* The droplet silhouette comes from JS whenever the bead is stuck (the wave owns
   border-radius), so CSS must not animate that property here — and a stuck bead
   with nothing to say stays perfectly still instead of trembling. The state
   rules further down still shake it, because they only touch the transform. */
.dshv[data-attached="left"] .dshv-orb,
.dshv[data-attached="right"] .dshv-orb,
.dshv[data-attached="top"] .dshv-orb,
.dshv[data-attached="bottom"] .dshv-orb{animation:none}
/* Only settle the sag when nothing is driving the level, or the meter lags. */
.dshv[data-state="idle"] .dshv-gel,
.dshv[data-state="notready"] .dshv-gel{transition:transform .3s cubic-bezier(.2,.9,.25,1)}
.dshv-orb{position:absolute;inset:0;width:52px;height:52px;padding:0;border:0;
  border-radius:50%;background:transparent;color:var(--dshv-ink);
  cursor:grab;touch-action:none;
  display:grid;place-items:center;font:inherit;
  animation:dshv-swell 9.3s ease-in-out infinite;
  transition:transform .3s cubic-bezier(.34,1.3,.64,1),opacity .3s ease}
.dshv[data-dragging="true"] .dshv-orb{cursor:grabbing}
.dshv-orb::before,.dshv-bead::before{content:"";position:absolute;inset:0;border-radius:inherit;
  background:
    radial-gradient(circle at 34% 23%,rgba(255,255,255,.98) 0 5%,rgba(255,255,255,.55) 12%,rgba(255,255,255,.10) 30%,rgba(255,255,255,0) 56%),
    radial-gradient(circle at 28% 76%,rgba(255,255,255,.30),rgba(255,255,255,0) 46%),
    radial-gradient(circle at 74% 82%,rgba(255,255,255,.30),rgba(255,255,255,0) 50%),
    var(--dshv-bead-tint);
  backdrop-filter:blur(9px) saturate(150%);-webkit-backdrop-filter:blur(9px) saturate(150%);
  box-shadow:inset 0 1.5px 2px var(--dshv-bead-rim),inset 0 -12px 20px rgba(255,255,255,.20),
    inset 0 0 0 1px rgba(255,255,255,.45),0 10px 24px var(--dshv-bead-shade),0 2px 5px rgba(0,0,0,.10)}
.dshv-orb::after,.dshv-bead::after{content:"";position:absolute;left:50%;bottom:6%;
  width:calc(46% + var(--dshv-lvl,0) * 26%);height:calc(16% + var(--dshv-lvl,0) * 8%);
  transform:translateX(-50%);border-radius:50%;pointer-events:none;
  background:radial-gradient(closest-side,rgba(255,255,255,.72),rgba(255,255,255,0))}
.dshv-orb>svg,.dshv-bead>svg{position:relative;z-index:1}

/* Idle: the outline drifts through irregular stops, like water settling. */
@keyframes dshv-swell{
  0%,100%{border-radius:50% 50% 50% 50%/50% 50% 50% 50%}
  18%{border-radius:46% 54% 51% 49%/52% 47% 53% 48%}
  36%{border-radius:52% 48% 47% 53%/48% 54% 46% 52%}
  54%{border-radius:49% 51% 55% 45%/45% 51% 49% 55%}
  72%{border-radius:54% 46% 48% 52%/53% 48% 52% 47%}
  88%{border-radius:48% 52% 50% 50%/49% 53% 47% 51%}}
/* Under a pixel of high-frequency displacement: the surface trembles. */
@keyframes dshv-tremble{
  0%,100%{transform:translate(0,0)}
  20%{transform:translate(.6px,-.45px)}
  40%{transform:translate(-.5px,.35px)}
  60%{transform:translate(.35px,.5px)}
  80%{transform:translate(-.45px,-.3px)}}
/* Three concentric rings, a third of a cycle apart: an unbroken ripple. */
@keyframes dshv-ripple{0%{transform:scale(1);opacity:.72}60%{opacity:.22}100%{transform:scale(2.05);opacity:0}}

/* Listening drives the outline from the microphone instead: the bead doubles as
   a level meter, so a quiet voice becomes something the speaker can see. */
.dshv[data-state="listening"] .dshv-orb{color:var(--dshv-record);
  animation:dshv-tremble .26s linear infinite}
.dshv[data-state="recognizing"] .dshv-orb{color:var(--dshv-warn);
  animation:dshv-swell 2.3s ease-in-out infinite,dshv-tremble .15s linear infinite}
.dshv[data-state="notready"] .dshv-orb{color:var(--dshv-warn)}
/* Speaking: the outline comes from the analyser each frame, so only the
   tremble stays in CSS (and it animates transform, never border-radius). */
.dshv[data-state="speaking"] .dshv-orb{animation:dshv-tremble .3s linear infinite}
/* Stuck to an edge the silhouette is written per frame in JS, so the swell has to
   stand down there as well — the state motions still get to shake it. */
.dshv[data-attached="left"][data-state="recognizing"] .dshv-orb,
.dshv[data-attached="right"][data-state="recognizing"] .dshv-orb,
.dshv[data-attached="top"][data-state="recognizing"] .dshv-orb,
.dshv[data-attached="bottom"][data-state="recognizing"] .dshv-orb{animation:dshv-tremble .15s linear infinite}

.dshv-wave{position:absolute;inset:0;border-radius:50%;border:2px solid var(--dshv-ripple);
  opacity:0;pointer-events:none}
.dshv-wave::before,.dshv-wave::after{content:"";position:absolute;inset:0;border-radius:50%;
  border:2px solid var(--dshv-ripple);opacity:0;pointer-events:none}
.dshv[data-state="listening"] .dshv-wave,
.dshv[data-state="listening"] .dshv-wave::before,
.dshv[data-state="listening"] .dshv-wave::after{animation:dshv-ripple 2.4s ease-out infinite}
.dshv[data-state="listening"] .dshv-wave::before{animation-delay:.8s}
.dshv[data-state="listening"] .dshv-wave::after{animation-delay:1.6s}
.dshv[data-state="recognizing"] .dshv-wave,
.dshv[data-state="recognizing"] .dshv-wave::before,
.dshv[data-state="recognizing"] .dshv-wave::after{animation:dshv-ripple 1.35s ease-out infinite}
.dshv[data-state="recognizing"] .dshv-wave::before{animation-delay:.45s}
.dshv[data-state="recognizing"] .dshv-wave::after{animation-delay:.9s}
.dshv[data-state="speaking"] .dshv-wave,
.dshv[data-state="speaking"] .dshv-wave::before,
.dshv[data-state="speaking"] .dshv-wave::after{animation:dshv-ripple 1.9s ease-out infinite}
.dshv[data-state="speaking"] .dshv-wave::before{animation-delay:.63s}
.dshv[data-state="speaking"] .dshv-wave::after{animation-delay:1.27s}

/* Open: the four droplets glide out of the orb to their places along the nearest
   edge, on a spring. Closing is the same movement backwards — they gather along
   that edge into one another and melt there, while the orb reappears exactly
   where they gathered. */
.dshv-spread{position:absolute;right:0;bottom:0;width:0;height:0}
/* The node is exactly its bead — the label floats outside it — so a bead that
   docks flush really does touch the edge it docked to. */
.dshv-node{position:absolute;right:26px;bottom:26px;width:44px;height:44px;
  transform:translate(var(--mx),var(--my)) scale(.4);opacity:0;pointer-events:none;
  transition:transform .42s cubic-bezier(.26,1.5,.5,1),opacity .26s ease}
.dshv[data-expanded="true"] .dshv-node{transform:translate(var(--tx),var(--ty)) scale(1);
  opacity:1;pointer-events:auto}
.dshv[data-expanded="true"] .dshv-node:nth-child(2){transition-delay:.03s;--dshv-dock-delay:.03s}
.dshv[data-expanded="true"] .dshv-node:nth-child(3){transition-delay:.09s;--dshv-dock-delay:.09s}
.dshv[data-expanded="true"] .dshv-node:nth-child(4){transition-delay:.15s;--dshv-dock-delay:.15s}
.dshv[data-expanded="true"] .dshv-orb{transform:scale(.38);opacity:0;animation:none}
.dshv[data-expanded="true"] .dshv-wave{display:none}
/* The label always sits above the bead: below it, the transcript's own text runs
   straight through it. */
.dshv-cap{position:absolute;left:50%;bottom:100%;transform:translateX(-50%);
  margin-bottom:2px;font-size:11px;line-height:1.15;white-space:nowrap;
  color:var(--dsw-alias-label-secondary,currentColor)}
/* The droplet arrives bare — no label, no glyph — and only gets them once it has
   docked. Closing drops them at once, so nothing text-like travels back. */
.dshv-bead>svg,.dshv-cap{opacity:0;transition:opacity .14s ease}
.dshv[data-expanded="true"] .dshv-node .dshv-bead>svg,
.dshv[data-expanded="true"] .dshv-node .dshv-cap{
  opacity:1;transition:opacity .2s ease calc(.46s + var(--dshv-dock-delay,0s))}
.dshv-bead{position:relative;width:44px;height:44px;padding:0;border:0;border-radius:50%;
  background:transparent;color:var(--dshv-ink);cursor:pointer;display:grid;
  place-items:center;font:inherit;transition:border-radius .3s ease}
/* Every docked droplet hangs off its edge the way the orb does: flattened against
   the surface it touches, round away from it. */
.dshv-node[data-docked="left"]{--dshv-dock-radius:20% 80% 80% 20% / 50% 50% 50% 50%}
.dshv-node[data-docked="right"]{--dshv-dock-radius:80% 20% 20% 80% / 50% 50% 50% 50%}
.dshv-node[data-docked="top"]{--dshv-dock-radius:50% 50% 50% 50% / 20% 20% 80% 80%}
.dshv-node[data-docked="bottom"]{--dshv-dock-radius:50% 50% 50% 50% / 80% 80% 20% 20%}
.dshv-node .dshv-bead{border-radius:var(--dshv-dock-radius,50%)}
.dshv-node[data-on="true"] .dshv-bead::before{background:var(--dshv-glass-strong);
  box-shadow:inset 0 1px 1px rgba(255,255,255,.95),0 8px 22px var(--dshv-bead-shade)}
.dshv-node[data-on="true"] .dshv-bead{color:var(--dshv-accent)}
.dshv-node[data-tone="record"] .dshv-bead{color:var(--dshv-record)}
.dshv-node[data-tone="warn"] .dshv-bead{color:var(--dshv-warn)}

/* Readiness dot in the settings header. */
.dshv-readydot{flex:none;width:8px;height:8px;border-radius:50%;background:currentColor;
  box-shadow:0 0 0 3px rgba(120,120,128,.20)}

/* The settings sheet. Its coordinates come from a placement helper so it always
   opens beside the bead; the inside is a plain scrolling column. */
.dshv-panel h4{margin:0;font-size:13px;font-weight:600}
.dshv-panel .dshv-kv{display:flex;align-items:baseline;gap:8px;margin:4px 0}
.dshv-panel .dshv-kv>span:first-child{flex:none;min-width:58px;
  color:var(--dsw-alias-label-secondary,inherit)}
.dshv-panel .dshv-kv>span:last-child{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;
  white-space:nowrap}
/* A cloned voice reads better as a card: its name needs the full width, and the
   player used to squeeze it into a sliver beside the delete button. */
.dshv-voicecard{margin:6px 0;padding:7px 8px;border-radius:12px;
  border:1px solid var(--dshv-sep);background:var(--dshv-field)}
.dshv-voicehead{display:flex;align-items:center;gap:6px}
.dshv-panel audio{width:100%;height:26px}
.dshv-panel button{cursor:pointer}
.dshv-panel button:disabled{opacity:.5;cursor:default}
.dshv-panel select,.dshv-panel input,.dshv-panel textarea{min-width:0}
.dshv-panel ::placeholder{color:var(--dsw-alias-label-tertiary,currentColor);opacity:.8}
/* The tabs split a long sheet into three pages. They sit below the sticky head
   and above the content, and the selected one is marked by its colour and
   weight rather than by a box, so the strip stays quiet. */
.dshv-tabs{display:flex;gap:4px;margin:0 0 4px;padding:2px;border-radius:12px;
  background:var(--dshv-field)}
.dshv-tabpanel{display:block}
.dshv-tab{flex:1;min-width:0;padding:6px 4px;border:0;border-radius:10px;background:none;
  font:inherit;font-size:12px;color:var(--dsw-alias-label-secondary,inherit);
  text-align:center;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer}
.dshv-tab:hover{background:rgba(120,120,128,.16)}
body[data-ds-dark-theme] .dshv-tab:hover{background:rgba(255,255,255,.12)}
.dshv-tab[data-active="true"]{background:var(--dshv-glass);color:var(--dshv-accent);font-weight:600;
  box-shadow:0 1px 2px rgba(0,0,0,.08)}
/* The dependency list answers "is it installed, and where did it come from". */
.dshv-dep{margin:7px 0;padding:7px 8px;border-radius:12px;background:var(--dshv-field)}
.dshv-dep-head{display:flex;align-items:center;gap:8px;margin-bottom:2px}
.dshv-dep-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font-size:12.5px;font-weight:600}
.dshv-dep-state{flex:none;font-size:10.5px;padding:1px 6px;border-radius:9px;
  color:var(--dsw-alias-label-secondary,inherit)}
.dshv-dep-state[data-state="ok"]{color:#10b981}
.dshv-dep-state[data-state="missing"]{color:var(--dshv-warn)}
.dshv-dep-state[data-state="mismatch"]{color:var(--dshv-record)}
.dshv-dep-log{max-height:140px;overflow:auto;margin:6px 0 0;padding:6px;border-radius:9px;
  background:var(--dshv-field);font-family:ui-monospace,Consolas,monospace;font-size:10.5px;
  line-height:1.5;white-space:pre-wrap;overflow-wrap:anywhere}
/* The sheet scrolls inside itself, so its head has to stay put: it carries the
   readiness dot and the only way out. It re-declares the glass because the
   content would otherwise show through as it scrolls underneath. */
.dshv-panelhead{position:sticky;z-index:1;top:-14px;display:flex;align-items:center;gap:8px;
  margin:-14px -14px 10px;padding:14px 14px 8px;border-radius:22px 22px 0 0;
  background:var(--dshv-glass);backdrop-filter:blur(30px) saturate(180%);
  -webkit-backdrop-filter:blur(30px) saturate(180%);box-shadow:0 1px 0 var(--dshv-sep)}
/* The one action that unblocks everything else gets to look like it. */
.dshv-panel .dshv-primary{width:100%;height:32px;justify-content:center;border-radius:12px;
  background:var(--dshv-accent);color:#fff;font-weight:600}
.dshv-panel .dshv-primary:hover:not(:disabled){background:var(--dshv-accent);filter:brightness(1.07)}
/* The error the bead is wearing, in words: beside the bead, capped in width and
   dismissible — a single failed request must not haunt the corner forever. */
.dshv-alert{position:absolute;top:50%;transform:translateY(-50%);display:inline-flex;
  align-items:center;gap:6px;width:max-content;padding:6px 8px;border-radius:12px;
  border:1px solid rgba(255,59,48,.35);
  background:rgba(255,59,48,.10);color:var(--dshv-record);cursor:pointer;
  font:inherit;font-size:11.5px;line-height:1.45;text-align:left}
body[data-ds-dark-theme] .dshv-alert{border-color:rgba(255,69,58,.42);
  background:rgba(255,69,58,.16)}
.dshv-alert-text{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;
  min-width:0;overflow:hidden;overflow-wrap:anywhere}
.dshv-alert-close{flex:none;display:inline-flex;align-items:center;justify-content:center;
  width:18px;height:18px;padding:0;border:0;border-radius:50%;background:none;
  color:inherit;cursor:pointer;opacity:.75}
.dshv-alert-close:hover{opacity:1;background:rgba(255,59,48,.18)}
.dshv-backdrop{position:fixed;inset:0;z-index:59;background:rgba(20,22,26,.28)}
body[data-ds-dark-theme] .dshv-backdrop{background:rgba(0,0,0,.48)}

.dshv-progress{margin-top:7px}
.dshv-progress-meta{display:flex;justify-content:space-between;gap:8px;font-size:11px;
  color:var(--dsw-alias-label-secondary,inherit)}
.dshv-bar{position:relative;height:5px;margin-top:5px;border-radius:3px;overflow:hidden;
  background:var(--dshv-field)}
.dshv-bar>i{position:absolute;top:0;bottom:0;left:0;min-width:7%;border-radius:3px;
  background:var(--dshv-accent);transition:width .4s ease}
.dshv-bar[data-busy="true"]>i{background-image:repeating-linear-gradient(115deg,
  rgba(255,255,255,.34) 0 9px,rgba(255,255,255,0) 9px 18px);
  background-size:200% 100%;animation:dshv-stripes 1.15s linear infinite}
@keyframes dshv-stripes{from{background-position:0 0}to{background-position:-36px 0}}
.dshv-diag-actions{display:flex;gap:10px;align-items:center;margin-top:6px}
.dshv-copy{border:0;background:none;padding:0;font:inherit;color:var(--dshv-accent);cursor:pointer}

@media (prefers-reduced-motion:reduce){
  .dshv-orb,.dshv-wave,.dshv-wave::before,.dshv-wave::after{animation:none!important}
  .dshv-node{animation:none!important;transition-duration:.01ms!important}
  .dshv[data-expanded="true"] .dshv-node{transform:translate(var(--tx),var(--ty)) scale(1)}
  .dshv-bead>svg,.dshv-cap{opacity:1!important;transition:none!important}
  .dshv-orb{transition-duration:.01ms!important}
  .dshv-bar[data-busy="true"]>i{animation:none!important}}
`;

    /** Inject the orb stylesheet once; the returned cleanup removes it. */
    function ensureStyleTag() {
      if (typeof document === 'undefined' || document.getElementById(STYLE_ID) !== null) {
        return () => {};
      }
      const tag = document.createElement('style');
      tag.id = STYLE_ID;
      tag.textContent = CSS;
      document.head.appendChild(tag);
      return () => tag.remove();
    }

    /**
     * Monochrome line icons, drawn inline: no emoji, no icon font, no asset
     * request, and they inherit colour from `currentColor`.
     */
    const PATHS = {
      mic: [
        ['rect', { x: 9, y: 2.6, width: 6, height: 10.6, rx: 3 }],
        ['path', { d: 'M5.6 11.6a6.4 6.4 0 0 0 12.8 0' }],
        ['path', { d: 'M12 18v3.4' }],
      ],
      speaker: [
        ['path', { d: 'M4 9.6h3.1L12 5.6v12.8l-4.9-4H4z' }],
        ['path', { d: 'M15.4 9.6a3.6 3.6 0 0 1 0 4.8' }],
        ['path', { d: 'M18.3 7.1a7.4 7.4 0 0 1 0 9.8' }],
      ],
      bolt: [['path', { d: 'M13.3 2.4 5.6 13.3h4.9l-1.1 8.3 8.1-11.2h-5z' }]],
      clock: [
        ['circle', { cx: 12, cy: 12, r: 8 }],
        ['path', { d: 'M12 7.3V12l3.1 1.9' }],
      ],
      gear: [
        ['path', { d: 'M19.4 13a7.6 7.6 0 0 0 0-2l2-1.6-2-3.4-2.4 1a7.6 7.6 0 0 0-1.7-1L15 3.3h-4l-.3 2.7a7.6 7.6 0 0 0-1.7 1l-2.4-1-2 3.4 2 1.6a7.6 7.6 0 0 0 0 2l-2 1.6 2 3.4 2.4-1c.5.4 1.1.7 1.7 1l.3 2.7h4l.3-2.7c.6-.2 1.2-.6 1.7-1l2.4 1 2-3.4z' }],
        ['circle', { cx: 12, cy: 12, r: 2.6 }],
      ],
      close: [
        ['path', { d: 'M6.4 6.4 17.6 17.6' }],
        ['path', { d: 'M17.6 6.4 6.4 17.6' }],
      ],
      check: [['path', { d: 'M5.6 12.6 10 17 18.4 7.4' }]],
      external: [
        ['path', { d: 'M13.4 4.6H19.4V10.6' }],
        ['path', { d: 'M19.4 4.6 11 13' }],
        ['path', { d: 'M17.4 14v4.4a1 1 0 0 1-1 1H5.6a1 1 0 0 1-1-1V7.6a1 1 0 0 1 1-1H10' }],
      ],
    };

    function Icon({ name, size = 22 }) {
      const parts = PATHS[name] ?? [];
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.7,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
      }, parts.map(([tag, spec], index) => h(tag, { key: index, ...spec })));
    }

    /**
     * Four coprime frequencies, so the outline never visibly repeats: the ball
     * undulates like a wave instead of breathing in and out. Horizontal and
     * vertical radii use opposite terms, which is what makes it lopsided.
     */
    const WAVE = [
      { frequency: 0.27, phase: 0, vertical: false },
      { frequency: 0.41, phase: 1.9, vertical: true },
      { frequency: 0.63, phase: 3.7, vertical: false },
      { frequency: 0.19, phase: 5.1, vertical: true },
    ];

    /**
     * Corner radii of a bead that has wetted an edge: flat against the surface it
     * touches and rounded away from it, like a droplet the boundary has wrapped
     * around. Order is clockwise from the top-left, matching border-radius.
     */
    const ATTACHED_RADII = {
      left: { h: [18, 82, 82, 18], v: [50, 50, 50, 50] },
      right: { h: [82, 18, 18, 82], v: [50, 50, 50, 50] },
      top: { h: [50, 50, 50, 50], v: [18, 18, 82, 82] },
      bottom: { h: [50, 50, 50, 50], v: [82, 82, 18, 18] },
    };

    /** CSS `border-radius` (8 values) for a given time, loudness and attachment. */
    function waveRadius(seconds, amplitude, edge = null) {
      const base = edge === null ? null : ATTACHED_RADII[edge];
      const horizontal = [];
      const vertical = [];
      for (let index = 0; index < WAVE.length; index += 1) {
        const term = WAVE[index];
        const value = Math.sin(2 * Math.PI * term.frequency * seconds + term.phase);
        const big = amplitude * 8.5 * value;
        const small = amplitude * 2.5 * value;
        const hBase = base === null ? 50 : base.h[index];
        const vBase = base === null ? 50 : base.v[index];
        horizontal.push(`${(hBase + (term.vertical ? small : big)).toFixed(2)}%`);
        vertical.push(`${(vBase + (term.vertical ? big : small)).toFixed(2)}%`);
      }
      return `${horizontal.join(' ')} / ${vertical.join(' ')}`;
    }

    // ─────────────────────────────────────────────────────── small pure helpers

    /** How long the model preparation may run before the poll gives up. */
    const PREPARE_TIMEOUT_MS = 30 * 60 * 1000;

    /** How often the preparation is asked for its progress. */
    const PREPARE_POLL_MS = 1500;

    /**
     * What the preparation poll does next.
     *
     * @param {object} state - the state of the poll.
     * @param {boolean} state.aborted - whether the plugin went away.
     * @param {boolean} state.running - whether the host is still working.
     * @param {number} state.elapsedMs - how long the run has been going.
     * @param {number} state.limitMs - how long it may go on.
     * @returns {'wait'|'done'|'timeout'|'stopped'} the next step.
     */
    function preparePoll(state) {
      if (state.aborted === true) return 'stopped';
      if (state.running !== true) return 'done';
      if (state.elapsedMs > state.limitMs) return 'timeout';
      return 'wait';
    }

    /**
     * A pause that can be cut short.
     *
     * @param {number} ms - how long to wait.
     * @param {AbortSignal} [signal] - the signal that ends the wait.
     * @returns {Promise<void>} the promise of the wait.
     */
    function delay(ms, signal) {
      return new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        const stop = () => {
          clearTimeout(timer);
          resolve();
        };
        if (signal !== undefined && signal !== null) {
          if (signal.aborted) {
            stop();
            return;
          }
          signal.addEventListener?.('abort', stop, { once: true });
        }
      });
    }

    /**
     * Whether an utterance that was recorded in one session may still be
     * delivered.
     *
     * The seat is mounted per session, and the microphone may still be open
     * when the user switches to another conversation. The words were spoken
     * in the old one, so they must not be sent to the new one.
     *
     * @param {string|undefined} recorded - the session the recorder was opened in.
     * @param {string|undefined} current - the session the plugin is bound to now.
     * @returns {boolean} whether the utterance still belongs there.
     */
    function sameSession(recorded, current) {
      if (recorded === undefined || recorded === null) return false;
      if (current === undefined || current === null) return false;
      return recorded === current;
    }

    /**
     * The options one recorder gets.
     *
     * Each recorder gets a copy: the callbacks belong to the recorder that
     * was opened, and writing them into the shared options would overwrite
     * the previous recorder's callbacks and grow the object for every
     * recording.
     *
     * @param {object} shared - the engine's options.
     * @param {object} callbacks - this recorder's callbacks.
     * @returns {object} the options for this recorder.
     */
    function recorderOptions(shared, callbacks) {
      return { ...(shared ?? {}), ...(callbacks ?? {}) };
    }

    /**
     * The install state of a dependency that is being installed.
     *
     * @param {string} name - the dependency.
     * @returns {object} the state the panel shows.
     */
    function installStarted(name) {
      return { running: true, name, output: [], error: null };
    }

    /**
     * The install state of a dependency whose installation failed.
     *
     * The run is over: the panel must not sit there saying "installing…" for
     * ever, and the button has to come back so the user can try again.
     *
     * @param {string} name - the dependency.
     * @param {string} message - why it failed.
     * @returns {object} the state the panel shows.
     */
    function installFailed(name, message) {
      return { running: false, name, output: [], error: String(message ?? '') };
    }

    // ────────────────────────────────────────────────────────────────── plugin

    /** Services this browser plugin needs before it may mount. */
    const inject = ['slots', 'locale', 'sessions'];

    /**
     * @param ctx - the browser plugin context.
     */
    function apply(ctx) {
      // One line, so "did the browser half actually load?" is answerable from
      // the console without guessing whether the toolbar is simply off-screen.
      console.log('[voice-chat] client half loaded; seats: conversation.input.dock / conversation.input.left');

      // The engine writes some of its own messages, and it does so outside a
      // component — where the Host's own translator is not at hand.
      const t = localT();

      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'voice-chat: dictionaries');
      ctx.effect(() => ensureStyleTag(), 'voice-chat: orb styles');

      const speaker = new Speaker();
      ctx.effect(() => () => speaker.dispose(), 'voice-chat: speaker');

      // Shared, plugin-lifetime engine state. Components subscribe instead of
      // owning it, so the toolbar and the reply listener never disagree about
      // whether the microphone is live.
      const engine = {
        ready: null,
        voices: [],
        presets: [],
        config: {},
        listening: false,
        recognizing: false,
        error: null,
        speaking: false,
        ttsController: null,
        // Counts how many times the user barged in. A counter rather than
        // a flag: the flag would be cleared by the first reader, and the
        // read-out chain has to notice the barge-in too.
        interruptSeq: 0,
        recorder: null,
        // True while the microphone is being opened, so a second click does
        // not start a second recorder; and set when the microphone is closed
        // while it is still being opened, so that start gives up instead of
        // opening a microphone the user just turned off.
        starting: false,
        stopRequested: false,
        // Utterances that arrived while a recognition was still running.
        // They wait their turn so the sentences reach the conversation in
        // the order they were spoken.
        pendingUtterances: [],
        sessionId: undefined,
        // The session the microphone was opened in. The seat is mounted per
        // session, and words that were spoken in one conversation must not be
        // sent to another one.
        recordedSessionId: undefined,
        listeners: new Set(),
        options: {
          minSilenceMs: 900,
          maxUtteranceMs: 30000,
          // Tuned for a quiet talker: a soft voice reaches the microphone 20-30 dB
          // down, and the old values (-38 dBFS to start, a -40 dBFS gate) cut it
          // off entirely. The host VAD already rejects noise, so the client-side
          // gate can afford to sit far lower.
          //
          // The two thresholds are read from the settings panel, and fall back
          // to the values this plugin has always used.
          rmsThreshold: sliderToThreshold(SENSITIVITY.minRms, readSlider('minRms', SENSITIVITY.minRms)),
          interruptThreshold: sliderToThreshold(SENSITIVITY.interrupt, readSlider('sensitivity', SENSITIVITY.interrupt)),
          interruptHoldMs: 220,
          noiseGateDb: -60,
        },
      };

      function notify() {
        for (const listener of [...engine.listeners]) listener();
      }

      function subscribe(listener) {
        engine.listeners.add(listener);
        return () => engine.listeners.delete(listener);
      }

      function setEngine(patch) {
        Object.assign(engine, patch);
        notify();
      }

      async function refreshState() {
        try {
          // Ask the host whether it will serve this page at all. When it
          // refuses, the reason is worth more than a bare failure.
          try {
            const caller = await api.ping?.();
            if (caller && caller.allowed === false) {
              setEngine({
                error: `${t('errHostRefused')}：${caller.reason ?? t('errHostRefusedReason')}（页面来源 ${caller.origin ?? t('errHostOriginUnknown')}）`,
              });
            }
          } catch {
            // The ping is a diagnostic; its failure is the state call's job.
          }
          const state = await api.state();
          setEngine({
            ready: state.ready === true,
            voices: state.voices ?? [],
            presets: state.presets ?? [],
            // The provider list travels with the state, so the voice tab can
            // tell whether the selected service can clone a voice without
            // having to open the advanced tab first.
            providers: state.providers ?? [],
            config: state.config ?? {},
          });
          if (state.error) setEngine({ error: state.error });
          return state;
        } catch (error) {
          setEngine({ ready: false, error: `${t('errServiceDown')}：${error.message ?? error}` });
          return null;
        }
      }

      /**
       * Kick off the model download and follow it to completion. The route
       * answers immediately so a multi-minute download never looks like a hung
       * request, which means progress has to be polled.
       *
       * The poll has a life of its own: it stops when the plugin goes away,
       * and it gives up after a while instead of following a download that
       * will never finish.
       */
      async function prepare() {
        setEngine({ error: null });
        const controller = new AbortController();
        engine.prepareController = controller;
        const startedAt = Date.now();
        try {
          await api.prepare();
        } catch (error) {
          if (engine.prepareController === controller) engine.prepareController = null;
          setEngine({ error: `${t('errModelPrepare')}：${error.message ?? error}` });
          return;
        }
        for (;;) {
          const state = await refreshState();
          const phase = state?.prepare ?? {};
          setEngine({
            prepare: phase,
            error: phase.error ? `${t('errModelPrepare')}：${phase.error}` : null,
          });
          const decision = preparePoll({
            aborted: !alive || controller.signal.aborted,
            running: phase.running === true,
            elapsedMs: Date.now() - startedAt,
            limitMs: PREPARE_TIMEOUT_MS,
          });
          if (decision === 'stopped') break;
          if (decision === 'done') break;
          if (decision === 'timeout') {
            // The download is still running on the host, but the panel must
            // not wait for it for ever: the user is told what happened.
            setEngine({ error: t('errModelTimeout') });
            break;
          }
          await delay(PREPARE_POLL_MS, controller.signal);
        }
        if (engine.prepareController === controller) engine.prepareController = null;
        await refreshState();
      }

      /** Stop playback and abandon the rest of the reply being spoken. */
      function interruptReply() {
        speaker.stop();
        engine.ttsController?.abort();
        engine.ttsController = null;
        setEngine({ speaking: false });
        engine.interruptSeq += 1;
      }

      /**
       * Deliver a recognized sentence through the session-scoped prompt API.
       *
       * @param {string} text - what was said.
       * @param {string|undefined} recordedSession - the session the recorder
       *        was opened in. The words belong to that conversation, and a
       *        conversation that is not the one any more must not receive
       *        them.
       */
      async function sendText(text, recordedSession) {
        const sessionId = engine.sessionId;
        if (sessionId === undefined) throw new Error(t('errNoSession'));
        if (!sameSession(recordedSession ?? sessionId, sessionId)) {
          // The user switched conversations while the microphone was open.
          // The sentence was spoken in the old one, so it is dropped instead
          // of being sent to a conversation nobody said it in.
          const message = t('errSessionChanged');
          setEngine({ error: message });
          void api.reportError?.('session', message, '');
          return;
        }
        const binding = ctx.sessions.binding(sessionId);
        const session = binding?.session;
        if (session === undefined) throw new Error(t('errSessionGone'));
        const running = session.getSnapshot?.()?.running === true;
        const mode = running && readFlag(STORAGE.interrupt, true) ? 'steer' : 'queue';
        const result = await session.prompt([{ type: 'text', text }], mode);
        if (result && result.ok === false) {
          throw new Error(result.error?.message ?? t('errSendFailed'));
        }
      }

      /**
       * Quiet talkers reach the recognizer 20-30 dB down, which is exactly where
       * the model starts guessing at fragments. Pull every utterance up to a
       * fixed peak, capped so genuine room tone is not amplified into fake speech.
       */
      function normalizeUtterance(buffer, target = 0.7, maxGain = 12, minPeak = 0.004) {
        const samples = new Int16Array(buffer);
        let peak = 0;
        for (let index = 0; index < samples.length; index += 1) {
          const magnitude = Math.abs(samples[index]);
          if (magnitude > peak) peak = magnitude;
        }
        const loudest = peak / 32768;
        if (loudest < minPeak) return buffer; // room tone: leave it alone
        const gain = Math.min(maxGain, target / loudest);
        if (gain <= 1.02) return buffer; // already loud enough
        for (let index = 0; index < samples.length; index += 1) {
          const scaled = Math.round(samples[index] * gain);
          samples[index] = scaled > 32767 ? 32767 : scaled < -32768 ? -32768 : scaled;
        }
        return buffer;
      }

      /**
       * Recognize one utterance and send it on.
       *
       * @param {ArrayBuffer} pcm - the recorded audio.
       * @param {string|undefined} recordedSession - the session the recorder
       *        was opened in.
       */
      async function recognize(pcm, recordedSession) {
        // One utterance at a time. The microphone keeps collecting while a
        // recognition is in flight, so a second utterance can arrive before
        // the first one has been sent. Running them together would let the
        // slower one overtake the other, and the sentences would reach the
        // conversation in the wrong order.
        if (engine.recognizing) {
          engine.pendingUtterances.push({ pcm, recordedSession });
          return;
        }
        engine.recorder?.setPaused(true);
        // A fresh attempt supersedes the previous failure; otherwise the old
        // message would sit beside the bead until the page was reloaded.
        setEngine({ recognizing: true, error: null });
        try {
          const language = readString(STORAGE.language, '') || engine.config?.language || 'auto';
          const result = await api.stt(normalizeUtterance(pcm), language);
          const text = String(result.text ?? '').trim();
          if (text.length > 0) await sendText(text, recordedSession);
        } catch (error) {
          const message = `${t('errRecognize')}：${error.message ?? error}`;
          setEngine({ error: message });
          // The host keeps the trail: a failure that only ever shows up in
          // the browser would otherwise be gone with the tab.
          void api.reportError?.('stt', message, String(error?.stack ?? '').slice(0, 500));
        } finally {
          const next = engine.pendingUtterances.shift();
          if (next === undefined) {
            setEngine({ recognizing: false });
            engine.recorder?.setPaused(false);
          } else {
            // The next utterance is already waiting: keep the microphone
            // paused and carry straight on with it.
            void recognize(next.pcm, next.recordedSession);
          }
        }
      }

      async function startListening(sessionId) {
        if (engine.recorder?.active) return;
        // Opening the microphone asks for permission, and that wait is long
        // enough for a second click to get in. Without this guard two
        // recorders would end up holding the microphone at the same time:
        // the second one would be remembered, the first one would be
        // orphaned but still collecting, and every word would be sent twice.
        if (engine.starting) return;
        engine.starting = true;
        if (sessionId !== undefined) engine.sessionId = sessionId;
        // The session is remembered as it is now: the words that are recorded
        // from here on belong to this conversation, whatever happens to the
        // seat in between.
        const recordedSession = engine.sessionId;
        engine.recordedSessionId = recordedSession;
        // Every recorder gets its own copy of the options. The callbacks
        // belong to the recorder that is being opened, and writing them
        // into the shared object would overwrite the previous recorder's
        // callbacks and grow the object for every recording.
        const recorder = new MicCapture(recorderOptions(engine.options, {
          onUtterance: (pcm) => void recognize(pcm, recordedSession),
          onBargeIn: () => interruptReply(),
          onSpeakingChange: (speaking) => setEngine({ listening: speaking ? 'speech' : 'open' }),
        }));
        try {
          await recorder.start();
        } catch (error) {
          const message = `${t('errMicOpen')}：${error.message ?? error}`;
          setEngine({ error: message });
          void api.reportError?.('microphone', message, String(error?.stack ?? '').slice(0, 500));
          return;
        } finally {
          engine.starting = false;
        }
        // The user may have turned the microphone off while the permission
        // prompt was up. In that case the recorder is not wanted: it is
        // stopped and dropped, and the microphone stays closed.
        if (engine.stopRequested) {
          engine.stopRequested = false;
          recorder.stop();
          return;
        }
        engine.recorder = recorder;
        setEngine({ listening: 'open', error: null });
      }

      function stopListening() {
        // A start that is still waiting for permission cannot be cancelled
        // from here, but it can be marked: when it comes back it stops
        // itself instead of opening a microphone the user just closed.
        engine.stopRequested = true;
        engine.recorder?.stop();
        engine.recorder = null;
        setEngine({ listening: false });
      }

      // Keep the recorder aligned with playback so barge-in stays armed.
      speaker.subscribe(() => {
        const talking = speaker.speaking;
        if (talking !== engine.speaking) setEngine({ speaking: talking });
        engine.recorder?.setInterruptMode(talking);
      });

      ctx.effect(() => () => stopListening(), 'voice-chat: microphone');

      // The plugin has a life of its own: when it goes away, the polls that
      // run in the background have to go with it. The flag says so, and the
      // abort signal cuts the wait short.
      let alive = true;
      ctx.effect(() => () => {
        alive = false;
        engine.prepareController?.abort();
        engine.prepareController = null;
      }, 'voice-chat: model preparation');

      const shared = {
        engine,
        api,
        speaker,
        subscribe,
        setEngine,
        refreshState,
        prepare,
        startListening,
        stopListening,
        interruptReply,
      };

      // `inject` receives the slot's session-scope key, so each seat knows the
      // session it renders for without reading any other plugin's state.
      const provide = (sessionId) => ({ ...shared, sessionId });

      ctx.slots.inject('conversation.input.dock', () => ctx.slots.register(
        { name: 'conversation.input.dock', id: 'voice-chat-bar', order: 2, locale: NS, inject: provide },
        VoiceBar,
      ));

      ctx.slots.inject('conversation.input.left', () => ctx.slots.register(
        { name: 'conversation.input.left', id: 'voice-chat-reply', order: 80, locale: NS, inject: provide },
        ReplyListener,
      ));
    }

    // ─────────────────────────────────────────────────────────────── components

    // ──────────────────────────────────────── orb placement + edge fitting

    const ORB_SIZE = 52; // matches .dshv-orbwrap
    const ORB_MARGIN = 6; // gap kept from a bound
    const DRAG_SLOP = 5; // below this a gesture is a tap, not a drag
    // A docked node is exactly its bead — the label floats outside it — so the
    // geometry computed here is the geometry on screen, and a bead that lands
    // flush against an edge really does touch it.
    const BEAD_SIZE = 44; // matches .dshv-node / .dshv-bead
    // Clearance between two docked beads, wide enough for the label floating
    // between them — the label is out of flow, so it is not part of the math.
    const BEAD_GAP = 18;

    /** The whole window, as a rect; never NaN, even outside a browser. */
    function viewportBounds() {
      const width = typeof window === 'undefined' ? 0 : Number(window.innerWidth);
      const height = typeof window === 'undefined' ? 0 : Number(window.innerHeight);
      return {
        x: 0,
        y: 0,
        width: Number.isFinite(width) && width > 0 ? width : 1024,
        height: Number.isFinite(height) && height > 0 ? height : 768,
      };
    }

    /** The element's viewport rect, in the shape the placement helpers expect. */
    function rectOf(element) {
      const rect = element.getBoundingClientRect();
      return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
    }

    /**
     * The composer that encloses the bead. The bead must stay above it: docking
     * on the true bottom edge of the transcript parks it on the token readout
     * printed just above the input card. The editor is a Lexical contenteditable
     * div, not a textarea, so all three shapes are accepted. Null when nothing
     * encloses the bead.
     */
    function composerElement(element) {
      let node = element.parentElement;
      while (node !== null && node !== document.body && node !== document.documentElement) {
        const input = typeof node.querySelector === 'function'
          ? node.querySelector('textarea, [contenteditable="true"], [role="textbox"]')
          : null;
        if (input !== null) return node;
        node = node.parentElement;
      }
      return null;
    }

    /** The movable rect, with its bottom pulled up above that composer. */
    function boundsFor(element, ceilingElement) {
      const rect = rectOf(element);
      if (ceilingElement === null || ceilingElement === undefined) return rect;
      const ceiling = rectOf(ceilingElement).y;
      if (!Number.isFinite(ceiling) || ceiling <= rect.y) return rect;
      // The space above the composer is what the bead may use, and nothing
      // more. The lower bound shrinks with it: a fixed minimum of 160 pushed
      // the bead over the composer whenever the window was shorter than that.
      const available = Math.max(0, ceiling - rect.y - ORB_MARGIN);
      return {
        ...rect,
        height: Math.min(rect.height, available),
      };
    }

    /**
     * The area the bead is allowed to live in: the innermost scrolling or
     * clipping ancestor — in practice the conversation panel — so the bead can
     * never drift over the sidebar or be clipped by the transcript viewport.
     * Falls back to the whole window when nothing suitable encloses the seat.
     * The element comes back too: it is what tells us the area changed shape.
     */
    function resolveBoundsTarget(element) {
      const fallback = { rect: viewportBounds(), element: null, ceilingElement: null };
      if (typeof window === 'undefined' || element === null || element === undefined) return fallback;
      let node = element.parentElement;
      while (node !== null && node !== document.body && node !== document.documentElement) {
        const style = window.getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        if (/(auto|scroll|hidden)/.test(style.overflowY) && rect.width >= 240 && rect.height >= 240) {
          const ceilingElement = composerElement(element);
          return { rect: boundsFor(node, ceilingElement), element: node, ceilingElement };
        }
        node = node.parentElement;
      }
      return fallback;
    }

    /** Just the rect, for the callers that only place the bead. */
    function resolveBounds(element) {
      return resolveBoundsTarget(element).rect;
    }

    function clampPosition(point, bounds = viewportBounds()) {
      const minX = bounds.x + ORB_MARGIN;
      const minY = bounds.y + ORB_MARGIN;
      const maxX = Math.max(minX, bounds.x + bounds.width - ORB_SIZE - ORB_MARGIN);
      const maxY = Math.max(minY, bounds.y + bounds.height - ORB_SIZE - ORB_MARGIN);
      return {
        x: Math.min(Math.max(point.x, minX), maxX),
        y: Math.min(Math.max(point.y, minY), maxY),
      };
    }

    function defaultOrbPosition(bounds = viewportBounds()) {
      return clampPosition({
        x: bounds.x + bounds.width - ORB_SIZE - 18,
        y: bounds.y + bounds.height - ORB_SIZE - 14,
      }, bounds);
    }

    /** Restores the saved spot; positions are stored as fractions of the bounds. */
    function readSavedPosition(bounds = viewportBounds()) {
      const fallback = { ...defaultOrbPosition(bounds), edge: null };
      const raw = readString(STORAGE.pos, '');
      if (raw === '') return fallback;
      try {
        const saved = JSON.parse(raw);
        if (!Number.isFinite(saved?.fx) || !Number.isFinite(saved?.fy)) return fallback;
        const edge = ['left', 'right', 'top', 'bottom'].includes(saved?.edge) ? saved.edge : null;
        return {
          ...clampPosition({
            x: bounds.x + saved.fx * bounds.width,
            y: bounds.y + saved.fy * bounds.height,
          }, bounds),
          edge,
        };
      } catch {
        return fallback;
      }
    }

    /**
     * Positions are stored as fractions of the bounds, so a shape change that
     * leaves them alone must not rewrite them: a dragged divider reflows on
     * every frame.
     */
    let lastPersistedPosition = '';

    function persistPosition(point, bounds, edge = null) {
      const payload = JSON.stringify({
        fx: (point.x - bounds.x) / bounds.width,
        fy: (point.y - bounds.y) / bounds.height,
        edge,
      });
      if (payload === lastPersistedPosition) return;
      lastPersistedPosition = payload;
      writeString(STORAGE.pos, payload);
    }

    function clampAlong(value, min, max) {
      return Math.min(Math.max(value, min), Math.max(min, max));
    }

    /** The flush coordinates of a bead wetted to one of the four edges. */
    function attachTo(edge, point, bounds = viewportBounds()) {
      const minX = bounds.x + ORB_MARGIN;
      const maxX = bounds.x + bounds.width - ORB_SIZE - ORB_MARGIN;
      const minY = bounds.y + ORB_MARGIN;
      const maxY = bounds.y + bounds.height - ORB_SIZE - ORB_MARGIN;
      if (edge === 'left') return { x: bounds.x, y: clampAlong(point.y, minY, maxY), edge: 'left' };
      if (edge === 'right') {
        return { x: bounds.x + bounds.width - ORB_SIZE, y: clampAlong(point.y, minY, maxY), edge: 'right' };
      }
      if (edge === 'top') return { x: clampAlong(point.x, minX, maxX), y: bounds.y, edge: 'top' };
      return {
        x: clampAlong(point.x, minX, maxX),
        y: bounds.y + bounds.height - ORB_SIZE,
        edge: 'bottom',
      };
    }

    /**
     * Snaps only when an edge is within one bead diameter — closer than that and
     * the bead sticks, further away it stays exactly where it was dropped.
     * The stuck coordinate is flush with the boundary, so the flattened side of
     * the droplet actually touches the surface it has wetted.
     * Returns `{ x, y, edge }`, or null when nothing is close enough.
     */
    function snapToEdge(point, bounds = viewportBounds(), reach = ORB_SIZE) {
      const minX = bounds.x + ORB_MARGIN;
      const maxX = bounds.x + bounds.width - ORB_SIZE - ORB_MARGIN;
      const minY = bounds.y + ORB_MARGIN;
      const maxY = bounds.y + bounds.height - ORB_SIZE - ORB_MARGIN;
      const distances = {
        left: point.x - minX,
        right: maxX - point.x,
        top: point.y - minY,
        bottom: maxY - point.y,
      };
      const nearest = Object.keys(distances)
        .reduce((best, edge) => (distances[edge] < distances[best] ? edge : best), 'left');
      if (distances[nearest] > reach) return null;
      return attachTo(nearest, point, bounds);
    }

    /**
     * Re-derives the coordinates once the movable area changed shape: a bead
     * wetted to an edge follows that edge, a free one is only kept inside. The
     * user moved the area, never the bead.
     */
    function refit(current, bounds = viewportBounds()) {
      const { edge } = current;
      if (edge === 'left' || edge === 'right' || edge === 'top' || edge === 'bottom') {
        return attachTo(edge, current, bounds);
      }
      return { ...clampPosition(current, bounds), edge: null };
    }

    /**
     * Where the bead comes to rest when the pointer is let go.
     *
     * Released anywhere, the bead travels to the nearest edge and sticks.
     * Dropped in open space it stays exactly there and keeps its round shape:
     * only a genuine collision sticks and sags.
     *
     * @param {{x: number, y: number}} released - where the bead was let go.
     * @param {object} [bounds] - the movable area.
     * @returns {{x: number, y: number, edge: string|null}} the resting place.
     */
    function settleDrag(released, bounds = viewportBounds()) {
      const snapped = snapToEdge(released, bounds);
      return snapped === null ? { ...released, edge: null } : snapped;
    }

    /** The edge of the movable area the bead sits closest to. */
    function nearestEdge(position, bounds = viewportBounds()) {
      const centreX = position.x + ORB_SIZE / 2;
      const centreY = position.y + ORB_SIZE / 2;
      const distances = {
        left: centreX - bounds.x,
        right: bounds.x + bounds.width - centreX,
        top: centreY - bounds.y,
        bottom: bounds.y + bounds.height - centreY,
      };
      return Object.keys(distances)
        .reduce((best, edge) => (distances[edge] < distances[best] ? edge : best), 'left');
    }

    /**
     * The beads break off the orb and dock against the nearest edge, in a line
     * parallel to it and centred on where the orb was. Nothing pushes anything
     * out of the way: the spacing alone keeps them apart, and the line is only
     * tightened and slid as a whole when the edge is too short to hold it.
     *
     * Each entry carries where the bead rests (`tx`/`ty`, flush against the edge,
     * no margin at all), the edge it docked to, and the point the droplets gather
     * into when they merge (`mx`/`my`).
     */
    function dockLayout(position, bounds = viewportBounds(), count = 4) {
      const edge = nearestEdge(position, bounds);
      const vertical = edge === 'left' || edge === 'right';
      const centreX = position.x + ORB_SIZE / 2;
      const centreY = position.y + ORB_SIZE / 2;
      const room = vertical ? bounds.height : bounds.width;
      const usable = Math.max(BEAD_SIZE, room);
      const spacing = Math.min(
        BEAD_SIZE + BEAD_GAP,
        (usable - BEAD_SIZE) / Math.max(1, count - 1),
      );
      const offsets = [];
      for (let index = 0; index < count; index += 1) {
        const step = (index - (count - 1) / 2) * spacing;
        offsets.push(vertical
          ? { tx: 0, ty: step + BEAD_SIZE / 2, mx: 0, my: BEAD_SIZE / 2 }
          : { tx: step + BEAD_SIZE / 2, ty: 0, mx: BEAD_SIZE / 2, my: 0 });
      }
      const flush = {
        left: { x: bounds.x - centreX + BEAD_SIZE, y: 0 },
        right: { x: bounds.x + bounds.width - centreX, y: 0 },
        top: { x: 0, y: bounds.y - centreY + BEAD_SIZE },
        bottom: { x: 0, y: bounds.y + bounds.height - centreY },
      }[edge];
      const spans = offsets.map((offset) => (vertical
        ? [centreY + offset.ty - BEAD_SIZE, centreY + offset.ty]
        : [centreX + offset.tx - BEAD_SIZE, centreX + offset.tx]));
      const first = Math.min(...spans.map((span) => span[0]));
      const last = Math.max(...spans.map((span) => span[1]));
      const min = vertical ? bounds.y : bounds.x;
      const max = vertical ? bounds.y + bounds.height : bounds.x + bounds.width;
      let shift = 0;
      if (first < min) shift = min - first;
      else if (last > max) shift = max - last;
      for (const offset of offsets) {
        const slideX = flush.x + (vertical ? 0 : shift);
        const slideY = flush.y + (vertical ? shift : 0);
        offset.tx += slideX;
        offset.ty += slideY;
        offset.mx += slideX;
        offset.my += slideY;
        offset.edge = edge;
      }
      return offsets;
    }

    /**
     * Where the docked line sits, as a point — the shared middle of the beads. The
     * orb comes back there once they merge, so it reappears exactly where they
     * gathered instead of at the spot it was opened from.
     */
    function dockCentre(position, bounds = viewportBounds(), offsets = dockLayout(position, bounds, 4)) {
      const centreX = position.x + ORB_SIZE / 2;
      const centreY = position.y + ORB_SIZE / 2;
      const xs = offsets.map((offset) => centreX + offset.tx - BEAD_SIZE / 2);
      const ys = offsets.map((offset) => centreY + offset.ty - BEAD_SIZE / 2);
      return {
        x: (Math.min(...xs) + Math.max(...xs)) / 2,
        y: (Math.min(...ys) + Math.max(...ys)) / 2,
      };
    }

    // ───────────────────────────────────────────── status + panel placement

    /** Byte count that stays readable in a 340 px column. */
    function formatBytes(bytes) {
      const value = Number(bytes);
      if (!Number.isFinite(value) || value <= 0) return '0 MB';
      if (value >= 1024 * 1024 * 1024) return `${(value / 1073741824).toFixed(1)} GB`;
      if (value >= 1024 * 1024) return `${(value / 1048576).toFixed(1)} MB`;
      return `${Math.max(1, Math.round(value / 1024))} KB`;
    }

    /**
     * Everything the panel's progress row needs to know about a model
     * preparation run, derived in one place so the bar and the label agree.
     * `percent` stays null until the server has reported a byte range.
     */
    function prepareView(prepare) {
      const run = prepare ?? {};
      const running = run.running === true;
      const total = Number(run.total) || 0;
      const received = Number(run.received) || 0;
      const percent = total > 0 ? Math.min(100, Math.max(0, Math.round((received / total) * 100))) : null;
      return {
        running,
        phase: run.phase ?? 'idle',
        total,
        received,
        percent,
        // Bytes without a percentage means checking, or fixing up, cached files.
        indeterminate: running && percent === null,
        label: percent === null
          ? formatBytes(received)
          : `${formatBytes(received)} / ${formatBytes(total)}`,
        error: run.error ?? null,
      };
    }

    /**
     * The one line that says what the plugin is doing right now, or why it
     * cannot: the settings sheet turns it into its live status row.
     */
    function statusLine(engine, t) {
      const prepare = engine.prepare ?? {};
      if (prepare.running) {
        const view = prepareView(prepare);
        return {
          kind: 'warn',
          text: view.percent === null ? t('preparingModel') : `${t('preparingModel')} ${view.percent}%`,
          action: 'stop',
        };
      }
      // Speaking comes before the microphone: the microphone is open most of
      // the time, and a read-out that never shows up because the mic got
      // there first is a read-out nobody notices.
      if (engine.speaking) return { kind: 'busy', text: t('thinking'), action: 'stop' };
      if (engine.listening === 'speech') return { kind: 'live', text: t('listening'), action: 'stop' };
      if (engine.listening === 'open') return { kind: 'live', text: t('mic'), action: 'stop' };
      if (engine.recognizing) return { kind: 'busy', text: t('recognizing'), action: 'stop' };
      if (engine.error) return { kind: 'warn', text: String(engine.error), action: 'settings' };
      if (engine.ready === false) return { kind: 'warn', text: t('notReady'), action: 'settings' };
      return { kind: 'quiet', text: t('ready'), action: null };
    }

    /**
     * The panel opens next to the bead, on whichever side has room, and is
     * pushed back inside the movable area when it would hang off an edge — a
     * bead dragged into a corner must not open its sheet half off-screen.
     */
    function fitPanel(opts) {
      const o = opts ?? {};
      const bounds = o.bounds ?? viewportBounds();
      const position = o.position ?? defaultOrbPosition(bounds);
      const width = Math.max(240, Math.min(Number(o.width) || 340, Math.max(240, bounds.width - 24)));
      const height = Math.min(Number(o.height) || 440, Math.max(220, bounds.height - 24));
      const gap = Number.isFinite(o.gap) ? o.gap : 12;
      const centre = { x: position.x + ORB_SIZE / 2, y: position.y + ORB_SIZE / 2 };
      // Flipping near the middle is what a popover is expected to do.
      const side = centre.x <= bounds.x + bounds.width / 2 ? 'right' : 'left';
      const x = side === 'right' ? position.x + ORB_SIZE + gap : position.x - width - gap;
      const y = centre.y - height / 2;
      const minX = bounds.x + 8;
      const minY = bounds.y + 8;
      return {
        side,
        x: Math.min(Math.max(x, minX), Math.max(minX, bounds.x + bounds.width - width - 8)),
        y: Math.min(Math.max(y, minY), Math.max(minY, bounds.y + bounds.height - height - 8)),
      };
    }

    /**
     * How large the settings sheet may be. It is bound to the movable area rather
     * than to the window, so a bead parked near the bottom can no longer push the
     * sheet off screen. The sheet and `fitPanel` both read their numbers here, so
     * the height used for placement cannot drift away from the height rendered.
     */
    function panelLimits(bounds = viewportBounds(), wide = false, viewport = viewportBounds()) {
      const gutter = 8;
      const width = Math.min(wide ? 420 : 340, Math.max(240, bounds.width - gutter * 2));
      const maxHeight = Math.min(
        Math.round(viewport.height * 0.82),
        Math.max(220, bounds.height - gutter * 2),
      );
      return { width, maxHeight };
    }

    /**
     * Which side of the bead the error bubble goes on, and how wide it may get:
     * a bead parked against the right edge must not push the message off screen.
     */
    function alertPlacement(position, bounds = viewportBounds()) {
      const gap = 10;
      const centre = position.x + ORB_SIZE / 2;
      const side = centre <= bounds.x + bounds.width / 2 ? 'right' : 'left';
      const room = side === 'right'
        ? bounds.x + bounds.width - (position.x + ORB_SIZE)
        : position.x - bounds.x;
      return { side, maxWidth: Math.max(96, Math.min(280, room - gap)) };
    }

    /**
     * The clipboard payload for the diagnostics drawer. Assembled from what the
     * page already knows, so reporting a problem never needs a second request.
     */
    function diagReport(engine) {
      const config = engine.config ?? {};
      const prepare = prepareView(engine.prepare);
      const lines = [
        `DSH-Voice ${engine.ready === true ? 'ready' : 'not ready'}`,
        `stt=${config.sttBackend ?? '?'} precision=${config.precision ?? '?'}`,
        `vad=${config.vadBackendEffective ?? config.vadBackend ?? '?'}`,
      ];
      if (config.vadNote) lines.push(`vadNote=${config.vadNote}`);
      lines.push(`provider=${config.provider ?? '?'} model=${config.model ?? '?'}`);
      lines.push(`voice=${config.voice ?? '?'} hasKey=${String(config.hasKey === true)}`);
      lines.push(`language=${config.language ?? '?'}`);
      lines.push(`dataRoot=${config.dataRoot ?? '?'}`);
      if (prepare.running) lines.push(`prepare=${prepare.phase} ${prepare.label}`);
      if (engine.error) lines.push(`error=${String(engine.error)}`);
      return lines.join('\n');
    }

    /**
     * One translucent bead. It stays colourless in every state — only the glyph
     * inside changes colour — and tapping it breaks it into four smaller beads.
     * It can also be dragged anywhere and sticks to an edge when it hits one.
     */
    function VoiceBar(props) {
      const { engine, speaker, subscribe, startListening, stopListening, refreshState, interruptReply, setEngine, sessionId } = props;
      const t = props.t ?? ((key) => key);
      const [, force] = useState(0);
      const [panel, setPanel] = useState(false);
      const [open, setOpen] = useState(false);
      const [, setTick] = useState(0);
      const [position, setPosition] = useState(() => ({ ...defaultOrbPosition(), edge: null }));
      const [bounds, setBounds] = useState(() => viewportBounds());
      const [dragging, setDragging] = useState(false);
      const rootRef = useRef(null);
      const orbRef = useRef(null);
      const dragRef = useRef(null);
      const frameRef = useRef(0);
      const settleRef = useRef(0);
      const boundsRef = useRef(bounds);
      const positionRef = useRef(position);
      const boundsElementRef = useRef(null);
      const ceilingElementRef = useRef(null);
      const speakEnabled = readFlag(STORAGE.enabled, true);
      const interruptMode = readFlag(STORAGE.interrupt, true);

      useEffect(() => subscribe(() => force((value) => value + 1)), [subscribe]);
      useEffect(() => {
        if (sessionId !== undefined) engine.sessionId = sessionId;
      }, [engine, sessionId]);
      useEffect(() => {
        void refreshState();
      }, [refreshState]);

      // Everything that changes the movable area — a window resize, a dragged
      // divider, a collapsing sidebar — funnels into one reflow per frame. The
      // coordinates go straight to the DOM as it happens: a dragged divider must
      // not wait for a React render or for the placement transition, which is
      // exactly what made the bead lag behind the edge. The state catches up once
      // the area stops changing.
      const reflow = useCallback(() => {
        if (dragRef.current !== null || frameRef.current !== 0) return;
        frameRef.current = requestAnimationFrame(() => {
          frameRef.current = 0;
          const root = rootRef.current;
          if (root === null) return;
          const element = boundsElementRef.current;
          const next = element === null
            ? resolveBounds(root)
            : boundsFor(element, ceilingElementRef.current);
          const settled = refit(positionRef.current, next);
          boundsRef.current = next;
          positionRef.current = settled;
          root.dataset.following = 'true';
          root.style.left = `${settled.x}px`;
          root.style.top = `${settled.y}px`;
          if (settleRef.current !== 0) clearTimeout(settleRef.current);
          settleRef.current = window.setTimeout(() => {
            settleRef.current = 0;
            const node = rootRef.current;
            if (node !== null) delete node.dataset.following;
            setBounds(boundsRef.current);
            setPosition(positionRef.current);
            persistPosition(positionRef.current, boundsRef.current, positionRef.current.edge);
          }, 140);
        });
      }, []);

      // Between reflows the state is the source of truth; the refs are what the
      // per-frame path reads, so they have to follow it.
      useEffect(() => {
        positionRef.current = position;
      }, [position]);
      useEffect(() => {
        boundsRef.current = bounds;
      }, [bounds]);

      useEffect(() => () => {
        if (frameRef.current !== 0) cancelAnimationFrame(frameRef.current);
        if (settleRef.current !== 0) clearTimeout(settleRef.current);
      }, []);

      const listening = engine.listening === 'open' || engine.listening === 'speech';
      // `notready` outranks the rest: with the models missing, the amber bead is
      // the only thing worth saying, whatever the microphone is doing.
      // Speaking outranks listening: the microphone is open most of the time,
      // so a state that put listening first would mean the read-out never
      // showed up — no colour change, no movement with the voice.
      const state = engine.ready === false
        ? 'notready'
        : engine.recognizing
          ? 'recognizing'
          : engine.speaking
            ? 'speaking'
            : listening
              ? 'listening'
              : 'idle';

      // The outline is drawn by JS in two situations: while audio drives it
      // (spoken playback, or the level meter while listening) and whenever the
      // bead is stuck to an edge — the droplet silhouette lives in the radius, so
      // the CSS swell must not own it. A stuck idle bead gets one static shape.
      const attached = position.edge;
      useEffect(() => {
        const root = rootRef.current;
        const orb = orbRef.current;
        if (orb === null) return undefined;
        // Two things can own the outline: the audio driving it, or an edge the
        // bead has wetted (the droplet silhouette lives in the radius). A stuck
        // bead with nothing to say gets one static shape and no per-frame work,
        // so it hangs there quietly instead of trembling.
        const driven = state === 'speaking' || state === 'listening';
        const stuck = attached !== null;
        if (!driven && !stuck) {
          orb.style.borderRadius = '';
          if (root !== null) root.style.setProperty('--dshv-lvl', '0');
          return undefined;
        }
        if (!driven) {
          orb.style.borderRadius = waveRadius(0, 0, attached);
          if (root !== null) root.style.setProperty('--dshv-lvl', '0');
          return () => {
            // Barge-in can arrive at any moment; leaving the deformed shape
            // behind would freeze the bead mid-wobble.
            orb.style.borderRadius = '';
          };
        }
        const started = performance.now();
        let frame = 0;
        const step = (now) => {
          frame = requestAnimationFrame(step);
          let level;
          if (state === 'speaking') {
            level = speaker?.level?.() ?? 0;
          } else {
            // 0.045 RMS is a comfortable speaking level; the floor keeps the bead
            // breathing when the room goes quiet.
            const rms = engine.recorder?.level ?? 0;
            level = 0.18 + 0.82 * Math.min(1, rms / 0.045);
          }
          if (root !== null) root.style.setProperty('--dshv-lvl', String(level));
          orb.style.borderRadius = waveRadius((now - started) / 1000, level, attached);
        };
        frame = requestAnimationFrame(step);
        return () => {
          cancelAnimationFrame(frame);
          // Barge-in stops playback mid-sentence; without this the bead would
          // freeze in its deformed shape instead of springing back.
          orb.style.borderRadius = '';
          if (root !== null) root.style.setProperty('--dshv-lvl', '0');
        };
      }, [state, speaker, engine, attached]);

      // The movable area comes from the DOM, so it is measured once mounted and
      // then observed: dragging the divider beside the conversation changes it
      // without ever resizing the window. The element is kept, so a reflow only
      // needs one rect read instead of walking the ancestors again.
      useLayoutEffect(() => {
        const root = rootRef.current;
        if (root === null) return undefined;
        const target = resolveBoundsTarget(root);
        boundsElementRef.current = target.element;
        ceilingElementRef.current = target.ceilingElement;
        boundsRef.current = target.rect;
        const saved = readSavedPosition(target.rect);
        positionRef.current = saved;
        setBounds(target.rect);
        setPosition(saved);
        if (target.element === null || typeof ResizeObserver === 'undefined') return undefined;
        const observer = new ResizeObserver(() => reflow());
        observer.observe(target.element);
        return () => observer.disconnect();
      }, [reflow]);

      // The bead is fixed-position, so its coordinates are written straight
      // through: a re-render mid-drag must not yank it back to the old spot.
      useLayoutEffect(() => {
        const root = rootRef.current;
        if (root === null) return;
        root.style.left = `${position.x}px`;
        root.style.top = `${position.y}px`;
      }, [position]);

      useEffect(() => {
        window.addEventListener('resize', reflow);
        return () => window.removeEventListener('resize', reflow);
      }, [reflow]);

      // Closing runs the beads back into each other, so the orb reappears in the
      // middle of the line they docked into. The position comes back because a tap
      // that closes the beads and then drags has to start from where the orb ended
      // up, not from where it was before.
      const closeBeads = useCallback(() => {
        setOpen(false);
        const current = positionRef.current;
        const area = boundsRef.current;
        const spread = dockLayout(current, area, 4);
        const centre = dockCentre(current, area, spread);
        const settled = attachTo(nearestEdge(current, area), {
          x: centre.x - ORB_SIZE / 2,
          y: centre.y - ORB_SIZE / 2,
        }, area);
        positionRef.current = settled;
        setPosition(settled);
        persistPosition(settled, area, settled.edge);
        return settled;
      }, []);

      // Tapping anything that is not part of this plugin folds the beads back
      // into the big bead. Escape does the same — but not while the panel is
      // open, where it belongs to whatever field has focus. The listener is
      // capturing so a host handler cannot swallow the key first.
      useEffect(() => {
        const onOutsideDown = (event) => {
          const root = rootRef.current;
          if (root !== null && root.contains(event.target)) return;
          if (open) closeBeads();
        };
        const onKeyDown = (event) => {
          if (event.key !== 'Escape' || panel) return;
          const target = event.target;
          if (target && typeof target.closest === 'function' && target.closest('.dshv-panel')) return;
          closeBeads();
        };
        document.addEventListener('pointerdown', onOutsideDown, true);
        document.addEventListener('keydown', onKeyDown, true);
        return () => {
          document.removeEventListener('pointerdown', onOutsideDown, true);
          document.removeEventListener('keydown', onKeyDown, true);
        };
      }, [open, panel, closeBeads]);

      const onPointerDown = (event) => {
        if (event.button !== 0) return;
        const from = open ? closeBeads() : positionRef.current;
        dragRef.current = {
          id: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          originX: from.x,
          originY: from.y,
          wasOpen: open,
          moved: false,
        };
        // The edge is released when the bead is actually dragged away, never on
        // a plain press: tapping the bead expands the beads, and that has to keep
        // the stuck layout it was already showing.
        event.currentTarget.setPointerCapture(event.pointerId);
      };

      const onPointerMove = (event) => {
        const drag = dragRef.current;
        if (drag === null || drag.id !== event.pointerId) return;
        const dx = event.clientX - drag.startX;
        const dy = event.clientY - drag.startY;
        if (!drag.moved && Math.hypot(dx, dy) < DRAG_SLOP) return;
        if (!drag.moved) {
          drag.moved = true;
          setDragging(true);
          // Now it is a drag, so the bead leaves the edge it had wetted. The
          // position is written together with the cleared edge, otherwise the
          // layout effect below would pull the bead back to where the drag began.
          setPosition({
            ...clampPosition({ x: drag.originX + dx, y: drag.originY + dy }, bounds),
            edge: null,
          });
        }
        const root = rootRef.current;
        if (root === null) return;
        const next = clampPosition({ x: drag.originX + dx, y: drag.originY + dy }, bounds);
        root.style.left = `${next.x}px`;
        root.style.top = `${next.y}px`;
      };

      /**
       * Finish a drag, however it ended.
       *
       * The pointer can be let go, or the system can take it away — a call
       * comes in, a notification takes the focus. A cancelled gesture has to
       * clean up just like a finished one, or the bead keeps the drag state
       * for ever and the layout stops following the area it lives in.
       *
       * @param {PointerEvent} event - the pointer event that ended the drag.
       * @param {boolean} cancelled - whether the gesture was interrupted.
       */
      const finishDrag = (event, cancelled) => {
        const drag = dragRef.current;
        if (drag === null || drag.id !== event.pointerId) return;
        dragRef.current = null;
        if (!drag.moved) {
          // A cancelled gesture is not a tap: the beads stay as they are.
          if (!cancelled) setOpen(!drag.wasOpen);
          return;
        }
        setDragging(false);
        const root = rootRef.current;
        const left = root === null ? Number.NaN : Number.parseFloat(root.style.left);
        const top = root === null ? Number.NaN : Number.parseFloat(root.style.top);
        // Released anywhere, the bead travels to the nearest edge and sticks.
        const released = clampPosition({
          x: Number.isFinite(left) ? left : drag.originX,
          y: Number.isFinite(top) ? top : drag.originY,
        }, bounds);
        const resting = settleDrag(released, bounds);
        setPosition(resting);
        persistPosition(resting, bounds, resting.edge);
      };

      const onPointerUp = (event) => finishDrag(event, false);

      const onPointerCancel = (event) => finishDrag(event, true);

      const toggleMic = useCallback(() => {
        if (listening) stopListening();
        else void startListening(sessionId);
      }, [listening, sessionId, startListening, stopListening]);

      const toggleSpeak = () => {
        writeFlag(STORAGE.enabled, !speakEnabled);
        if (speakEnabled) interruptReply();
        setTick((value) => value + 1);
      };

      const toggleMode = () => {
        writeFlag(STORAGE.interrupt, !interruptMode);
        setTick((value) => value + 1);
      };

      // The four functions and nothing else: the cloned voice's name used to sit
      // on the toolbar and now lives in the settings panel instead. Where a
      // bead comes to rest is not decided here — the dock layout owns that.
      const beads = [
        {
          key: 'mic',
          icon: 'mic',
          label: t('mic'),
          on: listening,
          tone: listening ? (engine.recognizing ? 'warn' : 'record') : null,
          title: listening ? t('micStop') : t('micTitle'),
          pressed: listening,
          onClick: toggleMic,
        },
        {
          key: 'speak',
          icon: 'speaker',
          label: t('speak'),
          on: speakEnabled,
          tone: null,
          title: t('speak'),
          pressed: speakEnabled,
          onClick: toggleSpeak,
        },
        {
          key: 'mode',
          icon: interruptMode ? 'bolt' : 'clock',
          label: interruptMode ? t('interruptShort') : t('queueShort'),
          on: interruptMode,
          tone: null,
          title: interruptMode ? t('interrupt') : t('queue'),
          pressed: interruptMode,
          onClick: toggleMode,
        },
        {
          key: 'settings',
          icon: 'gear',
          label: t('settingsShort'),
          on: panel,
          tone: null,
          title: t('settings'),
          pressed: panel,
          onClick: () => setPanel((value) => !value),
        },
      ];

      // Opening breaks the orb into four beads, which dock against the nearest
      // edge and line up parallel to it.
      const spread = dockLayout(position, bounds, beads.length);

      // Whatever the bead has to say in words goes beside it, and always on the
      // side that has room: a bead stuck to the right edge would otherwise push
      // the message off screen, which is exactly how an error came to look like
      // it had exploded out of the bead.
      const alert = alertPlacement(position, bounds);
      const alertPlacementStyle = alert.side === 'right'
        ? { left: ORB_SIZE + 10 }
        : { right: ORB_SIZE + 10 };

      return h(
        'div',
        {
          ref: rootRef,
          className: 'dshv',
          'data-state': state,
          'data-expanded': String(open),
          'data-dragging': String(dragging),
          'data-attached': position.edge ?? 'none',
        },
        h(
          'div',
          { className: 'dshv-orbwrap' },
          h('span', { className: 'dshv-wave' }),
          h(
            'span',
            { className: 'dshv-gel' },
            h(
              'button',
              {
                ref: orbRef,
                type: 'button',
                className: 'dshv-orb',
                title: listening ? t('micStop') : t('micTitle'),
                'aria-expanded': open,
                'aria-pressed': listening,
                onPointerDown,
                onPointerMove,
                onPointerUp,
                onPointerCancel,
                onKeyDown: (event) => {
                  if (event.key !== 'Enter' && event.key !== ' ') return;
                  event.preventDefault();
                  if (open) closeBeads();
                  else setOpen(true);
                },
              },
              h(Icon, { name: 'mic' }),
            ),
          ),
          h(
            'div',
            { className: 'dshv-spread' },
            beads.map((bead, index) => h(
              'div',
              {
                key: bead.key,
                className: 'dshv-node',
                'data-on': String(bead.on),
                'data-tone': bead.tone ?? 'none',
                'data-docked': spread[index].edge,
                style: {
                  '--tx': `${spread[index].tx}px`,
                  '--ty': `${spread[index].ty}px`,
                  '--mx': `${spread[index].mx}px`,
                  '--my': `${spread[index].my}px`,
                },
              },
              h('span', { className: 'dshv-cap' }, bead.label),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dshv-bead',
                  title: bead.title,
                  'aria-pressed': bead.pressed,
                  onClick: bead.onClick,
                },
                h(Icon, { name: bead.icon, size: 19 }),
              ),
            )),
          ),
        ),
        // Everything the bead cannot say by itself, in words, sitting beside it
        // and absolutely placed: the bead itself stays 52 by 52, so nothing here
        // can widen the floating layer or push it past the edge of the area.
        engine.ready === false
          ? h(Button, {
              style: {
                ...alertPlacementStyle,
                position: 'absolute',
                top: '50%',
                transform: 'translateY(-50%)',
                width: 'max-content',
                flex: 'none',
                color: 'var(--dshv-warn)',
              },
              onClick: () => setPanel(true),
            }, `⚠ ${t('notReady')}`)
          : null,
        // A failure worth reading in full gets the bubble, and the bubble can be
        // dismissed or opened: a single failed request must not haunt the corner
        // until the page is reloaded. The models-missing case above is a state,
        // not an error, so only one of the two is ever on screen.
        engine.ready !== false && engine.error !== null
          ? h(
              'div',
              {
                className: 'dshv-alert',
                // The width is capped here rather than on the text: the bubble is
                // absolutely placed inside a 52px-wide bead layer, and without an
                // explicit width it would be squeezed into a vertical sliver.
                style: { ...alertPlacementStyle, maxWidth: alert.maxWidth },
              },
              h('span', {
                className: 'dshv-alert-text',
                style: { cursor: 'pointer' },
                title: engine.error,
                onClick: () => setPanel(true),
              }, engine.error),
              h('button', {
                type: 'button',
                className: 'dshv-alert-close',
                title: t('close'),
                'aria-label': t('close'),
                onClick: () => setEngine({ error: null }),
              }, h(Icon, { name: 'close', size: 12 })),
            )
          : null,
        panel
          ? h(SettingsPanel, {
            ...props,
            t,
            bounds,
            position,
            onClose: () => setPanel(false),
          })
          : null,
      );
    }

    /**
     * Settings sheet: engine status, model preparation, voice library and the
     * credentials. It opens beside the bead — the coordinates come from
     * `fitPanel` — and is laid out as one calm column: status first, then the
     * things that are configured once, then a folded-away diagnostics block.
     */
    function SettingsPanel(props) {
      const { engine, api: client, prepare, refreshState, onClose, t, setEngine } = props;
      const [busy, setBusy] = useState(null);
      const [error, setError] = useState(null);
      const [note, setNote] = useState(null);
      const [draftKey, setDraftKey] = useState('');
      const [name, setName] = useState('');
      const [refText, setRefText] = useState('');
      const [file, setFile] = useState(null);
      const [, force] = useState(0);
      const panelRef = useRef(null);
      // Whether the panel is still on screen. A background poll checks it
      // before it touches any state, so closing the panel stops the polling.
      const aliveRef = useRef(true);
      useEffect(() => () => {
        aliveRef.current = false;
      }, []);
      const [sheetHeight, setSheetHeight] = useState(0);
      // Which tab is showing. The state lives here, above the tabs, so
      // switching tabs never discards what was typed into a field.
      const [tab, setTab] = useState('voices');
      // The persona and the speaking style are edited locally and saved
      // together, so a half-finished edit is not pushed to the model.
      const [persona, setPersona] = useState('');
      const [style, setStyle] = useState('');
      // The provider list and the dependency report, loaded on demand.
      const [providers, setProviders] = useState(null);
      const [deps, setDeps] = useState(null);
      const [depsInstall, setDepsInstall] = useState(null);
      const [update, setUpdate] = useState(null);
      // The two microphone sliders, in the same 0-100 units they show.
      const [sensitivity, setSensitivity] = useState(() => readSlider('sensitivity', SENSITIVITY.interrupt));
      const [minRms, setMinRms] = useState(() => readSlider('minRms', SENSITIVITY.minRms));
      // The provider form, for adding or editing one.
      const [providerForm, setProviderForm] = useState(null);
      const [formOpen, setFormOpen] = useState(true);
      const config = engine.config ?? {};
      const currentVoice = readString(STORAGE.voice, '') || config.voice || 'mimo_default';
      const progress = prepareView(engine.prepare);
      const bounds = props.bounds ?? viewportBounds();
      // The sheet is sized against the movable area, not against the window, so a
      // bead parked low can no longer push it off the bottom of the screen.
      const limits = panelLimits(bounds, engine.ready !== true);
      const place = fitPanel({
        bounds,
        position: props.position,
        width: limits.width,
        height: sheetHeight === 0 ? undefined : sheetHeight,
      });

      // Everything the rest of the panel reads is derived here, above the
      // callbacks that use it. The order used to matter — a callback could
      // reach for a value that was only declared further down — and that is
      // exactly the kind of fragility that breaks silently.
      const voices = engine.voices ?? [];
      const presets = engine.presets ?? [];
      // The stored language wins; without one the Host's own setting is used,
      // and the panel shows what is really in force.
      const language = readString(STORAGE.language, '') || config.language || 'auto';
      const live = statusLine(engine, t);
      const readiness = engine.ready === true
        ? { tone: 'on', text: t('ready') }
        : engine.ready === false
          ? { tone: 'warn', text: config.vadNote ? `${t('notReady')} · ${config.vadNote}` : t('notReady') }
          : { tone: 'quiet', text: '…' };

      // The provider the replies are read with. The list is fetched when the
      // tab is opened, because most sessions never need it.
      const providerList = providers ?? engine.providers ?? [];
      const selectedProvider = providerList.find((entry) => entry.id === config.provider) ?? null;
      const cloneSupported = selectedProvider?.clone === true;
      // Some services match the sample against its transcript, so for them
      // the words are part of the clone and not a nicety.
      const cloneNeedsTranscript = selectedProvider?.cloneNeedsTranscript === true;

      // The form is only there while it is being used: it opens on "edit the
      // service in use" or on "add a service", and closing it puts it away
      // again.
      const form = providerForm;
      const providerFormReady = form === null
        ? false
        : form.existing === true || PROVIDER_ID_PATTERN.test(form.id.trim());
      // A new provider needs an id the Host will accept; an existing one has
      // its id already and cannot change it. The key is left out on purpose:
      // it is never handed back to the browser, and the form has its own
      // field for it.
      const providerFormFrom = (entry) => ({
        id: entry.id,
        label: entry.label ?? '',
        kind: entry.kind ?? 'openai-speech',
        baseUrl: entry.baseUrl ?? '',
        model: entry.model ?? '',
        voice: entry.voice ?? '',
        format: entry.format ?? 'wav',
        apiKey: '',
        apiKeyEnv: entry.apiKeyEnv ?? '',
        clone: entry.clone === true,
        existing: true,
      });
      // Whether a service can clone a voice is the Host's business: it
      // decides from the wire format, and what is shown here is only a
      // report of what it said. The box is therefore read-only — a switch
      // that looks real and does nothing is worse than no switch at all.
      const cloneCapability = providerList
        .find((entry) => entry.kind === (form?.kind ?? 'openai-speech'))?.clone
        ?? (form?.existing === true ? form.clone === true : false);

      // A folded section opening makes the sheet taller and `fitPanel` has to hear
      // about it, or the sheet hangs off the area it is meant to fit inside. Only
      // the height is measured: taking the width from a measurement would resize
      // the sheet, which would measure it again, forever.
      useLayoutEffect(() => {
        const node = panelRef.current;
        if (node === null) return undefined;
        const measure = () => setSheetHeight(node.offsetHeight);
        measure();
        if (typeof ResizeObserver === 'undefined') return undefined;
        const observer = new ResizeObserver(measure);
        observer.observe(node);
        return () => observer.disconnect();
      }, []);

      const withBusy = async (label, action) => {
        setBusy(label);
        setError(null);
        try {
          await action();
        } catch (caught) {
          setError(String(caught?.message ?? caught));
        } finally {
          setBusy(null);
          force((value) => value + 1);
        }
      };

      const pickVoice = (voice) => {
        writeString(STORAGE.voice, voice);
        void withBusy('音色', async () => {
          await client.configure({ voice });
          await refreshState();
        });
      };

      const upload = () => {
        if (file === null) {
          setError('请先选择参考音频');
          return;
        }
        // The service matches the words against the sample, so a missing
        // transcript is a failed clone waiting to happen.
        if (cloneNeedsTranscript && refText.trim() === '') {
          setError('请填写参考音频对应的文字，该服务靠它与音频对齐');
          return;
        }
        void withBusy('创建音色', async () => {
          const buffer = await file.arrayBuffer();
          const bytes = new Uint8Array(buffer);
          let binary = '';
          const step = 0x8000;
          for (let i = 0; i < bytes.length; i += step) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
          }
          await client.saveVoice({
            name: name.trim() || file.name.replace(/\.[^.]+$/, ''),
            filename: file.name,
            refText,
            dataBase64: btoa(binary),
          });
          setFile(null);
          setName('');
          setRefText('');
          await refreshState();
        });
      };

      const copyDiagnostics = () => {
        const report = diagReport(engine);
        const done = () => {
          setNote(t('copied'));
          window.setTimeout(() => setNote(null), 1600);
        };
        // The clipboard API needs a secure context; the textarea fallback keeps
        // this working in a plain http window, which is how DSH is served.
        if (navigator.clipboard?.writeText) {
          navigator.clipboard.writeText(report).then(done, () => setNote(null));
          return;
        }
        const area = document.createElement('textarea');
        area.value = report;
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        try {
          document.execCommand('copy');
          done();
        } catch {
          setNote(null);
        }
        area.remove();
      };

      // Load the provider list and the dependency report the first time the
      // advanced tab is shown, so opening the sheet stays cheap.
      useEffect(() => {
        if (tab !== 'advanced') return;
        if (providers === null) {
          void client.providers()
            .then((payload) => setProviders(payload.providers ?? []))
            .catch(() => setProviders([]));
        }
        if (deps === null) {
          void client.dependencies()
            .then((payload) => setDeps(payload.entries ?? []))
            .catch(() => setDeps([]));
        }
      }, [tab, providers, deps]);

      // Fill the persona and style fields from the configuration, once it has
      // arrived. The wait is for the configuration itself, not for the first
      // render: a panel opened before the state came back would otherwise
      // show empty fields and save them over what the Host actually holds.
      const [personaLoaded, setPersonaLoaded] = useState(false);
      useEffect(() => {
        if (personaLoaded) return;
        if (config.persona === undefined) return;
        setPersona(String(config.persona ?? ''));
        setStyle(String(config.instruction ?? ''));
        setPersonaLoaded(true);
      }, [personaLoaded, config.persona, config.instruction]);

      // Store a slider position and apply it to the running engine, so the
      // next utterance uses it.
      const applySensitivity = (key, position) => {
        writeString(STORAGE[key], String(position));
        // The options object is shared with the running recorder, which reads
        // the thresholds on every frame. It is therefore changed in place: a
        // fresh copy would leave the open microphone on the old thresholds
        // until it was reopened.
        const options = engine.options;
        if (key === 'sensitivity') {
          options.interruptThreshold = sliderToThreshold(SENSITIVITY.interrupt, position);
          setSensitivity(position);
        } else {
          options.rmsThreshold = sliderToThreshold(SENSITIVITY.minRms, position);
          setMinRms(position);
        }
        force((value) => value + 1);
      };

      // Save the persona and the speaking style together.
      const savePersona = () => {
        void withBusy('保存人设', async () => {
          await client.configure({ persona, instruction: style });
          await refreshState();
          setNote(t('providerSaved'));
        });
      };

      // Check for a newer release.
      const checkUpdate = () => {
        void withBusy('检查更新', async () => {
          const result = await client.version();
          setUpdate(result);
        });
      };

      // Install a newer release, after the user has been told what it does.
      const installUpdate = () => {
        const latest = update?.latest;
        if (!latest) return;
        if (!window.confirm(t('updateConfirm'))) return;
        const spec = `github:HimaCSR/dsh-voice-chat@v${latest}`;
        void withBusy('更新', async () => {
          const result = await client.installVersion(spec);
          setUpdate({ ...update, install: result });
        });
      };

      // Install one missing dependency into the DSH profile.
      const installDependency = (entry) => {
        void withBusy(`安装 ${entry.name}`, async () => {
          setDepsInstall({ running: true, name: entry.name, output: [], error: null });
          await client.installDependency(entry.name, entry.required ?? '');
          // The install runs in the background; its log is polled until it
          // stops. The poll gives up when the panel is closed, so it does not
          // keep talking to a panel that is no longer on screen.
          const poll = async () => {
            if (!aliveRef.current) return;
            const state = await client.dependencyInstallStatus();
            if (!aliveRef.current) return;
            setDepsInstall(state);
            if (state.running === true) {
              window.setTimeout(() => void poll(), 900);
              return;
            }
            const refreshed = await client.dependencies();
            setDeps(refreshed.entries ?? []);
          };
          await poll();
        });
      };

      // Add or change one provider.
      const saveProvider = () => {
        if (form === null) return;
        const record = { ...form };
        // An empty key field means "leave the stored key alone", not "clear
        // it". The Host reads a blank key as a request to clear the stored
        // one, so editing a service to change its model would wipe the key
        // the user had saved. The field is only sent when something was
        // actually typed into it.
        if (typeof record.apiKey === 'string' && record.apiKey.trim() === '') {
          delete record.apiKey;
        }
        void withBusy('保存服务', async () => {
          const payload = await client.saveProvider(record);
          setProviders(payload.providers ?? []);
          setProviderForm(null);
          await refreshState();
        });
      };

      // ── the tab bar
      const tabButton = (id, label) => h('button', {
        type: 'button',
        className: 'dshv-tab',
        role: 'tab',
        'aria-selected': tab === id ? 'true' : 'false',
        'data-active': tab === id ? 'true' : 'false',
        onClick: () => setTab(id),
      }, label);

      // ── tab: voice preferences
      const voicesTab = h('div', { role: 'tabpanel', className: 'dshv-tabpanel' },
        h('div', { style: styles.section },
          h('div', { style: styles.sectionHead }, h('span', null, t('voice'))),
          h('div', { style: styles.row },
            h('select', {
              style: { ...styles.field, flex: 1 },
              value: currentVoice,
              onChange: (event) => pickVoice(event.target.value),
            },
              h('optgroup', { label: t('provider') },
                presets.map((preset) => h('option', { key: preset.id, value: preset.id }, preset.label))),
              voices.length > 0
                ? h('optgroup', { label: t('newVoice') },
                  voices.map((voice) => h('option', { key: voice.name, value: `clone:${voice.name}` },
                    `🎤 ${voice.name}（克隆）`)))
                : null,
            )),
          voices.map((voice) => h('div', { key: voice.name, className: 'dshv-voicecard' },
            h('div', { className: 'dshv-voicehead' },
              h('span', {
                style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                title: voice.refText || voice.name,
              }, voice.name),
              h('span', { style: styles.note }, `${Math.round(voice.bytes / 1024)} KB`),
              h(Button, {
                style: styles.knob,
                onClick: () => void withBusy('删除音色', async () => {
                  await client.deleteVoice(voice.name);
                  await refreshState();
                }),
              }, t('remove'))),
            h('audio', { src: client.sampleUrl(voice.name), controls: true })))),
        // Cloning needs a provider that can do it; say so rather than letting
        // the upload fail later.
        cloneSupported
          ? h('details', { style: styles.section },
            h('summary', { style: { cursor: 'pointer', fontSize: 12.5, fontWeight: 600 } }, t('newVoice')),
            h('div', { style: styles.row }, h('input', {
              style: styles.field,
              placeholder: t('voiceName'),
              value: name,
              onChange: (event) => setName(event.target.value),
            })),
            h('div', { style: styles.row }, h('input', {
              style: styles.field,
              type: 'file',
              accept: 'audio/wav,audio/mpeg,.wav,.mp3',
              onChange: (event) => setFile(event.target.files?.[0] ?? null),
            })),
            h('div', { style: styles.row }, h('span', { style: styles.note }, t('upload'))),
            h('div', { style: styles.row }, h('input', {
              style: styles.field,
              placeholder: cloneNeedsTranscript ? t('refTextRequired') : t('refText'),
              value: refText,
              onChange: (event) => setRefText(event.target.value),
            })),
            cloneNeedsTranscript
              ? h('div', { style: styles.note }, t('refTextRequiredHint'))
              : null,
            h('div', { style: { margin: '8px 0 2px' } },
              h(Button, { className: 'dshv-primary', disabled: busy !== null, onClick: upload }, t('create'))))
          : h('div', { style: styles.section },
            h('div', { style: styles.sectionHead }, h('span', null, t('newVoice'))),
            h('div', { style: styles.note }, t('noCloneSupport'))),
      );

      // ── tab: persona
      const personaTab = h('div', { role: 'tabpanel', className: 'dshv-tabpanel' },
        h('div', { style: styles.section },
          h('div', { style: styles.sectionHead }, h('span', null, t('personaTitle'))),
          h('div', { style: styles.note }, t('personaHint')),
          h('div', { style: { margin: '6px 0 2px' } }, h('textarea', {
            style: { ...styles.field, width: '100%', minHeight: 84, resize: 'vertical', font: 'inherit', fontSize: 12.5 },
            placeholder: t('personaPlaceholder'),
            value: persona,
            onChange: (event) => setPersona(event.target.value),
          }))),
        h('div', { style: styles.section },
          h('div', { style: styles.sectionHead }, h('span', null, t('ttsStyleTitle'))),
          h('div', { style: styles.note }, t('ttsStyleHint')),
          h('div', { style: { margin: '6px 0 2px' } }, h('textarea', {
            style: { ...styles.field, width: '100%', minHeight: 84, resize: 'vertical', font: 'inherit', fontSize: 12.5 },
            placeholder: t('ttsStylePlaceholder'),
            value: style,
            onChange: (event) => setStyle(event.target.value),
          })),
          h('div', { style: styles.note }, t('ttsStyleTags'))),
        h('div', { style: styles.section },
          h('div', { style: styles.sectionHead }, h('span', null, t('speakModeTitle'))),
          h('div', { style: styles.note }, t('speakModeHint')),
          h('div', { style: styles.row },
            h('select', {
              style: { ...styles.field, flex: 1 },
              value: config.speakMode ?? 'head-tail',
              onChange: (event) => void withBusy('保存播报方式', async () => {
                await client.configure({ speakMode: event.target.value });
                await refreshState();
              }),
            }, [
              ['head-tail', t('speakModeHeadTail')],
              ['all', t('speakModeAll')],
              ['head', t('speakModeHead')],
              ['tail', t('speakModeTail')],
            ].map(([value, label]) => h('option', { key: value, value }, label))))),
        h('div', { style: styles.section },
          h('div', { style: styles.sectionHead }, h('span', null, t('languageLabel'))),
          h('div', { style: styles.row },
            h('select', {
              style: { ...styles.field, flex: 1 },
              value: language,
              onChange: (event) => {
                writeString(STORAGE.language, event.target.value);
                setEngine({ config: { ...engine.config, language: event.target.value } });
                force((value) => value + 1);
                // The language is also written to the Host's configuration, so
                // it survives a reload and shows up in the diagnostics.
                void client.configure({ language: event.target.value }).catch(() => undefined);
              },
            },
              ['auto', 'zh', 'en', 'yue', 'ja', 'ko'].map((code) =>
                h('option', { key: code, value: code }, t(`lang_${code}`)))))),
        h('div', { style: { margin: '10px 0 2px' } },
          h(Button, { className: 'dshv-primary', disabled: busy !== null, onClick: savePersona },
            busy === '保存人设' ? `${t('save')}…` : t('save'))),
      );

      // ── tab: advanced — the TTS service, the microphone, and the two
      // housekeeping sections: diagnostics with the dependency audit, and the
      // version check.
      const providerFormView = form === null ? null : h('details', {
        style: styles.section,
        // React re-renders the open attribute, so the browser's own toggle
        // has to be reported back or the form springs open again.
        open: formOpen,
        onToggle: (event) => setFormOpen(event.currentTarget.open),
      },
        // The way out sits at the top of the form. At the bottom it was only
        // reachable after scrolling the whole form past the last field, and
        // the full-width button beside it had squeezed its own text out of
        // sight.
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
          h('summary', {
            style: { cursor: 'pointer', fontSize: 12.5, fontWeight: 600, flex: '1 1 auto', minWidth: 0 },
          }, form.existing === true ? t('editProvider') : t('addProvider')),
          h(Button, {
            style: { ...styles.knob, flex: 'none' },
            onClick: () => setProviderForm(null),
          }, t('close'))),
        h('div', { style: styles.row }, h('span', { style: styles.label }, t('providerId')),
          h('input', {
            style: { ...styles.field, flex: 1, minWidth: 0 },
            value: form.id,
            placeholder: 'my-tts',
            disabled: form.existing === true,
            onChange: (event) => setProviderForm({ ...form, id: event.target.value }),
          })),
        form.existing === true
          ? null
          : h('div', { style: styles.note }, t('providerIdHint'),
            // The id becomes a key in the stored map, so it is checked before
            // the request is made rather than after it comes back refused.
            PROVIDER_ID_PATTERN.test(form.id.trim())
              ? null
              : h('div', { style: { color: '#e8a33d', marginTop: 3 } }, t('providerIdInvalid'))),
        h('div', { style: styles.row }, h('span', { style: styles.label }, t('providerLabel')),
          h('input', {
            style: { ...styles.field, flex: 1, minWidth: 0 },
            value: form.label ?? '',
            onChange: (event) => setProviderForm({ ...form, label: event.target.value }),
          })),
        h('div', { style: styles.row }, h('span', { style: styles.label }, t('providerKind')),
          h('select', {
            style: { ...styles.field, flex: 1 },
            value: form.kind ?? 'openai-speech',
            onChange: (event) => setProviderForm({ ...form, kind: event.target.value }),
          }, ['mimo', 'openai-speech', 'siliconflow', 'dev-tone'].map((kind) =>
            h('option', { key: kind, value: kind }, t(`kind_${kind.replace(/-/g, '')}`))))),
        h('div', { style: styles.row }, h('span', { style: styles.label }, t('providerBaseUrl')),
          h('input', {
            style: { ...styles.field, flex: 1, minWidth: 0 },
            value: form.baseUrl ?? '',
            placeholder: 'https://api.example.com/v1',
            onChange: (event) => setProviderForm({ ...form, baseUrl: event.target.value }),
          })),
        h('div', { style: styles.row }, h('span', { style: styles.label }, t('providerModel')),
          h('input', {
            style: { ...styles.field, flex: 1, minWidth: 0 },
            value: form.model ?? '',
            onChange: (event) => setProviderForm({ ...form, model: event.target.value }),
          })),
        h('div', { style: styles.row }, h('span', { style: styles.label }, t('providerVoice')),
          h('input', {
            style: { ...styles.field, flex: 1, minWidth: 0 },
            value: form.voice ?? '',
            onChange: (event) => setProviderForm({ ...form, voice: event.target.value }),
          })),
        h('div', { style: styles.row }, h('span', { style: styles.label }, t('providerFormat')),
          h('select', {
            style: { ...styles.field, flex: 1 },
            value: form.format ?? 'wav',
            onChange: (event) => setProviderForm({ ...form, format: event.target.value }),
          }, ['wav', 'mp3', 'pcm'].map((format) => h('option', { key: format, value: format }, format)))),
        h('div', { style: styles.row }, h('span', { style: styles.label }, t('providerApiKey')),
          h('input', {
            style: { ...styles.field, flex: 1, minWidth: 0 },
            type: 'password',
            placeholder: 'sk-…',
            value: form.apiKey ?? '',
            onChange: (event) => setProviderForm({ ...form, apiKey: event.target.value }),
          })),
        h('div', { style: styles.row }, h('span', { style: styles.label }, t('providerApiKeyEnv')),
          h('input', {
            style: { ...styles.field, flex: 1, minWidth: 0 },
            value: form.apiKeyEnv ?? '',
            onChange: (event) => setProviderForm({ ...form, apiKeyEnv: event.target.value }),
          })),
        h('div', { style: styles.row }, h('span', { style: styles.label }, t('providerClone')),
          h('input', {
            type: 'checkbox',
            checked: form.clone === true,
            onChange: (event) => setProviderForm({ ...form, clone: event.target.checked }),
          })),
        h('div', { style: { margin: '8px 0 2px' } },
          h(Button, {
            className: 'dshv-primary',
            disabled: busy !== null || !providerFormReady,
            onClick: saveProvider,
          }, t('save'))),
      );

      const dependencyRow = (entry) => h('div', { key: entry.name, className: 'dshv-dep' },
        h('div', { className: 'dshv-dep-head' },
          h('span', { className: 'dshv-dep-name' }, entry.name),
          h('span', { className: 'dshv-dep-state', 'data-state': entry.status },
            entry.kind === 'dsh'
              ? t('depProvided')
              : entry.status === 'ok' ? t('depOk') : entry.status === 'missing' ? t('depMissing') : t('depMismatch'))),
        h('div', { className: 'dshv-kv' }, h('span', null, t('dependencyVersion')),
          h('span', null, entry.version ?? '—')),
        h('div', { className: 'dshv-kv' }, h('span', null, t('dependencyRequired')),
          h('span', null, entry.required ?? '—')),
        h('div', { className: 'dshv-kv' }, h('span', null, t('dependencySource')),
          h('span', { title: entry.resolved ?? '' }, entry.resolvedFrom ?? '—')),
        entry.reason ? h('div', { style: styles.note }, entry.reason) : null,
        // Only a dependency the plugin owns can be installed; the ones DSH
        // ships are reported but not touched.
        entry.kind === 'plugin' && entry.status !== 'ok'
          ? h('div', { style: { marginTop: 5 } },
            h(Button, {
              style: styles.knob,
              disabled: busy !== null,
              onClick: () => installDependency(entry),
            }, busy === `安装 ${entry.name}` ? t('depInstalling') : t('depInstall')))
          : null,
      );

      const advancedTab = h('div', { role: 'tabpanel', className: 'dshv-tabpanel' },
        h('div', { style: styles.section },
          h('div', { style: styles.sectionHead }, h('span', null, t('providerSection'))),
          h('div', { style: styles.note }, t('providerHint')),
          h('div', { style: { ...styles.row } },
            h('select', {
              style: { ...styles.field, flex: 1 },
              value: config.provider ?? 'mimo',
              onChange: (event) => {
                // Choosing a service also loads its settings into the form
                // below. The list offered the same services a second time as
                // "recommended" buttons, which read as a duplicate of the
                // menu right above them.
                const entry = providerList.find((item) => item.id === event.target.value);
                if (entry) setProviderForm(providerFormFrom(entry));
                void withBusy('切换服务', async () => {
                  await client.configure({ provider: event.target.value });
                  await refreshState();
                });
              },
            }, providerList.map((entry) => h('option', { key: entry.id, value: entry.id }, entry.label))),
            // A custom provider can be removed again; a built-in one cannot,
            // because it is the fallback the plugin falls back to.
            selectedProvider && selectedProvider.builtin !== true
              ? h(Button, {
                style: styles.knob,
                disabled: busy !== null,
                onClick: () => void withBusy('删除服务', async () => {
                  const payload = await client.deleteProvider(selectedProvider.id);
                  setProviders(payload.providers ?? []);
                  setProviderForm(null);
                  await refreshState();
                }),
              }, t('providerDelete'))
              : null,
          ),
          h('div', { style: { margin: '6px 0 2px', display: 'flex', gap: 8, flexWrap: 'wrap' } },
            // The menu above switches between services; these two do the
            // other half of the work — change the one in use, or bring a new
            // one in.
            selectedProvider
              ? h(Button, {
                style: styles.knob,
                onClick: () => setProviderForm(providerFormFrom(selectedProvider)),
              }, t('editCurrentProvider'))
              : null,
            h(Button, {
              style: styles.knob,
              onClick: () => setProviderForm({
                id: '', label: '', kind: 'openai-speech', baseUrl: '', model: '', voice: '',
                format: 'mp3', apiKey: '', apiKeyEnv: '', clone: false, existing: false,
              }),
            }, t('addProvider'))),
          ),
          providerFormView,
          h('div', { style: styles.row },
            h('span', { style: styles.label }, t('providerApiKey')),
            h('input', {
              style: { ...styles.field, flex: 1, minWidth: 0 },
              type: 'password',
              placeholder: 'sk-…',
              value: draftKey,
              onChange: (event) => setDraftKey(event.target.value),
            }),
            h(Button, {
              style: styles.knob,
              disabled: busy !== null,
              onClick: () => void withBusy('保存 Key', async () => {
                await client.configure({ apiKey: draftKey });
                setDraftKey('');
                await refreshState();
              }),
            }, t('save'))),
        h('div', { style: styles.section },
          h('div', { style: styles.sectionHead }, h('span', null, t('sensitivityTitle'))),
          h('div', { style: styles.row },
            h('span', { style: { ...styles.label, minWidth: 92 } }, t('interruptSensitivity')),
            h('input', {
              type: 'range', min: 0, max: 100, step: 1,
              style: { flex: 1, minWidth: 0 },
              value: sensitivity,
              onChange: (event) => applySensitivity('sensitivity', Number(event.target.value)),
            }),
            h('span', { style: { ...styles.note, minWidth: 48, textAlign: 'right' } },
              sliderToThreshold(SENSITIVITY.interrupt, sensitivity).toFixed(3))),
          h('div', { style: styles.note }, t('interruptSensitivityHint')),
          h('div', { style: styles.row },
            h('span', { style: { ...styles.label, minWidth: 92 } }, t('minRms')),
            h('input', {
              type: 'range', min: 0, max: 100, step: 1,
              style: { flex: 1, minWidth: 0 },
              value: minRms,
              onChange: (event) => applySensitivity('minRms', Number(event.target.value)),
            }),
            h('span', { style: { ...styles.note, minWidth: 48, textAlign: 'right' } },
              sliderToThreshold(SENSITIVITY.minRms, minRms).toFixed(3))),
          h('div', { style: styles.note }, t('minRmsHint')),
          h('div', { style: styles.note }, t('sensitivityEffect'))),
        h('div', { style: styles.section },
          h('div', { style: styles.sectionHead }, h('span', null, t('modelPrepTitle'))),
          h('div', { style: styles.note }, t('modelPrepHint'))),
        h('div', { style: styles.section },
          h('div', { style: styles.sectionHead }, h('span', null, t('diagSection'))),
          h('div', { className: 'dshv-kv' }, h('span', null, t('sttBackend')),
            h('span', null, `${config.sttBackend ?? '—'} · ${config.precision ?? '—'}`)),
          h('div', { className: 'dshv-kv' }, h('span', null, t('vadBackend')),
            h('span', null, config.vadBackendEffective ?? config.vadBackend ?? '—')),
          config.vadNote ? h('div', { style: styles.note }, config.vadNote) : null,
          h('div', { style: { marginTop: 8, marginBottom: 2 } },
            h('span', { style: { fontSize: 12.5, fontWeight: 600 } }, t('dependencyName'))),
          h('div', { style: styles.note }, t('depOptionalHint')),
          (deps ?? []).map(dependencyRow),
          depsInstall !== null && depsInstall.running === true
            ? h('div', { style: styles.note }, t('depInstalling'))
            : null,
          depsInstall !== null && depsInstall.phase === 'done'
            ? h('div', { style: styles.note }, t('depInstalled'))
            : null,
          depsInstall !== null && depsInstall.error
            ? h('div', { style: styles.error }, `${t('depInstallFailed')}：${depsInstall.error}`)
            : null,
          depsInstall !== null && Array.isArray(depsInstall.output) && depsInstall.output.length > 0
            ? h('pre', { className: 'dshv-dep-log' }, depsInstall.output.join('\n'))
            : null,
          depsInstall !== null ? h('div', { style: styles.note }, t('depRestartHint')) : null,
          h('div', { style: { marginTop: 6 } }, h('div', { style: styles.note }, config.dataRoot ?? '—')),
          h('div', { className: 'dshv-diag-actions' },
            h('button', { type: 'button', className: 'dshv-copy', onClick: copyDiagnostics }, t('copyDiag')),
            note !== null ? h('span', { style: styles.note }, note) : null)),
        h('div', { style: styles.section },
          h('div', { style: styles.sectionHead }, h('span', null, t('versionSection'))),
          h('div', { style: styles.note }, t('updateNoServer')),
          h('div', { className: 'dshv-kv' }, h('span', null, t('currentVersion')),
            h('span', null, config.version ?? '—')),
          update !== null && update.reachable === true
            ? h('div', { className: 'dshv-kv' }, h('span', null, t('latestVersion')),
              h('span', null, update.latest ?? '—'))
            : null,
          update !== null && update.reachable === false
            ? h('div', { style: styles.note }, t('updateUnreachable'))
            : null,
          update !== null && update.hasUpdate === true
            ? h('div', { style: { marginTop: 6 } },
              h(Button, { className: 'dshv-primary', disabled: busy !== null, onClick: installUpdate },
                busy === '更新' ? t('updateInstalling') : t('updateNow')))
            : null,
          update !== null && update.hasUpdate === false && update.reachable === true
            ? h('div', { style: styles.note }, t('upToDate'))
            : null,
          update !== null && update.notes
            ? h('div', { style: styles.note }, update.notes.slice(0, 400))
            : null,
          update !== null && update.install?.error
            ? h('div', { style: styles.error }, `${t('updateFailed')}：${update.install.error}`)
            : null,
          update !== null && update.install?.applied === true
            ? h('div', { style: styles.note }, t('updateDone'))
            : null,
          update !== null && update.install?.manual
            ? h('div', { style: styles.note }, `${t('updateManual')}：${update.install.manual}`)
            : null,
          h('div', { style: { marginTop: 8 } },
            h(Button, { style: styles.knob, disabled: busy !== null, onClick: checkUpdate },
              busy === '检查更新' ? t('checking') : t('checkUpdate')))),
      );

      const tabContent = tab === 'persona' ? personaTab : tab === 'advanced' ? advancedTab : voicesTab;

      return h(
        'div',
        { className: 'dshv-backdrop', onClick: onClose, 'aria-hidden': 'true' },
        h(
          'div',
          {
            ref: panelRef,
            className: 'dshv-panel',
            style: {
              ...styles.panel,
              top: place.y,
              left: place.x,
              width: limits.width,
              maxHeight: limits.maxHeight,
            },
            role: 'dialog',
            'aria-label': t('settings'),
            'aria-modal': 'true',
            onClick: (event) => event.stopPropagation(),
          },
          // ── header: what it is, and whether it is usable. It sticks to the top
          // of the sheet, because a long sheet scrolls behind it.
          h('div', { className: 'dshv-panelhead' },
            h('h4', null, t('title')),
            h('span', {
              className: 'dshv-readydot',
              style: { color: readiness.tone === 'on' ? '#10b981' : readiness.tone === 'warn' ? 'var(--dshv-warn)' : 'var(--dsw-alias-label-tertiary,inherit)' },
            }),
            h('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11.5, color: 'var(--dsw-alias-label-secondary, inherit)' } },
              readiness.text),
            h(Button, {
              style: { ...styles.iconKnob, ...styles.knob },
              'aria-label': t('close'),
              title: t('close'),
              onClick: onClose,
            }, h(Icon, { name: 'close', size: 14 })),
          ),

          // ── what it is doing right now, timed so it cannot be mistaken for a hang
          live.action !== null && live.kind !== 'warn'
            ? h('div', { style: styles.statusRow }, h('span', null, live.text))
            : null,
          // The bubble beside the bead can be dismissed, so the sheet keeps the
          // last failure in full: this is the place that never hides it.
          engine.error !== null
            ? h('div', { style: styles.error }, String(engine.error))
            : null,

          // ── model preparation: the only long operation, so it gets a real bar
          progress.running
            ? h('div', { className: 'dshv-progress' },
              h('div', { className: 'dshv-progress-meta' },
                h('span', null, t('preparing')),
                h('span', null, progress.label)),
              h('div', { className: 'dshv-bar', 'data-busy': String(progress.indeterminate) },
                h('i', { style: { width: `${progress.percent ?? 8}%` } })))
            : null,
          progress.error !== null
            ? h('div', { style: styles.error }, `${t('downloadFailed')}：${progress.error}`)
            : null,
          engine.ready !== true && !progress.running
            ? h('div', { style: { margin: '8px 0 2px' } },
              h(Button, {
                className: 'dshv-primary',
                disabled: busy !== null,
                onClick: () => void withBusy('准备模型', prepare),
              }, busy === '准备模型' ? t('preparing') : t('prepare')))
            : null,

          // ── the tabs. The state of the plugin — status, errors, the model
          // download — stays above them, because it describes the plugin and
          // not one part of its configuration.
          h('div', { className: 'dshv-tabs', role: 'tablist' },
            tabButton('voices', t('tabVoices')),
            tabButton('persona', t('tabPersona')),
            tabButton('advanced', t('tabAdvanced'))),

          tabContent,

          // The model download already has a real progress bar above; this plain
          // line is only for the short operations that have no bar of their own.
          busy !== null && !progress.running
            ? h('div', { style: styles.row }, h('span', { style: styles.note }, `${busy}…`))
            : null,
          error !== null ? h('div', { style: styles.error }, error) : null,
        ),
      );
    }

    /**
     * Hidden per-session listener. Streams complete sentences of the newest
     * assistant reply into the TTS provider and plays them in order, so a long
     * answer starts speaking long before it finishes streaming.
     */
    function ReplyListener(props) {
      const { engine, api: client, speaker, subscribe, setEngine } = props;
      const useChatSnapshot = props.useChat;
      const chat = useChatSnapshot ? useChatSnapshot((snapshot) => snapshot) : undefined;
      const spokenRef = useRef(new Map());
      const chainRef = useRef(Promise.resolve());
      const baselineRef = useRef(null);
      // The last barge-in the listener has already accounted for.
      const seenInterruptRef = useRef(0);
      const skipRef = useRef(0);
      const [, force] = useState(0);

      useEffect(() => subscribe(() => force((value) => value + 1)), [subscribe]);

      // The microphone's barge-in path asks this listener to abandon the reply
      // currently being spoken. The signal lives on the engine rather than in
      // a callback: a callback is only there while this seat is mounted, and
      // a barge-in that arrives in the gap — while the session is switching,
      // or between two mounts — would otherwise be dropped, leaving the
      // reply being read out after the user had interrupted it.
      useEffect(() => {
        seenInterruptRef.current = engine.interruptSeq;
      }, [engine]);

      useEffect(() => () => speaker.stop(), [speaker]);

      useEffect(() => {
        if (!readFlag(STORAGE.enabled, true)) return;
        const nodes = chatNodes(chat);
        let hasSettled = false;
        let maxAnchor = 0;
        for (const node of nodes) {
          if (node.kind !== 'assistant-step') continue;
          if (node.data?.status === 'settled') hasSettled = true;
          const anchor = node.anchorSeq ?? 0;
          if (anchor > maxAnchor) maxAnchor = anchor;
        }
        // History protection: never replay a conversation the user merely
        // opened. The baseline freezes on the replies that were already
        // finished when the plugin mounted — not on the first one that
        // finishes afterwards, which in an empty conversation is the very
        // first reply the user gets, and skipping it means the plugin says
        // nothing at all when a new session starts.
        if (baselineRef.current === null) {
          const settledAnchor = historyAnchor(nodes);
          baselineRef.current = settledAnchor;
          skipRef.current = settledAnchor;
          return;
        }
        if (engine.interruptSeq !== seenInterruptRef.current) {
          // The user barged in: the rest of that reply is not read out.
          seenInterruptRef.current = engine.interruptSeq;
          skipRef.current = maxAnchor;
          return;
        }
        const jobs = [];
        for (const node of nodes) {
          if (node.kind !== 'assistant-step') continue;
          const anchor = node.anchorSeq ?? 0;
          if (anchor <= skipRef.current) continue;
          const data = node.data ?? {};
          if (data.status === 'interrupted') continue;
          const text = cleanReplyText(
            (data.blocks ?? [])
              .filter((block) => block.kind === 'text')
              .map((block) => block.text)
              .join('\n'),
            2000,
          );
          if (text.length < 2) continue;
          const settled = data.status === 'settled';
          const { sentences, partial } = splitSentences(text);
          const speakable = settled && partial !== null ? [...sentences, partial] : sentences;
          // The trail of what was already spoken is kept by content, not by
          // count: the set of sentences changes shape when the reply settles
          // (the closing sentence joins them), so counting would speak the
          // opening sentence a second time.
          const spoken = spokenRef.current.get(node.key) ?? new Set();
          const mode = engine.config?.speakMode ?? 'head-tail';
          for (const sentence of pickSpoken(speakable, mode, settled, spoken)) {
            spoken.add(sentence);
            jobs.push({ anchor, key: node.key, index: 0, sentence });
          }
          spokenRef.current.set(node.key, spoken);
        }
        if (jobs.length === 0) return;
        jobs.sort((a, b) => a.anchor - b.anchor || a.index - b.index);
        const voice = readString(STORAGE.voice, '') || engine.config?.voice || '';
        // The chain watches the barge-in counter: a reply that was cut short
        // must not be read out to the end afterwards.
        const chainSeq = engine.interruptSeq;
        chainRef.current = jobs.reduce(
          (chain, job) =>
            chain.then(async () => {
              if (engine.interruptSeq !== chainSeq || !readFlag(STORAGE.enabled, true)) return;
              const controller = new AbortController();
              engine.ttsController = controller;
              try {
                const audio = await client.tts(job.sentence, voice, controller.signal);
                if (engine.interruptSeq !== chainSeq) return;
                speaker.enqueue(audio);
                // Speaking again means the failure is behind us. A persistent
                // problem — an unset key, say — simply reports itself once more.
                if (engine.error !== null) setEngine({ error: null });
              } catch (error) {
                if (error?.name !== 'AbortError') {
                  console.error('[voice-chat] TTS failed:', error);
                  const message = `朗读失败：${error.message ?? error}`;
                  setEngine({ error: message });
                  // The host keeps the trail: a failure that only ever shows
                  // up in the browser would otherwise be gone with the tab.
                  void client.reportError?.('tts', message, String(error?.stack ?? '').slice(0, 500));
                }
              } finally {
                if (engine.ttsController === controller) engine.ttsController = null;
              }
            }),
          chainRef.current,
        );
      });

      return null;
    }

    // `__internals` exists so the Host-side unit test can exercise the pure
    // text helpers without a browser. The module system reads only `inject`
    // and `apply`, so the extra key is inert at runtime.
    return {
      inject,
      apply,
      __internals: {
        splitSentences,
        historyAnchor,
        sliderToThreshold,
        thresholdToSlider,
        PROVIDER_ID_PATTERN,
        cleanReplyText,
        pickSpoken,
        chatNodes,
        viewportBounds,
        clampPosition,
        snapToEdge,
        attachTo,
        refit,
        nearestEdge,
        dockLayout,
        dockCentre,
        waveRadius,
        panelLimits,
        alertPlacement,
      },
    };
  },
});
