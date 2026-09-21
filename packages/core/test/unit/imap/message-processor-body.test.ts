import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MessageProcessor } from '../../../src/imap/message-processor';
import { FakeEmailStorage, resetFakeStorageIds } from '../../../src/test-support/fake-email-storage';
import { FakeImapServer, resetFakeMessageIds } from '../../../src/test-support/fake-imap-server';
import type { IMAPMessage } from '../../../src/types/imap';
import { BODY_FETCH_DEFERRED } from '../../../src/utils/deferred-fetch-error';


// Body fetching is the LAZY half of ingest: sync stores headers, and the body is
// downloaded later, by UID, on a shared connection. That makes it the one path
// where a UID can be plain WRONG by the time it's used — the mailbox may have been
// re-selected, renumbered, or the row repointed — and a wrong body is worse than
// no body: a newsletter rendered inside an unrelated work thread. So fetchBody
// must (a) verify the fetched message's identity against the stored Message-ID and
// (b) REPAIR the stale UID from the message-id instead of looping forever on an
// empty body.
//
// It is also where attachment metadata becomes authoritative (parsed from the real
// source, matching what the download path will look for) and where a calendar
// invite is captured.
//
// Sibling message-body-charset.test.ts covers parseBody's charset decoding; this
// file covers its attachment/calendar extraction plus the whole fetchBody flow.

const INBOX = 'INBOX';

function setup() {
  resetFakeMessageIds();
  resetFakeStorageIds();
  const server = new FakeImapServer();
  server.addFolder(INBOX, { uidValidity: 1 });
  const db = new FakeEmailStorage();
  db.addFolder(INBOX, { uidValidity: 1 });
  return { server, db, mp: new MessageProcessor({ headersOnly: false }) };
}

const crlf = (lines: string[]): string => lines.join('\r\n');

/** A multipart message with one real attachment. */
const withAttachment = (messageId: string): string => crlf([
  `Message-ID: ${messageId}`,
  'Subject: Invoice',
  'From: sender@test.local',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary=BOUND',
  '',
  '--BOUND',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'See attached.',
  '--BOUND',
  'Content-Type: application/pdf; name="invoice.pdf"',
  'Content-Disposition: attachment; filename="invoice.pdf"',
  'Content-Transfer-Encoding: base64',
  '',
  Buffer.from('%PDF-1.4 fake').toString('base64'),
  '--BOUND--',
  '',
]);

/**
 * A message whose .txt attachment declares base64 but carries RAW HTML text —
 * the shape of the real message this was found on. A base64 decoder keeps only
 * alphabet characters and stops at the first `=`, so mailparser decodes this to
 * a handful of junk bytes.
 */
const withLyingBase64Attachment = (messageId: string, encoding = 'base64'): string => crlf([
  `Message-ID: ${messageId}`,
  'Subject: Decorated',
  'From: sender@test.local',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary=BOUND',
  '',
  '--BOUND',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'See attached.',
  '--BOUND',
  'Content-Type: text/plain; name="note.txt"',
  'Content-Disposition: attachment; filename="note.txt"',
  `Content-Transfer-Encoding: ${encoding}`,
  '',
  '<p><span style="font-family: sans-serif;">Hello World</span></p>',
  '--BOUND--',
  '',
]);

/** The bodystructure the server reports for that same message. */
const lyingStructure = (declaredSize: number, encoding = 'base64'): IMAPMessage['bodyStructure'] => ({
  type: 'multipart', subtype: 'mixed', params: {}, id: null, description: null,
  encoding: '7bit', size: 0, disposition: null,
  parts: [
    {
      type: 'text', subtype: 'plain', params: {}, id: null, description: null,
      encoding: '7bit', size: 13, disposition: null, part: '1',
    },
    {
      type: 'text', subtype: 'plain', params: { name: 'note.txt' }, id: null, description: null,
      encoding, size: declaredSize, part: '2',
      disposition: { type: 'attachment', params: { filename: 'note.txt' } },
    },
  ],
} as IMAPMessage['bodyStructure']);

const ICS = crlf([
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'BEGIN:VEVENT',
  'UID:evt-1@test.local',
  'SUMMARY:Standup',
  'END:VEVENT',
  'END:VCALENDAR',
]);

