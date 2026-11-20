import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';

import { SyncEngine } from '../../../src/imap/sync-engine';
import { captureLogs, type CapturedLogs } from '../../../src/test-support/log-capture';
import type { BodyStructure } from '../../../src/types/imap';
import { getLogLevel, setLogLevel, setLogSink } from '../../../src/utils/logger';

// Regression tests for the single-attachment fetch path and its recovery from a
// part whose Content-Transfer-Encoding header LIES.
//
// A real message carried a .txt attachment declaring `base64` while actually
// holding raw HTML text. A base64 decoder keeps only alphabet characters and
// stops at the first `=`, so `<p><span style=` collapsed to SEVEN bytes of
// binary — and those seven bytes are what got cached, shown as the attachment's
// size, handed to the OS viewer, and refused by the in-app viewer. Gmail shows
// the real text for the same message, so the bytes are recoverable: re-fetch the
// part UNDECODED when the decode came back implausibly short against the size
// the server declared.

/** A bodystructure with one attachment part, parameterised for each case. */
function structure(overrides: Partial<BodyStructure> = {}): BodyStructure {
  return {
    type: 'multipart/mixed',
    parts: [
      { type: 'text/html', part: '1' } as BodyStructure,
      {
        type: 'text/plain',
        part: '2',
        encoding: 'base64',
        size: 400,
        disposition: { type: 'attachment', params: { filename: 'note.txt' } },
        ...overrides,
      } as BodyStructure,
    ],
  } as BodyStructure;
}

function makeEngine(client: any) {
  const engine = new SyncEngine({} as any);
  vi.spyOn(engine as any, 'isConnected').mockReturnValue(true);
  vi.spyOn(engine as any, 'isSyncing').mockReturnValue(false);
  vi.spyOn(engine as any, 'reselectMonitoredFolder').mockResolvedValue(undefined);
  (engine as any).connectionPool = null;
  (engine as any).connectionManager = { client };
  return engine;
}

/** A client whose part download is decoded, with an optional raw escape hatch. */
function makeClient(opts: {
  bodyStructure?: BodyStructure;
  decoded?: Buffer | null;
  raw?: Buffer | null;
  withRawMethod?: boolean;
}) {
  const downloadPartRaw = vi.fn().mockResolvedValue(opts.raw ?? null);
  const client: any = {
    selectFolder: vi.fn().mockResolvedValue(undefined),
    fetchMessagesByUID: vi
      .fn()
      .mockResolvedValue([{ bodyStructure: opts.bodyStructure ?? structure() }]),
    downloadPart: vi.fn().mockResolvedValue(opts.decoded ?? null),
  };
  if (opts.withRawMethod !== false) client.downloadPartRaw = downloadPartRaw;
  return { client, downloadPartRaw };
}

describe('SyncEngine.fetchAttachmentPart', () => {
  it('fetches only the matching part and returns its decoded bytes', async () => {
    // Breaks if the part lookup regresses: the caller then falls back to
    // downloading the WHOLE message for every attachment open.
    const decoded = Buffer.alloc(300, 0x61);
    const { client, downloadPartRaw } = makeClient({ decoded });
    const engine = makeEngine(client);

    const result = await engine.fetchAttachmentPart('e1', 'INBOX', 42, 'note.txt');

    expect(result).toEqual({ filename: 'note.txt', content: decoded });
    expect(client.downloadPart).toHaveBeenCalledWith(42, '2');
    expect(downloadPartRaw).not.toHaveBeenCalled();
  });

  it('returns null when the filename resolves to no part', async () => {
    // Breaks if an unresolved name throws or returns empty bytes instead of
    // null — null is the signal that makes the caller use the whole-message path.
    const { client } = makeClient({ decoded: Buffer.from('x') });
    const engine = makeEngine(client);

    expect(await engine.fetchAttachmentPart('e1', 'INBOX', 42, 'other.pdf')).toBeNull();
    expect(client.downloadPart).not.toHaveBeenCalled();
  });

  it('returns null when the part download yields nothing', async () => {
    // Breaks if an empty download is cached as a zero-byte attachment.
    const { client } = makeClient({ decoded: null });
    expect(await makeEngine(client).fetchAttachmentPart('e1', 'INBOX', 42, 'note.txt')).toBeNull();
  });

  it('returns null (not a throw) when the connection blips mid-fetch', async () => {
    // Transient failure: breaks if a connection error escapes and the attachment
    // open surfaces an error instead of retrying via the whole-message path.
    const { client } = makeClient({ decoded: Buffer.alloc(300) });
    client.downloadPart.mockRejectedValue(new Error('Connection closed'));
    expect(await makeEngine(client).fetchAttachmentPart('e1', 'INBOX', 42, 'note.txt')).toBeNull();
  });

  it('returns null when not connected, without touching the socket', async () => {
    const { client } = makeClient({ decoded: Buffer.alloc(300) });
    const engine = makeEngine(client);
    (engine as any).isConnected.mockReturnValue(false);
    expect(await engine.fetchAttachmentPart('e1', 'INBOX', 42, 'note.txt')).toBeNull();
    expect(client.fetchMessagesByUID).not.toHaveBeenCalled();
  });
});

