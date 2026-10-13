/**
 * Local speech-asset manifest and downloader.
 *
 * Every file the local recognizer and the VAD need is declared here with a
 * pinned size and SHA-256. Preparation is idempotent: a complete, verified
 * file is reused, a missing or mismatched one is fetched again, and a partial
 * download never becomes a candidate.
 *
 * The SenseVoiceSmall entries mirror the pinned revision DSH itself ships for
 * its built-in SenseVoice provider, so an already populated cache is
 * interchangeable with ours.
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import { downloadToFile, expandPath, fileSize, isFile, log, sha256File, warn } from './util.js';

/** SentencePiece vocabulary shared by both SenseVoice precisions. */
const TOKENS = {
  name: 'tokens.txt',
  urls: ['https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/2365baeacb507f821a0c8120fcee3d484dba7a07/tokens.txt'],
  bytes: 315894,
  sha256: 'f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc',
};

/** Pinned downloads for one SenseVoice precision plus each VAD backend. */
export const ASSETS = {
  sensevoice: {
    int8: {
      name: 'sensevoice.int8.onnx',
      urls: ['https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/2365baeacb507f821a0c8120fcee3d484dba7a07/model.int8.onnx'],
      bytes: 239233841,
      sha256: 'c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51',
    },
    fp32: {
      name: 'sensevoice.onnx',
      urls: ['https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/2365baeacb507f821a0c8120fcee3d484dba7a07/model.onnx'],
      bytes: 937617178,
      sha256: '977016bd9c79f9eb343430b5cc305e07ab64d5212dff41b0dcfa1694bee9a8cb',
    },
    tokens: TOKENS,
  },
  vad: {
    // FireRedVAD: the official ONNX export from the FireRedTeam repository.
    // The graph is self-contained except for its Kaldi CMVN sidecar.
    firered: {
      model: {
        name: 'fireredvad_stream_vad_with_cache.onnx',
        urls: [
          'https://raw.githubusercontent.com/FireRedTeam/FireRedVAD/main/pretrained_models/onnx_models/fireredvad_stream_vad_with_cache.onnx',
          'https://gh-proxy.com/https://raw.githubusercontent.com/FireRedTeam/FireRedVAD/main/pretrained_models/onnx_models/fireredvad_stream_vad_with_cache.onnx',
        ],
        bytes: 2306042,
        sha256: null,
      },
      cmvn: {
        name: 'cmvn.ark',
        urls: [
          'https://raw.githubusercontent.com/FireRedTeam/FireRedVAD/main/pretrained_models/onnx_models/cmvn.ark',
          'https://gh-proxy.com/https://raw.githubusercontent.com/FireRedTeam/FireRedVAD/main/pretrained_models/onnx_models/cmvn.ark',
        ],
        bytes: 1311,
        sha256: null,
      },
    },
    ten: {
      model: {
        name: 'ten-vad.onnx',
        urls: [
          'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/ten-vad.onnx',
          'https://gh-proxy.com/https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/ten-vad.onnx',
        ],
        bytes: -1,
        sha256: null,
      },
    },
    silero: {
      model: {
        name: 'silero_vad.onnx',
        urls: [
          'https://huggingface.co/csukuangfj/vad/resolve/fba88cd2e921609e7675c3aaf51e0b9b295da4bc/silero_vad.onnx',
        ],
        bytes: 1807522,
        sha256: 'a35ebf52fd3ce5f1469b2a36158dba761bc47b973ea3382b3186ca15b1f5af28',
      },
    },
  },
};

/** Expand one Hugging Face URL into its mirror counterpart. */
function withMirror(url) {
  if (url.includes('huggingface.co') && !url.includes('hf-mirror.com')) {
    return [url, url.replace('huggingface.co', 'hf-mirror.com')];
  }
  return [url];
}

/**
 * Materialize one asset on disk, verifying size (when pinned) and SHA-256
 * (when pinned). Verification failures fall through to the next mirror.
 * @param asset - manifest entry.
 * @param destination - absolute target path.
 * @param options - `{ signal, force, onProgress }`.
 * @returns the verified absolute path.
 */
export async function ensureAsset(asset, destination, options = {}) {
  const { signal, force = false, onProgress } = options;
  const size = await fileSize(destination);
  if (!force && size >= 0 && (asset.bytes < 0 || size === asset.bytes) && (await isFile(destination))) {
    if (asset.sha256) {
      const digest = await sha256File(destination);
      if (digest === asset.sha256) return destination;
      warn(`cached ${asset.name} failed SHA-256; re-downloading`);
    } else if (asset.bytes >= 0) {
      return destination;
    }
  }
  const urls = asset.urls.flatMap(withMirror);
  let lastError = null;
  for (const url of urls) {
    try {
      log(`downloading ${asset.name} from ${new URL(url).host}`);
      const received = await downloadToFile(url, destination, {
        expectedBytes: asset.bytes,
        signal,
        onProgress,
      });
      if (asset.sha256) {
        const digest = await sha256File(destination);
        if (digest !== asset.sha256) throw new Error(`SHA-256 mismatch (${digest})`);
      }
      log(`${asset.name} ready (${received} bytes)`);
      return destination;
    } catch (error) {
      lastError = error;
      warn(`${asset.name} from ${url} failed: ${error.message}`);
    }
  }
  throw lastError ?? new Error(`no download source for ${asset.name}`);
}

