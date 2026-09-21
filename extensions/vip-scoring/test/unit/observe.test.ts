import { describe, it, expect } from 'vitest';

import { isOutgoingFolder, messageTimeMs, observationsFor } from '../../src/observe';

const NOW = 1_700_000_000_000;
const NOW_SECONDS = NOW / 1000;
const FALLBACK = 1_600_000_000_000;

const email = {
  fromAddress: 'ada@example.com',
  toAddress: 'me@example.com',
  tags: '|INBOX|read|',
  date: NOW_SECONDS,
  receivedDate: NOW_SECONDS,
};

describe('isOutgoingFolder', () => {
  // Regression: telling mail you SENT from mail you received is the only way
  // the extension keeps learning after the first sync. Misreading the folder
  // credits your correspondents' own messages as yours, or loses them entirely.
  it.each(['Sent', 'Sent Items', 'INBOX.Sent', '[Gmail]/Sent Mail', 'Drafts', 'sent-to-legal'])(
    'treats %s as outgoing',
    (folder) => {
      expect(isOutgoingFolder(folder)).toBe(true);
    }
  );

  // Regression: "Consent" contains "sent". Matching it as the Sent folder
  // would invert every observation in that folder.
  it.each(['INBOX', 'Archive', 'Consent Forms', 'Spam'])('treats %s as incoming', (folder) => {
    expect(isOutgoingFolder(folder)).toBe(false);
  });
});

describe('messageTimeMs', () => {
  // Regression: records store seconds and the profile stores milliseconds. A
  // missing conversion puts every observation in 1970, which makes every
  // relationship look permanently stale.
  it('converts stored seconds to milliseconds', () => {
    expect(messageTimeMs({ date: NOW_SECONDS, receivedDate: null }, FALLBACK)).toBe(NOW);
  });

  // Regression: a wrong clock on the far end must not be able to rewrite when
  // a relationship happened.
  it('prefers our receive time over the sender header', () => {
    expect(messageTimeMs({ date: 1, receivedDate: NOW_SECONDS }, FALLBACK)).toBe(NOW);
  });

  // Regression: an absent timestamp must fall back to the event's own time,
  // not to zero, which would date the observation to 1970 and score it stale.
  it.each([
    ['zero', { date: 0, receivedDate: null }],
    ['not a number', { date: Number.NaN, receivedDate: null }],
  ])('falls back for %s timestamps', (_label, record) => {
    expect(messageTimeMs(record, FALLBACK)).toBe(FALLBACK);
  });
});

describe('observationsFor', () => {
  // Regression: the ordinary inbound case — one observation, about the sender.
  it('produces one inbound observation for received mail', () => {
    expect(observationsFor(email, 'INBOX', FALLBACK)).toEqual([
      {
        key: 'ada@example.com',
        observation: { inbound: true, answered: false, starred: false, direct: true, at: NOW },
      },
    ]);
  });

  // Regression: the \Answered and \Flagged flags are the historical signal the
  // first sync provides. Reading the tag string wrongly loses all of it.
  it('reads the answered and starred flags from the tag string', () => {
    const [entry] = observationsFor({ ...email, tags: '|INBOX|answered|starred|' }, 'INBOX', FALLBACK);
    expect(entry.observation).toMatchObject({ answered: true, starred: true });
  });

  // Regression: a message to a list is not a message to you. Losing this makes
  // every newsletter look like a personal note.
  it('marks a multi-recipient message as not direct', () => {
    const [entry] = observationsFor(
      { ...email, toAddress: 'me@example.com, someone@example.com' },
      'INBOX',
      FALLBACK
    );
    expect(entry.observation.direct).toBe(false);
  });

  // Regression: mail you sent must credit its RECIPIENTS, not its sender —
  // otherwise your own address accumulates a profile and nobody else does.
  it('credits every recipient of outgoing mail', () => {
    const entries = observationsFor(
      { ...email, fromAddress: 'me@example.com', toAddress: 'ada@example.com, grace@example.com' },
      'Sent',
      FALLBACK
    );
    expect(entries.map((entry) => entry.key)).toEqual(['ada@example.com', 'grace@example.com']);
    expect(entries.every((entry) => entry.observation.inbound === false)).toBe(true);
  });

  // Regression: mail from an address nobody can reply to is not a relationship
  // however much of it arrives.
  it('produces nothing for an unreachable sender', () => {
    expect(observationsFor({ ...email, fromAddress: 'no-reply@example.com' }, 'INBOX', FALLBACK)).toEqual([]);
  });

  // Regression: malformed headers are routine; producing a bogus key would
  // create a bucket every broken message accumulates into.
  it.each([
    ['an unparseable sender', { fromAddress: 'not-an-address' }],
    ['an empty sender', { fromAddress: '' }],
  ])('produces nothing for %s', (_label, overrides) => {
    expect(observationsFor({ ...email, ...overrides }, 'INBOX', FALLBACK)).toEqual([]);
  });

  // Regression: an announcement you sent to a large list is not a set of
  // relationships, and must not evict real correspondents from the table.
  it('produces nothing for a large outgoing broadcast', () => {
    const many = Array.from({ length: 20 }, (_value, index) => `p${index}@example.com`).join(', ');
    expect(observationsFor({ ...email, toAddress: many }, 'Sent', FALLBACK)).toEqual([]);
  });
});