describe('SyncEngine.fetchAttachmentPart — part that lies about base64', () => {
  it('serves the UNDECODED bytes when a base64 part decodes to far less than declared', async () => {
    // THE reported bug: a .txt holding raw HTML but declaring base64 decoded to
    // 7 bytes. Breaks if we ever cache that decode again — the viewer shows
    // "could not be read" and the OS app shows binary garbage.
    const raw = Buffer.from('<p><span style="font-family: sans-serif;">Hello World</span></p>');
    const { client, downloadPartRaw } = makeClient({ decoded: Buffer.alloc(7), raw });
    const engine = makeEngine(client);

    const result = await engine.fetchAttachmentPart('e1', 'INBOX', 42, 'note.txt');

    expect(result?.content).toEqual(raw);
    expect(downloadPartRaw).toHaveBeenCalledWith(42, '2');
  });

  it('leaves a genuine base64 part alone', async () => {
    // Breaks if the heuristic fires on healthy mail: every base64 attachment
    // would be fetched TWICE and served in its still-encoded form.
    const decoded = Buffer.alloc(300); // ~75% of the declared 400 — plausible
    const { client, downloadPartRaw } = makeClient({ decoded });
    expect(
      (await makeEngine(client).fetchAttachmentPart('e1', 'INBOX', 42, 'note.txt'))?.content,
    ).toEqual(decoded);
    expect(downloadPartRaw).not.toHaveBeenCalled();
  });

  it('does not second-guess a part that never claimed base64', async () => {
    // Breaks if a short quoted-printable or 7bit part gets re-fetched raw —
    // those bytes are already correct however small they are.
    const decoded = Buffer.alloc(7);
    const { client, downloadPartRaw } = makeClient({
      bodyStructure: structure({ encoding: 'quoted-printable' }),
      decoded,
    });
    expect(
      (await makeEngine(client).fetchAttachmentPart('e1', 'INBOX', 42, 'note.txt'))?.content,
    ).toEqual(decoded);
    expect(downloadPartRaw).not.toHaveBeenCalled();
  });

  it('does not second-guess a part whose size the server never declared', async () => {
    // Breaks if a missing size reads as 0 and trips the "implausibly short"
    // test on every part — there is nothing to compare against.
    const decoded = Buffer.alloc(7);
    const { client, downloadPartRaw } = makeClient({
      bodyStructure: structure({ size: undefined }),
      decoded,
    });
    expect(
      (await makeEngine(client).fetchAttachmentPart('e1', 'INBOX', 42, 'note.txt'))?.content,
    ).toEqual(decoded);
    expect(downloadPartRaw).not.toHaveBeenCalled();
  });

  it('keeps the decoded bytes when the raw re-fetch comes back empty or no longer', async () => {
    // Transient failure on the SECOND fetch: breaks if a failed recovery
    // replaces a real (if short) attachment with nothing.
    const decoded = Buffer.alloc(7, 0x41);
    for (const raw of [null, Buffer.alloc(3)]) {
      const { client } = makeClient({ decoded, raw });
      expect(
        (await makeEngine(client).fetchAttachmentPart('e1', 'INBOX', 42, 'note.txt'))?.content,
      ).toEqual(decoded);
    }
  });

  it('keeps the decoded bytes when the client has no raw-fetch capability', async () => {
    // downloadPartRaw is optional on IIMAPClient. Breaks if the engine calls it
    // unconditionally — every pooled/alternate client implementation would throw.
    const decoded = Buffer.alloc(7, 0x41);
    const { client } = makeClient({ decoded, withRawMethod: false });
    expect(
      (await makeEngine(client).fetchAttachmentPart('e1', 'INBOX', 42, 'note.txt'))?.content,
    ).toEqual(decoded);
  });

  // The cases above stub the 7-byte decode libbase64 1.3.0 produced. imapflow
  // decodes with libbase64 1.3.1 now, which turns the same 64 bytes of HTML into
  // 34 — just over half — and the old "under half" test let that through.
  const HTML = Buffer.from('<p><span style="font-family: sans-serif;">Hello World</span></p>');

  // THE regression of the libbase64 1.3.1 bump on this path. Breaks if the
  // trigger slides back to "under half": the attachment opens as 34 bytes of
  // binary whenever the mailbox is idle, the case this path serves.
  it('repairs the just-over-half decode libbase64 1.3.1 makes of mislabelled text', async () => {
    const { client, downloadPartRaw } = makeClient({
      bodyStructure: structure({ size: HTML.length }),
      decoded: Buffer.alloc(34, 0xa6),
      raw: HTML,
    });

    const result = await makeEngine(client).fetchAttachmentPart('e1', 'INBOX', 42, 'note.txt');

    expect(result?.content).toEqual(HTML);
    expect(downloadPartRaw).toHaveBeenCalledWith(42, '2');
  });

  // Breaks if a short decode alone is taken as proof: genuine base64 wrapped at
  // 16 characters decodes to two thirds of its size, and the user would be
  // handed the file's base64 text instead of the file.
  it('keeps the decode when the raw part turns out to be genuine base64', async () => {
    const file = Buffer.from('0123456789'.repeat(12));
    const raw = Buffer.from(file.toString('base64').match(/.{1,16}/g)!.join('\r\n'));
    const { client, downloadPartRaw } = makeClient({
      bodyStructure: structure({ size: raw.length }),
      decoded: file,
      raw,
    });

    const result = await makeEngine(client).fetchAttachmentPart('e1', 'INBOX', 42, 'note.txt');

    expect(downloadPartRaw).toHaveBeenCalledTimes(1); // it did look…
    expect(result?.content).toEqual(file); // …and kept the decode
  });

  // Transient failure on the raw re-fetch, now reached for decodes the old test
  // never questioned. Breaks if a connection blip there fails the open instead
  // of falling back to the (wrong, but openable) decode.
  it('keeps the decoded bytes when the raw re-fetch throws', async () => {
    const decoded = Buffer.alloc(34, 0xa6);
    const { client, downloadPartRaw } = makeClient({
      bodyStructure: structure({ size: HTML.length }),
      decoded,
    });
    downloadPartRaw.mockRejectedValue(new Error('Connection closed'));

    const result = await makeEngine(client).fetchAttachmentPart('e1', 'INBOX', 42, 'note.txt');

    expect(result?.content).toEqual(decoded);
  });
});

