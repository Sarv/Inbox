import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The `sarv-attachment://` handler — the only path by which attachment BYTES
 * reach the renderer.
 *
 * Two classes of regression are guarded here and nowhere else:
 *  - SECURITY: it must refuse anything outside the inline-renderable allow-list,
 *    and it must never serve a filename the email does not declare. Either
 *    failure turns the scheme into a way to run hostile content, or into an
 *    arbitrary read of the attachment cache.
 *  - RANGE: video seeking and Chromium's PDF viewer both fetch byte ranges. A
 *    handler that answers 200-with-everything instead of 206 looks fine on a
 *    small PNG and silently breaks both.
 */

const h = vi.hoisted(() => ({
  userData: '',
  /** What `resolveAttachmentFile` should do for the next request. */
  resolve: null as null | ((ref: unknown) => Promise<{ filePath: string; filename: string }>),
  preview: null as
    null | ((ref: unknown, url: string, signal?: AbortSignal) => Promise<Buffer | undefined>),
  registered: new Map<string, (request: Request) => Promise<Response>>(),
  /** Every plaintext buffer the real `readCachedAttachment` handed the handler. */
  opened: [] as Buffer[],
}));

vi.mock('electron', () => ({
  app: { getPath: () => h.userData },
  protocol: {
    handle: (scheme: string, handler: (request: Request) => Promise<Response>) => {
      h.registered.set(scheme, handler);
    },
  },
}));

// The real classifier — the point of these tests is that the handler and the
// allow-list agree — with only the logger stitched out so a failing request
// doesn't print a stack into the test output.
vi.mock('@sarvinbox/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@sarvinbox/core')>()),
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

// The cache's lookup and authorization (resolveAttachmentFile) is the unit next
// door (covered by attachment-handlers.test.ts); here it is a seam. Everything
// else is the REAL cache module: the cache is sealed (CASA M-7), so the bytes
// served here must come through its real decrypting reader, from entries the
// real writer sealed. `AttachmentError` is the real class, so the one the
// handler catches on is the one these tests throw. The DB-key store and the
// account resolver are stubbed, which keeps storage-node, the account runtime
// and the OS keychain out of this suite.
vi.mock('../../../../electron/services/attachment-cache', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../../electron/services/attachment-cache')>();
  return {
    ...actual,
    resolveAttachmentFile: (ref: unknown) => {
      if (!h.resolve) throw new Error('test did not set a resolver');
      return h.resolve(ref);
    },
    readCachedAttachment: async (filePath: string) => {
      const content = await actual.readCachedAttachment(filePath);
      h.opened.push(content);
      return content;
    },
  };
});
vi.mock('../../../../electron/services/db-key-store', () => ({
  getDbEncryptionKey: () => 'k'.repeat(64),
}));
vi.mock('../../../../electron/services/account-target', () => ({
  resolveAccountTarget: () => {
    throw new Error('the protocol suite resolves through h.resolve only');
  },
}));

vi.mock('../../../../electron/services/attachment-preview-protection', () => ({
  getAttachmentPreviewProtection: () => (h.preview ? { contentForRequest: h.preview } : undefined),
}));

import { AttachmentError, getOrCacheAttachment } from '../../../../electron/services/attachment-cache';
import {
  forgetRecentAttachmentEntries,
  handleAttachmentRequest,
  parseRangeHeader,
  registerAttachmentProtocol,
} from '../../../../electron/services/attachment-protocol';

const TMP = mkdtempSync(join(tmpdir(), 'attachment-protocol-'));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

let entries = 0;
/**
 * A SEALED cache entry, written by the real cache exactly as a fetch would
 * write it; returns its path. Each call is a fresh email, so an entry written
 * by an earlier test is never a cache hit for a later one.
 */
async function sealed(filename: string, contents: Buffer | string): Promise<string> {
  const content = Buffer.from(contents);
  return getOrCacheAttachment('acct-protocol', `email-${++entries}`, 'INBOX', 1, filename, {
    isConnected: () => true,
    fetchAttachmentPart: async () => ({ filename, content }),
    fetchAttachment: async () => {
      throw new Error('the part fetch answers');
    },
  });
}

