import { describe, expect, it } from 'vitest';

import {
  DEFAULT_EXTENSIONS_CONFIG,
  OFFICIAL_REGISTRY_URL,
  parseExtensionsConfig,
} from '../../../src/extensions/extensions-config';

describe('parseExtensionsConfig', () => {
  it('reads a well-formed config', () => {
    const parsed = parseExtensionsConfig({
      registries: [OFFICIAL_REGISTRY_URL],
      systemExtensions: ['otp-code', 'vip-scoring'],
    });

    expect(parsed).toEqual({
      registries: [OFFICIAL_REGISTRY_URL],
      systemExtensions: ['otp-code', 'vip-scoring'],
      warnings: [],
    });
  });

  // Regression: the config is read at first run, before there is any UI to
  // report a problem in. An unreadable one must leave the Browse tab working,
  // not leave the app with no registry at all.
  it.each([null, undefined, 'a string', 42])('falls back to defaults for %j', (junk) => {
    const parsed = parseExtensionsConfig(junk);
    expect(parsed.registries).toEqual(DEFAULT_EXTENSIONS_CONFIG.registries);
    expect(parsed.systemExtensions).toEqual([]);
    expect(parsed.warnings).toHaveLength(1);
  });

  // Regression: `mergeRegistries` lets the FIRST source win a clash of ids.
  // If a config could push a community registry ahead of the official one, it
  // could shadow an official extension with a build of its own.
  it('forces the official registry to the front even when the config omits or reorders it', () => {
    const other = 'https://raw.githubusercontent.com/someone/else/main/registry.json';

    expect(parseExtensionsConfig({ registries: [other] }).registries).toEqual([
      OFFICIAL_REGISTRY_URL,
      other,
    ]);
    expect(parseExtensionsConfig({ registries: [other, OFFICIAL_REGISTRY_URL] }).registries).toEqual([
      OFFICIAL_REGISTRY_URL,
      other,
    ]);
  });

  it('drops a registry that is not an allowed https GitHub URL, and says so', () => {
    const parsed = parseExtensionsConfig({
      registries: ['http://github.com/x/registry.json', 'https://evil.example.com/registry.json'],
    });

    expect(parsed.registries).toEqual([OFFICIAL_REGISTRY_URL]);
    expect(parsed.warnings).toHaveLength(2);
  });

  // Regression: a system-extension id becomes a folder name and a registry
  // lookup key. A traversal here would install outside the extensions dir.
  it.each(['../escape', '/abs', 'Upper', 'has space', '', 7])(
    'drops the invalid system extension id %j',
    (id) => {
      const parsed = parseExtensionsConfig({ systemExtensions: [id] });
      expect(parsed.systemExtensions).toEqual([]);
      expect(parsed.warnings[0]).toContain('not a valid extension id');
    }
  );

  it('de-duplicates system extensions, keeping the configured order', () => {
    const parsed = parseExtensionsConfig({ systemExtensions: ['b-ext', 'a-ext', 'b-ext'] });
    expect(parsed.systemExtensions).toEqual(['b-ext', 'a-ext']);
  });

  // Regression: a first run that has to download twenty extensions before it
  // shows any mail looks like a hang.
  it('caps the system extension list and warns about the overflow', () => {
    const many = Array.from({ length: 20 }, (_unused, index) => `ext-${index}`);
    const parsed = parseExtensionsConfig({ systemExtensions: many });

    expect(parsed.systemExtensions).toHaveLength(16);
    expect(parsed.systemExtensions[0]).toBe('ext-0');
    expect(parsed.warnings[0]).toContain('ext-16');
  });

  it('treats non-array registries and systemExtensions as absent', () => {
    const parsed = parseExtensionsConfig({ registries: 'nope', systemExtensions: { a: 1 } });
    expect(parsed.registries).toEqual([OFFICIAL_REGISTRY_URL]);
    expect(parsed.systemExtensions).toEqual([]);
  });
});
