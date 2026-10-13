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
    };

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
        if (!response.ok) throw new Error((await asJson(response)).error ?? `STT HTTP ${response.status}`);
        return asJson(response);
      },
      /** Synthesize one sentence; resolves with the audio bytes. */
      async tts(text, voice, signal) {
        const response = await fetch(`${BASE}/tts`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text, voice }),
          signal,
        });
        if (!response.ok) throw new Error((await asJson(response)).error ?? `TTS HTTP ${response.status}`);
        return response.arrayBuffer();
      },
      /** Download the pinned local models; resolves when the run finishes. */
      async prepare() {
        return asJson(await fetch(`${BASE}/prepare`, { method: 'POST' }));
      },
      async voices() {
        return asJson(await fetch(`${BASE}/voices`));
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
        return Math.min(1, sum / bins / 180);
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
          const interruptAt = this.options.interruptThreshold ?? 0.06;
          const now = performance.now();
          if (rms >= interruptAt) {
            if (this.armedAt === 0) this.armedAt = now;
            else if (now - this.armedAt >= (this.options.interruptHoldMs ?? 220)) {
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
        const threshold = this.options.rmsThreshold ?? 0.012;
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
        if (!this.speaking) return;
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

    function isTrivial(sentence) {
      if (sentence.length <= 1) return true;
      return !/[\u4e00-\u9fff0-9a-zA-Z]/.test(sentence);
    }

    /** Split a reply into complete sentences plus a trailing partial chunk. */
    function splitSentences(text) {
      const sentences = [];
      let buffer = '';
      for (const character of text) {
        buffer += character;
        if (TERMINATORS.has(character)) {
          const trimmed = buffer.trim();
          if (trimmed !== '' && !isTrivial(trimmed)) sentences.push(trimmed);
          buffer = '';
        }
      }
      const partial = buffer.trim();
      return { sentences, partial: partial === '' || isTrivial(partial) ? null : partial };
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
    };
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
      chip: {
        display: 'block',
        width: '100%',
        textAlign: 'left',
        margin: '5px 0 0',
        padding: '7px 9px',
        fontSize: 11.5,
      },
      // The panel is placed by `fitPanel()` next to wherever the bead happens to
      // sit, so only the material and the shape are declared here.
      panel: {
        position: 'fixed',
        zIndex: 60,
        maxHeight: '72vh',
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
      head: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 },
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
      diag: {
        height: 108,
        marginTop: 7,
        padding: 8,
        overflow: 'auto',
        resize: 'vertical',
        fontFamily: 'ui-monospace,SFMono-Regular,Consolas,monospace',
        fontSize: 11,
        lineHeight: 1.45,
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
/* No transition while the pointer owns the position, or the bead would lag. */
.dshv[data-dragging="true"]{transition:none}
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
   border-radius), so only the tremble stays in CSS. */
.dshv[data-attached="left"] .dshv-orb,
.dshv[data-attached="right"] .dshv-orb,
.dshv[data-attached="top"] .dshv-orb,
.dshv[data-attached="bottom"] .dshv-orb{animation:dshv-tremble .34s linear infinite}
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

/* Open: the big bead breaks into four smaller ones. */
.dshv-spread{position:absolute;right:0;bottom:0;width:0;height:0}
.dshv-node{position:absolute;right:26px;bottom:26px;display:flex;flex-direction:column;
  align-items:center;gap:5px;transform:translate(0,0) scale(.4);opacity:0;pointer-events:none;
  transition:transform .42s cubic-bezier(.26,1.5,.5,1),opacity .26s ease}
.dshv[data-expanded="true"] .dshv-node{transform:translate(var(--tx),var(--ty)) scale(1);
  opacity:1;pointer-events:auto}
.dshv[data-expanded="true"] .dshv-node:nth-child(2){transition-delay:.03s}
.dshv[data-expanded="true"] .dshv-node:nth-child(3){transition-delay:.09s}
.dshv[data-expanded="true"] .dshv-node:nth-child(4){transition-delay:.15s}
.dshv[data-expanded="true"] .dshv-orb{transform:scale(.38);opacity:0;animation:none}
.dshv[data-expanded="true"] .dshv-wave{display:none}
.dshv-cap{font-size:11px;white-space:nowrap;color:var(--dsw-alias-label-secondary,currentColor)}
.dshv-bead{position:relative;width:44px;height:44px;padding:0;border:0;border-radius:50%;
  background:transparent;color:var(--dshv-ink);cursor:pointer;display:grid;
  place-items:center;font:inherit}
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
.dshv-panel .dshv-voicerow{display:flex;align-items:center;gap:6px;margin:5px 0}
.dshv-panel audio{height:26px;max-width:132px}
.dshv-panel button{cursor:pointer}
.dshv-panel button:disabled{opacity:.5;cursor:default}
.dshv-panel select,.dshv-panel input,.dshv-panel textarea{min-width:0}
.dshv-panel ::placeholder{color:var(--dsw-alias-label-tertiary,currentColor);opacity:.8}
.dshv-panel[data-wide="true"]{width:min(420px,calc(100vw - 24px));max-height:82vh}
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
.dshv-diag{margin-top:5px;color:var(--dsw-alias-label-secondary,inherit)}
.dshv-diag summary{cursor:pointer;font-size:11.5px}
.dshv-diag-actions{display:flex;gap:10px;align-items:center;margin-top:6px}
.dshv-copy{border:0;background:none;padding:0;font:inherit;color:var(--dshv-accent);cursor:pointer}

@media (prefers-reduced-motion:reduce){
  .dshv-orb,.dshv-wave,.dshv-wave::before,.dshv-wave::after{animation:none!important}
  .dshv-node,.dshv-orb{transition-duration:.01ms!important}
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
        interruptHandler: null,
        recorder: null,
        sessionId: undefined,
        listeners: new Set(),
        options: {
          minSilenceMs: 900,
          maxUtteranceMs: 30000,
          // Tuned for a quiet talker: a soft voice reaches the microphone 20-30 dB
          // down, and the old values (-38 dBFS to start, a -40 dBFS gate) cut it
          // off entirely. The host VAD already rejects noise, so the client-side
          // gate can afford to sit far lower.
          rmsThreshold: 0.005,
          interruptThreshold: 0.035,
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
          const state = await api.state();
          setEngine({
            ready: state.ready === true,
            voices: state.voices ?? [],
            presets: state.presets ?? [],
            config: state.config ?? {},
          });
          if (state.error) setEngine({ error: state.error });
          return state;
        } catch (error) {
          setEngine({ ready: false, error: `语音服务不可用：${error.message ?? error}` });
          return null;
        }
      }

      /**
       * Kick off the model download and follow it to completion. The route
       * answers immediately so a multi-minute download never looks like a hung
       * request, which means progress has to be polled.
       */
      async function prepare() {
        setEngine({ error: null, preparing: true });
        try {
          await api.prepare();
        } catch (error) {
          setEngine({ preparing: false, error: `模型准备失败：${error.message ?? error}` });
          return;
        }
        const deadline = Date.now() + 60 * 60 * 1000;
        for (;;) {
          const state = await refreshState();
          const phase = state?.prepare ?? {};
          setEngine({
            prepare: phase,
            error: phase.error ? `模型准备失败：${phase.error}` : null,
          });
          if (!phase.running || Date.now() > deadline) break;
          await new Promise((resolve) => setTimeout(resolve, 1500));
        }
        setEngine({ preparing: false });
        await refreshState();
      }

      /** Stop playback and abandon the rest of the reply being spoken. */
      function interruptReply() {
        speaker.stop();
        engine.ttsController?.abort();
        engine.ttsController = null;
        setEngine({ speaking: false });
        engine.interruptHandler?.();
      }

      /** Deliver a recognized sentence through the session-scoped prompt API. */
      async function sendText(text) {
        const sessionId = engine.sessionId;
        if (sessionId === undefined) throw new Error('没有活动会话');
        const binding = ctx.sessions.binding(sessionId);
        const session = binding?.session;
        if (session === undefined) throw new Error('会话不可用');
        const running = session.getSnapshot?.()?.running === true;
        const mode = running && readFlag(STORAGE.interrupt, true) ? 'steer' : 'queue';
        const result = await session.prompt([{ type: 'text', text }], mode);
        if (result && result.ok === false) {
          throw new Error(result.error?.message ?? '发送失败');
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

      async function recognize(pcm) {
        engine.recorder?.setPaused(true);
        setEngine({ recognizing: true });
        try {
          const language = readString(STORAGE.language, '') || engine.config?.language || 'auto';
          const result = await api.stt(normalizeUtterance(pcm), language);
          const text = String(result.text ?? '').trim();
          if (text.length > 0) await sendText(text);
        } catch (error) {
          setEngine({ error: `识别失败：${error.message ?? error}` });
        } finally {
          setEngine({ recognizing: false });
          engine.recorder?.setPaused(false);
        }
      }

      async function startListening(sessionId) {
        if (engine.recorder?.active) return;
        if (sessionId !== undefined) engine.sessionId = sessionId;
        const recorder = new MicCapture({
          ...engine.options,
          onUtterance: (pcm) => void recognize(pcm),
          onBargeIn: () => interruptReply(),
          onSpeakingChange: (speaking) => setEngine({ listening: speaking ? 'speech' : 'open' }),
        });
        try {
          await recorder.start();
        } catch (error) {
          setEngine({ error: `无法打开麦克风：${error.message ?? error}` });
          return;
        }
        engine.recorder = recorder;
        setEngine({ listening: 'open', error: null });
      }

      function stopListening() {
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
        notify,
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
    const NODE_WIDTH = 48; // a bead plus its label box
    const NODE_HEIGHT = 68;
    const BEAD_GAP = 4; // minimum clearance between two beads

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

    /**
     * The area the bead is allowed to live in: the innermost scrolling or
     * clipping ancestor — in practice the conversation panel — so the bead can
     * never drift over the sidebar or be clipped by the transcript viewport.
     * Falls back to the whole window when nothing suitable encloses the seat.
     */
    function resolveBounds(element) {
      const fallback = viewportBounds();
      if (typeof window === 'undefined' || element === null || element === undefined) return fallback;
      let node = element.parentElement;
      while (node !== null && node !== document.body && node !== document.documentElement) {
        const style = window.getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        if (/(auto|scroll|hidden)/.test(style.overflowY) && rect.width >= 240 && rect.height >= 240) {
          return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
        }
        node = node.parentElement;
      }
      return fallback;
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

    function persistPosition(point, bounds, edge = null) {
      writeString(STORAGE.pos, JSON.stringify({
        fx: (point.x - bounds.x) / bounds.width,
        fy: (point.y - bounds.y) / bounds.height,
        edge,
      }));
    }

    function clampAlong(value, min, max) {
      return Math.min(Math.max(value, min), Math.max(min, max));
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
      if (nearest === 'left') return { x: bounds.x, y: clampAlong(point.y, minY, maxY), edge: 'left' };
      if (nearest === 'right') {
        return { x: bounds.x + bounds.width - ORB_SIZE, y: clampAlong(point.y, minY, maxY), edge: 'right' };
      }
      if (nearest === 'top') return { x: clampAlong(point.x, minX, maxX), y: bounds.y, edge: 'top' };
      return {
        x: clampAlong(point.x, minX, maxX),
        y: bounds.y + bounds.height - ORB_SIZE,
        edge: 'bottom',
      };
    }

    /** Stuck beads fan out in a line parallel to the edge they cling to. */
    function edgeLayout(attached, count) {
      const vertical = attached === 'left' || attached === 'right';
      const step = (vertical ? NODE_HEIGHT : NODE_WIDTH) + 6;
      const offsets = [];
      for (let index = 0; index < count; index += 1) {
        const along = (index - (count - 1) / 2) * step;
        offsets.push(vertical ? { tx: 0, ty: along } : { tx: along, ty: 0 });
      }
      return offsets;
    }

    /** Mirrors the base fan away from the edge the bead hugs, and flips it near the top. */
    function orientBeam(bead, position, bounds) {
      const centreX = position.x + ORB_SIZE / 2;
      const centreY = position.y + ORB_SIZE / 2;
      const mirrorX = centreX < bounds.x + bounds.width / 2 ? -1 : 1;
      const flipY = centreY < bounds.y + bounds.height * 0.42 ? -1 : 1;
      return { tx: bead.tx * mirrorX, ty: bead.ty * flipY };
    }

    /** Reflects one bead back inside — a bounce, not a clamp. */
    function reflectBeam(tx, ty, position, bounds) {
      const centreX = position.x + ORB_SIZE / 2;
      const centreY = position.y + ORB_SIZE / 2;
      const inner = { left: bounds.x + ORB_MARGIN, top: bounds.y + ORB_MARGIN };
      const outer = {
        right: bounds.x + bounds.width - ORB_MARGIN,
        bottom: bounds.y + bounds.height - ORB_MARGIN,
      };
      let nextX = tx;
      let nextY = ty;
      const left = centreX + tx - NODE_WIDTH;
      const right = centreX + tx;
      const top = centreY + ty - NODE_HEIGHT;
      const bottom = centreY + ty;
      if (left < inner.left) nextX += 2 * (inner.left - left);
      if (right > outer.right) nextX -= 2 * (right - outer.right);
      if (top < inner.top) nextY += 2 * (inner.top - top);
      if (bottom > outer.bottom) nextY -= 2 * (bottom - outer.bottom);
      return { tx: nextX, ty: nextY };
    }

    function fitBeam(bead, position, bounds = viewportBounds()) {
      const oriented = orientBeam(bead, position, bounds);
      return reflectBeam(oriented.tx, oriented.ty, position, bounds);
    }

    /**
     * Lays the fan out: fit every bead inside the bounds, then relax overlapping
     * pairs apart. Without the second pass a bead bounced off an edge can land
     * on top of its neighbour — the reflection moves beads toward each other.
     */
    function layoutFan(beads, position, bounds = viewportBounds(), attached = null) {
      // Stuck to an edge the beads line up alongside it; otherwise they arc away.
      const offsets = attached === null
        ? beads.map((bead) => fitBeam(bead, position, bounds))
        : edgeLayout(attached, beads.length)
          .map((offset) => reflectBeam(offset.tx, offset.ty, position, bounds));
      for (let pass = 0; pass < 16; pass += 1) {
        let moved = false;
        for (let a = 0; a < offsets.length; a += 1) {
          for (let b = a + 1; b < offsets.length; b += 1) {
            const dx = offsets[b].tx - offsets[a].tx;
            const dy = offsets[b].ty - offsets[a].ty;
            const overlapX = NODE_WIDTH + BEAD_GAP - Math.abs(dx);
            const overlapY = NODE_HEIGHT + BEAD_GAP - Math.abs(dy);
            if (overlapX <= 0 || overlapY <= 0) continue;
            moved = true;
            // Push apart along whichever axis needs the least movement.
            if (overlapX <= overlapY) {
              const push = (overlapX / 2 + 0.5) * (dx < 0 ? -1 : 1);
              offsets[a].tx -= push;
              offsets[b].tx += push;
            } else {
              const push = (overlapY / 2 + 0.5) * (dy < 0 ? -1 : 1);
              offsets[a].ty -= push;
              offsets[b].ty += push;
            }
          }
        }
        if (!moved) break;
        // Separation must not push anyone back outside.
        for (let index = 0; index < offsets.length; index += 1) {
          offsets[index] = reflectBeam(offsets[index].tx, offsets[index].ty, position, bounds);
        }
      }
      return offsets;
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
      if (engine.listening === 'speech') return { kind: 'live', text: t('listening'), action: 'stop' };
      if (engine.listening === 'open') return { kind: 'live', text: t('mic'), action: 'stop' };
      if (engine.recognizing) return { kind: 'busy', text: t('recognizing'), action: 'stop' };
      if (engine.speaking) return { kind: 'busy', text: t('thinking'), action: 'stop' };
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
      const { engine, speaker, subscribe, startListening, stopListening, refreshState, interruptReply, sessionId } = props;
      const t = props.t ?? ((key) => key);
      const [, force] = useState(0);
      const [panel, setPanel] = useState(false);
      const [open, setOpen] = useState(false);
      const [tick, setTick] = useState(0);
      const [position, setPosition] = useState(() => ({ ...defaultOrbPosition(), edge: null }));
      const [bounds, setBounds] = useState(() => viewportBounds());
      const [dragging, setDragging] = useState(false);
      const rootRef = useRef(null);
      const orbRef = useRef(null);
      const dragRef = useRef(null);
      const speakEnabled = readFlag(STORAGE.enabled, true);
      const interruptMode = readFlag(STORAGE.interrupt, true);

      useEffect(() => subscribe(() => force((value) => value + 1)), [subscribe]);
      useEffect(() => {
        if (sessionId !== undefined) engine.sessionId = sessionId;
      }, [engine, sessionId]);
      useEffect(() => {
        void refreshState();
      }, [refreshState]);

      const listening = engine.listening === 'open' || engine.listening === 'speech';
      // `notready` outranks the rest: with the models missing, the amber bead is
      // the only thing worth saying, whatever the microphone is doing.
      const state = engine.ready === false
        ? 'notready'
        : engine.recognizing
          ? 'recognizing'
          : listening
            ? 'listening'
            : engine.speaking
              ? 'speaking'
              : 'idle';

      // The outline is drawn by JS in three cases: while speaking (spoken audio),
      // while listening (the bead doubles as a level meter), and whenever it is
      // stuck to an edge — the droplet silhouette lives in the radius, so the CSS
      // swell must not own it. Everything else is left to CSS for free.
      const attached = position.edge;
      useEffect(() => {
        const root = rootRef.current;
        const orb = orbRef.current;
        if (orb === null) return undefined;
        const live = state === 'speaking' || state === 'listening' || attached !== null;
        if (!live) {
          orb.style.borderRadius = '';
          if (root !== null) root.style.setProperty('--dshv-lvl', '0');
          return undefined;
        }
        const started = performance.now();
        let frame = 0;
        const step = (now) => {
          frame = requestAnimationFrame(step);
          let level;
          if (state === 'speaking') {
            level = speaker?.level?.() ?? 0;
          } else if (state === 'listening') {
            // 0.045 RMS is a comfortable speaking level; the floor keeps the bead
            // breathing when the room goes quiet.
            const rms = engine.recorder?.level ?? 0;
            level = 0.18 + 0.82 * Math.min(1, rms / 0.045);
          } else {
            level = 0.12; // stuck and idle: a slow, shallow wetting wobble
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
      // again on every resize.
      useLayoutEffect(() => {
        const root = rootRef.current;
        if (root === null) return;
        const next = resolveBounds(root);
        setBounds(next);
        setPosition(readSavedPosition(next));
      }, []);

      // The bead is fixed-position, so its coordinates are written straight
      // through: a re-render mid-drag must not yank it back to the old spot.
      useLayoutEffect(() => {
        const root = rootRef.current;
        if (root === null) return;
        root.style.left = `${position.x}px`;
        root.style.top = `${position.y}px`;
      }, [position]);

      useEffect(() => {
        const onResize = () => {
          const root = rootRef.current;
          const next = root === null ? viewportBounds() : resolveBounds(root);
          setBounds(next);
          setPosition((current) => ({ ...clampPosition(current, next), edge: current.edge }));
        };
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
      }, []);

      // Tapping anything that is not part of this plugin folds the beads back
      // into the big bead. Escape does the same — but not while the panel is
      // open, where it belongs to whatever field has focus. The listener is
      // capturing so a host handler cannot swallow the key first.
      useEffect(() => {
        const onOutsideDown = (event) => {
          const root = rootRef.current;
          if (root !== null && root.contains(event.target)) return;
          if (open) setOpen(false);
        };
        const onKeyDown = (event) => {
          if (event.key !== 'Escape' || panel) return;
          const target = event.target;
          if (target && typeof target.closest === 'function' && target.closest('.dshv-panel')) return;
          setOpen(false);
        };
        document.addEventListener('pointerdown', onOutsideDown, true);
        document.addEventListener('keydown', onKeyDown, true);
        return () => {
          document.removeEventListener('pointerdown', onOutsideDown, true);
          document.removeEventListener('keydown', onKeyDown, true);
        };
      }, [open, panel]);

      const onPointerDown = (event) => {
        if (event.button !== 0) return;
        dragRef.current = {
          id: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          originX: position.x,
          originY: position.y,
          wasOpen: open,
          moved: false,
        };
        setOpen(false);
        // Grabbing the bead pulls it off the edge, so the sag goes away at once.
        setPosition((current) => ({ ...current, edge: null }));
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
        }
        const root = rootRef.current;
        if (root === null) return;
        const next = clampPosition({ x: drag.originX + dx, y: drag.originY + dy }, bounds);
        root.style.left = `${next.x}px`;
        root.style.top = `${next.y}px`;
      };

      const onPointerUp = (event) => {
        const drag = dragRef.current;
        if (drag === null || drag.id !== event.pointerId) return;
        dragRef.current = null;
        if (!drag.moved) {
          setOpen(!drag.wasOpen);
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
        const snapped = snapToEdge(released, bounds);
        // Null means it was dropped in open space: it stays exactly there and
        // keeps its round shape. Only a genuine collision sticks and sags.
        setPosition(snapped === null ? { ...released, edge: null } : snapped);
        persistPosition(snapped === null ? released : snapped, bounds, snapped?.edge ?? null);
      };

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
      // on the toolbar and now lives in the settings panel instead.
      const beads = [
        {
          key: 'mic',
          icon: 'mic',
          label: t('mic'),
          tx: -138,
          ty: -8,
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
          tx: -94,
          ty: -46,
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
          tx: -46,
          ty: -68,
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
          tx: 4,
          ty: -72,
          on: panel,
          tone: null,
          title: t('settings'),
          pressed: panel,
          onClick: () => setPanel((value) => !value),
        },
      ];

      // Edge-aware fan, relaxed so beads never overlap; while the bead is stuck
      // to an edge the beads line up parallel to that edge instead.
      const spread = layoutFan(beads, position, bounds, position.edge);

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
                onKeyDown: (event) => {
                  if (event.key !== 'Enter' && event.key !== ' ') return;
                  event.preventDefault();
                  setOpen((value) => !value);
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
                style: { '--tx': `${spread[index].tx}px`, '--ty': `${spread[index].ty}px` },
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
        // The one thing the bead cannot say by itself: with the models missing,
        // or a request failed, there is nothing to hear — so it gets a line
        // beside the bead that leads straight to the settings sheet.
        engine.ready === false
          ? h(Button, {
              style: { flex: 'none', color: 'var(--dshv-warn)' },
              onClick: () => setPanel(true),
            }, `⚠ ${t('notReady')}`)
          : null,
        engine.error !== null
          ? h('span', {
              style: {
                color: 'var(--dshv-record)',
                maxWidth: 280,
                marginLeft: 8,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              },
              title: engine.error,
            }, engine.error)
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
      const config = engine.config ?? {};
      const currentVoice = readString(STORAGE.voice, '') || config.voice || 'mimo_default';
      const progress = prepareView(engine.prepare);
      const place = fitPanel({ bounds: props.bounds ?? viewportBounds(), position: props.position });

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

      const voices = engine.voices ?? [];
      const presets = engine.presets ?? [];
      const language = readString(STORAGE.language, 'auto');
      const live = statusLine(engine, t);
      const readiness = engine.ready === true
        ? { tone: 'on', text: t('ready') }
        : engine.ready === false
          ? { tone: 'warn', text: config.vadNote ? `${t('notReady')} · ${config.vadNote}` : t('notReady') }
          : { tone: 'quiet', text: '…' };

      return h(
        'div',
        { className: 'dshv-backdrop', onClick: onClose, 'aria-hidden': 'true' },
        h(
          'div',
          {
            className: 'dshv-panel',
            'data-wide': String(engine.ready !== true),
            style: { ...styles.panel, top: place.y, left: place.x, width: 340 },
            role: 'dialog',
            'aria-label': t('settings'),
            'aria-modal': 'true',
            onClick: (event) => event.stopPropagation(),
          },
          // ── header: what it is, and whether it is usable
          h('div', { style: styles.head },
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
            ? h('div', { style: styles.row },
              h(Button, {
                disabled: busy !== null,
                style: { ...styles.chip, width: 'auto', flex: 1 },
                onClick: () => void withBusy('准备模型', prepare),
              }, busy === '准备模型' ? t('preparing') : t('prepare')))
            : null,

          // ── voice: pick one, audition it, delete it
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
            voices.map((voice) => h('div', { key: voice.name, className: 'dshv-voicerow' },
              h('span', {
                style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                title: voice.refText || voice.name,
              }, voice.name),
              h('span', { style: styles.note }, `${Math.round(voice.bytes / 1024)} KB`),
              h('audio', { src: client.sampleUrl(voice.name), controls: true }),
              h(Button, {
                style: styles.knob,
                onClick: () => void withBusy('删除音色', async () => {
                  await client.deleteVoice(voice.name);
                  await refreshState();
                }),
              }, t('remove'))))),

          // ── add a clone: collapsed to one line until it is wanted
          h('details', { style: styles.section },
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
              placeholder: t('refText'),
              value: refText,
              onChange: (event) => setRefText(event.target.value),
            })),
            h('div', { style: styles.row },
              h(Button, { disabled: busy !== null, onClick: upload }, t('create')))),

          // ── credentials + language
          h('div', { style: styles.section },
            h('div', { style: styles.sectionHead },
              h('span', null, t('apiKey')),
              h('span', { style: styles.note },
                config.hasKey === true ? (config.keySource === 'env' ? 'env' : 'saved') : '—')),
            h('div', { style: styles.row },
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
            h('div', { style: styles.row },
              h('span', { style: styles.label }, t('languageLabel')),
              h('select', {
                style: { ...styles.field, flex: 1 },
                value: language,
                onChange: (event) => {
                  writeString(STORAGE.language, event.target.value);
                  setEngine({ config: { ...engine.config, language: event.target.value } });
                  force((value) => value + 1);
                },
              },
                ['auto', 'zh', 'en', 'yue', 'ja', 'ko'].map((code) =>
                  h('option', { key: code, value: code }, t(`lang_${code}`)))))),

          // ── the numbers behind a bug report, folded away by default
          h('details', { className: 'dshv-diag' },
            h('summary', null, t('diag')),
            h('div', { className: 'dshv-kv' }, h('span', null, t('sttBackend')),
              h('span', null, `${config.sttBackend ?? '—'} · ${config.precision ?? '—'}`)),
            h('div', { className: 'dshv-kv' }, h('span', null, t('vadBackend')),
              h('span', null, config.vadBackendEffective ?? config.vadBackend ?? '—')),
            h('div', { className: 'dshv-kv' }, h('span', null, t('provider')),
              h('span', null, config.provider ?? '—')),
            config.vadNote
              ? h('div', { style: styles.note }, config.vadNote)
              : null,
            h('div', { style: styles.note }, config.dataRoot ?? '—'),
            h('div', { className: 'dshv-diag-actions' },
              h('button', { type: 'button', className: 'dshv-copy', onClick: copyDiagnostics }, t('copyDiag')),
              note !== null ? h('span', { style: styles.note }, note) : null)),

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
      const skipRef = useRef(0);
      const interruptedRef = useRef(false);
      const [, force] = useState(0);

      useEffect(() => subscribe(() => force((value) => value + 1)), [subscribe]);

      // The microphone's barge-in path asks this listener to abandon the reply
      // currently being spoken.
      useEffect(() => {
        engine.interruptHandler = () => {
          interruptedRef.current = true;
        };
        return () => {
          engine.interruptHandler = null;
        };
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
        // opened. The baseline freezes on the first settled reply.
        if (baselineRef.current === null) {
          if (hasSettled && maxAnchor > 0) {
            baselineRef.current = maxAnchor;
            skipRef.current = maxAnchor;
          }
          return;
        }
        if (interruptedRef.current) {
          interruptedRef.current = false;
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
          const { sentences, partial } = splitSentences(text);
          const speakable = data.status === 'settled' && partial !== null ? [...sentences, partial] : sentences;
          const spoken = spokenRef.current.get(node.key) ?? 0;
          if (speakable.length > spoken) {
            for (let index = spoken; index < speakable.length; index++) {
              jobs.push({ anchor, key: node.key, index, sentence: speakable[index] });
            }
            spokenRef.current.set(node.key, speakable.length);
          }
        }
        if (jobs.length === 0) return;
        jobs.sort((a, b) => a.anchor - b.anchor || a.index - b.index);
        const voice = readString(STORAGE.voice, '') || engine.config?.voice || '';
        chainRef.current = jobs.reduce(
          (chain, job) =>
            chain.then(async () => {
              if (interruptedRef.current || !readFlag(STORAGE.enabled, true)) return;
              const controller = new AbortController();
              engine.ttsController = controller;
              try {
                const audio = await client.tts(job.sentence, voice, controller.signal);
                if (interruptedRef.current) return;
                speaker.enqueue(audio);
              } catch (error) {
                if (error?.name !== 'AbortError') {
                  console.error('[voice-chat] TTS failed:', error);
                  setEngine({ error: `朗读失败：${error.message ?? error}` });
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
        cleanReplyText,
        chatNodes,
        viewportBounds,
        clampPosition,
        snapToEdge,
        fitBeam,
        layoutFan,
        waveRadius,
      },
    };
  },
});
