import { describe, expect, it } from 'vitest';

import {
  addAlias,
  aliasesOf,
  normalizeIdentities,
  sendAsFrom,
} from '../../../../src/store/identities';

// These govern which addresses an account may send as, and the exact From header
// that goes on the wire. A regression here is a security-adjacent bug: a stale or
// spoofed picker value sending under an address the account never owned, or the
// account's own address silently dropping off the picker.

describe('normalizeIdentities', () => {
  it('always lists the account address first, then aliases', () => {
    // Regression: the picker must always be able to send as the account itself,
    // even for an account that has extra aliases configured.
    expect(normalizeIdentities('me@example.com', ['alias@example.com']))
      .toEqual(['me@example.com', 'alias@example.com']);
  });

  it('de-duplicates case-insensitively and trims', () => {
    // Regression: the same address in different casing/whitespace must collapse to
    // one entry — a duplicated From option confuses and can double-send intent.
    expect(normalizeIdentities('Me@Example.com', ['  me@example.com  ', 'ALIAS@example.com', 'alias@example.com']))
      .toEqual(['Me@Example.com', 'ALIAS@example.com']);
  });

  it('drops invalid addresses', () => {
    // Regression: a garbage alias must never reach the wire as a From header.
    expect(normalizeIdentities('me@example.com', ['not-an-email', '', 'good@example.com']))
      .toEqual(['me@example.com', 'good@example.com']);
  });

  it('returns just the account address when there are no aliases', () => {
    // Regression: legacy accounts (identities undefined) must still yield a usable
    // single-identity list, never an empty one.
    expect(normalizeIdentities('me@example.com')).toEqual(['me@example.com']);
    expect(normalizeIdentities('me@example.com', [])).toEqual(['me@example.com']);
  });
});

describe('aliasesOf', () => {
  it('returns the extra aliases only, excluding the primary address', () => {
    // Regression: the AccountsTab editor must not offer the primary as a removable
    // alias — removing it would be meaningless and the list re-adds it anyway.
    expect(aliasesOf('me@example.com', ['me@example.com', 'a@example.com', 'b@example.com']))
      .toEqual(['a@example.com', 'b@example.com']);
    expect(aliasesOf('me@example.com', ['ME@EXAMPLE.COM'])).toEqual([]);
  });
});

describe('sendAsFrom', () => {
  const identities = ['me@example.com', 'alias@example.com'];

  it('returns undefined for the default (own) address or an empty selection', () => {
    // Regression: sending as the account's own address must NOT set an explicit
    // From override — that path is the plain, SPF-clean default send.
    expect(sendAsFrom('me@example.com', undefined, identities)).toBeUndefined();
    expect(sendAsFrom('me@example.com', 'me@example.com', identities)).toBeUndefined();
    expect(sendAsFrom('me@example.com', 'ME@EXAMPLE.COM', identities)).toBeUndefined();
  });

  it('returns the alias (canonical casing) when a real alias is selected', () => {
    // Regression: choosing an alias must actually send under it.
    expect(sendAsFrom('me@example.com', 'alias@example.com', identities)).toBe('alias@example.com');
    expect(sendAsFrom('me@example.com', 'ALIAS@example.com', identities)).toBe('alias@example.com');
  });

  it('ignores a selection that is not one of the account identities', () => {
    // Regression: a stale/tampered picker value for an address the account can't
    // send as must fall back to the default, never spoof the unknown address.
    expect(sendAsFrom('me@example.com', 'stranger@evil.com', identities)).toBeUndefined();
  });
});

describe('addAlias', () => {
  it('appends a valid, new alias', () => {
    // Regression: the happy path — a fresh valid address is added to the list.
    expect(addAlias('me@example.com', ['a@example.com'], '  new@example.com '))
      .toEqual({ ok: true, aliases: ['a@example.com', 'new@example.com'] });
  });

  it('rejects blank, invalid, the primary, and duplicates', () => {
    // Regression: each guard prevents a distinct bad state — empty entry, garbage
    // address, re-adding the account's own address, or a duplicate alias.
    expect(addAlias('me@example.com', [], '   ').ok).toBe(false);
    expect(addAlias('me@example.com', [], 'nope').ok).toBe(false);
    expect(addAlias('me@example.com', [], 'ME@example.com').ok).toBe(false);
    expect(addAlias('me@example.com', ['a@example.com'], 'A@EXAMPLE.COM').ok).toBe(false);
  });
});