/**
 * Put a sealed entry on disk and make the resolver hand it back.
 * Changed deliberately (CASA M-7): this wrote a PLAINTEXT file, which the
 * handler streamed as-is; the cache is sealed now, so it writes what the cache
 * writes, and every serving test below proves the decrypt path.
 */
async function serving(filename: string, contents: Buffer | string): Promise<string> {
  const filePath = await sealed(filename, contents);
  h.resolve = async () => ({ filePath, filename });
  return filePath;
}

function url(filename: string, { emailId = 'e1', account = '' } = {}): string {
  const query = account ? `?account=${encodeURIComponent(account)}` : '';
  return `sarv-attachment://attachment/${encodeURIComponent(emailId)}/${encodeURIComponent(filename)}${query}`;
}

beforeEach(() => {
  h.userData = TMP;
  h.resolve = null;
  h.preview = async () => undefined;
  h.registered.clear();
  h.opened = [];
  // Held entries are module state; each test starts with none.
  forgetRecentAttachmentEntries();
});

describe('handleAttachmentRequest — verified preview bytes', () => {
  // Regression confirmed in Electron: its custom-protocol request includes the
  // PDF iframe's toolbar fragment, unlike an ordinary HTTP network request.
  it('validates the fragmentless lease URL when a PDF includes display options', async () => {
    const preparedUrl = `${url('report.pdf', { account: 'acct-2' })}&preview=lease`;
    h.preview = async (_ref, requestedUrl) => {
      expect(requestedUrl).toBe(preparedUrl);
      if (new URL(requestedUrl).hash) throw new AttachmentError('Invalid preview URL', 403);
      return Buffer.from('%PDF-1.7 verified');
    };
    const res = await handleAttachmentRequest(new Request(`${preparedUrl}#toolbar=0`));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('%PDF-1.7 verified');
  });

  // Regression: cached or direct attachment URLs must not bypass the scan gate.
  it('serves only retained clean bytes, without resolving a cached copy', async () => {
    const clean = Buffer.from('%PDF-1.7 verified');
    const resolve = vi.fn(async () => {
      throw new Error('unchecked cache must never be read');
    });
    h.resolve = resolve;
    const preview = vi.fn(async () => clean);
    h.preview = preview;
    const request = new Request(`${url('report.pdf', { account: 'acct-2' })}&preview=lease`);

    const res = await handleAttachmentRequest(request);
    // Revoking the lease after response creation must not alter its byte copy.
    clean.fill(0);

    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('%PDF-1.7 verified');
    expect(preview).toHaveBeenCalledWith(
      { emailId: 'e1', filename: 'report.pdf', accountId: 'acct-2' },
      request.url,
      request.signal
    );
    expect(resolve).not.toHaveBeenCalled();
  });

  // Regression: PDFs and video must seek within the same scanned buffer.
  it('answers ranges and HEAD using the verified buffer', async () => {
    h.preview = async () => Buffer.from('0123456789abcdefghij');
    const requestUrl = `${url('clip.mp4', { account: 'acct-1' })}&preview=lease`;
    const res = await handleAttachmentRequest(
      new Request(requestUrl, { headers: { Range: 'bytes=-5' } })
    );
    expect(res.status).toBe(206);
    expect(res.headers.get('Content-Range')).toBe('bytes 15-19/20');
    expect(await res.text()).toBe('fghij');

    const head = await handleAttachmentRequest(new Request(requestUrl, { method: 'HEAD' }));
    expect(head.status).toBe(200);
    expect(head.headers.get('Content-Length')).toBe('20');
    expect(await head.text()).toBe('');

    const past = await handleAttachmentRequest(
      new Request(requestUrl, { headers: { Range: 'bytes=20-' } })
    );
    expect(past.status).toBe(416);
    expect(past.headers.get('Content-Range')).toBe('bytes */20');
  });

  it('serves an empty verified attachment without touching the legacy cache', async () => {
    h.preview = async () => Buffer.alloc(0);
    const res = await handleAttachmentRequest(new Request(url('empty.txt')));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Length')).toBe('0');
    expect(await res.text()).toBe('');
  });

  // Regression: missing, expired, revoked and cross-account leases refuse reads
  // even when the old unscanned attachment is already cached.
  it('passes a blocked preview error without falling back to the cache', async () => {
    registerAttachmentProtocol('http://localhost:5173/');
    const resolve = vi.fn(async () => {
      throw new Error('must never reach cache');
    });
    h.resolve = resolve;
    h.preview = async () => {
      throw new AttachmentError('Preview blocked: scan this attachment again before viewing.', 403);
    };
    const res = await handleAttachmentRequest(
      new Request(url('report.pdf'), {
        headers: { Origin: 'http://localhost:5173' },
      })
    );
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('Preview blocked');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173');
    expect(resolve).not.toHaveBeenCalled();
  });

  it('fails closed while the preview controller has not initialized', async () => {
    h.preview = null;
    const res = await handleAttachmentRequest(new Request(url('report.pdf')));
    expect(res.status).toBe(503);
    expect(await res.text()).toBe('Attachment preview is not ready. Try again.');
  });

  // Regression: scanner enablement while IMAP fetch awaits cannot authorize the
  // old cache path based on the scanner state from before the fetch.
  it('rechecks protection after a legacy cache read', async () => {
    await serving('report.pdf', 'unchecked');
    let reads = 0;
    h.preview = async () => {
      if (++reads === 1) return undefined;
      throw new AttachmentError('Preview blocked: scan this attachment again before viewing.', 403);
    };
    const res = await handleAttachmentRequest(new Request(url('report.pdf')));
    expect(reads).toBe(2);
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain('unchecked');
    // The entry was opened before the refusal; it is not held, and its plaintext is wiped.
    expect(h.opened).toHaveLength(1);
    expect(h.opened[0].every((byte) => byte === 0)).toBe(true);
  });

  it('sanitizes an unexpected preview verification failure', async () => {
    h.preview = async () => {
      throw new Error(`/private/account/secret-db ${TMP}`);
    };
    const res = await handleAttachmentRequest(new Request(url('report.pdf')));
    expect(res.status).toBe(500);
    expect(await res.text()).toBe('Attachment could not be read');
  });
});

