import { simpleParser } from 'mailparser';
import type { AddressObject } from 'mailparser';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SMTPConfig, SendEmailOptions } from '../../../src/types/smtp';

// The SMTP client is the last hop before the wire, so these tests assert on the
// EXACT bytes/options that would have reached the server. nodemailer's transport
// is stubbed (no socket is ever opened) but MailComposer is left REAL — the
// message it builds is the message that would be transmitted, so parsing the
// captured `raw` buffer back with mailparser proves the headers, alternatives
// and attachments a recipient would actually see.
const h = vi.hoisted(() => {
  const state = {
    createdOptions: [] as any[],
    sent: [] as any[],
    closed: 0,
    verifyError: null as Error | null,
    sendError: null as Error | null,
  };
  const createTransport = vi.fn((options: any) => {
    state.createdOptions.push(options);
    return {
      verify: vi.fn(async () => {
        if (state.verifyError) throw state.verifyError;
        return true;
      }),
      sendMail: vi.fn(async (mail: any) => {
        if (state.sendError) throw state.sendError;
        state.sent.push(mail);
        return { messageId: '<assigned-by-server@smtp>' };
      }),
      close: vi.fn(() => { state.closed++; }),
    };
  });
  return { state, createTransport };
});

vi.mock('nodemailer', () => ({
  default: { createTransport: h.createTransport },
  createTransport: h.createTransport,
}));

// Imported AFTER the mock so the client picks up the stubbed transport.
const { SMTPClient, smtpClient } = await import('../../../src/smtp/smtp-client');

const baseConfig = (over: Partial<SMTPConfig> = {}): SMTPConfig => ({
  host: 'smtp.sarv.com',
  port: 587,
  secure: false,
  username: 'me@sarv.com',
  password: 'pw',
  from: 'Me Myself <me@sarv.com>',
  ...over,
});

const lastTransportOptions = () => h.state.createdOptions[h.state.createdOptions.length - 1];
const lastSentMail = () => h.state.sent[h.state.sent.length - 1];
/** Parse the raw MIME the client submitted, i.e. what the recipient receives. */
const parseLastSent = () => simpleParser((lastSentMail().raw as Buffer).toString('utf-8'));

/** Flatten a parsed address header (single object or array) to its text form. */
const addressText = (field?: AddressObject | AddressObject[]): string =>
  (Array.isArray(field) ? field.map((a) => a.text).join(', ') : field?.text) ?? '';

const send = (over: Partial<SendEmailOptions> = {}): SendEmailOptions => ({
  to: ['to@example.com'],
  subject: 'Quarterly report',
  body: 'plain text body',
  ...over,
});

beforeEach(() => {
  h.state.createdOptions.length = 0;
  h.state.sent.length = 0;
  h.state.closed = 0;
  h.state.verifyError = null;
  h.state.sendError = null;
  h.createTransport.mockClear();
});

