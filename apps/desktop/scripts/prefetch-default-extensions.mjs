#!/usr/bin/env node
/**
 * Seed the extensions a fresh install starts with.
 *
 * The extensions named in `extensions.config.json` under `systemExtensions` are
 * meant to be present and enabled the first time the app opens. They are not in
 * this repository — they are published to the GitHub registry like every other
 * extension — so this script downloads them at build time and unpacks them into
 * `build/default-extensions/`, which electron-builder copies into Resources.
 *
 * Without this, a first run with no network would start with nothing installed.
 * With it, first run is instant and offline-safe, and the registry is only
 * consulted for updates and for anything the user installs themselves.
 *
 * The same checksum rule the app enforces at install time applies here: the
 * archive is hashed and compared against the digest the registry pins, and a
 * mismatch fails the build. A network failure only warns — the app still knows
 * how to fetch a missing system extension on first run.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { x as extract } from 'tar';

const DESKTOP_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = join(DESKTOP_DIR, 'extensions.config.json');
const OUTPUT_DIR = join(DESKTOP_DIR, 'build', 'default-extensions');
const TRUSTED_HOSTS = new Set([
  'github.com',
  'raw.githubusercontent.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
]);
const ALLOWED_ENTRY = /^(?:\.\/)?(?:sarvinbox-extension\.json|dist\/[\w.-]+\.js|icon\.svg|README\.md|LICENSE)$/;

function isTrusted(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && TRUSTED_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

async function fetchRegistry(url) {
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json();
}

/**
 * Fill in an entry's download block from its detail document if the registry is
 * a thin index. A v1 registry already carries one and needs no extra request.
 *
 * The id and the version are re-checked against the index: a detail document
 * that disagrees with the list means the two are out of step, and seeding the
 * build from it would ship bytes nobody reviewed under a version nobody
 * published.
 */
async function resolveEntry(entry, sourceUrl) {
  if (entry.download) return entry;
  if (!entry.detailUrl) throw new Error(`${entry.id}: no download block and no detailUrl`);

  const detailUrl = new URL(entry.detailUrl, sourceUrl).toString();
  if (!isTrusted(detailUrl)) fail(`${entry.id}: detail URL ${detailUrl} is not a trusted host`);

  const detail = await fetchRegistry(detailUrl);
  if (detail?.id !== entry.id || detail?.version !== entry.version) {
    throw new Error(
      `${entry.id}: detail document describes ${detail?.id}@${detail?.version}, the index offered ${entry.id}@${entry.version}`
    );
  }
  return { ...entry, ...detail };
}

async function seed(entry) {
  if (!isTrusted(entry.download?.url)) {
    fail(`${entry.id}: download URL ${entry.download?.url} is not a trusted host`);
  }

  const response = await fetch(entry.download.url, { headers: { accept: 'application/octet-stream' } });
  if (!response.ok) throw new Error(`${entry.id}: ${response.status} ${response.statusText}`);
  const archive = Buffer.from(await response.arrayBuffer());

  const digest = createHash('sha256').update(archive).digest('hex');
  if (digest !== String(entry.download.sha256).toLowerCase()) {
    fail(`${entry.id}: checksum mismatch - registry pins ${entry.download.sha256}, downloaded ${digest}`);
  }

  const target = join(OUTPUT_DIR, entry.id);
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });

  const archivePath = join(OUTPUT_DIR, `${entry.id}.tgz`);
  await writeFile(archivePath, archive);
  await extract({
    file: archivePath,
    cwd: target,
    filter: (path) => {
      const normalized = path.replace(/\\/g, '/');
      return normalized === '.' || normalized === './' || ALLOWED_ENTRY.test(normalized);
    },
  });
  await rm(archivePath, { force: true });

  const manifestPath = join(target, 'sarvinbox-extension.json');
  if (!existsSync(manifestPath)) fail(`${entry.id}: archive has no sarvinbox-extension.json`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  if (manifest.id !== entry.id || manifest.version !== entry.version) {
    fail(`${entry.id}: archive declares ${manifest.id}@${manifest.version}, registry offered ${entry.id}@${entry.version}`);
  }

  console.log(`  OK: ${entry.id}@${entry.version} (${archive.length} bytes, sha256 verified)`);
}

async function main() {
  const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
  const wanted = Array.isArray(config.systemExtensions) ? config.systemExtensions : [];
  const registries = Array.isArray(config.registries) ? config.registries.filter(isTrusted) : [];

  await rm(OUTPUT_DIR, { recursive: true, force: true });
  await mkdir(OUTPUT_DIR, { recursive: true });
  // electron-builder skips an empty directory; a marker keeps the Resources
  // path present so the app can tell "no seeds shipped" from "no such folder".
  await writeFile(join(OUTPUT_DIR, '.seeded'), `${new Date().toISOString()}\n`, 'utf-8');

  if (wanted.length === 0) {
    console.log('No system extensions configured; nothing to prefetch.');
    return;
  }
  console.log(`Prefetching ${wanted.length} system extension(s) from ${registries.length} registry/registries...`);

  const entries = new Map();
  for (const url of registries) {
    try {
      const document = await fetchRegistry(url);
      for (const entry of Array.isArray(document.extensions) ? document.extensions : []) {
        // Earlier registries win, matching how the app merges them at runtime.
        if (entry && typeof entry.id === 'string' && !entries.has(entry.id)) {
          entries.set(entry.id, { entry, sourceUrl: url });
        }
      }
    } catch (error) {
      console.warn(`WARN: could not read registry ${url}: ${error.message}`);
    }
  }

  for (const id of wanted) {
    const listed = entries.get(id);
    if (!listed) {
      console.warn(`WARN: "${id}" is not in any registry yet; the app will fetch it on first run.`);
      continue;
    }
    try {
      await seed(await resolveEntry(listed.entry, listed.sourceUrl));
    } catch (error) {
      // A build machine with no network still produces a working app - it just
      // installs its system extensions on first launch instead.
      console.warn(`WARN: could not prefetch "${id}": ${error.message}`);
    }
  }
}

main().catch((error) => fail(error.stack ?? String(error)));