describe('handleAttachmentRequest — serving', () => {
  // Breaks: the viewer shows an empty frame because the bytes never arrive, or
  // arrives with a type the element refuses to render.
  it('serves the exact bytes with the type derived from the extension', async () => {
    const body = Buffer.from('%PDF-1.7 hello');
    await serving('report.pdf', body);

    const res = await handleAttachmentRequest(new Request(url('report.pdf')));

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/pdf');
    expect(res.headers.get('Content-Length')).toBe(String(body.length));
    expect(Buffer.from(await res.arrayBuffer())).toEqual(body);
  });

  // Breaks: without nosniff Chromium may re-type an octet-stream by sniffing its
  // content and execute something we deliberately refused to type. `inline` is
  // what stops the response being treated as a download — the whole feature.
  it('sets nosniff, inline disposition and no-store', async () => {
    await serving('note.txt', 'hello');

    const res = await handleAttachmentRequest(new Request(url('note.txt')));

    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Content-Disposition')).toContain('inline');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('Accept-Ranges')).toBe('bytes');
  });

  // Breaks: a filename containing a quote or a newline could otherwise terminate
  // the header value and inject a header of the attacker's choosing.
  it('percent-escapes the filename in Content-Disposition', async () => {
    await serving('we"ird name.txt', 'x');

    const res = await handleAttachmentRequest(new Request(url('we"ird name.txt')));

    const disposition = res.headers.get('Content-Disposition') ?? '';
    expect(disposition).not.toContain('"ird');
    expect(disposition).toContain('%22ird%20name.txt');
  });

  // Breaks: a zero-byte attachment made fs.createReadStream throw on an
  // impossible {start: 0, end: -1} range, turning an empty file into a 500.
  it('serves an empty file as an empty 200', async () => {
    await serving('empty.txt', '');

    const res = await handleAttachmentRequest(new Request(url('empty.txt')));

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Length')).toBe('0');
    expect((await res.arrayBuffer()).byteLength).toBe(0);
  });
});