/** A calendar invite: an unnamed text/calendar part, as Google Calendar sends. */
const withInvite = (messageId: string): string => crlf([
  `Message-ID: ${messageId}`,
  'Subject: Standup',
  'From: organiser@test.local',
  'MIME-Version: 1.0',
  'Content-Type: multipart/alternative; boundary=BOUND',
  '',
  '--BOUND',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'You are invited.',
  '--BOUND',
  'Content-Type: text/calendar; charset=utf-8; method=REQUEST',
  '',
  ICS,
  '--BOUND--',
  '',
]);

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('fetchBody', () => {
  it('stores the parsed body and hands the RAW source back for "Show Original"', async () => {
    const ctx = setup();
    const uid = ctx.server.addMessage(INBOX, { subject: 'Hello', messageId: '<a@test.local>' });
    const row = ctx.db.seedEmail({
      folderId: ctx.db.folderId(INBOX), uid, tags: `|${INBOX}|`, messageId: '<a@test.local>',
    });

    const res = await ctx.mp.fetchBody(ctx.server, INBOX, uid, ctx.db.asStorage(), row.id);

    expect(res!.cleanBody).toContain('Body of Hello');
    expect(res!.contentType).toBe('text');
    // The source is downloaded here anyway — returning it saves a second fetch.
    expect(res!.source).toContain('Message-ID: <a@test.local>');
    expect(ctx.db.row(row.id)!.cleanBody).toContain('Body of Hello');
  });

  it('returns null for a GHOST uid without touching the row', async () => {
    const ctx = setup();
    const row = ctx.db.seedEmail({
      folderId: ctx.db.folderId(INBOX), uid: 99, tags: `|${INBOX}|`, messageId: '<a@test.local>',
    });

    const res = await ctx.mp.fetchBody(ctx.server, INBOX, 99, ctx.db.asStorage(), row.id);

    expect(res).toBeNull();
    expect(ctx.db.callCount('updateEmail')).toBe(0);
    expect(ctx.db.row(row.id)!.cleanBody).toBe('');
  });

  it('returns null when the server has the message but no body', async () => {
    const ctx = setup();
    const uid = ctx.server.addMessage(INBOX, { messageId: '<a@test.local>', body: '' });
    const row = ctx.db.seedEmail({
      folderId: ctx.db.folderId(INBOX), uid, tags: `|${INBOX}|`, messageId: '<a@test.local>',
    });

    expect(await ctx.mp.fetchBody(ctx.server, INBOX, uid, ctx.db.asStorage(), row.id)).toBeNull();
    expect(ctx.db.callCount('updateEmail')).toBe(0);
  });

  it('REPAIRS a stale UID by re-resolving the message-id, and writes the right body', async () => {
    // The reported bug: UID 1 now holds a newsletter, so the work email got the
    // newsletter's body. Discarding alone left it permanently blank (every retry
    // re-fetched the same wrong slot), so the UID must be repaired.
    const ctx = setup();
    ctx.server.addMessage(INBOX, { subject: 'Newsletter', messageId: '<newsletter@test.local>' }); // uid 1
    const realUid = ctx.server.addMessage(INBOX, { subject: 'Work', messageId: '<work@test.local>' });
    const row = ctx.db.seedEmail({
      folderId: ctx.db.folderId(INBOX), uid: 1, tags: `|${INBOX}|`, messageId: '<work@test.local>',
    });

    const res = await ctx.mp.fetchBody(ctx.server, INBOX, 1, ctx.db.asStorage(), row.id);

    expect(res!.cleanBody).toContain('Body of Work');
    expect(res!.cleanBody).not.toContain('Newsletter');
    expect(ctx.db.row(row.id)!.uid).toBe(realUid); // stale uid healed
  });

  it('RESOLVES a MISSING uid (null, from a folder relink) via message-id and repairs the row', async () => {
    // The Gmail backlog bug: a category-label move cleared the row's uid, so it
    // sat body-less forever — body-prefetch short-circuited on the null uid and
    // re-seeded it every tick (0/N fetched, backlog frozen). fetchBody must fall
    // back to the message-id, find the real uid, fetch the body and heal the row.
    const ctx = setup();
    const realUid = ctx.server.addMessage(INBOX, { subject: 'Relinked', messageId: '<relinked@test.local>' });
    const row = ctx.db.seedEmail({
      folderId: ctx.db.folderId(INBOX), uid: 0, tags: `|${INBOX}|`, messageId: '<relinked@test.local>',
    });

    // 0 = "no uid" (what the scheduler passes for email.uid ?? 0).
    const res = await ctx.mp.fetchBody(ctx.server, INBOX, 0, ctx.db.asStorage(), row.id);

    expect(res!.cleanBody).toContain('Body of Relinked');
    expect(ctx.db.row(row.id)!.uid).toBe(realUid); // missing uid healed → won't re-seed
    expect(ctx.db.row(row.id)!.cleanBody).toContain('Body of Relinked');
  });

  it('returns a null VERDICT for a missing uid whose message-id is not on the server', async () => {
    // Truly unresolvable (relinked away / expunged): must NOT loop — a null verdict
    // lets body-prefetch accrue a strike and eventually stop re-seeding it.
    const ctx = setup();
    ctx.server.addMessage(INBOX, { subject: 'Other', messageId: '<other@test.local>' });
    const row = ctx.db.seedEmail({
      folderId: ctx.db.folderId(INBOX), uid: 0, tags: `|${INBOX}|`, messageId: '<gone@test.local>',
    });

    const res = await ctx.mp.fetchBody(ctx.server, INBOX, 0, ctx.db.asStorage(), row.id);

    expect(res).toBeNull();
    expect(ctx.db.row(row.id)!.cleanBody).toBe('');
  });

  it('leaves the body EMPTY (never writes the wrong one) when re-resolution finds nothing', async () => {
    const ctx = setup();
    ctx.server.addMessage(INBOX, { subject: 'Newsletter', messageId: '<newsletter@test.local>' });
    const row = ctx.db.seedEmail({
      folderId: ctx.db.folderId(INBOX), uid: 1, tags: `|${INBOX}|`, messageId: '<gone@test.local>',
    });

    const res = await ctx.mp.fetchBody(ctx.server, INBOX, 1, ctx.db.asStorage(), row.id);

    expect(res).toBeNull();
    expect(ctx.db.row(row.id)!.cleanBody).toBe('');
    expect(ctx.db.row(row.id)!.uid).toBe(1); // not repaired to something wrong
  });

  it('refuses a re-resolved UID that STILL does not match — and DEFERS rather than answering', async () => {
    // The HEADER search substring-matches, so it can hit a message that quotes the
    // id in a header without being it. The identity check must run again.
    //
    // UPDATED (deliberate): this used to return null, which the prefetch scheduler
    // counts as "the server has no such message" and retires the row after 3
    // ticks. But the search DID find something — the mailbox is inconsistent with
    // our UID right now, which is a reason to ask again, not to give up on live
    // mail. The row is still left untouched (no wrong body written).
    const ctx = setup();
    ctx.server.addMessage(INBOX, { subject: 'Newsletter', messageId: '<newsletter@test.local>' });
    // uid 2's RAW header claims the wanted id, but its envelope id is different.
    ctx.server.addMessage(INBOX, {
      messageId: '<impostor@test.local>',
      body: crlf(['Message-ID: <work@test.local>', 'Subject: Impostor', '', 'body', '']),
    });
    const row = ctx.db.seedEmail({
      folderId: ctx.db.folderId(INBOX), uid: 1, tags: `|${INBOX}|`, messageId: '<work@test.local>',
    });

    await expect(ctx.mp.fetchBody(ctx.server, INBOX, 1, ctx.db.asStorage(), row.id))
      .rejects.toMatchObject({ code: BODY_FETCH_DEFERRED });
    expect(ctx.db.row(row.id)!.cleanBody).toBe('');
  });

  it('DEFERS when the HEADER search itself fails — a broken search is not a verdict', async () => {
    // UPDATED (deliberate): this returned null, so a SEARCH that timed out or hit a
    // dropped socket was reported as "no such message" and the row was retired
    // after 3 ticks. app.log showed 332 emails given up with ZERO "no message
    // found" lines — none of them had actually been answered by the server. The
    // caller must be told to ask again.
    const ctx = setup();
    ctx.server.addMessage(INBOX, { messageId: '<newsletter@test.local>' });
    const row = ctx.db.seedEmail({
      folderId: ctx.db.folderId(INBOX), uid: 1, tags: `|${INBOX}|`, messageId: '<work@test.local>',
    });
    vi.spyOn(ctx.server, 'search').mockRejectedValue(new Error('NO unsupported SEARCH'));

    await expect(ctx.mp.fetchBody(ctx.server, INBOX, 1, ctx.db.asStorage(), row.id))
      .rejects.toMatchObject({ code: BODY_FETCH_DEFERRED });
    expect(ctx.db.row(row.id)!.cleanBody).toBe(''); // and no wrong body written
  });

  it('DEFERS when the search finds the message only at the UID that just failed', async () => {
    // The FETCH said "nothing at UID 1" while the SEARCH says the message-id IS at
    // UID 1 — the two disagree, so the mailbox shifted under us. A contradiction is
    // a reason to retry; treating it as a verdict retires a message the server has.
    const ctx = setup();
    const uid = ctx.server.addMessage(INBOX, { subject: 'Work', messageId: '<work@test.local>' });
    const row = ctx.db.seedEmail({
      folderId: ctx.db.folderId(INBOX), uid, tags: `|${INBOX}|`, messageId: '<work@test.local>',
    });
    // Fetch comes back empty (the transient half), search still resolves the id.
    vi.spyOn(ctx.server, 'fetchMessagesByUID').mockResolvedValue([]);

    await expect(ctx.mp.fetchBody(ctx.server, INBOX, uid, ctx.db.asStorage(), row.id))
      .rejects.toMatchObject({ code: BODY_FETCH_DEFERRED });
    expect(ctx.db.row(row.id)!.uid).toBe(uid); // row untouched
  });

  it('still returns a null VERDICT when the search legitimately finds nothing', async () => {
    // The other side of the split: zero hits means the server WAS asked and has no
    // such message-id. That must stay a verdict, or a genuinely expunged ghost row
    // is re-seeded every tick forever (the backlog that never drained).
    const ctx = setup();
    ctx.server.addMessage(INBOX, { messageId: '<newsletter@test.local>' });
    const row = ctx.db.seedEmail({
      folderId: ctx.db.folderId(INBOX), uid: 1, tags: `|${INBOX}|`, messageId: '<gone@test.local>',
    });

    expect(await ctx.mp.fetchBody(ctx.server, INBOX, 1, ctx.db.asStorage(), row.id)).toBeNull();
  });

  it('accepts the body when the SERVER omits the message-id (no identity to check)', async () => {
    const ctx = setup();
    const uid = ctx.server.addMessage(INBOX, { messageId: '' , subject: 'Anon' });
    const row = ctx.db.seedEmail({
      folderId: ctx.db.folderId(INBOX), uid, tags: `|${INBOX}|`, messageId: '<stored@test.local>',
    });

    const res = await ctx.mp.fetchBody(ctx.server, INBOX, uid, ctx.db.asStorage(), row.id);

    expect(res!.cleanBody).toContain('Body of Anon');
    expect(ctx.server.callCount('search')).toBe(0); // no repair attempted
  });

  it('writes AUTHORITATIVE attachment names + sizes from the source', async () => {
    const ctx = setup();
    const uid = ctx.server.addMessage(INBOX, {
      messageId: '<inv@test.local>', body: withAttachment('<inv@test.local>'),
    });
    const row = ctx.db.seedEmail({
      folderId: ctx.db.folderId(INBOX), uid, tags: `|${INBOX}|`, messageId: '<inv@test.local>',
      hasAttachments: false, attachmentCount: 0,
    });

    await ctx.mp.fetchBody(ctx.server, INBOX, uid, ctx.db.asStorage(), row.id);

    const stored = ctx.db.row(row.id)!;
    expect(stored.hasAttachments).toBe(true);
    expect(stored.attachmentCount).toBe(1);
    expect(JSON.parse(stored.attachmentNames!)).toEqual(['invoice.pdf']);
    expect(JSON.parse(stored.attachmentSizes!)[0]).toBeGreaterThan(0);
  });

  // Stored sizes come from the DECODED part, so a part whose
  // Content-Transfer-Encoding header lies poisons them: raw text claiming
  // `base64` collapses to junk and a 64-byte .txt was listed as "7 B" on the
  // chip and in the viewer header — the size the real message showed. The
  // honest number is the part's RAW length in the source just parsed, and
  // deliberately NOT the size the server declared in BODYSTRUCTURE (400 here):
  // mailboxes exist that return every bodystructure parameter with its value
  // missing, so neither the filename nor the size is there to compare against.
  // Breaks if the source cross-check is dropped: the row advertises the junk
  // size again even though the download path now recovers the real content.
  it('stores the part’s RAW source length when it lies about being base64', async () => {
    const ctx = setup();
    const messageId = '<lying@test.local>';
    const row = ctx.db.seedEmail({
      folderId: ctx.db.folderId(INBOX), uid: 5, tags: `|${INBOX}|`, messageId,
    });
    vi.spyOn(ctx.server, 'fetchMessagesByUID').mockResolvedValue([{
      uid: 5, body: withLyingBase64Attachment(messageId),
      envelope: { messageId }, bodyStructure: lyingStructure(400),
    } as unknown as IMAPMessage]);

    await ctx.mp.fetchBody(ctx.server, INBOX, 5, ctx.db.asStorage(), row.id);

    const stored = ctx.db.row(row.id)!;
    expect(JSON.parse(stored.attachmentNames!)).toEqual(['note.txt']);
    // 64 = the part's body in the source. Not 7 (the collapsed decode) and not
    // 400 (what the server claimed).
    expect(JSON.parse(stored.attachmentSizes!)).toEqual([64]);
  });

  it('does NOT override the decoded size when the part never claimed base64', async () => {
    // Breaks if the correction keys off size alone: a genuinely tiny attachment
    // would be re-labelled with the size of its MIME part, headers included.
    // The SOURCE is what decides this now, so it is the source's CTE that is
    // varied here — the bodystructure below still says base64 and must not matter.
    const ctx = setup();
    const messageId = '<7bit@test.local>';
    const row = ctx.db.seedEmail({
      folderId: ctx.db.folderId(INBOX), uid: 6, tags: `|${INBOX}|`, messageId,
    });
    vi.spyOn(ctx.server, 'fetchMessagesByUID').mockResolvedValue([{
      uid: 6, body: withLyingBase64Attachment(messageId, '7bit'),
      envelope: { messageId }, bodyStructure: lyingStructure(400),
    } as unknown as IMAPMessage]);

    await ctx.mp.fetchBody(ctx.server, INBOX, 6, ctx.db.asStorage(), row.id);

    // A 7bit part decodes to itself: the 64 source bytes, unchanged.
    expect(JSON.parse(ctx.db.row(row.id)!.attachmentSizes!)).toEqual([64]);
  });

  it('corrects the size even when the server sends a bodystructure with no values', async () => {
    // THE reason this moved off BODYSTRUCTURE. The mailbox that produced the
    // report returns every parameter with its VALUE missing — `("NAME" )`,
    // `("FILENAME" )`, `("BOUNDARY" )` — so there is no filename to match and no
    // size to compare, and three successive fixes keyed off it did nothing at
    // all. Breaks if the size correction ever consults the server's structure
    // again: the chip goes back to showing "7 B" for a 1 KB attachment.
    const ctx = setup();
    const messageId = '<stripped@test.local>';
    const row = ctx.db.seedEmail({
      folderId: ctx.db.folderId(INBOX), uid: 8, tags: `|${INBOX}|`, messageId,
    });
    const stripped = {
      type: 'multipart/mixed',
      parts: [
        { type: 'text/plain', part: '1', params: {} },
        { type: 'text/plain', part: '2', encoding: '', size: 0, params: {}, disposition: null },
      ],
    };
    vi.spyOn(ctx.server, 'fetchMessagesByUID').mockResolvedValue([{
      uid: 8, body: withLyingBase64Attachment(messageId),
      envelope: { messageId }, bodyStructure: stripped,
    } as unknown as IMAPMessage]);

    await ctx.mp.fetchBody(ctx.server, INBOX, 8, ctx.db.asStorage(), row.id);

    expect(JSON.parse(ctx.db.row(row.id)!.attachmentSizes!)).toEqual([64]);
  });

  it('leaves a healthy base64 attachment at its decoded size', async () => {
    // Breaks if the heuristic fires on normal mail: every attachment would be
    // listed at its ENCODED size, ~33% larger than the file the user gets.
    const ctx = setup();
    const messageId = '<healthy@test.local>';
    const row = ctx.db.seedEmail({
      folderId: ctx.db.folderId(INBOX), uid: 7, tags: `|${INBOX}|`, messageId,
    });
    const structure = lyingStructure(20);
    structure!.parts![1].disposition!.params.filename = 'invoice.pdf';
    vi.spyOn(ctx.server, 'fetchMessagesByUID').mockResolvedValue([{
      uid: 7, body: withAttachment(messageId), envelope: { messageId }, bodyStructure: structure,
    } as unknown as IMAPMessage]);

    await ctx.mp.fetchBody(ctx.server, INBOX, 7, ctx.db.asStorage(), row.id);

    // '%PDF-1.4 fake' is 13 bytes decoded from 20 of base64 — plausible, kept.
    expect(JSON.parse(ctx.db.row(row.id)!.attachmentSizes!)).toEqual([13]);
  });

  it('CORRECTS a body-structure over-count when the source has no attachments', async () => {
    // The BODYSTRUCTURE walk counts inline images as attachments; left uncorrected
    // the paperclip stays and every open re-triggers a source re-fetch.
    const ctx = setup();
    const uid = ctx.server.addMessage(INBOX, { messageId: '<a@test.local>' });
    const row = ctx.db.seedEmail({
      folderId: ctx.db.folderId(INBOX), uid, tags: `|${INBOX}|`, messageId: '<a@test.local>',
      hasAttachments: true, attachmentCount: 3,
    });

    await ctx.mp.fetchBody(ctx.server, INBOX, uid, ctx.db.asStorage(), row.id);

    expect(ctx.db.row(row.id)!.hasAttachments).toBe(false);
    expect(ctx.db.row(row.id)!.attachmentCount).toBe(0);
  });

  it('captures a calendar invite so the event card renders offline', async () => {
    const ctx = setup();
    const uid = ctx.server.addMessage(INBOX, {
      messageId: '<evt@test.local>', body: withInvite('<evt@test.local>'),
    });
    const row = ctx.db.seedEmail({
      folderId: ctx.db.folderId(INBOX), uid, tags: `|${INBOX}|`, messageId: '<evt@test.local>',
    });

    await ctx.mp.fetchBody(ctx.server, INBOX, uid, ctx.db.asStorage(), row.id);

    expect(ctx.db.row(row.id)!.calendarIcs).toContain('BEGIN:VCALENDAR');
    expect(ctx.db.row(row.id)!.calendarIcs).toContain('SUMMARY:Standup');
  });

  // RECOVERY for mail already stored garbled. body-reheal-scheduler finds rows
  // whose stored body carries U+FFFD and re-fetches them through here — but for
  // a message whose SENDER declared the wrong charset, the server's copy tells
  // the same lie, so the re-fetch used to rewrite the identical mojibake and the
  // row stayed corrupt for good. Breaks: that permanence comes back, and a user
  // on an older build never recovers the bodies it already ruined.
  it('HEALS a stored body that was saved with replacement characters', async () => {
    const ctx = setup();
    const source = [
      'Message-ID: <mislabelled@test.local>',
      'Subject: Order update',
      'From: sender@test.local',
      'Content-Type: text/plain; charset=us-ascii', // the lie
      '',
      // Windows-1252 bytes, one char per byte, exactly as the fetch layer hands
      // them over (latin1). 0xe9 = é, 0xef = ï, 0x92 = right single quote.
      'Dear customer, we couldn\x92t process your order because the caf\xe9 was '
      + 'closed. Please r\xe9sum\xe9 the na\xefve request at your convenience.',
      '',
    ].join('\r\n');
    const uid = ctx.server.addMessage(INBOX, { messageId: '<mislabelled@test.local>', body: source });
    const row = ctx.db.seedEmail({
      folderId: ctx.db.folderId(INBOX),
      uid,
      tags: `|${INBOX}|`,
      messageId: '<mislabelled@test.local>',
      // What the old build wrote: the corruption the re-heal scan looks for.
      cleanBody: 'Dear customer, we couldn�t process your order because the caf� was closed.',
      rawBody: 'Dear customer, we couldn�t process your order because the caf� was closed.',
    });

    await ctx.mp.fetchBody(ctx.server, INBOX, uid, ctx.db.asStorage(), row.id);

    const healed = ctx.db.row(row.id)!;
    expect(healed.cleanBody).toContain('café');
    expect(healed.cleanBody).toContain('naïve');
    expect(healed.cleanBody).not.toContain('�');
    expect(healed.rawBody).not.toContain('�');
  });
});

