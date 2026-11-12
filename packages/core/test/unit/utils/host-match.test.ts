import { describe, expect, it } from 'vitest';

import { hostIsOrUnder } from '../../../src/utils/host-match';

// The one "does this host belong to that domain" rule. Callers hand a matching
// host a provider's settings (the SMTP prefill, provider detection) or treat it
// as that provider (Safe Links unwrapping), so a false match sends a user's
// details to the wrong server.

describe('hostIsOrUnder', () => {
  // Breaks: the provider's own hosts stop matching and every Gmail / iCloud
  // account loses its provider settings.
  it('matches the domain itself and any host under it', () => {
    expect(hostIsOrUnder('gmail.com', 'gmail.com')).toBe(true);
    expect(hostIsOrUnder('imap.gmail.com', 'gmail.com')).toBe(true);
    expect(hostIsOrUnder('a.b.imap.mail.me.com', 'me.com')).toBe(true);
  });

  // Breaks (the substring bug this replaces): a self-hosted server whose name
  // merely CONTAINS a provider's domain is taken for that provider.
  it.each([
    ['imap.acme.com', 'me.com'],
    ['notgmail.com', 'gmail.com'],
    ['gmail.com.evil.example', 'gmail.com'],
    ['imap.gmail.company.example', 'gmail.com'],
    ['mygmail.com', 'gmail.com'],
  ])('does not match %s against %s', (host, domain) => {
    expect(hostIsOrUnder(host, domain)).toBe(false);
  });

  // Breaks: a host typed in capitals, with stray spaces or with the DNS root
  // dot reads as a different server than the same host written plainly.
  it('ignores case, surrounding whitespace and one trailing root dot', () => {
    expect(hostIsOrUnder(' IMAP.Gmail.COM ', 'gmail.com')).toBe(true);
    expect(hostIsOrUnder('imap.gmail.com.', 'gmail.com')).toBe(true);
    expect(hostIsOrUnder('imap.gmail.com', 'Gmail.Com.')).toBe(true);
  });

  // Breaks: an empty host would match an empty domain (and `''.endsWith('.')`
  // style edge cases would pass a host with no name at all).
  it('never matches an empty or missing host or domain', () => {
    expect(hostIsOrUnder('', 'gmail.com')).toBe(false);
    expect(hostIsOrUnder(undefined, 'gmail.com')).toBe(false);
    expect(hostIsOrUnder(null, 'gmail.com')).toBe(false);
    expect(hostIsOrUnder('imap.gmail.com', '')).toBe(false);
    expect(hostIsOrUnder('.', '.')).toBe(false);
  });
});
