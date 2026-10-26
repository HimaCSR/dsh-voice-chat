/**
 * Dependency audit and installation.
 *
 * Two kinds of native module matter to this plugin, and they are supplied in
 * different ways:
 *
 *   • `onnxruntime-node` is declared by the plugin itself. It powers the
 *     FireRedVAD endpoint detector, and the plugin degrades to a different
 *     detector when it is missing — so it is an optional enhancement, not a
 *     requirement. Because the plugin is installed with `link:`, pnpm does
 *     not install the dependencies of a linked package, which is exactly why
 *     this module can install it.
 *   • `sherpa-onnx-node` is shipped by the DSH installation and resolved
 *     through the anchor list. It is reported for information only: the
 *     plugin does not own it and must not try to install it.
 *
 * Installation runs pnpm directly. The DSH plugin manager cannot be used for
 * this: its `installBundle` requires the package to declare a `dsh.bundle`
 * and rolls the profile files back when it does not, which a plain
 * dependency never does.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeModule } from './sherpa.js';
import { log, warn } from './util.js';

/** The dependency the plugin declares for itself. */
export const PLUGIN_DEPENDENCIES = ['onnxruntime-node'];

/** The modules the runtime needs but the DSH installation supplies. */
export const DSH_SUPPLIED_MODULES = ['sherpa-onnx-node'];

/** How long an installation may run before it is given up on. */
export const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Where a bundled pnpm may live.
 *
 * The harness ships its own pnpm rather than relying on one on PATH, so the
 * lookup walks the runtime directories it uses. The layout has moved twice
 * already — the runtime directory gained a `primary-runtime` level and the
 * script is now called `pnpm.mjs` next to the older `pnpm.cjs` — so every
 * shape that has been observed is tried, and both script names are accepted.
 * @param env - the process environment.
 * @returns the candidate paths, most likely first.
 */