describe('parseBody — attachments and invites', () => {
  const mp = new MessageProcessor({ headersOnly: false });

  it('reports a real attachment with its decoded name and byte size', async () => {
    const parsed = await mp.parseBody(withAttachment('<inv@test.local>'));

    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0].name).toBe('invoice.pdf');
    expect(parsed.attachments[0].contentType).toBe('application/pdf');
    expect(parsed.attachments[0].size).toBeGreaterThan(0);
  });

  it('EXCLUDES an inline (cid:) image — it is not a downloadable file', async () => {
    const raw = crlf([
      'Content-Type: multipart/related; boundary=B',
      '',
      '--B',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<p>Hi <img src="cid:logo"></p>',
      '--B',
      'Content-Type: image/png; name="logo.png"',
      'Content-Disposition: inline; filename="logo.png"',
      'Content-ID: <logo>',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from('PNGDATA').toString('base64'),
      '--B--',
      '',
    ]);

    const parsed = await mp.parseBody(raw);

    expect(parsed.attachments).toEqual([]);
    expect(parsed.contentType).toBe('html');
  });

  it('captures the invite but keeps the unnamed calendar part OUT of the file list', async () => {
    // Google Calendar ships the event as an unnamed text/calendar part; Gmail lists
    // only a named invite.ics. Showing "attachment" as a downloadable file was wrong.
    const parsed = await mp.parseBody(withInvite('<evt@test.local>'));

    expect(parsed.calendarIcs).toContain('BEGIN:VEVENT');
    expect(parsed.attachments.map((a) => a.name)).not.toContain('attachment');
  });

  it('returns no invite for a plain message', async () => {
    const parsed = await mp.parseBody(crlf(['Content-Type: text/plain', '', 'no invite here', '']));

    expect(parsed.calendarIcs).toBeNull();
  });
});