/**
 * The WHOLE-MESSAGE fallback, which is where this bug actually reached the user.
 *
 * `fetchAttachmentPart` bows out and returns null in several ordinary
 * situations — most often `isSyncing()`, because it will not fight the primary
 * socket — and the caller then parses the full message instead. That path had no
 * recovery at all, so during any sync the collapsed 7-byte decode was still what
 * got cached and served, even with the per-part path repaired.
 *
 * Two earlier attempts at a fix here went through the server's BODYSTRUCTURE and
 * silently did nothing, because the mailbox that produced this bug returns every
 * BODYSTRUCTURE parameter with its VALUE missing — `("NAME" )`, `("FILENAME" )`,
 * `("BOUNDARY" )` — so no filename lookup can match and no declared size exists
 * to compare against. The recovery now reads the raw message source we already
 * hold, which is why these tests hand the engine a BODYSTRUCTURE that is useless
 * on purpose.
 */
describe('SyncEngine.fetchAttachment (whole-message fallback)', () => {
  /** A real MIME message whose .txt part declares base64 but carries raw HTML. */
  const LYING_SOURCE = [
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="B"',
    '',
    '--B',
    'Content-Type: text/html; charset=utf-8',
    '',
    '<html>body</html>',
    '--B',
    'Content-Type: text/plain; name="note.txt"',
    'Content-Disposition: attachment; filename="note.txt"',
    'Content-Transfer-Encoding: base64',
    '',
    '<p><span style="color:red">hello there</span></p>',
    '--B--',
    '',
  ].join('\r\n');

  /** The bytes that part really carries — what Gmail shows for the same message. */
  const REAL_BYTES = Buffer.from('<p><span style="color:red">hello there</span></p>', 'utf8');

  /** The same message with an honestly-encoded attachment. */
  const HONEST_SOURCE = LYING_SOURCE
    .replace('Content-Transfer-Encoding: base64', 'Content-Transfer-Encoding: 7bit');

  /**
   * A BODYSTRUCTURE exactly as the offending server returns it: the shape is
   * there, every parameter value is gone. Nothing in the repair may depend on it.
   */
  const STRIPPED_STRUCTURE = {
    type: 'multipart/mixed',
    parts: [
      { type: 'text/html', part: '1', params: {} } as BodyStructure,
      { type: 'text/plain', part: '2', encoding: '', size: 0, params: {}, disposition: null } as BodyStructure,
    ],
  } as BodyStructure;

  function makeWholeMessageClient(source: string) {
    const downloadPartRaw = vi.fn().mockResolvedValue(Buffer.alloc(300, 0x61));
    const client: any = {
      selectFolder: vi.fn().mockResolvedValue(undefined),
      fetchMessagesByUID: vi.fn().mockResolvedValue([
        { body: Buffer.from(source, 'utf8').toString('latin1'), bodyStructure: STRIPPED_STRUCTURE },
      ]),
      downloadPart: vi.fn().mockResolvedValue(Buffer.alloc(300)),
      downloadPartRaw,
    };
    return { client, downloadPartRaw };
  }

  // Breaks: the exact reported failure — an attachment opened while a sync is
  // running is cached as 7 junk bytes, and the in-app viewer shows an unreadable
  // file for content Gmail displays fine. That it passes with a BODYSTRUCTURE
  // carrying no filename and no size is the whole point of the fix.
  it('serves the part\'s raw source bytes when the parse collapses', async () => {
    const { client } = makeWholeMessageClient(LYING_SOURCE);
    const engine = makeEngine(client);

    const result = await engine.fetchAttachment('e1', 'INBOX', 42, 'note.txt');

    expect(result.content).toEqual(REAL_BYTES);
    expect(result.filename).toBe('note.txt');
  });

  // Breaks: the repair goes back to the server for the part, which costs a round
  // trip AND cannot work at all here — a sync holds the socket and the stripped
  // BODYSTRUCTURE has no part number to ask for.
  it('repairs from the message it already has, with no second fetch', async () => {
    const { client, downloadPartRaw } = makeWholeMessageClient(LYING_SOURCE);
    const engine = makeEngine(client);

    await engine.fetchAttachment('e1', 'INBOX', 42, 'note.txt');

    expect(downloadPartRaw).not.toHaveBeenCalled();
    expect(client.downloadPart).not.toHaveBeenCalled();
    expect(client.fetchMessagesByUID).toHaveBeenCalledTimes(1);
    // Exact MIME retrieval must not run unrelated category discovery.
    expect(client.fetchMessagesByUID).toHaveBeenCalledWith([42], {
      discoverCategories: false,
      fetchHeaders: false,
      fetchBody: true,
    });
  });

  // Breaks: healthy mail is re-served in some other form than what the parser
  // produced — i.e. the heuristic fires on attachments that were always fine.
  it('leaves a healthy attachment alone', async () => {
    const { client, downloadPartRaw } = makeWholeMessageClient(HONEST_SOURCE);
    const engine = makeEngine(client);

    const result = await engine.fetchAttachment('e1', 'INBOX', 42, 'note.txt');

    expect(result.content.toString('utf8')).toContain('hello there');
    expect(downloadPartRaw).not.toHaveBeenCalled();
  });

  // Breaks: the UID is resolved against whatever mailbox the connection drifted
  // to — the failure the "one mailbox section" rule exists to prevent.
  it('holds one mailbox selection across the whole fetch', async () => {
    const { client } = makeWholeMessageClient(LYING_SOURCE);
    const engine = makeEngine(client);

    await engine.fetchAttachment('e1', 'INBOX', 42, 'note.txt');

    expect(client.selectFolder).toHaveBeenCalledTimes(1);
  });

  // Breaks: an attachment the parser could not find returns empty bytes that get
  // cached as a valid (empty) file instead of surfacing as an error.
  it('throws when the message carries no attachment of that name', async () => {
    const { client } = makeWholeMessageClient(LYING_SOURCE);
    await expect(
      makeEngine(client).fetchAttachment('e1', 'INBOX', 42, 'missing.txt'),
    ).rejects.toThrow('not found');
  });

  // Breaks: the "not found" error names the attachment again, and every
  // attachment IPC handler writes that error to a release app.log whole (the
  // name comes from the mail: "Payslip-Jane-Doe.pdf").
  it('does not name the missing attachment in its error', async () => {
    const { client } = makeWholeMessageClient(LYING_SOURCE);
    const error = await makeEngine(client)
      .fetchAttachment('e1', 'INBOX', 42, 'SENTINEL-Payslip-Jane-Doe.pdf')
      .catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('Attachment not found in message');
  });

  // Transient failure: breaks if an empty body is parsed as "no attachments"
  // and reported as a content problem rather than a fetch that has to be retried.
  it('throws when the message body comes back empty', async () => {
    const { client } = makeWholeMessageClient(LYING_SOURCE);
    client.fetchMessagesByUID.mockResolvedValue([{ body: '', bodyStructure: STRIPPED_STRUCTURE }]);
    await expect(
      makeEngine(client).fetchAttachment('e1', 'INBOX', 42, 'note.txt'),
    ).rejects.toThrow('Message body is empty');
  });

  // Breaks: a UID that has since been expunged (or a re-run after a move) reads
  // as a content error instead of a missing message.
  it('throws when the UID no longer exists in the folder', async () => {
    const { client } = makeWholeMessageClient(LYING_SOURCE);
    client.fetchMessagesByUID.mockResolvedValue([]);
    await expect(
      makeEngine(client).fetchAttachment('e1', 'INBOX', 42, 'note.txt'),
    ).rejects.toThrow('Message not found');
  });
});

