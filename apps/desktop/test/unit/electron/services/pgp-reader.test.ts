import {
  encryptOutgoingMime,
  generateKeyPair,
  readAnyKey,
  readUnlockedPrivateKey,
  signOutgoingMime,
  type PgpOpenKeys,
} from '@sarvinbox/core/pgp';
import type * as openpgp from 'openpgp';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { OPENED_CACHE_SIZE, PgpReader, type StoredSource } from '../../../../electron/services/pgp-reader';

/**
 * Decrypt-on-view. What this protects: an encrypted message that will not
 * open in the reader; a "locked" or "no key" state shown as a crash; a green
 * signature badge on mail whose key speaks for someone other than From; and
 * plaintext attachments lingering in memory after the user deleted their key.
 */
const inner = Buffer.from(
  [
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="b1"',
    '',
    '--b1',
    'Content-Type: text/html; charset=utf-8',
    '',
    '<p>the secret plan</p>',
    '--b1',
    'Content-Type: application/pdf; name="plan.pdf"',
    'Content-Disposition: attachment; filename="plan.pdf"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from('%PDF-1.4 plan').toString('base64'),
    '--b1--',
    '',
  ].join('\r\n'),
);
const withOuterHeaders = (body: Buffer): Buffer =>
  Buffer.concat([Buffer.from('From: Gee <gee@example.org>\r\nTo: rita@example.com\r\nSubject: plan\r\n'), body]);

let rita: openpgp.PrivateKey;
let gee: openpgp.PrivateKey;
let encryptedRaw: string;
let signedRaw: string;
beforeAll(async () => {
  const [ritaKey, geeKey] = await Promise.all([
    generateKeyPair({ name: 'Rita', email: 'rita@example.com' }),
    generateKeyPair({ name: 'Gee', email: 'gee@example.org' }),
  ]);
  rita = await readUnlockedPrivateKey(ritaKey.armoredPrivateKey);
  gee = await readUnlockedPrivateKey(geeKey.armoredPrivateKey);
  const ritaPublic = await readAnyKey(ritaKey.armoredPublicKey);
  encryptedRaw = withOuterHeaders(
    await encryptOutgoingMime(inner, { encryptionKeys: [ritaPublic], signingKeys: [gee] }),
  ).toString('latin1');
  signedRaw = withOuterHeaders(await signOutgoingMime(inner, [gee])).toString('latin1');
});

const readerWith = (
  source: StoredSource | null | (() => Promise<StoredSource | null>),
  keys: () => PgpOpenKeys | Promise<PgpOpenKeys> = () => ({ decryptionKeys: [rita], verificationKeys: [gee.toPublic()] }),
) => {
  const openingKeys = vi.fn(async () => keys());
  const reader = new PgpReader({
    keyring: () => ({ openingKeys }),
    source: typeof source === 'function' ? source : async () => source,
  });
  return { reader, openingKeys };
};

describe('PgpReader.open', () => {
  // Breaks: the core decrypt-on-view path — an encrypted message shows only its placeholder.
  it('decrypts to the body and lists the attachments without their bytes', async () => {
    const { reader, openingKeys } = readerWith({ raw: encryptedRaw, fromAddress: 'Gee@Example.org' });
    const view = await reader.open('e1', 'acct');

    expect(openingKeys).toHaveBeenCalledWith('Gee@Example.org');
    expect(view).toMatchObject({
      ok: true,
      wasEncrypted: true,
      contentType: 'html',
      signature: { status: 'valid', fromMatches: true },
      attachments: [{ index: 0, name: 'plan.pdf', contentType: 'application/pdf', size: 13 }],
    });
    if (!view.ok) throw new Error('unreachable');
    expect(view.body).toContain('the secret plan');
    // Nothing but metadata crosses to the renderer.
    expect(JSON.stringify(view.attachments)).not.toContain('PDF');
  });

  // Breaks: a valid signature by an unrelated key reads as "signed by the sender".
  it('marks a good signature whose key does not name From as not matching', async () => {
    const { reader } = readerWith({ raw: signedRaw, fromAddress: 'mallory@example.net' });
    expect(await reader.open('e1')).toMatchObject({
      ok: true,
      wasEncrypted: false,
      signature: { status: 'valid', fromMatches: false },
    });
    const { reader: noFrom } = readerWith({ raw: signedRaw, fromAddress: null });
    expect(await noFrom.open('e1')).toMatchObject({ signature: { fromMatches: false } });
  });

  // Breaks: a message nobody's key opens shows as a crash instead of "no key".
  it('returns the PgpOpenError code when no key opens it', async () => {
    const { reader } = readerWith({ raw: encryptedRaw, fromAddress: 'gee@example.org' }, () => ({
      decryptionKeys: [],
      verificationKeys: [],
    }));
    expect(await reader.open('e1')).toMatchObject({ ok: false, code: 'no-key' });
    expect(reader.attachment('e1', undefined, 0)).toBeNull();
  });

  // Breaks: a message whose source is gone (deleted on the server, offline)
  // hangs the reader or throws into the renderer.
  it('reports an unavailable source, thrown or missing', async () => {
    expect(await readerWith(null).reader.open('e1')).toMatchObject({ ok: false, code: 'unavailable' });
    const thrown = readerWith(async () => {
      throw new Error('connection reset');
    });
    expect(await thrown.reader.open('e1')).toMatchObject({ ok: false, code: 'unavailable', error: expect.stringContaining('connection reset') });
  });

  // Breaks: an unexpected failure (keyring unreadable) escapes as a rejected IPC call.
  it('maps an unexpected failure to unavailable', async () => {
    const { reader } = readerWith({ raw: encryptedRaw, fromAddress: 'gee@example.org' }, () => {
      throw new Error('keyring unreadable');
    });
    expect(await reader.open('e1')).toMatchObject({ ok: false, code: 'unavailable', error: 'keyring unreadable' });
  });
});