describe('SMTPClient.connect — transport + TLS policy', () => {
  // Regression guard for the secure-by-default policy: a STARTTLS session that
  // silently stays cleartext leaks the password and the whole message.
  it('REQUIREs STARTTLS on a non-implicit-TLS port and verifies the certificate', async () => {
    const client = new SMTPClient();
    await client.connect(baseConfig({ port: 587, secure: false }));

    const opts = lastTransportOptions();
    expect(opts.host).toBe('smtp.sarv.com');
    expect(opts.port).toBe(587);
    expect(opts.secure).toBe(false);
    expect(opts.requireTLS).toBe(true);                    // cannot fall back to cleartext
    expect(opts.tls).toEqual({ rejectUnauthorized: true, minVersion: 'TLSv1.2' });
    expect(client.isConnected()).toBe(true);
  });

  it('uses implicit TLS (no STARTTLS upgrade) when secure=true', async () => {
    const client = new SMTPClient();
    await client.connect(baseConfig({ port: 465, secure: true }));

    const opts = lastTransportOptions();
    expect(opts.secure).toBe(true);
    expect(opts.requireTLS).toBe(false);                   // meaningless on implicit TLS
    expect(opts.tls.rejectUnauthorized).toBe(true);        // still verified
  });

  // Verification may only be dropped by an EXPLICIT per-account opt-in — never
  // as a side effect of anything else.
  it('only disables certificate verification on the explicit allowInsecureTLS opt-in', async () => {
    const client = new SMTPClient();
    await client.connect(baseConfig({ allowInsecureTLS: true }));
    expect(lastTransportOptions().tls.rejectUnauthorized).toBe(false);
    expect(lastTransportOptions().requireTLS).toBe(false); // opted out of forced upgrade too

    await client.connect(baseConfig({ tlsOptions: { rejectUnauthorized: true }, allowInsecureTLS: true }));
    expect(lastTransportOptions().tls.rejectUnauthorized).toBe(true); // explicit override wins
  });

  it('pins a TLS 1.2 floor regardless of the account settings', async () => {
    const client = new SMTPClient();
    await client.connect(baseConfig({ allowInsecureTLS: true }));
    expect(lastTransportOptions().tls.minVersion).toBe('TLSv1.2');
  });
});

describe('SMTPClient.connect — authentication', () => {
  it('uses plain user/pass credentials by default', async () => {
    const client = new SMTPClient();
    await client.connect(baseConfig({ password: 's3cret' }));
    expect(lastTransportOptions().auth).toEqual({ user: 'me@sarv.com', pass: 's3cret' });
  });

  // OAuth accounts must authenticate with XOAUTH2 — sending the (empty/stale)
  // password field instead is what produced the "invalid login" loop.
  it('uses XOAUTH2 with the access token when authMethod is oauth2', async () => {
    const client = new SMTPClient();
    await client.connect(baseConfig({ authMethod: 'oauth2', accessToken: 'ya29.token', password: '' }));
    expect(lastTransportOptions().auth).toEqual({
      type: 'OAuth2',
      user: 'me@sarv.com',
      accessToken: 'ya29.token',
    });
    expect(lastTransportOptions().auth.pass).toBeUndefined(); // never falls back to a password
  });

  it('refuses to connect when oauth2 is requested without an access token', async () => {
    const client = new SMTPClient();
    await expect(client.connect(baseConfig({ authMethod: 'oauth2' })))
      .rejects.toThrow(/accessToken missing/);
    expect(h.createTransport).not.toHaveBeenCalled(); // no transport built at all
  });

  // connect() is re-called on every re-auth / token refresh: the previous
  // transporter (and its socket) must be released, not abandoned.
  it('closes the previous transporter when reconnecting', async () => {
    const client = new SMTPClient();
    await client.connect(baseConfig());
    await client.connect(baseConfig());
    expect(h.state.closed).toBe(1);
    expect(h.createTransport).toHaveBeenCalledTimes(2);
  });

  it('surfaces a verification failure and leaves the client disconnected', async () => {
    h.state.verifyError = Object.assign(new Error('535 Authentication failed'), { responseCode: 535 });
    const client = new SMTPClient();
    await expect(client.connect(baseConfig())).rejects.toThrow(/Authentication failed/);
    expect(client.isConnected()).toBe(false);
    expect(client.getConfig()).toBeNull(); // no stale config for the refresh path to reuse
  });

  it('exposes the connected config so the OAuth path can reconnect with a fresh token', async () => {
    const client = new SMTPClient();
    await client.connect(baseConfig({ authMethod: 'oauth2', accessToken: 't1' }));
    expect(client.getConfig()?.accessToken).toBe('t1');
  });

  it('disconnect releases the transport and is a no-op when already disconnected', async () => {
    const client = new SMTPClient();
    await client.connect(baseConfig());
    await client.disconnect();
    expect(h.state.closed).toBe(1);
    expect(client.isConnected()).toBe(false);
    await client.disconnect();               // second call must not throw / double-close
    expect(h.state.closed).toBe(1);
  });

  it('tolerates a transporter whose close() throws while reconnecting', async () => {
    const client = new SMTPClient();
    await client.connect(baseConfig());
    // Simulate a transporter that was never fully opened: close() throws.
    (client as any).transporter.close = () => { throw new Error('already closed'); };
    await expect(client.connect(baseConfig())).resolves.toBeUndefined();
  });
});

