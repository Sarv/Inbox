import { describe, it, expect } from 'vitest';

import type { IMAPMessage } from '../../../src/types/imap';

import { mapEnvelopeFields } from '../../../src/imap/envelope-mapper';

// mapEnvelopeFields is the SINGLE source of truth for turning an IMAP ENVELOPE
// into the address/subject columns of an EmailRecord — used by both the ingest
// path (message-processor.convertMessage) and the sync-engine repair path. Every
// case here is something real mail does: RFC-2047 encoded words, a From with an
// unquoted comma, a header-less/blank subject, empty recipient lists. A wrong
// mapping here is permanent (it's what the list and thread header render), and
// because two callers share it, a drift shows up as "the repaired row looks
// different from the synced one".
//
// Pure function — no client, no storage, no clock.

const env = (over: Partial<IMAPMessage['envelope']> = {}): IMAPMessage['envelope'] => ({
  messageId: '<m1@test.local>',
  inReplyTo: null,
  references: [],
  subject: 'Subject',
  from: [{ address: 'sender@test.local', name: 'Sender' }],
  replyTo: [],
  to: [{ address: 'me@test.local', name: 'Me' }],
  cc: [],
  bcc: [],
  date: new Date('2026-01-01T00:00:00Z'),
  ...over,
}) as IMAPMessage['envelope'];

