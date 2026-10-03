import { describe, it, expect } from 'vitest';

import { autocryptSighting, headerStage } from '../../../src/imap/header-stage';
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

  // Regression (mailguard 0.4.3): a sender typed `dmarc=pass` into their own
  // message. The verdict the shield shows, the trusted-sender bypass and the
  // image auto-load all read this `auth`, and the score's `auth-failed` reason
  // keys on it — so the forged header must lose here, whichever side of the
  // real one it sits on.
  it('reads the receiving server\'s verdict, not a forged one, by the message\'s authserv-id', () => {
    const real = 'Authentication-Results: mx.google.com; spf=fail smtp.mailfrom=paypal.com; dkim=none; dmarc=fail header.from=paypal.com';
    const forged = 'Authentication-Results: mx.evil.example; spf=pass; dkim=pass; dmarc=pass';
    for (const authHeaders of [`${forged}\n${real}`, `${real}\n${forged}`]) {
      const { auth, spam } = headerStage(message({ authHeaders, authserv: ['mx.google.com'] }));
      expect(auth?.dmarc).toBe('fail');
      expect(spam?.reasons.map((r) => r.id)).toContain('auth-failed');
    }
  });

  // Without a known authserv-id only the topmost header counts — the receiving
  // server's on every mainstream provider — and ARC copies never do.
  it('believes only the topmost Authentication-Results when the server\'s id is unknown', () => {
    const { auth } = headerStage(message({
      authHeaders: [
        'ARC-Authentication-Results: i=1; mx.test.local; dmarc=pass',
        'Authentication-Results: mx.test.local; dmarc=fail',
        'Authentication-Results: mx.evil.example; dmarc=pass',
      ].join('\n'),
    }));
    expect(auth?.dmarc).toBe('fail');
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

/**
 * Forged origin addresses. `originIp` is what the reputation stage asks every
 * blocklist about, so an address the SENDER chooses turns a listed spam source
 * into a clean one. The forgery is one header line anybody can type:
 * `Received-SPF: pass client-ip=<a clean address>`. The first `client-ip=`
 * anywhere in the block used to win.
 */
describe('headerStage origin IP: forged headers', () => {
  // The spammer's real address, as the receiving server saw it, and the clean
  // one they would rather be judged by. Both routable: the documentation
  // ranges are `reserved` and the extractor never returns one.
  const SPAMMER = '185.199.108.1';
  const FORGED = '1.1.1.1';
  // Gmail's own verdict for a message whose SPF softfailed at the spammer's IP.
  const GMAIL_AR = `Authentication-Results: mx.google.com; spf=softfail (google.com: domain of transitioning x@evil.example does not designate ${SPAMMER} as permitted sender) smtp.mailfrom=x@evil.example; dmarc=fail header.from=evil.example`;
  const TRACE =
    `Received: from mta.evil.example (mta.evil.example. [${SPAMMER}]) by mx.google.com with ESMTPS id 1; Thu, 1 Jan 2026 00:00:01 +0000\r\n` +
    'Subject: Subject\r\n';

  // Regression: THE bug. The sender's Received-SPF sits below everything the
  // receiving server prepended; its client-ip was read before the real one.
  it('records the address the receiving server saw, not a forged Received-SPF', () => {
    const authHeaders = [GMAIL_AR, `Received-SPF: pass (evil) client-ip=${FORGED};`].join('\n');
    for (const authserv of [['mx.google.com'], undefined]) {
      expect(headerStage(message({ authHeaders, authserv, rawHeaders: TRACE })).originIp).toBe(SPAMMER);
    }
  });

  // Regression: an ARC header is a copy sealed for the NEXT hop and is
  // prepended like any other, so a sender's copy can sit on top of the block.
  it('never takes the address from an ARC-Authentication-Results', () => {
    const arc = `ARC-Authentication-Results: i=1; mx.google.com; spf=pass (google.com: domain of x designates ${FORGED} as permitted sender) smtp.mailfrom=x; iprev=pass smtp.remote-ip=${FORGED}`;
    const { originIp } = headerStage(message({ authHeaders: [arc, GMAIL_AR].join('\n'), authserv: ['mx.google.com'] }));
    expect(originIp).toBe(SPAMMER);
  });

  // Regression: the message's authserv-id has to reach the extractor, not
  // just the verdict. A forged header on TOP naming another server is what
  // it rescues. Without the id the topmost header is believed (the same known
  // limit the verdict has), which is why the Gmail account gets the real
  // address and an account on an unknown provider does not. That limit
  // closes for any provider added to receiving-authserv.
  it('reads the address from the server the message\'s authserv-id names', () => {
    const forgedAr = `Authentication-Results: mx.evil.example; spf=pass (sender IP is ${FORGED})`;
    const authHeaders = [forgedAr, GMAIL_AR].join('\n');
    const gmail = headerStage(message({ authHeaders, authserv: ['mx.google.com'], rawHeaders: TRACE }));
    expect(gmail.originIp).toBe(SPAMMER);
    expect(gmail.auth?.dmarc).toBe('fail');
    const unknownProvider = headerStage(message({ authHeaders, rawHeaders: TRACE }));
    expect(unknownProvider.originIp).toBe(FORGED);
  });

  // With no trusted header naming an address, the Received trace the
  // receiving server wrote answers. Never the forged lines beside it.
  it('falls back to the Received trace when no trusted header names an address', () => {
    const authHeaders = [
      `Authentication-Results: mx.evil.example; spf=pass (sender IP is ${FORGED})`,
      `Received-SPF: pass client-ip=${FORGED};`,
    ].join('\n');
    const { originIp, auth } = headerStage(message({ authHeaders, authserv: ['mx.google.com'], rawHeaders: TRACE }));
    expect(originIp).toBe(SPAMMER);
    // The same rule left the verdict untrusted too: no header was believed.
    expect(auth).toMatchObject({ spf: 'unknown', dkim: 'unknown', dmarc: 'unknown' });
  });
});


/**
 * The unsubscribe headers the stage lifts out for storage (migration v93).
 *
 * What breaks if these go red: the Unsubscribe button never appears, or worse,
 * appears pointing at a truncated URL. Both look like ordinary mail — nobody
 * reports "the button I have never seen is missing".
 */
describe('headerStage unsubscribe headers', () => {
  it('lifts both List-Unsubscribe headers out verbatim', () => {
    const { unsubscribe } = headerStage(message({
      rawHeaders: [
        'From: news@brand.example',
        'List-Unsubscribe: <https://brand.example/u/abc>, <mailto:u@brand.example>',
        'List-Unsubscribe-Post: List-Unsubscribe=One-Click',
        '',
      ].join('\r\n'),
    }));
    expect(unsubscribe).toEqual({
      listUnsubscribe: '<https://brand.example/u/abc>, <mailto:u@brand.example>',
      listUnsubscribePost: 'List-Unsubscribe=One-Click',
    });
  });

  // Regression: senders wrap these headers because they are long, and a value
  // cut at the fold is a URL that 404s when the reader finally clicks it.
  it('unfolds a header the sender wrapped across lines', () => {
    const { unsubscribe } = headerStage(message({
      rawHeaders: 'List-Unsubscribe: <mailto:u@brand.example>,\r\n <https://brand.example/u/abc>\r\n\r\n',
    }));
    expect(unsubscribe.listUnsubscribe).toContain('https://brand.example/u/abc');
  });

  // Ordinary mail is most mail. Both null, never an empty string — the column
  // then reads as "this sender published no way off a list", which is the truth.
  it('reports both null on a message with neither header, and with no headers at all', () => {
    expect(headerStage(message({ rawHeaders: 'From: a@b.example\r\n\r\n' })).unsubscribe).toEqual({
      listUnsubscribe: null,
      listUnsubscribePost: null,
    });
    expect(headerStage(message()).unsubscribe).toEqual({
      listUnsubscribe: null,
      listUnsubscribePost: null,
    });
  });

  // A sender who declares one-click but publishes no address, and one who
  // publishes an address without declaring one-click, are both stored as they
  // arrived: the parse that reconciles them runs at read time, so a better
  // parser later improves mail already in the mailbox.
  it('stores each header independently of the other', () => {
    const postOnly = headerStage(message({ rawHeaders: 'List-Unsubscribe-Post: List-Unsubscribe=One-Click\r\n\r\n' }));
    expect(postOnly.unsubscribe).toEqual({
      listUnsubscribe: null,
      listUnsubscribePost: 'List-Unsubscribe=One-Click',
    });
  });
});

describe('autocryptSighting', () => {
  const header = 'addr=sender@test.local; keydata=AAAA';

  // Breaks: the keyring never sees the sender's key, or sees it under the
  // wrong address or date.
  it('reads the one Autocrypt header with the envelope From and a UTC date', () => {
    expect(autocryptSighting(message({ rawHeaders: `Autocrypt: ${header}\r\n` }))).toEqual({
      fromAddress: 'sender@test.local',
      header,
      sentAt: '2026-01-01T00:00:00.000Z',
    });
  });

  // Breaks: a message dated in the future would stand as the "most recent"
  // sighting and pin a stale key over every real one after it (the spec's
  // effective date is min(Date, arrival)).
  it('clamps a future Date header to the arrival time', () => {
    const future = message({
      rawHeaders: `Autocrypt: ${header}\r\n`,
      envelope: { ...message().envelope, date: new Date('2030-01-01T00:00:00Z') },
    });
    expect(autocryptSighting(future)?.sentAt).toBe('2026-01-01T00:00:05.000Z');
  });

  // Breaks: with two headers, one of which cannot be the sender's, the
  // keyring would learn whichever came first. The spec says: treat as none.
  it('ignores a message with more than one Autocrypt header, or none', () => {
    expect(autocryptSighting(message({ rawHeaders: `Autocrypt: ${header}\r\nAutocrypt: ${header}\r\n` }))).toBeNull();
    expect(autocryptSighting(message({ rawHeaders: 'Subject: hi\r\n' }))).toBeNull();
    expect(autocryptSighting(message())).toBeNull();
  });

  // Breaks: a header with nothing to check its addr against would be accepted
  // for any address it names.
  it('ignores a message with no From address or no usable date', () => {
    const base = message({ rawHeaders: `Autocrypt: ${header}\r\n` });
    expect(autocryptSighting({ ...base, envelope: { ...base.envelope, from: [] } })).toBeNull();
    expect(
      autocryptSighting({ ...base, date: new Date('nope'), envelope: { ...base.envelope, date: null } }),
    ).toBeNull();
  });
});
