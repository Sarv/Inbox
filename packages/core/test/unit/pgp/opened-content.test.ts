import { readFileSync } from 'fs';
import { join } from 'path';

import MailComposer from 'nodemailer/lib/mail-composer';
import type * as openpgp from 'openpgp';
import { beforeAll, describe, expect, it } from 'vitest';

import { readAnyKey, readUnlockedPrivateKey } from '../../../src/pgp/keys';
import { openStoredPgp, readOpenedContent } from '../../../src/pgp/opened-content';
import { encryptOutgoingMime } from '../../../src/pgp/pgp-mime';
import { PgpOpenError } from '../../../src/pgp/types';

/**
 * The reader's one door into a PGP message. What this protects: every shape
 * a stored message can have opens through the same call, and what comes out
 * is a body the reader can render plus the files, with nothing lost between.
 */
const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', name));
const plainMessage = (body: string): Buffer =>
  Buffer.from(['From: gee@example.org', 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', '', body, ''].join('\r\n'));

let rita: openpgp.PrivateKey;
let gee: openpgp.Key;
beforeAll(async () => {
  rita = await readUnlockedPrivateKey(fixture('recipient.key.asc').toString());
  gee = await readAnyKey(fixture('gpg-sender.pub.asc').toString());
});

describe('openStoredPgp', () => {
  // Breaks: PGP/MIME mail (Thunderbird, Mutt, Proton) never opens in the reader.
  it('opens PGP/MIME encrypted and signed messages', async () => {
    const keys = { decryptionKeys: [rita], verificationKeys: [gee] };
    expect(await openStoredPgp(fixture('gpg-encrypted-signed.eml'), keys)).toMatchObject({
      wasEncrypted: true,
      signature: { status: 'valid' },
    });
    expect(await openStoredPgp(fixture('gpg-signed.eml'), keys)).toMatchObject({ wasEncrypted: false });
  });

  // Breaks: inline PGP (webmail plugins, older clients) never opens — the
  // ciphertext sits inside an ordinary text/plain part that must be decoded first.
  it('opens inline PGP inside a text part', async () => {
    const opened = await openStoredPgp(plainMessage(fixture('gpg-inline-encrypted.asc').toString()), {
      decryptionKeys: [rita],
      verificationKeys: [gee],
    });
    expect(opened).toMatchObject({ kind: 'inline-encrypted', content: { type: 'text' } });
  });

  // Breaks: a message the user's keys cannot open reads as a crash rather
  // than "no key", so the reader cannot tell them what to do.
  it('refuses with a PgpOpenError when no key opens it', async () => {
    await expect(
      openStoredPgp(fixture('gpg-encrypted-signed.eml'), { decryptionKeys: [], verificationKeys: [] }),
    ).rejects.toMatchObject({ code: 'no-key' });
    await expect(openStoredPgp(plainMessage('just text'), { decryptionKeys: [], verificationKeys: [] })).rejects.toBeInstanceOf(
      PgpOpenError,
    );
  });
});

describe('readOpenedContent', () => {
  // Breaks: inline plaintext is shown as HTML (or lost).
  it('passes bare text through', async () => {
    expect(await readOpenedContent({ type: 'text', text: 'hi' })).toEqual({ contentType: 'text', body: 'hi', attachments: [] });
  });

  // Breaks: the decrypted message shows without its HTML or its files — or
  // an inline image shows up twice, once in the body and once as a file.
  it('parses decrypted MIME into an HTML body and its real attachments', async () => {
    const inner = await new MailComposer({
      from: 'gee@example.org',
      to: 'rita@example.com',
      text: 'plain',
      html: '<p>secret <img src="cid:logo@x"></p>',
      attachments: [
        { filename: 'plan.pdf', content: Buffer.from('%PDF-1.4 plan'), contentType: 'application/pdf' },
        { filename: 'logo.png', content: Buffer.from('png'), contentType: 'image/png', cid: 'logo@x' },
      ],
    })
      .compile()
      .build();
    const encrypted = await encryptOutgoingMime(inner, { encryptionKeys: [rita.toPublic()] });
    const opened = await openStoredPgp(encrypted, { decryptionKeys: [rita], verificationKeys: [] });
    const view = await readOpenedContent(opened.content);

    expect(view.contentType).toBe('html');
    expect(view.body).toContain('secret');
    expect(view.attachments).toHaveLength(1);
    expect(view.attachments[0]).toMatchObject({ name: 'plan.pdf', contentType: 'application/pdf', size: 13 });
    expect(view.attachments[0].content.toString()).toBe('%PDF-1.4 plan');
  });

  // Breaks: a text-only decrypted message shows as empty.
  it('falls back to the text part when there is no HTML', async () => {
    const inner = await new MailComposer({ from: 'a@example.org', text: 'only text' }).compile().build();
    expect(await readOpenedContent({ type: 'mime', bytes: inner })).toMatchObject({ contentType: 'text', body: 'only text\n' });
  });
});