export function pnpmCandidates(env = process.env) {
  const candidates = [];
  const home = env.DSH_HOME;
  if (typeof home === 'string' && home.length > 0) {
    candidates.push(path.join(home, 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.cjs'));
    candidates.push(path.join(home, 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.mjs'));
  }
  if (typeof process.resourcesPath === 'string' && process.resourcesPath.length > 0) {
    const roots = [
      path.join(process.resourcesPath, 'runtime'),
      path.join(process.resourcesPath, 'app.asar.unpacked', 'runtime'),
    ];
    for (const root of roots) {
      // The current layout: <root>/primary-runtime/dependencies/pnpm/bin.
      candidates.push(path.join(root, 'primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.cjs'));
      candidates.push(path.join(root, 'primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.mjs'));
      // The layout that came before it.
      candidates.push(path.join(root, 'pnpm', 'bin', 'pnpm.cjs'));
      candidates.push(path.join(root, 'pnpm', 'bin', 'pnpm.mjs'));
    }
  }
  return candidates;
}

/**
 * Find a usable pnpm runtime.
 * @returns the path to `pnpm.cjs`, or null when none is present.
 */
export async function findPnpm(env = process.env) {
  for (const candidate of pnpmCandidates(env)) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

/**
 * Parse a version string into its numeric parts.
 * @param value - a version such as `1.30.0`.
 */
export function parseVersion(value) {
  const text = String(value ?? '').trim().replace(/^v/i, '');
  const [core] = text.split('-');
  const parts = core.split('.').map((piece) => Number.parseInt(piece, 10));
  return parts.map((piece) => (Number.isFinite(piece) ? piece : 0));
}

/**
 * Compare two versions.
 * @returns a negative number when `a` is older, 0 when equal, positive when newer.
 */
export function compareVersionParts(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * Test whether a version satisfies a range.
 *
 * The ranges used by this plugin are simple: an exact version, a caret, a
 * tilde, or a `>=` bound. A range that cannot be understood is treated as
 * satisfied, so an unusual manifest never produces a false alarm.
 * @param version - the installed version.
 * @param range - the declared range.
 */
export function satisfiesRange(version, range) {
  const text = String(range ?? '').trim();
  if (text === '' || text === '*' || text === 'latest') return true;
  // A range with alternatives is checked part by part, and it has to come
  // before the single-range cases: `^1.0.0 || ^2.0.0` would otherwise be
  // read as a caret range and mis-parsed.
  if (text.includes('||')) {
    return text.split('||').some((part) => satisfiesRange(version, part.trim()));
  }
  if (text.startsWith('^')) {
    const bound = parseVersion(text.slice(1));
    const current = parseVersion(version);
    if (compareVersionParts(version, text.slice(1)) < 0) return false;
    // A caret allows changes that do not modify the left-most non-zero digit.
    for (let index = 0; index < bound.length; index++) {
      if (bound[index] === 0) continue;
      return (current[index] ?? 0) === bound[index];
    }
    return true;
  }
  if (text.startsWith('~')) {
    if (compareVersionParts(version, text.slice(1)) < 0) return false;
    const bound = parseVersion(text.slice(1));
    const current = parseVersion(version);
    return (current[0] ?? 0) === (bound[0] ?? 0) && (current[1] ?? 0) === (bound[1] ?? 0);
  }
  if (text.startsWith('>=')) {
    return compareVersionParts(version, text.slice(2).trim()) >= 0;
  }
  if (text.startsWith('>')) {
    return compareVersionParts(version, text.slice(1).trim()) > 0;
  }
  if (text.startsWith('<=')) {
    return compareVersionParts(version, text.slice(2).trim()) <= 0;
  }
  if (text.startsWith('<')) {
    return compareVersionParts(version, text.slice(1).trim()) < 0;
  }
  // An exact version is the only remaining shape this understands. Anything
  // else — a compound range, a tag — is taken as satisfied, so an unusual
  // manifest never produces a false alarm.
  if (!/^\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z.-]+)?$/.test(text)) return true;
  return compareVersionParts(version, text) === 0;
}

/**
 * Read the installed version of a module.
 *
 * The module is located but never loaded: loading a native addon pins its
 * DLL into the process, which would make the audit report a version the
 * running process cannot actually use.
 * @param resolved - the absolute path of the module's entry point.
 */
async function installedVersion(resolved) {
  if (!resolved) return null;
  try {
    let directory = path.dirname(resolved);
    for (let depth = 0; depth < 4; depth++) {
      const manifest = path.join(directory, 'package.json');
      try {
        const raw = await fs.readFile(manifest, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed.version === 'string') return parsed.version;
      } catch {
        // Keep walking up.
      }
      const parent = path.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  } catch {
    // No version to report.
  }
  return null;
}

/**
 * Audit one module.
 * @param name - the module name.
 * @param kind - `'plugin'` or `'dsh'`.
 * @param required - the declared range, for a plugin dependency.
 */
export async function auditModule(name, kind, required = null) {
  const probe = probeModule(name);
  const resolved = probe.resolved ? probe.resolved : null;
  const version = await installedVersion(resolved);
  let status = 'ok';
  let reason = null;
  if (!probe.resolved) {
    status = 'missing';
    reason = kind === 'plugin' ? '未安装（可选增强）' : '未找到';
  } else if (required && version && !satisfiesRange(version, required)) {
    status = 'mismatch';
    reason = `版本 ${version} 不满足 ${required}`;
  }
  return {
    name,
    kind,
    required,
    version,
    resolved,
    resolvedFrom: probe.resolvedFrom ?? null,
    attempts: probe.attempts ?? [],
    status,
    reason,
  };
}

/**
 * Audit every module the plugin cares about.
 * @param manifest - the plugin's `package.json` contents.
 */
export async function auditDependencies(manifest) {
  const declared = manifest?.dependencies ?? {};
  const entries = [];
  for (const name of PLUGIN_DEPENDENCIES) {
    entries.push(await auditModule(name, 'plugin', declared[name] ?? null));
  }
  for (const name of DSH_SUPPLIED_MODULES) {
    entries.push(await auditModule(name, 'dsh', null));
  }
  return entries;
}

/**
 * Read the plugin's own manifest.
 */
export async function readManifest() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const raw = await fs.readFile(path.join(here, '..', 'package.json'), 'utf8');
  return JSON.parse(raw);
}

/**
 * Install one dependency into the DSH profile.
 *
 * The dependency must land in the profile's own `node_modules`: the plugin is
 * linked, and installing into the linked directory would leave the profile
 * unable to resolve it. The install runs in the background and reports its
 * output through the returned state object.
 *
 * The package's own install scripts are not run: the dependencies here are
 * prebuilt binaries, and a script would run with the Host's privileges.
 * @param options - `{ name, range, profileDir, onState, packageManager, signal }`.
 * @returns the initial state of the install.
 */
export function installDependency(options) {
  const { name, range, profileDir, onState, packageManager = null, signal = null } = options;
  const state = {
    running: true,
    name,
    range,
    phase: 'starting',
    output: [],
    error: null,
    finishedAt: null,
  };
  const publish = (patch) => {
    Object.assign(state, patch);
    if (typeof onState === 'function') onState({ ...state });
  };
  const append = (line) => {
    const text = String(line ?? '').trimEnd();
    if (text === '') return;
    state.output.push(text);
    if (state.output.length > 200) state.output.shift();
    if (typeof onState === 'function') onState({ ...state });
  };
  void (async () => {
    let child = null;
    try {
      if (typeof profileDir !== 'string' || profileDir === '') {
        throw new Error('找不到 DSH profile 目录');
      }
      // The harness knows which package manager it ships with; that is the
      // one to use, since the paths below are only a guess at its layout.
      let command = null;
      let args = [];
      let extraEnv = {};
      if (packageManager && typeof packageManager.command === 'string' && packageManager.command !== '') {
        command = packageManager.command;
        args = Array.isArray(packageManager.args) ? [...packageManager.args] : [];
        extraEnv = packageManager.env && typeof packageManager.env === 'object' ? packageManager.env : {};
      } else {
        const pnpm = await findPnpm();
        if (!pnpm) {
          throw new Error('找不到 pnpm 运行时；请手动执行：dsh plugin --profile desktop add ' + `${name}@${range}`);
        }
        command = process.execPath;
        args = [pnpm];
        extraEnv = { ELECTRON_RUN_AS_NODE: '1' };
      }
      publish({ phase: 'installing' });
      log(`installing ${name}@${range} into ${profileDir}`);
      const spec = range ? `${name}@${range}` : name;
      child = spawn(command, [...args, 'add', '--ignore-scripts', spec], {
        cwd: profileDir,
        env: { ...process.env, ...extraEnv },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout.on('data', (chunk) => String(chunk).split('\n').forEach(append));
      child.stderr.on('data', (chunk) => String(chunk).split('\n').forEach(append));
      // A network stall must not keep the installation running forever: the
      // guard that refuses a second install would then never lift.
      const timer = setTimeout(() => {
        publish({ error: '安装超时' });
        try {
          child.kill();
        } catch {
          // The process may already be gone.
        }
      }, INSTALL_TIMEOUT_MS);
      const outcome = await new Promise((resolve) => {
        child.on('error', (error) => resolve({ code: -1, reason: error.message }));
        child.on('close', (value) => resolve({ code: value, reason: null }));
      });
      clearTimeout(timer);
      if (outcome.reason) {
        // The reason the process could not run is more useful than its exit
        // code, so it is reported instead of being overwritten.
        throw new Error(outcome.reason);
      }
      if (outcome.code !== 0) {
        throw new Error(`安装失败（退出码 ${outcome.code}）`);
      }
      publish({ running: false, phase: 'done', finishedAt: Date.now() });
      log(`installed ${spec}`);
    } catch (error) {
      warn(`dependency install failed: ${error?.message ?? error}`);
      publish({ running: false, phase: 'failed', error: String(error?.message ?? error), finishedAt: Date.now() });
    } finally {
      if (child && signal?.aborted) {
        try {
          child.kill();
        } catch {
          // Nothing to do.
        }
      }
    }
  })();
  return { ...state };
}