// The mail that looked bodyless in the list. mailparser only converts HTML→text
// when the HTML part is the ROOT node or the message also has a text/plain part
// (mail-parser.js: `(!alternative && this.hasText) || (node.root && !this.hasText)`).
// So a multipart/related or multipart/mixed carrying ONLY HTML — the standard
// shape for marketing mail with inline images — yields `text: undefined`, and
// cleanBody was stored EMPTY: 205 of 26,185 real rows. cleanBody is what the
// list snippet, the filter engine and every AI prompt read, so the mail read as
// having no body even though its HTML had downloaded fine.
describe('parseBody — cleanBody for an HTML-only mail', () => {
  const mp = new MessageProcessor({ headersOnly: false });

  /** multipart/related, HTML + one inline image, NO text/plain part. */
  const htmlOnly = (inner: string): string => crlf([
    'Message-ID: <html-only@test.local>',
    'Subject: A $130M startup is hiring',
    'From: info@minis.naukri.com',
    'MIME-Version: 1.0',
    'Content-Type: multipart/related; boundary=REL',
    '',
    '--REL',
    'Content-Type: text/html; charset=utf-8',
    '',
    `<html><body>${inner}</body></html>`,
    '--REL',
    'Content-Type: image/png; name="logo.png"',
    'Content-Disposition: inline; filename="logo.png"',
    'Content-ID: <logo>',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from('PNGDATA').toString('base64'),
    '--REL--',
    '',
  ]);

  // The regression itself: text derived from the HTML, so the row has a snippet.
  it('derives cleanBody from the HTML instead of storing it empty', async () => {
    const parsed = await mp.parseBody(htmlOnly(
      '<img height="0px" src="https://logs.example.com/uba?data=%7B%22a%22%3A1%7D">' +
      '<div>Hey Advik, Emergent just raised $130M. And now, it is hiring.</div>' +
      '<a href="https://example.com/tracked?x=1">Read the full story</a>',
    ));

    expect(parsed.contentType).toBe('html');
    expect(parsed.cleanBody).toContain('Emergent just raised $130M');
    expect(parsed.cleanBody).toContain('Read the full story');
    // The tracking pixel and the tracked href must NOT become the snippet.
    expect(parsed.cleanBody).not.toContain('logs.example.com');
    expect(parsed.cleanBody).not.toContain('tracked?x=1');
    // rawBody stays the HTML — the detail view still renders the real thing.
    expect(parsed.rawBody).toContain('<div>');
  });

  // Regression: when the mail DOES carry a text/plain part, that part is the
  // author's own text and must win over anything derived from the HTML.
  it('prefers the real text/plain part over the derived text', async () => {
    const parsed = await mp.parseBody(crlf([
      'Message-ID: <alt@test.local>',
      'MIME-Version: 1.0',
      'Content-Type: multipart/alternative; boundary=ALT',
      '',
      '--ALT',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'THE PLAIN PART',
      '--ALT',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<p>the html part</p>',
      '--ALT--',
      '',
    ]));

    expect(parsed.cleanBody).toContain('THE PLAIN PART');
    expect(parsed.cleanBody).not.toContain('the html part');
  });

  // Regression: an image-only mail has no readable text at all. It must still
  // parse to a normal record (empty cleanBody, HTML preserved), not throw.
  it('leaves cleanBody empty when the HTML has no readable text', async () => {
    const parsed = await mp.parseBody(htmlOnly('<img src="https://x.test/a.png">'));

    expect(parsed.cleanBody).toBe('');
    expect(parsed.rawBody).toContain('<img');
  });
});