describe('SMTPClient.sendEmail — recipient validation', () => {
  let client: InstanceType<typeof SMTPClient>;

  beforeEach(async () => {
    client = new SMTPClient();
    await client.connect(baseConfig());
  });

  // "Not connected" must be TRANSIENT, otherwise an offline send is
  // dead-lettered instead of waiting in the outbox for reconnect.
  it('reports a transient failure when not connected (so the outbox retries)', async () => {
    const fresh = new SMTPClient();
    const result = await fresh.sendEmail(send());
    expect(result).toEqual({ success: false, error: 'Not connected to SMTP server', transient: true });
    expect(h.state.sent).toHaveLength(0);
  });

  it('rejects a send with no recipients as permanent (retrying can never help)', async () => {
    const result = await client.sendEmail(send({ to: [] }));
    expect(result.success).toBe(false);
    expect(result.transient).toBe(false);
    expect(result.error).toBe('No recipients specified');
  });

  it('rejects malformed recipients as permanent and names them', async () => {
    const result = await client.sendEmail(send({ to: ['ok@example.com'], cc: ['not-an-email'] }));
    expect(result.success).toBe(false);
    expect(result.transient).toBe(false);
    expect(result.error).toContain('not-an-email');
    expect(h.state.sent).toHaveLength(0); // nothing was transmitted
  });

  // Display names are legitimate; the old bare-email check rejected them as
  // "invalid recipient" and blocked real sends.
  it('accepts "Display Name <addr>" recipients in to/cc/bcc', async () => {
    const result = await client.sendEmail(send({
      to: ['"Doe, John" <john@example.com>'],
      cc: ['Accounts Sarv <accounts@sarv.com>'],
      bcc: ['Secret <secret@example.com>'],
    }));
    expect(result.success).toBe(true);
  });
});

