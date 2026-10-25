/**
 * Version reporting and update checking.
 *
 * There is no update server. The plugin asks GitHub's public Releases API
 * for the newest release of this repository, and falls back to a mirror when
 * GitHub is unreachable from the network. Both were verified to answer without
 * an API key, so a user never has to run anything of their own.
 *
 * The anonymous GitHub API allows 60 requests per hour per address, so the
 * answer is cached and every request carries a timeout.
 */
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The repository the releases are published from. */
export const RELEASE_REPO = 'HimaCSR/dsh-voice-chat';

/** Where the release list is fetched from, in order of preference. */
const DEFAULT_SOURCES = [
  `https://api.github.com/repos/${RELEASE_REPO}/releases/latest`,
  `https://gh-proxy.com/https://api.github.com/repos/${RELEASE_REPO}/releases/latest`,
];

/** How long a successful lookup stays fresh. */
const CACHE_TTL_MS = 60 * 60 * 1000;

/** How long a single request may take. */
const REQUEST_TIMEOUT_MS = 10000;

/**
 * Read the plugin's own version.
 *
 * `createRequire` is tried first because it survives a bundled layout where
 * the package directory is not on disk under its own name; the file read is
 * the fallback for a linked checkout.
 * @returns the version string, or null when it cannot be determined.
 */
export async function readPluginVersion() {
  try {
    const require = createRequire(import.meta.url);
    const manifest = require('../package.json');
    if (manifest && typeof manifest.version === 'string') return manifest.version;
  } catch {
    // Fall through to the file read below.
  }
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const raw = await fs.readFile(path.join(here, '..', 'package.json'), 'utf8');
    const manifest = JSON.parse(raw);
    if (manifest && typeof manifest.version === 'string') return manifest.version;
  } catch {
    // Nothing else to try.
  }
  return null;
}

/**
 * Compare two dotted version strings.
 *
 * A leading `v` is ignored, missing components count as zero, and a
 * pre-release suffix sorts before the same release without one.
 * @returns a negative number when `a` is older, 0 when equal, positive when newer.
 */
export function compareVersions(a, b) {
  const parse = (value) => {
    const text = String(value ?? '').trim().replace(/^v/i, '');
    const [core, pre = ''] = text.split('-');
    const parts = core.split('.').map((piece) => Number.parseInt(piece, 10));
    while (parts.length < 3) parts.push(0);
    return { parts, pre };
  };
  const left = parse(a);
  const right = parse(b);
  for (let index = 0; index < 3; index++) {
    const difference = (left.parts[index] || 0) - (right.parts[index] || 0);
    if (difference !== 0) return difference;
  }
  // A pre-release is older than the release it leads up to.
  if (left.pre === right.pre) return 0;
  if (left.pre === '') return 1;
  if (right.pre === '') return -1;
  return left.pre < right.pre ? -1 : 1;
}

/** Strip the leading `v` a release tag carries. */
export function normalizeVersion(value) {
  return String(value ?? '').trim().replace(/^v/i, '');
}

/**
 * Fetch the newest release.
 *
 * The sources are tried in order and the first answer wins; a failure of the
 * first is not an error as long as a later one works.
 * @param options - `{ manifestUrl, fetchImpl, timeoutMs }`.
 * @returns `{ latest, notes, url, publishedAt, assetUrl, source }` or null.
 */
export async function fetchLatestRelease(options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const custom = typeof options.manifestUrl === 'string' ? options.manifestUrl.trim() : '';
  const sources = custom ? [custom, ...DEFAULT_SOURCES] : DEFAULT_SOURCES;
  for (const source of sources) {
    try {
      const response = await fetchImpl(source, {
        headers: { accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) continue;
      const payload = await response.json();
      const tag = payload?.tag_name ?? payload?.version ?? payload?.name;
      if (!tag) continue;
      const assets = Array.isArray(payload.assets) ? payload.assets : [];
      const zip = assets.find((asset) => typeof asset?.name === 'string' && asset.name.endsWith('.zip'));
      return {
        latest: normalizeVersion(tag),
        notes: typeof payload.body === 'string' ? payload.body : '',
        url: typeof payload.html_url === 'string' ? payload.html_url : `https://github.com/${RELEASE_REPO}/releases/tag/${tag}`,
        publishedAt: payload.published_at ?? null,
        assetUrl: zip?.browser_download_url ?? null,
        source,
      };
    } catch {
      // Try the next source.
    }
  }
  return null;
}

/**
 * A cached release lookup.
 *
 * The cache keeps the plugin from spending the anonymous request budget on
 * every panel open.
 */
export class UpdateChecker {
  constructor(options = {}) {
    this.manifestUrl = options.manifestUrl ?? '';
    this.fetchImpl = options.fetchImpl ?? null;
    this.ttlMs = options.ttlMs ?? CACHE_TTL_MS;
    this.cached = null;
    this.cachedAt = 0;
  }

  /**
   * Look up the newest release, reusing a fresh cached answer.
   * @returns `{ current, latest, hasUpdate, ... }`.
   */
  async check(currentVersion) {
    const now = Date.now();
    let release = this.cached;
    if (!release || now - this.cachedAt > this.ttlMs) {
      release = await fetchLatestRelease({
        manifestUrl: this.manifestUrl,
        ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
      });
      this.cached = release;
      this.cachedAt = now;
    }
    if (!release) {
      return { current: currentVersion, latest: null, hasUpdate: false, reachable: false, error: '无法连接到版本检查服务' };
    }
    const hasUpdate = compareVersions(release.latest, currentVersion) > 0;
    return {
      current: currentVersion,
      latest: release.latest,
      hasUpdate,
      reachable: true,
      notes: release.notes,
      url: release.url,
      publishedAt: release.publishedAt,
      assetUrl: release.assetUrl,
      source: release.source,
    };
  }
}
