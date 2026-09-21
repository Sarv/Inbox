import { describe, it, expect } from 'vitest';

import { headerStage } from '../../../src/imap/header-stage';
import type { IMAPMessage } from '../../../src/types/imap';

/**
 * `headerStage` is the ONE derivation of `auth_status`, `spam_score` /
 * `spam_reasons` and `origin_ip` from a fetched message, shared by ingest
 * (`convertMessage`) and the header backfill that sweeps older mail.
 *
 * Why that matters enough to test on its own: a score that depends on which
 * code path wrote it is not a score. If the two callers derived it separately,
 * the Spam filter view would list a message swept today that an identical
 * message arriving tomorrow would not appear in, and nobody could tell which
 * run was right. These pin the contract both of them rely on — most of all the
 * two nulls, each of which means something different downstream.
 */

const message = (over: Partial<IMAPMessage> = {}): IMAPMessage => ({
  uid: 1,
  seqNo: 1,
  flags: [],
  date: new Date('2026-01-01T00:00:05Z'),
  size: 100,
  envelope: {
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
  },
  ...over,
}) as IMAPMessage;

describe('headerStage', () => {
  it('parses the authentication block the receiving server recorded', () => {
    const { auth } = headerStage(message({
      authHeaders: 'Authentication-Results: mx.test.local; spf=pass; dkim=pass; dmarc=pass',
    }));
    expect(auth).toMatchObject({ spf: 'pass', dkim: 'pass', dmarc: 'pass' });
  });

  // NULL here means exactly "the server recorded no verdict", and that is what
  // the scorer must see — an all-unknown verdict would look like a judgement
  // that was made. The backfill converts it to one only at the point of
  // STORING, where NULL instead means "not checked yet".
  it('returns a null verdict, not an all-unknown one, when there is no auth header', () => {
    expect(headerStage(message()).auth).toBeNull();
  });

  // The score keys on the very same DMARC verdict the shield displays; parsing
  // the block twice would let the two disagree on screen about one message.
  it('scores a DMARC failure the shield would show as failed', () => {
    const { spam, auth } = headerStage(message({
      authHeaders: 'Authentication-Results: mx.test.local; spf=fail; dkim=fail; dmarc=fail',
    }));
    expect(auth?.dmarc).toBe('fail');
    expect(spam?.reasons.map((r) => r.id)).toContain('auth-failed');
    expect(spam!.score).toBeGreaterThan(0);
  });

  // A different null with a different meaning: own mail is NOT JUDGED, which
  // the shield renders differently from "judged clean". Scoring the user's own
  // words would hide their sent replies behind a spam tag.
  it('never scores own mail, while still reading its auth verdict and origin IP', () => {
    const msg = message({
      authHeaders: 'Authentication-Results: mx.test.local; dmarc=fail',
      // A routable address on purpose: the RFC 5737 documentation ranges
      // (192.0.2.x, 198.51.100.x, 203.0.113.x) are classified `reserved`, and
      // the extractor only ever returns a public unicast address.
      rawHeaders: 'Received: from mta.test.local ([93.184.216.34]) by mx.test.local; Thu, 1 Jan 2026 00:00:00 +0000\r\n',
    });
    const own = headerStage(msg, { ownMail: true });
    expect(own.spam).toBeNull();
    expect(own.auth?.dmarc).toBe('fail');
    expect(own.originIp).toBe('93.184.216.34');
    // The same message in an ordinary folder IS scored — the only difference
    // is the flag.
    expect(headerStage(msg, { ownMail: false }).spam).not.toBeNull();
  });

  // The user's own report is an input to the score at ingest; a message swept
  // later must get the same points for it or the two runs disagree.
  it('carries the reported-sender flag into the score', () => {
    const clean = headerStage(message());
    const reported = headerStage(message(), { knownSpammer: true });
    expect(reported.spam!.score).toBeGreaterThan(clean.spam!.score);
    expect(reported.spam!.reasons.map((r) => r.id)).toContain('known-spammer');
  });

  // A synthesised Message-ID is this client's own invention for a message that
  // arrived without one. Passing it to the scorer would hide the missing
  // header — the very signal the rule exists to catch.
  it('scores a synthesised Message-ID as the missing header it stands in for', () => {
    const synthesised = headerStage(message({ messageIdSynthesized: true }));
    expect(synthesised.spam!.reasons.map((r) => r.id)).toContain('missing-message-id');
    expect(headerStage(message()).spam!.reasons.map((r) => r.id)).not.toContain('missing-message-id');
  });

  it('extracts the connecting IP from the Received chain', () => {
    const { originIp } = headerStage(message({
      rawHeaders:
        'Received: from relay.test.local ([8.8.4.4]) by mx.test.local; Thu, 1 Jan 2026 00:00:01 +0000\r\n' +
        'Subject: Subject\r\n',
    }));
    expect(originIp).toBe('8.8.4.4');
  });

  // A headers-only FETCH can come back with nothing but an envelope (a server
  // that dropped the peek, a message whose headers were stripped). It must
  // produce a verdict, not throw, or one odd message stalls the whole sweep.
  it('still returns a verdict when the message carries no headers at all', () => {
    const r = headerStage(message());
    expect(r.auth).toBeNull();
    expect(r.originIp).toBeNull();
    expect(r.spam).not.toBeNull();
  });

  // An unparseable or absent Date must not become NaN seconds — a rule that
  // compares it to INTERNALDATE would then fire on every such message.
  it('tolerates an unparseable envelope date', () => {
    const r = headerStage(message({ envelope: { ...message().envelope, date: new Date('nonsense') } }));
    expect(r.spam).not.toBeNull();
  });
});
