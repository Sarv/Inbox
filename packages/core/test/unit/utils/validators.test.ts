import { describe, it, expect } from 'vitest';

import { extractEmailAddress, hasReplyPrefix, isValidEmail, normalizeSubject } from '../../../src/utils/validators';

describe('extractEmailAddress', () => {
  it('returns a bare address unchanged', () => {
    expect(extractEmailAddress('accounts@sarv.com')).toBe('accounts@sarv.com');
  });

  it('extracts the address from "Name <email>" form', () => {
    expect(extractEmailAddress('Accounts Sarv <accounts@sarv.com>')).toBe('accounts@sarv.com');
  });

  it('handles a display name that contains a comma (the regex trap)', () => {
    expect(extractEmailAddress('"Doe, John" <john@x.com>')).toBe('john@x.com');
  });

  it('trims surrounding whitespace', () => {
    expect(extractEmailAddress('  bob@x.com  ')).toBe('bob@x.com');
  });

  it('falls back to the raw token when unparseable, so isValidEmail can reject it', () => {
    expect(extractEmailAddress('not-an-email')).toBe('not-an-email');
    expect(isValidEmail(extractEmailAddress('not-an-email'))).toBe(false);
  });

  it('makes a display-name recipient pass validation (the reported bug)', () => {
    expect(isValidEmail(extractEmailAddress('Accounts Sarv <accounts@sarv.com>'))).toBe(true);
  });
});

describe('normalizeSubject', () => {
  it('strips English Re:/Fwd: (any case) and stacked prefixes', () => {
    expect(normalizeSubject('Re: Project Falcon')).toBe('project falcon');
    expect(normalizeSubject('FWD: Project Falcon')).toBe('project falcon');
    expect(normalizeSubject('Re: Fwd: Re: Project Falcon')).toBe('project falcon');
  });

  it('strips i18n reply/forward prefixes so cross-locale replies thread together', () => {
    const base = 'quarterly review';
    for (const p of ['Re', 'AW', 'WG', 'SV', 'RV', 'TR', 'RIF', 'ENC', 'Antw', 'Antwort', 'Doorst', 'Rép']) {
      expect(normalizeSubject(`${p}: Quarterly Review`)).toBe(base);
    }
  });

  it('strips a bracketed/parenthesized reply count (Re[2]: / Re(3):)', () => {
    expect(normalizeSubject('Re[2]: Budget')).toBe('budget');
    expect(normalizeSubject('RE(3): Budget')).toBe('budget');
  });

  it('does NOT strip reference-style words that only look like prefixes', () => {
    // "REF:" / "RES:" / "VS:" are reference/subject words, not reply markers —
    // stripping them would merge unrelated mail.
    expect(normalizeSubject('REF: Invoice 8842')).toBe('ref: invoice 8842');
    expect(normalizeSubject('RES: Ticket 12')).toBe('res: ticket 12');
    expect(normalizeSubject('VS: Match report')).toBe('vs: match report');
  });

  it('does not strip a colon that is part of the real subject', () => {
    expect(normalizeSubject('Meeting: agenda for Monday')).toBe('meeting: agenda for monday');
  });
});

// Regression: threading uses this as the "this is a conversation, not a recurring
// notification" signal. A false positive re-opens the bug where two years of
// identical notifications collapsed into one thread; a false negative fragments a
// real reply chain whose References root was never synced.
describe('hasReplyPrefix', () => {
  it('detects English and i18n reply/forward markers, with or without a count', () => {
    for (const s of ['Re: Budget', 'fwd: Budget', 'AW: Budget', 'Rép: Budget', 'Re[2]: Budget', 'RE(3): Budget', 'Re: Fwd: Budget']) {
      expect(hasReplyPrefix(s)).toBe(true);
    }
  });

  it('is false for a plain subject, including one with its own colon or a look-alike word', () => {
    for (const s of ['OverTime Request is approved.', 'Meeting: agenda for Monday', 'REF: Invoice 8842', 'VS: Match report']) {
      expect(hasReplyPrefix(s)).toBe(false);
    }
  });

  it('is false for missing/empty subjects rather than throwing', () => {
    // Real mail arrives with a null subject; the resolver calls this on every
    // candidate, so a throw here would abort threading for the whole batch.
    expect(hasReplyPrefix(null)).toBe(false);
    expect(hasReplyPrefix(undefined)).toBe(false);
    expect(hasReplyPrefix('')).toBe(false);
    expect(hasReplyPrefix('   ')).toBe(false);
  });

  it('ignores surrounding whitespace and case, matching normalizeSubject', () => {
    // Derived from normalizeSubject on purpose — if these two ever disagree about
    // what a marker is, threading becomes non-deterministic.
    expect(hasReplyPrefix('  re:  Budget  ')).toBe(true);
    expect(hasReplyPrefix('  Budget  ')).toBe(false);
  });
});
