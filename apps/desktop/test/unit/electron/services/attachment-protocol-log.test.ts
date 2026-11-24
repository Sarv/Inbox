import { getLogLevel, setLogLevel, setLogSink } from '@sarvinbox/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What the `sarv-attachment://` handler writes to app.log. Its "served" line
 * is info (kept in a release log) and fires on EVERY range request — each PDF
 * page fetch, each video seek — and it used to name the attachment. A file
 * name comes from the mail and can name the letter, the person or the company
 * it is about. Its failure line logged the error whole, and the whole-message
 * fallback's error quotes the name too.
 *
 * What breaks if this file fails: an attachment's file name reaches app.log,
 * or serving changes while the line is changed.
 */

const h = vi.hoisted(() => ({
  preview: null as null | (() => Promise<Buffer | undefined>),
  resolve: null as null | (() => Promise<{ filePath: string; filename: string }>),
}));

vi.mock('electron', () => ({ protocol: { handle: vi.fn() } }));
vi.mock('../../../../electron/services/attachment-cache', () => {
  class AttachmentError extends Error {
    constructor(message: string, readonly status: number) { super(message); }
  }
  return {
    AttachmentError,
    readCachedAttachment: vi.fn(),
    resolveAttachmentFile: () => h.resolve!(),
  };
});
vi.mock('../../../../electron/services/attachment-preview-protection', () => ({
  getAttachmentPreviewProtection: () => ({ contentForRequest: () => h.preview!() }),
}));

import { captureLogs, type CapturedLogs } from '../../../../../../packages/core/src/test-support/log-capture';
import { handleAttachmentRequest } from '../../../../electron/services/attachment-protocol';

const NAME = 'SENTINEL-Payslip-Jane.pdf';
const url = `sarv-attachment://attachment/email-1/${encodeURIComponent(NAME)}?account=acct-1&preview=lease`;

let logs: CapturedLogs;
beforeEach(() => {
  h.preview = async () => Buffer.from('0123456789abcdefghij');
  h.resolve = null;
  logs = captureLogs({ setLogSink, setLogLevel, getLogLevel });
});
afterEach(() => { logs.stop(); });

describe('handleAttachmentRequest — what reaches the log', () => {
  // Breaks: '[attachment-protocol] served <file name> …' on every range.
  it('logs each served range by range, size and type, never the file name', async () => {
    const whole = await handleAttachmentRequest(new Request(url));
    const tail = await handleAttachmentRequest(new Request(url, { headers: { Range: 'bytes=-5' } }));

    expect(whole.status).toBe(200);
    expect(await tail.text()).toBe('fghij');
    expect(logs.containing('SENTINEL')).toEqual([]);
    expect(logs.containing('[attachment-protocol] served')).toEqual([
      '[INFO] [attachment-protocol] [attachment-protocol] served 0-19/20 type=application/pdf origin=none',
      '[INFO] [attachment-protocol] [attachment-protocol] served 15-19/20 type=application/pdf origin=none',
    ]);
  });

  // Breaks: a HEAD or an unsatisfiable range starts logging (with the name).
  it('logs nothing for a HEAD request or an unsatisfiable range', async () => {
    expect((await handleAttachmentRequest(new Request(url, { method: 'HEAD' }))).status).toBe(200);
    expect((await handleAttachmentRequest(new Request(url, { headers: { Range: 'bytes=20-' } }))).status).toBe(416);

    expect(logs.lines).toEqual([]);
  });

  // Breaks (failure path): the whole-message fallback's 'Attachment "<name>"
  // not found' error, or an IMAP error, is logged whole.
  it('logs a failed read by error class and code, and answers a bare 500', async () => {
    h.preview = async () => { throw Object.assign(new Error(`Attachment "${NAME}" not found`), { code: 'ENOATTACHMENT' }); };

    const res = await handleAttachmentRequest(new Request(url));

    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain('SENTINEL');
    expect(logs.containing('SENTINEL')).toEqual([]);
    expect(logs.lines).toEqual([
      "[ERROR] [attachment-protocol] [attachment-protocol] request failed: { name: 'Error', code: 'ENOATTACHMENT' }",
    ]);
  });
});