describe('PgpReader attachments', () => {
  // Breaks: saving a decrypted attachment needs a second decryption, or saves the wrong file.
  it('hands back the bytes of an attachment of an opened message', async () => {
    const { reader } = readerWith({ raw: encryptedRaw, fromAddress: 'gee@example.org' });
    await reader.open('e1', 'acct');
    expect(reader.attachment('e1', 'acct', 0)?.content.toString()).toBe('%PDF-1.4 plan');
    // Keyed by account too: the same id in another account is another message.
    expect(reader.attachment('e1', 'other', 0)).toBeNull();
    expect(reader.attachment('e1', 'acct', 5)).toBeNull();
  });

  // Breaks: plaintext outlives the key the user just deleted.
  it('forgets every opened message', async () => {
    const { reader } = readerWith({ raw: encryptedRaw, fromAddress: 'gee@example.org' });
    await reader.open('e1');
    reader.forget();
    expect(reader.attachment('e1', undefined, 0)).toBeNull();
  });

  // Breaks: every message read this session stays decrypted in memory.
  it(`keeps only the ${OPENED_CACHE_SIZE} most recently opened`, async () => {
    const { reader } = readerWith({ raw: encryptedRaw, fromAddress: 'gee@example.org' });
    for (let i = 0; i <= OPENED_CACHE_SIZE; i += 1) await reader.open(`e${i}`);
    expect(reader.attachment('e0', undefined, 0)).toBeNull();
    expect(reader.attachment(`e${OPENED_CACHE_SIZE}`, undefined, 0)).not.toBeNull();
    // Re-opening refreshes recency instead of evicting.
    await reader.open('e1');
    await reader.open('extra');
    expect(reader.attachment('e1', undefined, 0)).not.toBeNull();
    expect(reader.attachment('e2', undefined, 0)).toBeNull();
  });
});

describe('PgpReader.openDraft', () => {
  // Breaks: an encrypted draft reopens without its files, so the mail sent from it is missing them.
  it('hands the composer the body and the files with their bytes', async () => {
    const { reader } = readerWith({ raw: encryptedRaw, fromAddress: 'rita@example.com' });
    const draft = await reader.openDraft('d1', 'acct');
    expect(draft).toEqual({
      ok: true,
      contentType: 'html',
      body: expect.stringContaining('the secret plan'),
      attachments: [
        {
          filename: 'plan.pdf',
          contentType: 'application/pdf',
          size: 13,
          content: Buffer.from('%PDF-1.4 plan').toString('base64'),
          encoding: 'base64',
        },
      ],
    });
  });

  // Breaks: a draft that cannot be decrypted opens as its placeholder, and the next autosave overwrites the real one.
  it('passes a refusal through instead of an empty draft', async () => {
    const { reader } = readerWith({ raw: encryptedRaw, fromAddress: 'rita@example.com' }, () => ({
      decryptionKeys: [],
      verificationKeys: [],
    }));
    expect(await reader.openDraft('d1')).toMatchObject({ ok: false, code: 'no-key' });
    const { reader: unavailable } = readerWith(null);
    expect(await unavailable.openDraft('d1')).toMatchObject({ ok: false, code: 'unavailable' });
  });
});