describe('SMTPClient.sendEmail — the message that reaches the wire', () => {
  let client: InstanceType<typeof SMTPClient>;

  beforeEach(async () => {
    client = new SMTPClient();
    await client.connect(baseConfig());
  });

  it('carries From/To/Cc, the subject, and our own Message-ID', async () => {
    const result = await client.sendEmail(send({
      to: ['a@example.com', 'b@example.com'],
      cc: ['c@example.com'],
      subject: 'Quarterly report',
    }));

    expect(result.success).toBe(true);
    const mime = await parseLastSent();
    expect(addressText(mime.from)).toContain('me@sarv.com');
    expect(addressText(mime.to)).toContain('a@example.com');
    expect(addressText(mime.to)).toContain('b@example.com');
    expect(addressText(mime.cc)).toContain('c@example.com');
    expect(mime.subject).toBe('Quarterly report');
    // The Message-ID we generated must be the one in the MIME — the Sent-copy
    // APPEND and dedupe reconcile by exactly this value.
    expect(result.messageId).toMatch(/^<\d+\.[a-z0-9]+@sarv\.com>$/);
    expect(mime.messageId).toBe(result.messageId);
    expect(result.rawMessage).toContain(`Message-ID: ${result.messageId}`);
  });

  // The Message-ID domain is derived from the From address; a From with no
  // domain must still yield a syntactically valid id (dedupe keys on it).
  it('uses a fallback Message-ID domain when the From address has none', async () => {
    const odd = new SMTPClient();
    await odd.connect(baseConfig({ from: 'no-domain-here' }));
    const result = await odd.sendEmail(send());
    expect(result.messageId).toMatch(/@sarvinbox\.local>$/);
  });

  it('falls back to the username as From when no from is configured', async () => {
    const bare = new SMTPClient();
    await bare.connect(baseConfig({ from: undefined }));
    const result = await bare.sendEmail(send());
    expect(result.success).toBe(true);
    const mime = await parseLastSent();
    expect(addressText(mime.from)).toContain('me@sarv.com');
  });

  // Bcc must never appear in the transmitted MIME (or the Sent copy built from
  // it) — but the recipients still have to receive the mail, which is why the
  // envelope is set explicitly.
  it('delivers Bcc via the SMTP envelope only, never as a header', async () => {
    const result = await client.sendEmail(send({
      to: ['a@example.com'],
      cc: ['c@example.com'],
      bcc: ['hidden@example.com'],
    }));

    expect(result.success).toBe(true);
    expect(lastSentMail().envelope).toEqual({
      from: 'me@sarv.com',                                   // bare address for MAIL FROM
      to: ['a@example.com', 'c@example.com', 'hidden@example.com'],
    });
    const raw = (lastSentMail().raw as Buffer).toString('utf-8');
    expect(raw).not.toMatch(/^Bcc:/mi);
    expect(raw).not.toContain('hidden@example.com');
  });

  it('sends text and HTML as alternatives when both are supplied', async () => {
    await client.sendEmail(send({ body: 'plain version', htmlBody: '<p>rich <b>version</b></p>' }));
    const raw = (lastSentMail().raw as Buffer).toString('utf-8');
    expect(raw).toContain('multipart/alternative');
    const mime = await parseLastSent();
    expect(mime.text?.trim()).toBe('plain version');
    expect(mime.html).toContain('rich <b>version</b>');
  });

  it('sends an HTML-only message when there is no plain-text body', async () => {
    await client.sendEmail(send({ body: '', htmlBody: '<p>only html</p>' }));
    const mime = await parseLastSent();
    expect(mime.html).toContain('only html');
    const raw = (lastSentMail().raw as Buffer).toString('utf-8');
    expect(raw).toContain('text/html');
    expect(raw).not.toContain('multipart/alternative');
  });

  it('attaches files with their filename, content type and bytes intact', async () => {
    await client.sendEmail(send({
      attachments: [
        { filename: 'report.pdf', content: Buffer.from('%PDF-1.4 fake'), contentType: 'application/pdf' },
        { filename: 'notes.txt', content: 'hello attachment', contentType: 'text/plain' },
      ],
    }));

    const mime = await parseLastSent();
    expect(mime.attachments).toHaveLength(2);
    const pdf = mime.attachments.find(a => a.filename === 'report.pdf')!;
    expect(pdf.contentType).toBe('application/pdf');
    expect(pdf.content.toString('utf-8')).toBe('%PDF-1.4 fake');
    const txt = mime.attachments.find(a => a.filename === 'notes.txt')!;
    expect(txt.content.toString('utf-8')).toBe('hello attachment');
  });

  it('honours a base64-encoded attachment payload', async () => {
    await client.sendEmail(send({
      attachments: [{
        filename: 'logo.png',
        content: Buffer.from('binary-bytes').toString('base64'),
        contentType: 'image/png',
        encoding: 'base64',
      }],
    }));

    const mime = await parseLastSent();
    expect(mime.attachments[0].filename).toBe('logo.png');
    expect(mime.attachments[0].content.toString('utf-8')).toBe('binary-bytes'); // decoded, not double-encoded
  });

  it('does not build a multipart message when there are no attachments', async () => {
    await client.sendEmail(send({ attachments: [] }));
    const raw = (lastSentMail().raw as Buffer).toString('utf-8');
    expect(raw).not.toContain('multipart/mixed');
  });

  // Threading: a reply that loses In-Reply-To/References is shown as a new
  // thread by every client.
  it('stamps In-Reply-To and the full References chain on a reply', async () => {
    await client.sendEmail(send({
      inReplyTo: '<parent@example.com>',
      references: ['<root@example.com>', '<parent@example.com>'],
    }));

    const raw = (lastSentMail().raw as Buffer).toString('utf-8');
    expect(raw).toContain('In-Reply-To: <parent@example.com>');
    expect(raw).toMatch(/References: <root@example\.com>\s*<parent@example\.com>/);
  });

  it('falls back to In-Reply-To as the References chain when none is supplied', async () => {
    await client.sendEmail(send({ inReplyTo: '<parent@example.com>' }));
    const raw = (lastSentMail().raw as Buffer).toString('utf-8');
    expect(raw).toContain('References: <parent@example.com>');
  });

  it('omits threading headers entirely for a fresh (non-reply) message', async () => {
    await client.sendEmail(send());
    const raw = (lastSentMail().raw as Buffer).toString('utf-8');
    expect(raw).not.toMatch(/^In-Reply-To:/mi);
    expect(raw).not.toMatch(/^References:/mi);
  });
});

