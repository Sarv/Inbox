/**
 * Guards the SHIPPED `apps/desktop/extensions.config.json`, not the parser.
 *
 * `packages/core` already tests `parseExtensionsConfig` against synthetic
 * documents. What nothing tested is the one document that actually ships — the
 * file that decides which extensions a brand-new profile starts with. It is
 * plain JSON with no type to check it, read at build time by
 * `scripts/prefetch-default-extensions.mjs` and at first run by
 * `installSystemExtensions()`, and every way it can go wrong is silent: a typo
 * in an id warns to a log nobody reads and the extension simply never installs.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

import { OFFICIAL_REGISTRY_URL, parseExtensionsConfig } from '@sarvinbox/core';
import { describe, expect, it } from 'vitest';

const CONFIG_PATH = join(__dirname, '../../extensions.config.json');

const shippedConfig = () => parseExtensionsConfig(JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')));

describe('the shipped extensions.config.json', () => {
  // If this fails the file has an unparseable id or an untrusted registry URL,
  // which parseExtensionsConfig drops SILENTLY (a log warning only). The build
  // still succeeds and the app still starts — it just ships without whatever
  // was dropped.
  it('parses with nothing dropped', () => {
    expect(shippedConfig().warnings).toEqual([]);
  });

  // The OTP reader is a default: it must be installed and enabled on first run,
  // without the user going to look for it. Removing it from systemExtensions is
  // the one edit that would quietly turn that off for every new install.
  it('ships the OTP extension as a default', () => {
    expect(shippedConfig().systemExtensions).toContain('otp-code');
  });

  // Everything the app can preinstall has to be resolvable from a registry the
  // app trusts — that is where both the build-time prefetch and the first-run
  // fallback fetch it from. A config naming only an untrusted registry parses
  // to the official one alone, and the system extensions never arrive.
  it('keeps the official registry first, ahead of any extra source', () => {
    expect(shippedConfig().registries[0]).toBe(OFFICIAL_REGISTRY_URL);
  });

  // The ids are the exact directory names the build unpacks into
  // build/default-extensions/<id>, and the exact keys installSystemExtensions()
  // looks up in the registry index. A stray uppercase letter or space makes
  // both miss.
  it('names every default with a valid, unique extension id', () => {
    const { systemExtensions } = shippedConfig();
    expect(systemExtensions.length).toBeGreaterThan(0);
    for (const id of systemExtensions) expect(id).toMatch(/^[a-z0-9][a-z0-9-]{0,62}$/);
    expect(new Set(systemExtensions).size).toBe(systemExtensions.length);
  });
});
