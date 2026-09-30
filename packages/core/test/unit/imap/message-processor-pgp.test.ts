import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { MessageProcessor } from '../../../src/imap/message-processor';
import { PGP_ENCRYPTED_PLACEHOLDER } from '../../../src/pgp/types';
import { FakeEmailStorage, resetFakeStorageIds } from '../../../src/test-support/fake-email-storage';
import { FakeImapServer, resetFakeMessageIds } from '../../../src/test-support/fake-imap-server';

/**
 * OpenPGP at ingest. What this protects is the "decrypt on view only" promise:
 * an encrypted message's body columns hold a placeholder and nothing else, so
 * FTS, snippets, filters and every AI prompt never see the ciphertext (or,
 * later, the plaintext) — and `pgpStatus` is what tells the reader to decrypt.
 * Real GnuPG output is used (see ../pgp/fixtures/README.md), not openpgp.js's
 * own, so the detection is checked against what other clients actually send.
 */
const fixture = (name: string): string =>
  readFileSync(join(__dirname, '../pgp/fixtures', name)).toString('latin1');
const crlf = (lines: string[]): string => lines.join('\r\n');
const plainMessage = (body: string): string =>
  crlf(['From: gee@example.org', 'Subject: Plain', 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', '', body, '']);

const mp = new MessageProcessor({ headersOnly: false });

describe('parseBody — OpenPGP', () => {
  // Breaks: the ciphertext (and its encrypted.asc part) lands in the body,
  // the snippet and the attachment list.
  it('stores only a placeholder for a PGP/MIME encrypted message', async () => {
    const parsed = await mp.parseBody(fixture('gpg-encrypted-signed.eml'));
    expect(parsed).toMatchObject({
      rawBody: PGP_ENCRYPTED_PLACEHOLDER,
      cleanBody: PGP_ENCRYPTED_PLACEHOLDER,
      contentType: 'text',
      attachments: [],
      pgp: 'encrypted',
      attachmentSpam: null,
    });
  });

  // Breaks: inline-encrypted mail (common from older clients and webmail
  // plugins) is stored as a wall of armored ciphertext.
  it('stores only a placeholder for an inline encrypted message', async () => {
    const parsed = await mp.parseBody(plainMessage(fixture('gpg-inline-encrypted.asc')));
    expect(parsed).toMatchObject({ cleanBody: PGP_ENCRYPTED_PLACEHOLDER, pgp: 'encrypted' });
  });

  // Breaks: a signed message loses its readable body, or shows signature.asc
  // as an attachment next to the badge that already stands for it.
  it('keeps a signed message readable, marks it, and hides the signature part', async () => {
    const parsed = await mp.parseBody(fixture('gpg-signed.eml'));
    expect(parsed.pgp).toBe('signed');
    expect(parsed.cleanBody).not.toBe(PGP_ENCRYPTED_PLACEHOLDER);
    expect(parsed.cleanBody.length).toBeGreaterThan(0);
    expect(parsed.attachments.map((a) => a.contentType)).not.toContain('application/pgp-signature');

    const clear = await mp.parseBody(plainMessage(fixture('gpg-clearsigned.txt')));
    expect(clear.pgp).toBe('signed');
    expect(clear.cleanBody).toContain('Inline signed body.');
  });

  // Breaks: a mail that merely QUOTES a PGP block (a forwarded key, a how-to)
  // would vanish behind "Encrypted message" with nothing to decrypt.
  it('leaves ordinary mail that quotes armor further down alone', async () => {
    const parsed = await mp.parseBody(
      plainMessage(`Here is what it looks like:\r\n\r\n${fixture('gpg-inline-encrypted.asc')}`),
    );
    expect(parsed.pgp).toBeUndefined();
    expect(parsed.cleanBody).toContain('Here is what it looks like');
  });

  // Breaks: an S/MIME signed message (multipart/signed with a different
  // protocol) would be treated as PGP and badged "unverified".
  it('does not mistake S/MIME for PGP', async () => {
    const smime = crlf([
      'From: a@example.org',
      'MIME-Version: 1.0',
      'Content-Type: multipart/signed; protocol="application/pkcs7-signature"; micalg=sha-256; boundary=B',
      '',
      '--B',
      'Content-Type: text/plain',
      '',
      'Hello',
      '--B--',
      '',
    ]);
    expect((await mp.parseBody(smime)).pgp).toBeUndefined();
  });
});

describe('ingest and body download — OpenPGP', () => {
  const setup = () => {
    resetFakeMessageIds();
    resetFakeStorageIds();
    const server = new FakeImapServer();
    server.addFolder('INBOX', { uidValidity: 1 });
    const db = new FakeEmailStorage();
    db.addFolder('INBOX', { uidValidity: 1 });
    return { server, db };
  };

  // Breaks: headers-first sync (the common path) learns the shape only when
  // the body downloads; without the update the reader never decrypts.
  it('fetchBody stores the placeholder and the status', async () => {
    const { server, db } = setup();
    const uid = server.addMessage('INBOX', { messageId: '<gpg-encrypted@example.org>', body: fixture('gpg-encrypted-signed.eml') });
    const row = db.seedEmail({ folderId: db.folderId('INBOX'), uid, tags: '|INBOX|', messageId: '<gpg-encrypted@example.org>' });

    await mp.fetchBody(server, 'INBOX', uid, db.asStorage(), row.id);

    expect(db.row(row.id)).toMatchObject({ cleanBody: PGP_ENCRYPTED_PLACEHOLDER, pgpStatus: 'encrypted' });
  });

  // Breaks: a body-carrying sync inserts the ciphertext row as ordinary mail.
  it('processBatch stamps the status on insert when the fetch carried the body', async () => {
    const { server, db } = setup();
    server.addMessage('INBOX', { body: fixture('gpg-signed.eml') });
    await server.selectFolder('INBOX');
    const [message] = await server.fetchMessagesByUidRange(1, 10, { fetchBody: true });

    await mp.processBatch([message], db.folder('INBOX'), db.asStorage());

    expect(db.allRows()[0]).toMatchObject({ pgpStatus: 'signed' });
  });
});
