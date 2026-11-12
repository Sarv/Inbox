import { describe, expect, it } from 'vitest';

import { calculateImportanceScore } from '../../../src/processor/email-processor';
import type { EmailRecord } from '../../../src/types/models';

/**
 * The recipient arm of the rule-based importance scorer: is the user in To, in
 * Cc, or neither? It runs on every incoming email's To/Cc — a stranger's text.
 * The addresses were pulled out with `/[\w.+-]+@[\w.-]+/g`, quadratic on a long
 * run of address characters with no `@` (CodeQL js/polynomial-redos): a header
 * of 150 K `+` took about 9 s, twice per email (To and Cc).
 */

const email = (over: Partial<EmailRecord>): EmailRecord =>
  ({
    id: 'e1',
    messageId: '<m1@mail.example>',
    subject: 'Q3 numbers',
    fromAddress: 'boss@acme.example',
    toAddress: '',
    ccAddress: null,
    date: 1_757_900_000,
    cleanBody: 'See attached.',
    ...over,
  }) as EmailRecord;

const factorsFor = (record: EmailRecord, userEmail: string) =>
  calculateImportanceScore(record, null, userEmail, userEmail.split('@')[1], new Set()).factors.map((f) => f.name);

describe('calculateImportanceScore — To / Cc recipient', () => {
  // Breaks: the user stops being seen as a direct or Cc recipient, whatever
  // separator or display-name format the stored field uses.
  it('finds the user in To, else in Cc, case-insensitively', () => {
    expect(factorsFor(email({ toAddress: 'a@x.example, Me@Acme.example' }), 'me@acme.example')).toContain('direct_recipient');
    expect(factorsFor(email({ toAddress: 'a@x.example', ccAddress: 'Me <me@acme.example>; b@y.example' }), 'me@acme.example')).toContain('cc_recipient');
  });

  // Breaks: "joann@acme.example" counts as user "ann@acme.example".
  it('compares whole addresses, never a substring', () => {
    expect(factorsFor(email({ toAddress: 'joann@acme.example' }), 'ann@acme.example')).not.toContain('direct_recipient');
  });

  // Breaks: one mailbox's role leaks into another's — the same message, synced
  // into two accounts, must score To for one and Cc for the other.
  it('scores each account by its own address', () => {
    const shared = email({ toAddress: 'me@acme.example', ccAddress: 'you@acme.example' });
    expect(factorsFor(shared, 'me@acme.example')).toContain('direct_recipient');
    expect(factorsFor(shared, 'you@acme.example')).toContain('cc_recipient');
  });

  // Breaks: a crafted To/Cc header stalls importance scoring for seconds — the
  // regex is back. Under it this test times out.
  it('reads a To/Cc of 150 K "+" with no "@" at once', () => {
    const header = '+'.repeat(150_000);
    expect(factorsFor(email({ toAddress: header, ccAddress: header }), 'me@acme.example')).not.toContain('direct_recipient');
  });
});