// The reported bug: one avatar in a Bitbucket notification rendered broken in
// this app and fine in Gmail. mailparser rewrites `cid:` references to `data:`
// URIs, but skips any part whose type fails its own `/^image\/[\w]+$/` test —
// `image/x-png` and friends. What it leaves behind can never render: no scheme
// in the app answers `cid:`, the body iframe's CSP drops it without a console
// message, and the "remote images blocked" banner only looks for `http(s):`. So
// the failure is completely silent, which is why it went unnoticed. parseBody is
// the last place holding both the HTML and the part bytes — if these fail, the
// image is broken by the time anything is stored.
describe('parseBody — cid: images mailparser leaves behind', () => {
  const mp = new MessageProcessor({ headersOnly: false });

  const PNG_B64 = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  ).toString('base64');

  /** multipart/related: HTML plus inline parts addressed by Content-ID. */
  const withRelated = (parts: string[][], html: string): string => crlf([
    'Message-ID: <rel@test.local>',
    'Subject: Pull request #455',
    'From: notifications@test.local',
    'MIME-Version: 1.0',
    'Content-Type: multipart/related; type="text/html"; boundary=BOUND',
    '',
    '--BOUND',
    'Content-Type: text/html; charset=utf-8',
    '',
    html,
    ...parts.flatMap((lines) => ['--BOUND', ...lines]),
    '--BOUND--',
    '',
  ]);

  /** One inline image part, declared however the sender felt like declaring it. */
  const imagePart = (cid: string, contentType: string, filename: string): string[] => [
    `Content-Type: ${contentType}; name="${filename}"`,
    `Content-ID: <${cid}>`,
    `Content-Disposition: inline; filename="${filename}"`,
    'Content-Transfer-Encoding: base64',
    '',
    PNG_B64,
  ];

  it('inlines a part typed image/x-png, which mailparser refuses to rewrite', async () => {
    const parsed = await mp.parseBody(withRelated(
      [imagePart('avatar@test.local', 'image/x-png', 'avatar.png')],
      '<p>Ramesh commented</p><img src="cid:avatar@test.local" width="32">',
    ));

    expect(parsed.rawBody).toContain(`data:image/x-png;base64,${PNG_B64}`);
    expect(parsed.rawBody).not.toContain('cid:');
  });

  // Breaks: the repair replaces mailparser's work instead of completing it, and
  // the ordinary inline image (the 99% case) regresses to broken.
  it('leaves the parts mailparser DID rewrite intact, alongside the repaired one', async () => {
    const parsed = await mp.parseBody(withRelated(
      [
        imagePart('ok@test.local', 'image/png', 'ok.png'),
        imagePart('odd@test.local', 'image/x-icon', 'favicon.ico'),
      ],
      '<img src="cid:ok@test.local"><img src=cid:odd@test.local>',
    ));

    expect(parsed.rawBody).toContain(`data:image/png;base64,${PNG_B64}`);
    expect(parsed.rawBody).toContain(`data:image/x-icon;base64,${PNG_B64}`);
    expect(parsed.rawBody).not.toContain('cid:');
  });

  // Breaks: a sender whose parts genuinely don't line up gets a mangled body
  // instead of one broken image — and (see email-handlers) the mail would
  // re-download its whole source on every single open, forever.
  it('leaves a reference that names no part exactly where it was', async () => {
    const html = '<img src="cid:gone@test.local">';
    const parsed = await mp.parseBody(withRelated(
      [imagePart('avatar@test.local', 'image/x-png', 'avatar.png')],
      html,
    ));

    expect(parsed.rawBody).toContain('cid:gone@test.local');
  });

  // Breaks: a repaired inline image starts showing up in the attachment chips
  // and the download menu. An inline image is part of the body, not a file the
  // user attached — Gmail lists neither, and the paperclip would be wrong.
  it('does not turn a repaired inline image into a listed attachment', async () => {
    const parsed = await mp.parseBody(withRelated(
      [imagePart('avatar@test.local', 'image/x-png', 'avatar.png')],
      '<img src="cid:avatar@test.local">',
    ));

    expect(parsed.attachments).toHaveLength(0);
  });

  // Breaks: cleanBody (the list snippet, the filters and every AI prompt) is
  // derived from the html BEFORE substitution — or worse, from the base64.
  it('keeps base64 image bytes out of cleanBody', async () => {
    const parsed = await mp.parseBody(withRelated(
      [imagePart('avatar@test.local', 'image/x-png', 'avatar.png')],
      '<p>Ramesh commented on your pull request</p><img src="cid:avatar@test.local">',
    ));

    expect(parsed.cleanBody).toContain('Ramesh commented');
    expect(parsed.cleanBody).not.toContain('base64');
  });
});