describe('mapEnvelopeFields', () => {
  it('maps a plain single-recipient envelope', () => {
    const f = mapEnvelopeFields(env());

    expect(f).toMatchObject({
      subject: 'Subject',
      fromAddress: 'sender@test.local',
      fromName: 'Sender',
      toAddress: 'me@test.local',
      toNames: 'Me',
      ccAddress: null,
      ccNames: null,
      bccAddress: null,
      bccNames: null,
      replyTo: null,
    });
  });

  it('decodes RFC-2047 encoded words in the subject and in every display name', () => {
    // Encoded words reach us raw off the wire; storing them undecoded is the
    // "=?UTF-8?B?…?= in my inbox" bug.
    const f = mapEnvelopeFields(env({
      subject: '=?UTF-8?B?SGVsbG8gd29ybGQ=?=',
      from: [{ address: 'a@test.local', name: '=?ISO-8859-1?Q?Caf=E9?=' }],
      to: [{ address: 'b@test.local', name: '=?UTF-8?B?VGVhbQ==?=' }],
    }));

    expect(f.subject).toBe('Hello world');
    expect(f.fromName).toBe('Café');
    expect(f.toNames).toBe('Team');
  });

  it('normalises a MISSING or blank subject to an empty string (never null/undefined)', () => {
    // subject is NOT NULL in storage, and the UI substitutes "(No Subject)"
    // itself — so this must be '' rather than null, for both spellings.
    expect(mapEnvelopeFields(env({ subject: null })).subject).toBe('');
    expect(mapEnvelopeFields(env({ subject: '' })).subject).toBe('');
    expect(mapEnvelopeFields(env({ subject: undefined as unknown as string })).subject).toBe('');
  });

  it('survives an envelope with NO From at all (address "", name null)', () => {
    // Some automated/bounce mail genuinely arrives with no From. It must map to
    // an empty address instead of throwing mid-ingest and losing the message.
    expect(mapEnvelopeFields(env({ from: [] }))).toMatchObject({ fromAddress: '', fromName: null });
    expect(mapEnvelopeFields(env({ from: undefined }))).toMatchObject({ fromAddress: '', fromName: null });
  });

  it('joins MULTIPLE recipients in header order, addresses and names in parallel', () => {
    const f = mapEnvelopeFields(env({
      to: [
        { address: 'one@test.local', name: 'One' },
        { address: 'two@test.local', name: 'Two' },
        { address: 'three@test.local', name: 'Three' },
      ],
      cc: [{ address: 'cc1@test.local', name: 'CC One' }, { address: 'cc2@test.local', name: '' }],
      bcc: [{ address: 'bcc@test.local', name: 'BCC' }],
    }));

    expect(f.toAddress).toBe('one@test.local, two@test.local, three@test.local');
    expect(f.toNames).toBe('One, Two, Three');
    expect(f.ccAddress).toBe('cc1@test.local, cc2@test.local');
    // A recipient with no display name falls back to its address, so the two
    // joined lists stay index-aligned.
    expect(f.ccNames).toBe('CC One, cc2@test.local');
    expect(f.bccAddress).toBe('bcc@test.local');
    expect(f.bccNames).toBe('BCC');
  });

  it('keeps cc/bcc NULL when the lists are empty or absent (not an empty string)', () => {
    // '' and null are different in the DB and in the "has recipients" checks the
    // compose/reply path makes; an empty list must stay null.
    const empty = mapEnvelopeFields(env({ cc: [], bcc: [] }));
    expect(empty.ccAddress).toBeNull();
    expect(empty.bccAddress).toBeNull();
    const absent = mapEnvelopeFields(env({ cc: undefined, bcc: undefined }));
    expect(absent.ccAddress).toBeNull();
    expect(absent.ccNames).toBeNull();
    expect(absent.bccAddress).toBeNull();
    expect(absent.bccNames).toBeNull();
  });

  it('takes only the FIRST Reply-To address, and null when there is none', () => {
    expect(mapEnvelopeFields(env({
      replyTo: [{ address: 'first@test.local', name: '' }, { address: 'second@test.local', name: '' }],
    })).replyTo).toBe('first@test.local');
    expect(mapEnvelopeFields(env({ replyTo: [] })).replyTo).toBeNull();
    expect(mapEnvelopeFields(env({ replyTo: undefined })).replyTo).toBeNull();
  });

  describe('From with an UNQUOTED COMMA in the display name', () => {
    it('rejoins the split name fragments instead of showing the tail ("and APIs")', () => {
      // `From: Google Cloud Platform, and APIs <addr>` is RFC-violating, so the
      // server's ENVELOPE splits ONE sender into a name-only fragment plus the
      // addressed entry. Reading from[0] gave the address of nobody and the name
      // "Google Cloud Platform"; reading the addressed entry alone gave "and
      // APIs". Neither is the sender.
      const f = mapEnvelopeFields(env({
        from: [
          { address: '', name: 'Google Cloud Platform' },
          { address: 'CloudPlatform-noreply@google.com', name: 'and APIs' },
        ],
      }));

      expect(f.fromAddress).toBe('CloudPlatform-noreply@google.com');
      expect(f.fromName).toBe('Google Cloud Platform, and APIs');
    });

    it('does NOT rejoin when several entries are genuinely addressed', () => {
      // Two real mailboxes in From is a different (legal) shape — merging their
      // names would invent a sender. Use the first addressed entry as-is.
      const f = mapEnvelopeFields(env({
        from: [
          { address: 'a@test.local', name: 'Alice' },
          { address: 'b@test.local', name: 'Bob' },
        ],
      }));

      expect(f.fromAddress).toBe('a@test.local');
      expect(f.fromName).toBe('Alice');
    });

    it('falls back to the addressed entry when no fragment carries a name', () => {
      const f = mapEnvelopeFields(env({
        from: [{ address: '', name: '' }, { address: 'a@test.local', name: 'Alice' }],
      }));

      expect(f.fromAddress).toBe('a@test.local');
      expect(f.fromName).toBe('Alice');
    });

    it('decodes the rejoined name (fragments can each be encoded words)', () => {
      const f = mapEnvelopeFields(env({
        from: [
          { address: '', name: '=?UTF-8?B?U2Fydg==?=' },
          { address: 'x@test.local', name: 'Inbox' },
        ],
      }));

      expect(f.fromName).toBe('Sarv, Inbox');
    });
  });

  it('handles a NAME-ONLY From (no address anywhere) without inventing one', () => {
    const f = mapEnvelopeFields(env({ from: [{ address: '', name: 'No Address' }] }));

    expect(f.fromAddress).toBe('');
    expect(f.fromName).toBe('No Address');
  });
});
