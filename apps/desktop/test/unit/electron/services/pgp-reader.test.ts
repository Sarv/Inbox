import {
  encryptOutgoingMime,
  generateKeyPair,
  PGP_DECRYPT_FAILED_MESSAGE,
  readAnyKey,
  readUnlockedPrivateKey,
  signOutgoingMime,
  type PgpOpenKeys,
} from '@sarvinbox/core/pgp';
import * as openpgp from 'openpgp';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { OPENED_CACHE_SIZE, PGP_OPEN_FAILED_MESSAGE, PgpReader, type StoredSource } from '../../../../electron/services/pgp-reader';
import { SealError } from '../../../../electron/services/pgp-secret-seal';

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

afterEach(() => vi.restoreAllMocks());

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

  // Breaks: an unexpected failure (keyring unreadable) escapes as a rejected IPC call —
  // or (CASA 4.1.4) shows the library's / platform's own text instead of ours.
  it('maps an unexpected failure to unavailable, with its reason in the log only', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { reader } = readerWith({ raw: encryptedRaw, fromAddress: 'gee@example.org' }, () => {
      throw new Error('keyring unreadable');
    });
    expect(await reader.open('e1')).toEqual({ ok: false, code: 'unavailable', error: PGP_OPEN_FAILED_MESSAGE });
    expect(warnLines(warn)).toEqual([expect.stringContaining('keyring unreadable')]);
  });

  // Breaks: "the keychain is not available" — decided before any decryption,
  // and the one thing the user can act on — is flattened into the vague message.
  it('keeps our own keychain refusal in its own words', async () => {
    const { reader } = readerWith({ raw: encryptedRaw, fromAddress: 'gee@example.org' }, () => {
      throw new SealError('This key is sealed by the OS keychain, which is not available', 'keychain-unavailable');
    });
    expect(await reader.open('e1')).toEqual({
      ok: false,
      code: 'unavailable',
      error: 'This key is sealed by the OS keychain, which is not available',
    });
  });
});

const warnLines = (warn: { mock: { calls: unknown[][] } }): string[] => warn.mock.calls.map((call) => call.map(String).join(' '));

describe('PgpReader decryption failures (CASA 4.1.4)', () => {
  /** The encrypted fixture with one bit of its binary ciphertext flipped at `offset` (negative: from the end). */
  const tampered = async (offset: number): Promise<string> => {
    const armor = encryptedRaw.match(/-----BEGIN PGP MESSAGE-----[\s\S]*-----END PGP MESSAGE-----/)![0];
    const bytes = new Uint8Array((await openpgp.unarmor(armor)).data as Uint8Array);
    bytes[offset < 0 ? bytes.length + offset : offset] ^= 0x01;
    const rearmored = openpgp.armor(openpgp.enums.armor.message, bytes).trim().replace(/\r?\n/g, '\r\n');
    return encryptedRaw.replace(armor, rearmored);
  };

  // Breaks: the reader shows "Key Data Integrity failed" for one tampered
  // message and "Modification detected" for another — a decryption oracle for
  // whoever sent them. The renderer must get one sentence; the log the reason.
  it('shows the same text for a bad session key and a failed integrity check, and logs each reason', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const views = [];
    for (const raw of [await tampered(40), await tampered(-5)]) {
      views.push(await readerWith({ raw, fromAddress: 'gee@example.org' }).reader.open('e1'));
    }
    views.forEach((view) => expect(view).toEqual({ ok: false, code: 'bad-data', error: PGP_DECRYPT_FAILED_MESSAGE }));
    const lines = warnLines(warn);
    expect(lines).toEqual([
      expect.stringContaining('Key Data Integrity failed'),
      expect.stringContaining('Modification detected'),
    ]);
    // The log line names the message, never its content.
    lines.forEach((line) => expect(line).not.toContain('the secret plan'));
  });

  // Breaks: a refusal decided before decrypting ("no key") starts writing log noise for every message the user cannot open.
  it('logs nothing for a refusal that carries no library reason', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { reader } = readerWith({ raw: encryptedRaw, fromAddress: 'gee@example.org' }, () => ({ decryptionKeys: [], verificationKeys: [] }));
    expect(await reader.open('e1')).toMatchObject({ ok: false, code: 'no-key' });
    expect(warn).not.toHaveBeenCalled();
  });

  // Breaks: why a signature failed ("Signed digest did not match") reaches the renderer, or is lost from the log.
  it('logs why a signature did not verify and sends the renderer only the verdict', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const forged = signedRaw.replace('the secret plan', 'the forged plan');
    const view = await readerWith({ raw: forged, fromAddress: 'gee@example.org' }).reader.open('e1');
    expect(view).toMatchObject({ ok: true, signature: { status: 'invalid' } });
    expect(JSON.stringify(view)).not.toMatch(/digest|could not be verified/i);
    expect(warnLines(warn)).toEqual([expect.stringMatching(/signature on e1 did not verify: .+/)]);
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