// The part fetch's failure line reaches a release app.log (warn). It used to
// name the attachment ("Payslip-Jane-Doe.pdf", from the mail) and quote the
// error's message, which for an ImapFlow command error can carry the command
// it ran. It now names the email and UID, and the error's class and code.
describe('SyncEngine.fetchAttachmentPart — what reaches the log', () => {
  const NAME = 'SENTINEL-Payslip-Jane.pdf';
  const named = () => structure({ disposition: { type: 'attachment', params: { filename: NAME } } } as Partial<BodyStructure>);
  let logs: CapturedLogs;
  beforeEach(() => { logs = captureLogs({ setLogSink, setLogLevel, getLogLevel }); });
  afterEach(() => { logs.stop(); });

  // Breaks (transient): a connection blip writes the file name, or the error
  // text, on its way to the whole-message fallback.
  it('logs a transient failure by email, uid and error code, then falls back', async () => {
    const { client } = makeClient({ bodyStructure: named(), decoded: Buffer.alloc(300) });
    client.downloadPart.mockRejectedValue(Object.assign(new Error(`Connection closed fetching ${NAME}`), { code: 'ETIMEDOUT' }));

    expect(await makeEngine(client).fetchAttachmentPart('e-1', 'INBOX', 42, NAME)).toBeNull();

    expect(logs.containing(NAME)).toEqual([]);
    expect(logs.containing('fetchAttachmentPart failed')).toEqual([
      "[WARN] [sarvinbox] fetchAttachmentPart failed for email e-1 uid 42 (falling back to full message) { name: 'Error', code: 'ETIMEDOUT' }",
    ]);
  });

  // Breaks (permanent): a server refusal of the structure FETCH — an ImapFlow
  // error carrying the executed command — is written with its text.
  it('logs a permanent refusal by error class only', async () => {
    const { client } = makeClient({ bodyStructure: named(), decoded: Buffer.alloc(300) });
    client.fetchMessagesByUID.mockRejectedValue(Object.assign(new Error('Command failed'), {
      responseText: `NO no such part for ${NAME}`, executedCommand: `A5 UID FETCH 42 (BODYSTRUCTURE) "${NAME}"`,
    }));

    expect(await makeEngine(client).fetchAttachmentPart('e-1', 'INBOX', 42, NAME)).toBeNull();

    expect(logs.containing(NAME)).toEqual([]);
    expect(logs.containing("fetchAttachmentPart failed for email e-1 uid 42 (falling back to full message) { name: 'Error' }")).toHaveLength(1);
  });

  // Breaks (multi-account, re-run): each account's engine logs its own email
  // and uid, and a retry of the same open logs the same name-free line again.
  it('names the failing email per engine, on every retry, never the file', async () => {
    const a = makeClient({ bodyStructure: named(), decoded: Buffer.alloc(300) });
    const b = makeClient({ bodyStructure: named(), decoded: Buffer.alloc(300) });
    a.client.downloadPart.mockRejectedValue(new Error(`reset ${NAME}`));
    b.client.downloadPart.mockRejectedValue(new Error(`reset ${NAME}`));
    const first = makeEngine(a.client);
    const second = makeEngine(b.client);

    await first.fetchAttachmentPart('acct-a-email', 'INBOX', 7, NAME);
    await first.fetchAttachmentPart('acct-a-email', 'INBOX', 7, NAME);
    await second.fetchAttachmentPart('acct-b-email', 'Archive', 9, NAME);

    expect(logs.containing(NAME)).toEqual([]);
    expect(logs.containing('for email acct-a-email uid 7')).toHaveLength(2);
    expect(logs.containing('for email acct-b-email uid 9')).toHaveLength(1);
  });
});
