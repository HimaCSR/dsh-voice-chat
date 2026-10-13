/**
 * Resolve native/optional Node modules that may live either beside this plugin
 * (a profile install puts the plugin's own dependencies in the profile's
 * `node_modules`) or inside the DSH installation.
 *
 * Node resolves relative to the requiring file, and a profile-installed bundle
 * sits outside the harness's `node_modules`, so a plain `require` from here
 * finds only the plugin's own dependencies. The DSH anchor covers everything
 * the harness already ships — `sherpa-onnx-node` and its ONNX Runtime shared
 * library in particular — which is why the plugin does not have to ship a
 * second copy of a large runtime.
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const cache = new Map();

/**
 * Anchors supplied by the caller at runtime.
 *
 * A profile install links the bundle into the profile's `node_modules` while
 * the plugin's real files stay wherever the user keeps them. Node resolves from
 * the *real* path, so it walks up the user's directory tree and never enters
 * the profile — a dependency installed next to the bundle is therefore
 * invisible to a plain `require`. The Host half reads the profile directory
 * from DSH's own `profileContext` service and passes it here, which is more
 * reliable than guessing from the environment.
 */
let suppliedAnchors = [];

/**
 * Register resolution roots discovered at activation time.
 * @param dirs - absolute directories whose `package.json` roots a lookup.
 */
export function setModuleAnchors(dirs) {
  suppliedAnchors = (dirs ?? []).filter((dir) => typeof dir === 'string' && dir.length > 0);
  cache.clear();
}

/** Anchor files used as resolution roots, most specific first. */
function anchors() {
  const list = [];
  for (const dir of suppliedAnchors) list.push(path.join(dir, 'package.json'));
  if (process.env.DSH_PROFILE_DIR) {
    list.push(path.join(process.env.DSH_PROFILE_DIR, 'package.json'));
  }
  // DSH keeps a shared `profiles/node_modules` that every profile module sees
  // as an ordinary ancestor; the same directory is a useful fallback here.
  if (process.env.DSH_HOME) {
    list.push(path.join(process.env.DSH_HOME, 'profiles', 'node_modules', '..', 'package.json'));
  }
  if (process.resourcesPath) {
    list.push(path.join(process.resourcesPath, 'app.asar', 'dsh', 'package.json'));
    list.push(path.join(process.resourcesPath, 'app', 'dsh', 'package.json'));
    list.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'dsh', 'package.json'));
  }
  if (process.env.DSH_VOICE_MODULE_DIR) {
    list.push(path.join(process.env.DSH_VOICE_MODULE_DIR, 'package.json'));
  }
  return list;
}

/**
 * Require a module from the plugin's own dependencies first, then from the DSH
 * installation.
 * @param name - module specifier.
 * @returns the loaded module.
 * @throws with every attempted anchor listed when nothing resolves.
 */
export function loadModule(name) {
  if (cache.has(name)) return cache.get(name).module;
  const attempts = [];
  /** One diagnostic line per attempt, keeping the error code and cause. */
  const describe = (where, error) => {
    const head = String(error?.message ?? error).split('\n')[0];
    const code = error?.code ? ` [${error.code}]` : '';
    const cause = error?.cause?.message ? ` (cause: ${String(error.cause.message).split('\n')[0]})` : '';
    return `${where}: ${head}${code}${cause}`;
  };
  try {
    const module = createRequire(import.meta.url)(name);
    cache.set(name, { module, from: 'plugin dependency' });
    return module;
  } catch (error) {
    attempts.push(describe('plugin dependency', error));
  }
  for (const anchor of anchors()) {
    try {
      if (!fs.existsSync(anchor)) continue;
      const module = createRequire(anchor)(name);
      cache.set(name, { module, from: anchor });
      return module;
    } catch (error) {
      attempts.push(describe(anchor, error));
    }
  }
  const error = new Error(`${name} is not available.\n${attempts.join('\n')}`);
  error.code = 'no-module';
  throw error;
}

/** Where the last successful load of `name` came from, or null. */
export function moduleOrigin(name) {
  return cache.get(name)?.from ?? null;
}

/**
 * Resolve a module without executing it, and report every attempt.
 *
 * This is what `/dsh-voice/diag` serves. It deliberately uses `require.resolve`
 * rather than `require`: loading a native addon has side effects that would
 * corrupt the very answer being sought — resolving `sherpa-onnx-node` loads its
 * `onnxruntime.dll`, after which `onnxruntime-node` can no longer load in that
 * process, so a healthy install would be reported as broken.
 * @param name - module specifier.
 */
export function probeModule(name) {
  const attempts = [];
  const tryFrom = (where, anchor) => {
    try {
      const resolved = createRequire(anchor).resolve(name);
      attempts.push({ where, ok: true, resolved });
      return resolved;
    } catch (error) {
      attempts.push({
        where,
        ok: false,
        code: error?.code ?? null,
        message: String(error?.message ?? error).split('\n')[0],
      });
      return null;
    }
  };
  const direct = tryFrom('plugin dependency', import.meta.url);
  if (direct !== null) return { name, resolvedFrom: 'plugin dependency', resolved: direct, attempts };
  for (const anchor of anchors()) {
    if (!fs.existsSync(anchor)) {
      attempts.push({ where: anchor, ok: false, code: null, message: 'anchor does not exist' });
      continue;
    }
    const resolved = tryFrom(anchor, anchor);
    if (resolved !== null) return { name, resolvedFrom: anchor, resolved, attempts };
  }
  return { name, resolvedFrom: null, resolved: null, attempts };
}

/** The anchors this process would consult, in order (diagnostics). */
export function anchorList() {
  return [...anchors()];
}

/** The sherpa-onnx Node binding. */
export function loadSherpa() {
  return loadModule('sherpa-onnx-node');
}

/** Which anchor satisfied the sherpa-onnx load (diagnostics only). */
export function sherpaOrigin() {
  return moduleOrigin('sherpa-onnx-node');
}