describe('convertMessage — attachment indicator from BODYSTRUCTURE', () => {
  const mp = new MessageProcessor({ headersOnly: true, processAttachments: true });

  const message = (bodyStructure: unknown): IMAPMessage => ({
    uid: 1,
    seqNo: 1,
    flags: [],
    date: new Date('2026-01-01T00:00:00Z'),
    size: 10,
    bodyStructure,
    envelope: {
      messageId: '<a@test.local>',
      inReplyTo: null,
      references: [],
      subject: 'S',
      from: [{ address: 'a@test.local', name: '' }],
      replyTo: [],
      to: [],
      cc: [],
      bcc: [],
      date: null,
    },
  } as unknown as IMAPMessage);

  it('counts an explicit attachment part (cheap indicator, no download)', async () => {
    const record = await mp.convertMessage(message({
      type: 'multipart',
      parts: [
        { type: 'text' },
        { type: 'application', disposition: { type: 'attachment', params: { filename: 'a.pdf' } } },
      ],
    }), 'f', INBOX);

    expect(record.hasAttachments).toBe(true);
    expect(record.attachmentCount).toBe(1);
    // Names/sizes stay null until the SOURCE is parsed (fetchBody) — that is what
    // the download path matches against.
    expect(record.attachmentNames).toBeNull();
    expect(record.attachmentSizes).toBeNull();
  });

  it('counts a named part with NO disposition (servers that omit it)', async () => {
    const record = await mp.convertMessage(
      message({ type: 'multipart', parts: [{ type: 'application', params: { name: 'report.xlsx' } }] }),
      'f', INBOX,
    );

    expect(record.attachmentCount).toBe(1);
  });

  it('does NOT count an inline part, and recurses into nested multiparts', async () => {
    const record = await mp.convertMessage(message({
      type: 'multipart',
      parts: [
        {
          type: 'multipart',
          parts: [
            { type: 'image', disposition: { type: 'inline', params: { filename: 'logo.png' } } },
            { type: 'application', disposition: { type: 'attachment', params: { filename: 'deep.pdf' } } },
          ],
        },
      ],
    }), 'f', INBOX);

    expect(record.hasAttachments).toBe(true);
    expect(record.attachmentCount).toBe(1); // only deep.pdf
  });

  it('reports none when the message has no body structure at all', async () => {
    const record = await mp.convertMessage(message(undefined), 'f', INBOX);

    expect(record.hasAttachments).toBe(false);
    expect(record.attachmentCount).toBe(0);
  });
});

