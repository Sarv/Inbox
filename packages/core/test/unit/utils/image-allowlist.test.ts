import { describe, it, expect } from 'vitest';

import {
  bareSenderAddress,
  describeImageAllowEntry,
  imageAllowKeysFor,
  isImageAllowedFor,
  normalizeAllowDomain,
  parseImageAllowInput,
} from '../../../src/utils/image-allowlist';

describe('bareSenderAddress', () => {
  // The allowlist is keyed by the bare address; if "Name <addr>" kept its
  // display name, the same sender would be stored twice and match neither.
  it('strips a display name and lowercases', () => {
    expect(bareSenderAddress('The Boss <BOSS@X.com>')).toBe('boss@x.com');
    expect(bareSenderAddress('  boss@x.com  ')).toBe('boss@x.com');
  });

  // A comma inside a quoted display name is the classic split-on-comma bug.
  it('survives a comma in the display name', () => {
    expect(bareSenderAddress('"Doe, John" <j@x.com>')).toBe('j@x.com');
  });

  it('returns "" for empty input', () => {
    expect(bareSenderAddress(undefined)).toBe('');
    expect(bareSenderAddress(null)).toBe('');
    expect(bareSenderAddress('   ')).toBe('');
  });
});

describe('normalizeAllowDomain', () => {
  it('accepts a domain with or without the @, any casing, trailing dot', () => {
    expect(normalizeAllowDomain('Example.COM')).toBe('example.com');
    expect(normalizeAllowDomain('@example.com')).toBe('example.com');
    expect(normalizeAllowDomain('news.example.com.')).toBe('news.example.com');
  });

  // Allowing a public suffix would hand EVERY sender on it a pass — the one
  // typo in this field that silently disables the whole feature.
  it('refuses a bare public suffix', () => {
    expect(normalizeAllowDomain('com')).toBe('');
    expect(normalizeAllowDomain('co.uk')).toBe('');
    expect(normalizeAllowDomain('@com')).toBe('');
  });

  it('refuses junk that is not a hostname', () => {
    expect(normalizeAllowDomain('')).toBe('');
    expect(normalizeAllowDomain(null)).toBe('');
    expect(normalizeAllowDomain(undefined)).toBe('');
    expect(normalizeAllowDomain('exa..mple.com')).toBe('');
    expect(normalizeAllowDomain('example.com/')).toBe('');
    expect(normalizeAllowDomain('not a domain')).toBe('');
    expect(normalizeAllowDomain('http://example.com/path')).toBe('');
    expect(normalizeAllowDomain('boss@example.com')).toBe('');
    expect(normalizeAllowDomain('localhost')).toBe('');
  });

  // An unknown TLD is still a real internal domain; refusing it would make the
  // field unusable on a corporate intranet.
  it('accepts a multi-label host under an unknown TLD', () => {
    expect(normalizeAllowDomain('mail.corp')).toBe('mail.corp');
  });
});

describe('parseImageAllowInput', () => {
  it('reads a sender address, with or without a display name', () => {
    expect(parseImageAllowInput('BOSS@X.com')).toEqual({ kind: 'sender', key: 'boss@x.com', label: 'boss@x.com' });
    expect(parseImageAllowInput('The Boss <boss@x.com>')).toEqual({ kind: 'sender', key: 'boss@x.com', label: 'boss@x.com' });
  });

  it('reads a domain with or without the leading @', () => {
    expect(parseImageAllowInput('example.com')).toEqual({ kind: 'domain', key: '@example.com', label: 'example.com' });
    expect(parseImageAllowInput('@Example.com')).toEqual({ kind: 'domain', key: '@example.com', label: 'example.com' });
  });

  // A sender entry must never be stored with a registrable-domain check: an
  // intranet sender would then be silently forgotten every time the reader
  // clicked "Load images".
  it('keeps a sender on a domain with no public suffix', () => {
    expect(parseImageAllowInput('someone@mail.corp')?.key).toBe('someone@mail.corp');
    expect(parseImageAllowInput('root@localhost')?.key).toBe('root@localhost');
  });

  it('returns null for input that is neither', () => {
    expect(parseImageAllowInput('')).toBeNull();
    expect(parseImageAllowInput('   ')).toBeNull();
    expect(parseImageAllowInput(undefined)).toBeNull();
    expect(parseImageAllowInput('com')).toBeNull();
    expect(parseImageAllowInput('@co.uk')).toBeNull();
    expect(parseImageAllowInput('@')).toBeNull();
    expect(parseImageAllowInput('boss@')).toBeNull(); // an address with no domain
  });

  // "@x.com" with no local part is a domain, not a sender with an empty name.
  it('never produces a sender key with an empty local part', () => {
    expect(parseImageAllowInput('@x.com')?.kind).toBe('domain');
  });
});