describe('handleAttachmentRequest — range requests', () => {
  const body = Buffer.from('0123456789abcdefghij');

  // Breaks: video seeking and the PDF viewer's partial loads. Both send a Range
  // and treat a 200 as "this server cannot seek".
  it('answers a byte range with 206 and the right slice', async () => {
    await serving('clip.mp4', body);

    const res = await handleAttachmentRequest(
      new Request(url('clip.mp4'), { headers: { Range: 'bytes=10-19' } })
    );

    expect(res.status).toBe(206);
    expect(res.headers.get('Content-Range')).toBe('bytes 10-19/20');
    expect(res.headers.get('Content-Length')).toBe('10');
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('abcdefghij');
  });

  // Breaks: an open-ended range ("give me everything from here") is the common
  // form Chromium sends first; mis-handling it stalls playback at byte 0.
  it('answers an open-ended range to the end of the file', async () => {
    await serving('clip.mp4', body);

    const res = await handleAttachmentRequest(
      new Request(url('clip.mp4'), { headers: { Range: 'bytes=15-' } })
    );

    expect(res.status).toBe(206);
    expect(res.headers.get('Content-Range')).toBe('bytes 15-19/20');
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('fghij');
  });

  // Breaks: a range past the end must be 416, not a silent full-file 200 that the
  // media element then decodes as garbage at the wrong offset.
  it('answers an unsatisfiable range with 416', async () => {
    await serving('clip.mp4', body);

    const res = await handleAttachmentRequest(
      new Request(url('clip.mp4'), { headers: { Range: 'bytes=999-1200' } })
    );

    expect(res.status).toBe(416);
    expect(res.headers.get('Content-Range')).toBe('bytes */20');
  });

  // Breaks: a Range header we cannot parse must degrade to the whole file rather
  // than erroring — the spec allows ignoring it, and a 400 here means no playback.
  it('ignores an unparseable Range and serves the whole file', async () => {
    await serving('clip.mp4', body);

    const res = await handleAttachmentRequest(
      new Request(url('clip.mp4'), { headers: { Range: 'pages=1-2' } })
    );

    expect(res.status).toBe(200);
    expect((await res.arrayBuffer()).byteLength).toBe(body.length);
  });
});