describe('SMTPClient.sendEmail — failure classification', () => {
  let client: InstanceType<typeof SMTPClient>;

  beforeEach(async () => {
    client = new SMTPClient();
    await client.connect(baseConfig());
  });

  // A 4.x.x greylist/try-later must stay in the outbox; a 5.x.x rejection must
  // dead-letter instead of being retried forever.
  it('classifies a 4xx server reply as transient', async () => {
    h.state.sendError = Object.assign(new Error('450 Try again later'), { responseCode: 450 });
    const result = await client.sendEmail(send());
    expect(result).toMatchObject({ success: false, transient: true });
    expect(result.error).toContain('450');
  });

  it('classifies a 5xx server reply as permanent', async () => {
    h.state.sendError = Object.assign(new Error('550 Mailbox not found'), { responseCode: 550 });
    const result = await client.sendEmail(send());
    expect(result).toMatchObject({ success: false, transient: false });
  });

  it('classifies a socket-level failure as transient', async () => {
    h.state.sendError = Object.assign(new Error('Connection timeout'), { code: 'ETIMEDOUT' });
    const result = await client.sendEmail(send());
    expect(result.transient).toBe(true);
  });
});

describe('SMTPClient.sendEmail — read receipt + identity', () => {
  // Requesting a read receipt must add Disposition-Notification-To pointing at
  // the sender; without it, no recipient client will ever offer to notify back.
  it('adds Disposition-Notification-To when a read receipt is requested', async () => {
    const client = new SMTPClient();
    await client.connect(baseConfig());
    await client.sendEmail(send({ requestReadReceipt: true }));
    const parsed = await parseLastSent();
    // mailparser parses this address-type header into an AddressObject.
    const dnt = parsed.headers.get('disposition-notification-to') as AddressObject | undefined;
    expect(dnt).toBeTruthy();
    expect(addressText(dnt)).toContain('me@sarv.com');
  });

  it('omits the receipt header by default', async () => {
    const client = new SMTPClient();
    await client.connect(baseConfig());
    await client.sendEmail(send());
    const parsed = await parseLastSent();
    expect(parsed.headers.get('disposition-notification-to')).toBeUndefined();
  });

  // Sending as an identity/alias changes the visible From, but the SMTP envelope
  // sender MUST stay the authenticated account or the send trips SPF / MAIL FROM
  // checks — the exact footgun this split avoids.
  it('sends as an alias in the header From while keeping the authenticated envelope sender', async () => {
    const client = new SMTPClient();
    await client.connect(baseConfig()); // authenticated as me@sarv.com
    await client.sendEmail(send({ from: 'Sales <sales@sarv.com>' }));
    const parsed = await parseLastSent();
    expect(addressText(parsed.from)).toContain('sales@sarv.com'); // header From = alias
    expect(lastSentMail().envelope.from).toBe('me@sarv.com');     // envelope = authenticated
  });
});

describe('smtpClient singleton', () => {
  // The main process wires one shared instance; it must be usable as-is.
  it('is a ready SMTPClient instance that starts disconnected', () => {
    expect(smtpClient).toBeInstanceOf(SMTPClient);
    expect(smtpClient.isConnected()).toBe(false);
  });
});
