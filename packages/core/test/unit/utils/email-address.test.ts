import { describe, it, expect, vi } from 'vitest';

import { parseAddressList, parseAddresses } from '../../../src/utils/email-address';

// Stored To/Cc fields are a single RFC 5322 address LIST. The historical bug was
// splitting them on ',' — legal display names contain commas ("Doe, John"), so a
// naive split shredded one recipient into two garbage ones (and then the reply
// went to the wrong place). Everything below guards that funnel-through-the-parser
// behaviour, plus the "never throw, always return something" fallback.

describe('parseAddressList — empty input', () => {
  it('returns [] for empty, whitespace-only, null and undefined', () => {
    expect(parseAddressList('')).toEqual([]);
    expect(parseAddressList('   ')).toEqual([]);
    expect(parseAddressList(null)).toEqual([]);
    expect(parseAddressList(undefined)).toEqual([]);
  });
});

describe('parseAddressList — well-formed lists', () => {
  it('parses a bare address with no display name', () => {
    expect(parseAddressList('accounts@sarv.com')).toEqual([{ name: null, address: 'accounts@sarv.com' }]);
  });

  it('parses "Name <addr>" and keeps the display name separate', () => {
    expect(parseAddressList('Accounts Sarv <accounts@sarv.com>')).toEqual([
      { name: 'Accounts Sarv', address: 'accounts@sarv.com' },
    ]);
  });

  it('splits a multi-recipient list', () => {
    expect(parseAddressList('a@x.com, b@y.com')).toEqual([
      { name: null, address: 'a@x.com' },
      { name: null, address: 'b@y.com' },
    ]);
  });

  // THE regression: a comma inside a quoted display name must not split the list.
  it('keeps a quoted display name containing a comma intact (the split-on-comma bug)', () => {
    expect(parseAddressList('"Doe, John" <john@x.com>, jane@y.com')).toEqual([
      { name: 'Doe, John', address: 'john@x.com' },
      { name: null, address: 'jane@y.com' },
    ]);
  });

  // Real mail is not ASCII; a non-ASCII display name must survive unmangled.
  it('preserves a unicode display name', () => {
    expect(parseAddressList('Ünïcödé Nâme <u@x.com>')).toEqual([
      { name: 'Ünïcödé Nâme', address: 'u@x.com' },
    ]);
  });

  // RFC 5322 group syntax ("Team: a@x, b@x;") is a single node with nested
  // members — flattening it wrong loses every recipient in the group.
  it('flattens RFC 5322 group syntax into its member addresses', () => {
    expect(parseAddressList('Team: a@x.com, b@x.com;')).toEqual([
      { name: null, address: 'a@x.com' },
      { name: null, address: 'b@x.com' },
    ]);
  });

  it('drops a trailing empty element instead of emitting a blank recipient', () => {
    expect(parseAddressList('A B <a@x.com>, ')).toEqual([{ name: 'A B', address: 'a@x.com' }]);
  });

  it('tolerates stray whitespace around the separators', () => {
    expect(parseAddresses('plain@x.com , second@y.com')).toEqual(['plain@x.com', 'second@y.com']);
  });
});

describe('parseAddressList — malformed input never throws', () => {
  // Headers are attacker-controlled. The contract is "best effort, but always an
  // array" — a throw here would abort the whole message ingest.
  it('falls back to a comma split when the parser cannot make sense of the input', () => {
    expect(parseAddressList('a b c')).toEqual([{ name: null, address: 'a b c' }]);
    expect(parseAddressList('foo, bar')).toEqual([
      { name: null, address: 'foo' },
      { name: null, address: 'bar' },
    ]);
    expect(parseAddressList('"unterminated <a@x.com>')).toEqual([
      { name: null, address: '"unterminated <a@x.com>' },
    ]);
  });

  it('yields [] when the fallback split finds nothing usable', () => {
    expect(parseAddressList(',,,')).toEqual([]);
    expect(parseAddressList('   ,   ')).toEqual([]);
  });

  // An EMPTY group ("Team:;") parses successfully but contributes no mailbox —
  // the result must not be an empty array that silently loses the header text.
  it('falls back when a parse succeeds but produces no mailboxes (empty group)', () => {
    expect(parseAddressList('Team:;')).toEqual([{ name: null, address: 'Team:;' }]);
  });

  // Belt-and-braces: even if the underlying parser itself throws on some future
  // pathological header, ingest must keep going.
  it('falls back instead of propagating when the parser throws', async () => {
    const emailAddresses = (await import('email-addresses')).default;
    const spy = vi.spyOn(emailAddresses, 'parseAddressList').mockImplementation(() => {
      throw new Error('parser exploded');
    });
    try {
      expect(parseAddressList('a@x.com, b@y.com')).toEqual([
        { name: null, address: 'a@x.com' },
        { name: null, address: 'b@y.com' },
      ]);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('parseAddresses', () => {
  it('returns bare addresses only, dropping display names', () => {
    expect(parseAddresses('"Doe, John" <john@x.com>, Jane <jane@y.com>')).toEqual([
      'john@x.com',
      'jane@y.com',
    ]);
  });

  it('returns [] for empty input', () => {
    expect(parseAddresses(null)).toEqual([]);
    expect(parseAddresses('')).toEqual([]);
  });
});