/**
 * The BODY half of the spam score.
 *
 * A sync stores headers, so the verdict written at ingest is a header verdict:
 * the content rules had no words to read and the attachment rules had no bytes
 * to sniff. Those only become possible here, when the body finally arrives —
 * which for most mail in this app is the first time anyone opens it. Without
 * this the content and attachment stages would be dead code on every message
 * the user actually reads.
 *
 * `fetchBody` re-scores; it deliberately does NOT re-file. Filing belongs to
 * ingest and the reputation sweep, which run in the background and own the
 * folder list — a message must not vanish out of the folder a reader is
 * looking at because they opened it.
 */
describe('fetchBody — the body stage', () => {
  const HEADER_VERDICT = JSON.stringify([
    { id: 'auth-failed', points: 3, detail: 'SPF, DKIM or DMARC failed' },
  ]);

  /** An HTML message whose one link shows a bank and goes somewhere else. */
  const withDeceptiveLink = (messageId: string): string => crlf([
    `Message-ID: ${messageId}`,
    'Subject: Your account',
    'From: sender@test.local',
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=utf-8',
    '',
    '<p>Confirm below.</p><a href="https://evil.example/x">https://yourbank.example</a>',
    '',
  ]);

  /** A .pdf, declared as a .pdf, whose bytes are a Windows program. */
  const withDisguisedExecutable = (messageId: string): string => crlf([
    `Message-ID: ${messageId}`,
    'Subject: Report',
    'From: sender@test.local',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary=BOUND',
    '',
    '--BOUND',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Report attached.',
    '--BOUND',
    'Content-Type: application/pdf; name="report.pdf"',
    'Content-Disposition: attachment; filename="report.pdf"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]).toString('base64'),
    '--BOUND--',
    '',
  ]);

  const seedScored = (ctx: ReturnType<typeof setup>, uid: number, messageId: string) =>
    ctx.db.seedEmail({
      folderId: ctx.db.folderId(INBOX),
      uid,
      tags: `|${INBOX}|`,
      messageId,
      subject: 'Your account',
      spamScore: 3,
      spamReasons: HEADER_VERDICT,
    });

  it('adds the content verdict to the score the headers already earned', async () => {
    const ctx = setup();
    const messageId = '<phish@test.local>';
    const uid = ctx.server.addMessage(INBOX, { messageId, body: withDeceptiveLink(messageId) });
    const row = seedScored(ctx, uid, messageId);

    await ctx.mp.fetchBody(ctx.server, INBOX, uid, ctx.db.asStorage(), row.id);

    const stored = ctx.db.row(row.id)!;
    expect(stored.spamScore).toBe(5);
    expect(JSON.parse(stored.spamReasons!).map((r: { id: string }) => r.id))
      .toEqual(['auth-failed', 'link-display-mismatch']);
  });

  // Regression: the attachment rules need the decoded BYTES, and nothing in
  // this app stores them — they exist only for the length of the MIME parse.
  // Lose them and the one claim a sender cannot fake goes unchecked: here the
  // filename and the declared Content-Type both say PDF, and only the first
  // two bytes say otherwise.
  it('sniffs an attachment whose bytes contradict both its name and its type', async () => {
    const ctx = setup();
    const messageId = '<exe@test.local>';
    const uid = ctx.server.addMessage(INBOX, { messageId, body: withDisguisedExecutable(messageId) });
    const row = seedScored(ctx, uid, messageId);

    await ctx.mp.fetchBody(ctx.server, INBOX, uid, ctx.db.asStorage(), row.id);

    const stored = ctx.db.row(row.id)!;
    expect(JSON.parse(stored.spamReasons!).map((r: { id: string }) => r.id))
      .toEqual(['auth-failed', 'attachment-executable', 'attachment-type-mismatch']);
    expect(stored.spamScore).toBe(7);
  });

  // Regression: a body can be fetched more than once — a repaired UID, a
  // charset re-parse, a re-open. Appending the body reasons each time would
  // charge the same rule twice and eventually file ordinary mail as spam,
  // and a stored total gives nothing away about how it was reached.
  it('does not charge the body rules twice when the body is fetched again', async () => {
    const ctx = setup();
    const messageId = '<phish2@test.local>';
    const uid = ctx.server.addMessage(INBOX, { messageId, body: withDeceptiveLink(messageId) });
    const row = seedScored(ctx, uid, messageId);

    await ctx.mp.fetchBody(ctx.server, INBOX, uid, ctx.db.asStorage(), row.id);
    const once = ctx.db.row(row.id)!.spamScore;
    await ctx.mp.fetchBody(ctx.server, INBOX, uid, ctx.db.asStorage(), row.id);

    expect(ctx.db.row(row.id)!.spamScore).toBe(once);
    expect(JSON.parse(ctx.db.row(row.id)!.spamReasons!)).toHaveLength(2);
  });

  // Regression: NULL spam_score is the user's own outgoing mail, or mail that
  // predates the filter. Downloading a body is not a reason to start judging
  // either — "not judged" and "judged clean" are different facts to the shield.
  it('leaves a row that was never scored unscored', async () => {
    const ctx = setup();
    const messageId = '<own@test.local>';
    const uid = ctx.server.addMessage(INBOX, { messageId, body: withDeceptiveLink(messageId) });
    const row = ctx.db.seedEmail({
      folderId: ctx.db.folderId(INBOX), uid, tags: `|${INBOX}|`, messageId, spamScore: null,
    });

    await ctx.mp.fetchBody(ctx.server, INBOX, uid, ctx.db.asStorage(), row.id);

    const stored = ctx.db.row(row.id)!;
    expect(stored.spamScore).toBeNull();
    expect(stored.spamReasons ?? null).toBeNull();
  });

  // Regression: the tag is the classification the AI pipeline excludes on and
  // the Spam filter view lists; the MOVE is somebody else's job. Filing from
  // here would take a message out of the folder of a reader who just opened
  // it — which is exactly when this path runs.
  it('tags a message the body convicts, without moving it', async () => {
    const ctx = setup();
    const messageId = '<exe2@test.local>';
    const uid = ctx.server.addMessage(INBOX, { messageId, body: withDisguisedExecutable(messageId) });
    const row = seedScored(ctx, uid, messageId);

    await ctx.mp.fetchBody(ctx.server, INBOX, uid, ctx.db.asStorage(), row.id);

    expect(ctx.db.tagsOf(row.id)).toContain('spam');
    expect(ctx.db.row(row.id)!.folderId).toBe(ctx.db.folderId(INBOX));
  });

  // Regression: a clean body must not gain a tag it did not earn, and must
  // not lose the header verdict either.
  it('leaves an innocent body tagged as it was', async () => {
    const ctx = setup();
    const messageId = '<ok@test.local>';
    const uid = ctx.server.addMessage(INBOX, { messageId, subject: 'Lunch' });
    const row = seedScored(ctx, uid, messageId);

    await ctx.mp.fetchBody(ctx.server, INBOX, uid, ctx.db.asStorage(), row.id);

    expect(ctx.db.tagsOf(row.id)).not.toContain('spam');
    expect(ctx.db.row(row.id)!.spamScore).toBe(3);
  });
});