describe('describeImageAllowEntry', () => {
  // The stored key is the only thing the list has to tell the two apart; get
  // this wrong and a domain rule renders as a sender named "@x.com".
  it('treats a missing key as an empty sender rather than throwing', () => {
    expect(describeImageAllowEntry(null)).toEqual({ kind: 'sender', key: '', label: '' });
  });

  it('splits a stored key back into kind + label', () => {
    expect(describeImageAllowEntry('@x.com')).toEqual({ kind: 'domain', key: '@x.com', label: 'x.com' });
    expect(describeImageAllowEntry('Boss@X.com')).toEqual({ kind: 'sender', key: 'boss@x.com', label: 'boss@x.com' });
  });
});

describe('imageAllowKeysFor / isImageAllowedFor', () => {
  it('matches the exact sender', () => {
    expect(isImageAllowedFor('The Boss <BOSS@X.com>', new Set(['boss@x.com']))).toBe(true);
    expect(isImageAllowedFor('other@x.com', new Set(['boss@x.com']))).toBe(false);
  });

  // The whole reason domains exist here: a newsletter's envelope sender is a
  // per-campaign address nobody could have typed in advance.
  it('matches any sender on an allowed domain, including subdomains', () => {
    const entries = new Set(['@example.com']);
    expect(isImageAllowedFor('bounce-123@example.com', entries)).toBe(true);
    expect(isImageAllowedFor('news@mail.example.com', entries)).toBe(true);
    expect(isImageAllowedFor('news@example.com.evil.net', entries)).toBe(false);
    expect(isImageAllowedFor('news@notexample.com', entries)).toBe(false);
  });

  // A subdomain rule must NOT leak upward: allowing news.example.com says
  // nothing about the rest of example.com.
  it('does not let a subdomain rule cover the parent', () => {
    expect(isImageAllowedFor('a@example.com', new Set(['@news.example.com']))).toBe(false);
    expect(isImageAllowedFor('a@news.example.com', new Set(['@news.example.com']))).toBe(true);
  });

  it('never probes a single-label key, so no stored "@com" could ever match', () => {
    expect(imageAllowKeysFor('a@x.co.uk')).toEqual(['a@x.co.uk', '@x.co.uk', '@co.uk']);
    expect(imageAllowKeysFor('a@x.com')).toEqual(['a@x.com', '@x.com']);
  });

  it('yields nothing for a missing address, and nothing matches', () => {
    expect(imageAllowKeysFor('')).toEqual([]);
    expect(imageAllowKeysFor(undefined)).toEqual([]);
    expect(isImageAllowedFor(undefined, new Set(['@x.com']))).toBe(false);
  });

  // A local-only address ("root") has no domain to walk.
  it('handles an address with no domain', () => {
    expect(imageAllowKeysFor('root')).toEqual(['root']);
  });

  it('matches nothing against an empty allowlist', () => {
    expect(isImageAllowedFor('boss@x.com', new Set())).toBe(false);
  });
});