describe('handleAttachmentRequest — sealed cache entries (CASA M-7)', () => {
  const body = Buffer.from('0123456789abcdefghij');

  // Breaks: a range cut from the SEALED file (ciphertext at plaintext offsets),
  // or a Content-Length that counts the seal's overhead, so the viewer decodes
  // garbage; or every range of one viewer re-opens the whole sealed file (each
  // PDF page, each media seek).
  it('cuts ranges from the decrypted entry, opening it once for the viewer', async () => {
    const filePath = await serving('clip.mp4', body);
    const atRest = readFileSync(filePath);
    expect(atRest.includes(body)).toBe(false);
    expect(atRest.length).toBeGreaterThan(body.length);

    const res = await handleAttachmentRequest(
      new Request(url('clip.mp4'), { headers: { Range: 'bytes=3-7' } })
    );

    expect(res.status).toBe(206);
    expect(res.headers.get('Content-Range')).toBe('bytes 3-7/20');
    expect(res.headers.get('Content-Length')).toBe('5');
    expect(await res.text()).toBe('34567');

    const whole = await handleAttachmentRequest(new Request(url('clip.mp4')));
    expect(whole.headers.get('Content-Length')).toBe(String(body.length));
    expect(Buffer.from(await whole.arrayBuffer())).toEqual(body);
    expect(h.opened).toHaveLength(1);
  });

  // Breaks: HEAD or a refused range is answered from the wrong size.
  it('answers HEAD and an unsatisfiable range from the plaintext size', async () => {
    await serving('clip.mp4', body);

    const head = await handleAttachmentRequest(new Request(url('clip.mp4'), { method: 'HEAD' }));
    const past = await handleAttachmentRequest(
      new Request(url('clip.mp4'), { headers: { Range: 'bytes=20-' } })
    );

    expect(head.status).toBe(200);
    expect(head.headers.get('Content-Length')).toBe('20');
    expect(past.status).toBe(416);
    expect(past.headers.get('Content-Range')).toBe('bytes */20');
  });

  // Breaks: decrypted mail stays in memory after the viewer is done with it.
  it('erases a held entry after its TTL, and on demand', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await serving('clip.mp4', body);
      await handleAttachmentRequest(new Request(url('clip.mp4')));
      expect(h.opened[0]).toEqual(body); // still held for further ranges
      vi.advanceTimersByTime(30_000);
      expect(h.opened[0].every((byte) => byte === 0)).toBe(true);

      await handleAttachmentRequest(new Request(url('clip.mp4')));
      expect(h.opened).toHaveLength(2); // opened again once expired
      forgetRecentAttachmentEntries();
      expect(h.opened[1].every((byte) => byte === 0)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  // Breaks: memory grows with every attachment viewed in the TTL window.
  it('holds at most two entries, erasing the oldest', async () => {
    for (const name of ['a.mp4', 'b.mp4', 'c.mp4']) {
      await serving(name, body);
      await handleAttachmentRequest(new Request(url(name)));
    }
    expect(h.opened).toHaveLength(3);
    expect(h.opened[0].every((byte) => byte === 0)).toBe(true);
    expect(h.opened[1]).toEqual(body);
    expect(h.opened[2]).toEqual(body);
  });

  // Breaks: a damaged entry is served (garbage, or bytes nobody vouched for), or
  // reported as "not available" instead of the reader's retryable error; or it
  // stays on disk, so every later open fails the same way instead of re-fetching.
  it('answers an error, never bytes, for a damaged entry and drops it for a re-fetch', async () => {
    const filePath = await serving('report.pdf', '%PDF-1.7 private contents');
    const damaged = readFileSync(filePath);
    damaged[damaged.length - 1] ^= 0xff;
    writeFileSync(filePath, damaged);

    const res = await handleAttachmentRequest(new Request(url('report.pdf')));

    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).toBe('The attachment could not be read. Try again.');
    expect(text).not.toContain('private contents');
    expect(existsSync(filePath)).toBe(false);
    expect(h.opened).toEqual([]);
  });

  // Breaks: a plaintext file at a cache path (an older build's, or one planted
  // there) is served unverified.
  it('refuses a plaintext file at a cache path', async () => {
    const filePath = await serving('note.txt', 'sealed original');
    writeFileSync(filePath, 'planted plaintext');

    const res = await handleAttachmentRequest(new Request(url('note.txt')));

    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain('planted');
  });

  // SECURITY. Breaks: an entry copied into another attachment's slot opens there;
  // the seal must bind each entry to its own email and file.
  it("refuses an entry moved into another attachment's slot", async () => {
    const other = await sealed('report.pdf', 'another email entirely');
    const filePath = await serving('report.pdf', 'the real attachment');
    copyFileSync(other, filePath);

    const res = await handleAttachmentRequest(new Request(url('report.pdf')));

    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain('another email');
  });
});

describe('parseRangeHeader', () => {
  // Breaks: the suffix form ("the last N bytes") is how a media element probes a
  // container's trailing index; reading it as a start offset seeks to the wrong place.
  it('reads a suffix range as the last N bytes', () => {
    expect(parseRangeHeader('bytes=-5', 20)).toEqual({ start: 15, end: 19 });
  });

  it('clamps an end past the file to the last byte', () => {
    expect(parseRangeHeader('bytes=5-999', 20)).toEqual({ start: 5, end: 19 });
  });

  it('returns null with no header and rejects an inverted range', () => {
    expect(parseRangeHeader(null, 20)).toBeNull();
    expect(parseRangeHeader('bytes=10-4', 20)).toBe('unsatisfiable');
    expect(parseRangeHeader('bytes=-0', 20)).toBe('unsatisfiable');
  });

  // Breaks: multi-range is a form we do not implement; reading only its first
  // part would answer a Content-Range that contradicts the body we send.
  it('ignores a multi-range request rather than answering it wrongly', () => {
    expect(parseRangeHeader('bytes=0-9,20-29', 40)).toBeNull();
  });
});

describe('handleAttachmentRequest — refusals', () => {
  // SECURITY. Breaks: the single-click launch vector the allow-list exists to
  // close. An .exe/.html/.js served over the scheme is content the renderer can
  // run or display; it must never become a loadable URL at all.
  it('refuses every type the viewer will not render, before touching disk', async () => {
    h.resolve = async () => {
      throw new Error('must not reach the cache for a refused type');
    };

    for (const name of ['setup.exe', 'invoice.html', 'run.sh', 'app.js', 'macro.vbs', 'x.docx']) {
      const res = await handleAttachmentRequest(new Request(url(name)));
      expect(res.status, name).toBe(403);
    }
  });

  // SECURITY. Breaks: "invoice.pdf.exe" is the classic double-extension lure. The
  // LAST extension is what the OS acts on, so it must be what we classify on.
  it('refuses a double extension by its real (last) extension', async () => {
    h.resolve = async () => {
      throw new Error('must not reach the cache');
    };

    expect((await handleAttachmentRequest(new Request(url('invoice.pdf.exe')))).status).toBe(403);
  });

  // SECURITY. Breaks: the authorization check in resolveAttachmentFile is what
  // stops the scheme reading any file previously cached under any email. Its
  // 403 must reach the renderer as a 403, not be swallowed into a 200.
  it('passes an AttachmentError status straight through', async () => {
    for (const [status, message] of [
      [403, 'Attachment not found on this email'],
      [404, 'Email not found'],
      [503, 'Not connected to IMAP'],
    ] as const) {
      h.resolve = async () => {
        throw new AttachmentError(message, status);
      };
      const res = await handleAttachmentRequest(new Request(url('a.pdf')));
      expect(res.status).toBe(status);
      expect(await res.text()).toBe(message);
    }
  });

  // Breaks: an unexpected failure leaking a filesystem path tells a hostile email
  // where the user's data directory is.
  it('answers 500 without leaking a path or a stack', async () => {
    h.resolve = async () => {
      throw new Error(`ENOENT: open '${join(TMP, 'secret', 'db-key.bin')}'`);
    };

    const res = await handleAttachmentRequest(new Request(url('a.pdf')));

    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain(TMP);
    expect(text).not.toContain('db-key');
  });

  // Breaks: a malformed URL threw out of the handler, which Electron surfaces as
  // a dead request with no status the renderer can react to.
  it('answers 400 for a URL that is not an attachment URL', async () => {
    for (const bad of [
      'sarv-attachment://attachment/only-one-segment',
      'sarv-attachment://elsewhere/e1/a.pdf',
      'https://example.com/e1/a.pdf',
    ]) {
      expect((await handleAttachmentRequest(new Request(bad))).status).toBe(400);
    }
  });

  // Breaks: the row said the attachment exists but the cached file vanished
  // (pruned between resolve and read) — a 404 is recoverable, a thrown error is not.
  it('answers 404 when the resolved file is gone', async () => {
    h.resolve = async () => ({ filePath: join(TMP, 'does-not-exist.pdf'), filename: 'a.pdf' });

    expect((await handleAttachmentRequest(new Request(url('a.pdf')))).status).toBe(404);
  });
});

describe('handleAttachmentRequest — account routing', () => {
  // Breaks: attachments on a non-active account failed in the unified All
  // Inboxes view, because the lookup always used the active account's storage.
  it('forwards the account from the URL to the resolver', async () => {
    const seen: unknown[] = [];
    const filePath = await sealed('routed.png', 'png');
    h.resolve = async (ref) => {
      seen.push(ref);
      return { filePath, filename: 'routed.png' };
    };

    await handleAttachmentRequest(new Request(url('routed.png', { account: 'acct-2' })));

    expect(seen).toEqual([{ emailId: 'e1', filename: 'routed.png', accountId: 'acct-2' }]);
  });

  // Breaks: a URL with no account must mean "the active account", not the
  // literal string "undefined" or an empty id that matches nothing.
  it('omits the account entirely when the URL carries none', async () => {
    const seen: Array<{ accountId?: string }> = [];
    const filePath = await sealed('plain.png', 'png');
    h.resolve = async (ref) => {
      seen.push(ref as { accountId?: string });
      return { filePath, filename: 'plain.png' };
    };

    await handleAttachmentRequest(new Request(url('plain.png')));

    expect(seen[0].accountId).toBeUndefined();
  });
});

describe('registerAttachmentProtocol', () => {
  // Breaks: the scheme silently never gets a handler, and every attachment URL
  // fails with a net error the UI cannot explain.
  it('registers the handler under the shared scheme name', async () => {
    registerAttachmentProtocol('http://localhost:5173');

    expect([...h.registered.keys()]).toEqual(['sarv-attachment']);
    expect(h.registered.get('sarv-attachment')).toBe(handleAttachmentRequest);
  });
});

describe('handleAttachmentRequest — cross-origin reads', () => {
  // Breaks: THE way this first shipped. `sarv-attachment://` is a standard scheme
  // with its own origin, so the text pane's fetch() is cross-origin — with no
  // allow-origin header Chromium discards the response and every .txt/.csv/.json
  // reads "This file could not be read", while images, PDFs and media (no-cors
  // loads, which skip the check) look perfectly fine.
  it('allows the renderer origin it was registered with', async () => {
    registerAttachmentProtocol('http://localhost:5173/');
    await serving('note.txt', 'hello');

    const res = await handleAttachmentRequest(
      new Request(url('note.txt'), { headers: { Origin: 'http://localhost:5173' } })
    );

    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173');
    expect(res.headers.get('Vary')).toBe('Origin');
  });

  // Breaks: release-only. The packaged app loads the renderer from file://, whose
  // documents send `Origin: null` — matching the dev server URL alone leaves text
  // working in dev and broken in every shipped build.
  it('allows the packaged file:// renderer, which sends Origin: null', async () => {
    registerAttachmentProtocol('file:///Applications/Sarv%20Inbox.app/dist/index.html');
    await serving('note.txt', 'hello');

    const res = await handleAttachmentRequest(
      new Request(url('note.txt'), { headers: { Origin: 'null' } })
    );

    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('null');
  });

  // Breaks: attachment bytes are private mail. Anything else that learned a URL
  // could read them out of the app.
  it('allows no other origin', async () => {
    registerAttachmentProtocol('http://localhost:5173');
    await serving('note.txt', 'hello');

    const res = await handleAttachmentRequest(
      new Request(url('note.txt'), { headers: { Origin: 'https://evil.example' } })
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  // Breaks: an <img>/<video>/PDF load sends no Origin at all — adding a header
  // keyed off one that isn't there must not turn those into failures.
  it('serves a request with no Origin header at all', async () => {
    registerAttachmentProtocol('http://localhost:5173');
    await serving('photo.png', Buffer.from([0x89, 0x50]));

    const res = await handleAttachmentRequest(new Request(url('photo.png')));

    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  // Breaks: a refusal reaches the renderer as an opaque network error instead of
  // its status, so the viewer cannot tell "this type is not allowed" from "the
  // file is gone" and shows one useless message for both.
  it('carries the header on a refusal too', async () => {
    registerAttachmentProtocol('http://localhost:5173');

    const res = await handleAttachmentRequest(
      new Request(url('setup.exe'), { headers: { Origin: 'http://localhost:5173' } })
    );

    expect(res.status).toBe(403);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173');
  });
});