/** Resolved absolute paths for every asset, plus what is still missing. */
export async function resolveAssets(config) {
  const dataRoot = expandPath(config.dataRoot);
  const modelDir = config.stt?.modelDirectory ? expandPath(config.stt.modelDirectory) : path.join(dataRoot, 'models');
  const vadDir = path.join(dataRoot, 'vad');
  const precision = config.stt?.precision === 'fp32' ? 'fp32' : 'int8';
  const modelDirOwned = !config.stt?.modelDirectory;
  const sense = ASSETS.sensevoice[precision];
  const tokens = ASSETS.sensevoice.tokens;
  const model = modelDirOwned ? path.join(modelDir, sense.name) : path.join(modelDir, 'model.int8.onnx');
  const tokensPath = modelDirOwned ? path.join(modelDir, tokens.name) : path.join(modelDir, 'tokens.txt');
  return {
    dataRoot,
    modelDir,
    modelDirOwned,
    vadDir,
    precision,
    model,
    tokens: tokensPath,
    sense,
    tokensAsset: tokens,
    vad: vadPaths(config, vadDir),
  };
}

/** Absolute paths of the configured VAD backend's files. */
export function vadPaths(config, vadDir) {
  const backend = config.stt?.vadBackend ?? 'firered';
  if (backend === 'firered') {
    const dir = config.stt?.fireRedDirectory ? expandPath(config.stt.fireRedDirectory) : path.join(vadDir, 'firered');
    return {
      backend: 'firered',
      dir,
      model: path.join(dir, ASSETS.vad.firered.model.name),
      cmvn: path.join(dir, ASSETS.vad.firered.cmvn.name),
    };
  }
  const asset = ASSETS.vad[backend] ?? ASSETS.vad.silero;
  const model = config.stt?.vadModelPath ? expandPath(config.stt.vadModelPath) : path.join(vadDir, asset.model.name);
  return { backend: backend in ASSETS.vad ? backend : 'silero', dir: vadDir, model, asset: asset.model };
}

/**
 * Report which declared files are present and verified, without downloading.
 * @param config - plugin configuration.
 * @param options - `{ verify: boolean }` to also hash large files.
 */
export async function inspectAssets(config, options = {}) {
  const resolved = await resolveAssets(config);
  const check = async (file, asset) => {
    const size = await fileSize(file);
    const present = size >= 0;
    let verified = present && (asset?.bytes === undefined || asset.bytes < 0 || size === asset.bytes);
    if (present && verified && options.verify && asset?.sha256) {
      verified = (await sha256File(file)) === asset.sha256;
    }
    return { path: file, present, verified, size, expected: asset?.bytes ?? -1 };
  };
  const model = await check(resolved.model, resolved.sense);
  const tokens = await check(resolved.tokens, resolved.tokensAsset);
  const vad =
    resolved.vad.backend === 'firered'
      ? {
          backend: 'firered',
          model: await check(resolved.vad.model, ASSETS.vad.firered.model),
          cmvn: await check(resolved.vad.cmvn, ASSETS.vad.firered.cmvn),
        }
      : { backend: resolved.vad.backend, model: await check(resolved.vad.model, resolved.vad.asset) };
  const ready =
    model.present && tokens.present && vad.model.present && (vad.backend !== 'firered' || vad.cmvn.present);
  return { dataRoot: resolved.dataRoot, precision: resolved.precision, model, tokens, vad, ready };
}

/**
 * Download every missing or invalid asset.
 * @param config - plugin configuration.
 * @param options - `{ signal, force, onProgress }`.
 */
export async function prepareAssets(config, options = {}) {
  const resolved = await resolveAssets(config);
  await fs.mkdir(resolved.modelDir, { recursive: true });
  await fs.mkdir(resolved.vadDir, { recursive: true });
  if (resolved.modelDirOwned) {
    await ensureAsset(resolved.sense, resolved.model, options);
    await ensureAsset(resolved.tokensAsset, resolved.tokens, options);
  } else {
    for (const [file, label] of [[resolved.model, 'model'], [resolved.tokens, 'tokens']]) {
      if (!(await isFile(file))) throw new Error(`configured ${label} file is missing: ${file}`);
    }
  }
  if (resolved.vad.backend === 'firered') {
    await ensureAsset(ASSETS.vad.firered.model, resolved.vad.model, options);
    await ensureAsset(ASSETS.vad.firered.cmvn, resolved.vad.cmvn, options);
  } else if (!config.stt?.vadModelPath) {
    await ensureAsset(resolved.vad.asset, resolved.vad.model, options);
  } else if (!(await isFile(resolved.vad.model))) {
    throw new Error(`configured VAD model is missing: ${resolved.vad.model}`);
  }
  // Also fetch the sherpa-onnx fallbacks (a few megabytes together). They are
  // only used when FireRedVAD cannot start, but a fallback that has to download
  // first is useless: sherpa's C++ layer calls exit(-1) on a missing VAD file,
  // which kills the recognizer process instead of degrading.
  for (const backend of ['ten', 'silero']) {
    if (resolved.vad.backend === backend || config.stt?.vadModelPath) continue;
    const asset = ASSETS.vad[backend].model;
    try {
      await ensureAsset(asset, path.join(resolved.vadDir, asset.name), { ...options, force: false });
    } catch (error) {
      warn(`${backend} fallback model unavailable: ${error.message}`);
    }
  }
  return inspectAssets(config);
}
