import { readFileSync } from 'fs';
import { join } from 'path';

import MailComposer from 'nodemailer/lib/mail-composer';
import * as openpgp from 'openpgp';
import { beforeAll, describe, expect, it } from 'vitest';

import { generateKeyPair, readAnyKey, readUnlockedPrivateKey } from '../../../src/pgp/keys';
import { detectPgpMime, parseMimeEntity, splitHeaderBody } from '../../../src/pgp/mime-structure';
import {
  encryptOutgoingMime,
  openInlinePgp,
  openPgpMime,
  signOutgoingMime,
  toCanonicalCrlf,
  withHeader,
} from '../../../src/pgp/pgp-mime';
import type { PgpOpenKeys } from '../../../src/pgp/pgp-mime';

const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', name));

interface Party {
  priv: openpgp.PrivateKey;
  pub: openpgp.Key;
}

async function party(email: string): Promise<Party> {
  const generated = await generateKeyPair({ name: email.split('@')[0], email });
  return {
    priv: await readUnlockedPrivateKey(generated.armoredPrivateKey),
    pub: await readAnyKey(generated.armoredPublicKey),
  };
}

function compose(options: Record<string, unknown>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    new MailComposer(options as never).compile().build((error, message) => (error ? reject(error) : resolve(message)));
  });
}

const baseMail = {
  from: 'Ann <ann@x.com>',
  to: 'bob@y.com',
  subject: 'Héllo wörld',
  messageId: '<fixed@x.com>',
  inReplyTo: '<parent@y.com>',
  text: 'plain ünïcode\nsecond line',
  html: '<p>hi</p>',
  attachments: [{ filename: 'notes.txt', content: 'attachment data' }],
};

let ann: Party;
let bob: Party;
let raw: Buffer;

beforeAll(async () => {
  [ann, bob] = await Promise.all([party('ann@x.com'), party('bob@y.com')]);
  raw = await compose(baseMail);
});

const keysFor = (me: Party, ...others: Party[]): PgpOpenKeys => ({
  decryptionKeys: [me.priv],
  verificationKeys: [me.pub, ...others.map((other) => other.pub)],
});

const innerOf = (message: Buffer) => {
  const { body } = splitHeaderBody(message);
  const entity = parseMimeEntity(message);
  return { entity, body };
};

describe('encryptOutgoingMime', () => {
  // Breaks: the recipient opens the message and gets a different (or truncated)
  // body than the one the composer built — attachments included.
  it('round-trips the exact inner entity and a valid embedded signature', async () => {
    const encrypted = await encryptOutgoingMime(raw, { encryptionKeys: [bob.pub, ann.pub], signingKeys: [ann.priv] });
    const opened = await openPgpMime(encrypted, keysFor(bob, ann));
    expect(opened).toMatchObject({ kind: 'encrypted', wasEncrypted: true });
    expect(opened.signature).toMatchObject({ status: 'valid', signerEmails: ['ann@x.com'] });
    expect(opened.signature.signedAt).toMatch(/Z$/);
    const original = innerOf(raw);
    expect(opened.content.type).toBe('mime');
    if (opened.content.type !== 'mime') return;
    expect(splitHeaderBody(opened.content.bytes).body.equals(original.body)).toBe(true);
    expect(parseMimeEntity(opened.content.bytes).headers.getFirst('content-type')).toBe(
      original.entity.headers.getFirst('content-type'),
    );
  });

  // Breaks: threading, the Sent-folder dedupe (by Message-ID) and the list view
  // all read the OUTER headers; losing or re-encoding them breaks each one.
  it('keeps every envelope header outside, byte for byte, and hides the body', async () => {
    const encrypted = await encryptOutgoingMime(raw, { encryptionKeys: [bob.pub] });
    const outer = parseMimeEntity(encrypted);
    const original = parseMimeEntity(raw);
    ['from', 'to', 'subject', 'message-id', 'in-reply-to', 'date', 'mime-version'].forEach((key) => {
      expect(outer.headers.get(key)).toEqual(original.headers.get(key));
    });
    expect(detectPgpMime(encrypted)).toBe('encrypted');
    expect(outer.headers.get('content-transfer-encoding')).toEqual([]);
    expect(encrypted.toString()).not.toContain('attachment data');
    expect(encrypted.toString()).not.toContain('notes.txt');
  });

  // Breaks: the sender's own Sent copy is unreadable unless their key is a recipient.
  it('can be opened by every recipient key, and by nobody else', async () => {
    const carol = await party('carol@z.com');
    const encrypted = await encryptOutgoingMime(raw, { encryptionKeys: [bob.pub, ann.pub] });
    await expect(openPgpMime(encrypted, keysFor(ann))).resolves.toMatchObject({ wasEncrypted: true });
    await expect(openPgpMime(encrypted, keysFor(carol))).rejects.toMatchObject({ code: 'no-key' });
  });

  // Breaks: unsigned encrypted mail must say "no signature", never "valid".
  it('reports no signature when none was made', async () => {
    const encrypted = await encryptOutgoingMime(raw, { encryptionKeys: [bob.pub] });
    expect((await openPgpMime(encrypted, keysFor(bob))).signature.status).toBe('none');
  });

  // Breaks: a passphrase-locked key would read as "no key", sending the user to
  // import a key they already have instead of unlocking it.
  it('says "locked" when only a locked key could decrypt it', async () => {
    const encrypted = await encryptOutgoingMime(raw, { encryptionKeys: [bob.pub] });
    await expect(
      openPgpMime(encrypted, { decryptionKeys: [], lockedKeys: [bob.priv], verificationKeys: [] }),
    ).rejects.toMatchObject({ code: 'locked' });
  });

  // Breaks: a signature by someone we have no key for must read "unknown", not "forged".
  it('reports an unknown signer as unknown-key', async () => {
    const encrypted = await encryptOutgoingMime(raw, { encryptionKeys: [bob.pub], signingKeys: [ann.priv] });
    const opened = await openPgpMime(encrypted, keysFor(bob));
    expect(opened.signature.status).toBe('unknown-key');
    expect(opened.signature.signerKeyId).toMatch(/^[0-9A-F]{16}$/);
  });

  // Breaks: ciphertext damaged after the key packet (the right key IS held) must be bad data, not "no key".
  it('reports corrupted ciphertext for a held key as bad-data', async () => {
    const encrypted = (await encryptOutgoingMime(raw, { encryptionKeys: [bob.pub] })).toString();
    const armor = encrypted.match(/-----BEGIN PGP MESSAGE-----[\s\S]*-----END PGP MESSAGE-----/)![0];
    const lines = armor.split('\r\n');
    const target = lines.length - 4;
    lines[target] = lines[target].replace(/^(.{10})(.)/, (_all, head, char) => `${head}${char === 'A' ? 'B' : 'A'}`);
    const damaged = Buffer.from(encrypted.replace(armor, lines.join('\r\n')));
    await expect(openPgpMime(damaged, keysFor(bob))).rejects.toMatchObject({ code: 'bad-data' });
  });

  // Breaks: a corrupted data part must be reported as bad data, not crash the reader.
  it('rejects a message whose data part is missing or garbage', async () => {
    const encrypted = await encryptOutgoingMime(raw, { encryptionKeys: [bob.pub] });
    const truncated = Buffer.from(encrypted.toString().replace(/----_NmP[^\r\n]*Part_1\r\nContent-Type: application\/octet-stream[\s\S]*$/, ''));
    await expect(openPgpMime(truncated, keysFor(bob))).rejects.toMatchObject({ code: 'bad-data' });
    const garbage = Buffer.from(encrypted.toString().replace(/-----BEGIN PGP MESSAGE-----[\s\S]*-----END PGP MESSAGE-----/, 'nonsense'));
    await expect(openPgpMime(garbage, keysFor(bob))).rejects.toMatchObject({ code: 'bad-data' });
    await expect(openPgpMime(raw, keysFor(bob))).rejects.toMatchObject({ code: 'bad-data' });
  });
});

describe('signOutgoingMime', () => {
  // Breaks: our signed mail would fail verification at the recipient.
  it('produces a multipart/signed message that verifies', async () => {
    const signed = await signOutgoingMime(raw, [ann.priv]);
    expect(detectPgpMime(signed)).toBe('signed');
    expect(parseMimeEntity(signed).params.micalg).toMatch(/^pgp-sha(256|384|512)$/);
    const opened = await openPgpMime(signed, keysFor(bob, ann));
    expect(opened).toMatchObject({ kind: 'signed', wasEncrypted: false, signature: { status: 'valid' } });
    // The body stays readable to clients with no PGP support at all.
    expect(signed.toString()).toContain('plain =C3=BCn=C3=AFcode');
  });

  // Breaks: a message altered in transit would still show "verified".
  it('reports tampering as invalid', async () => {
    const signed = await signOutgoingMime(raw, [ann.priv]);
    const tampered = Buffer.from(signed.toString('latin1').replace('second line', 'SECOND LINE'), 'latin1');
    expect((await openPgpMime(tampered, keysFor(bob, ann))).signature.status).toBe('invalid');
  });

  // Breaks: a server that rewrites CRLF to LF (some do) would make every good signature read as forged.
  it('still verifies after a transport converts CRLF to LF', async () => {
    const signed = await signOutgoingMime(raw, [ann.priv]);
    const lf = Buffer.from(signed.toString('latin1').replace(/\r\n/g, '\n'), 'latin1');
    expect((await openPgpMime(lf, keysFor(bob, ann))).signature.status).toBe('valid');
  });

  // Breaks: a garbled signature part must read as invalid rather than throwing out of the reader.
  it('reports an unreadable signature part as invalid', async () => {
    const signed = await signOutgoingMime(raw, [ann.priv]);
    const broken = Buffer.from(signed.toString().replace(/-----BEGIN PGP SIGNATURE-----[\s\S]*-----END PGP SIGNATURE-----/, '-----BEGIN PGP SIGNATURE-----\r\nzz\r\n-----END PGP SIGNATURE-----'));
    expect((await openPgpMime(broken, keysFor(bob, ann))).signature.status).toBe('invalid');
  });

  // Breaks: clients that send the signature part base64-encoded as binary
  // (application/pgp-signature is allowed either way) would read as forged.
  it('verifies a base64-encoded binary signature part', async () => {
    const signed = (await signOutgoingMime(raw, [ann.priv])).toString('latin1');
    const armored = signed.match(/-----BEGIN PGP SIGNATURE-----[\s\S]*-----END PGP SIGNATURE-----/)![0];
    const binary = (await openpgp.readSignature({ armoredSignature: armored })).write();
    const rewritten = signed
      .replace(armored, Buffer.from(binary).toString('base64'))
      .replace(/(Content-Type: application\/pgp-signature[^\r]*\r\n)/, '$1Content-Transfer-Encoding: base64\r\n');
    expect((await openPgpMime(Buffer.from(rewritten, 'latin1'), keysFor(bob, ann))).signature.status).toBe('valid');
  });

  // Breaks: a multipart/signed with its signature part stripped (list software does this) must not read as verified.
  it('rejects a signed message with no signature part', async () => {
    const signed = (await signOutgoingMime(raw, [ann.priv])).toString('latin1');
    const boundary = parseMimeEntity(Buffer.from(signed, 'latin1')).params.boundary;
    const cut = signed.slice(0, signed.lastIndexOf(`--${boundary}\r\nContent-Type: application/pgp-signature`));
    await expect(openPgpMime(Buffer.from(`${cut}--${boundary}--\r\n`, 'latin1'), keysFor(bob, ann))).rejects.toMatchObject({
      code: 'bad-data',
    });
  });

  // Breaks: sign-then-encrypt as two layers (RFC 3156 §6.1) would show "no signature".
  it('verifies a signed message nested inside an encrypted one', async () => {
    const signed = await signOutgoingMime(raw, [ann.priv]);
    const { body } = splitHeaderBody(signed);
    const signedEntity = Buffer.concat([
      Buffer.from(`Content-Type: ${parseMimeEntity(signed).headers.get('content-type')[0].replace(/^content-type:\s*/i, '')}\r\n\r\n`),
      body,
    ]);
    const layered = await encryptOutgoingMime(
      Buffer.concat([Buffer.from('From: ann@x.com\r\n'), signedEntity]),
      { encryptionKeys: [bob.pub] },
    );
    const opened = await openPgpMime(layered, keysFor(bob, ann));
    expect(opened).toMatchObject({ wasEncrypted: true, signature: { status: 'valid' } });
  });
});

describe('interop with GnuPG', () => {
  let rita: openpgp.PrivateKey;
  let gee: openpgp.Key;
  beforeAll(async () => {
    rita = await readUnlockedPrivateKey(fixture('recipient.key.asc').toString());
    gee = await readAnyKey(fixture('gpg-sender.pub.asc').toString());
  });

  // Breaks: PGP/MIME mail from GnuPG-based clients (Thunderbird, Mutt, Enigmail) would not open.
  it('opens a GnuPG signed+encrypted PGP/MIME message', async () => {
    const opened = await openPgpMime(fixture('gpg-encrypted-signed.eml'), {
      decryptionKeys: [rita],
      verificationKeys: [gee],
    });
    expect(opened.signature).toMatchObject({ status: 'valid', signerEmails: ['gee@example.org'] });
    expect(opened.content.type === 'mime' && opened.content.bytes.toString()).toContain('Hello from GnuPG =E2=9C=93');
  });

  // Breaks: detached signatures from GnuPG would read as forged.
  it('verifies a GnuPG multipart/signed message', async () => {
    const opened = await openPgpMime(fixture('gpg-signed.eml'), { decryptionKeys: [], verificationKeys: [gee] });
    expect(opened.signature.status).toBe('valid');
  });

  // Breaks: clearsigned plain-text mail would show armor lines instead of a verified body.
  it('verifies GnuPG clearsigned text and returns the signed text', async () => {
    const text = `Intro\n${fixture('gpg-clearsigned.txt').toString()}Outro`;
    const opened = await openInlinePgp(text, { decryptionKeys: [], verificationKeys: [gee] });
    expect(opened).toMatchObject({ kind: 'inline-signed', wasEncrypted: false, signature: { status: 'valid' } });
    expect(opened.content).toEqual({ type: 'text', text: 'Intro\nInline signed body.\nWith two lines.\nOutro' });
  });

  // Breaks: inline-encrypted mail would show only ciphertext.
  it('decrypts GnuPG inline-encrypted text', async () => {
    const opened = await openInlinePgp(`Before\n${fixture('gpg-inline-encrypted.asc').toString()}`, {
      decryptionKeys: [rita],
      verificationKeys: [gee],
    });
    expect(opened).toMatchObject({ kind: 'inline-encrypted', wasEncrypted: true, signature: { status: 'valid' } });
    expect(opened.content).toEqual({ type: 'text', text: 'Before\nInline secret text.\n\n' });
  });
});

describe('openInlinePgp failure paths', () => {
  // Breaks: text with no (or broken) armor must be refused cleanly.
  it('rejects text with no PGP block or an unterminated one', async () => {
    await expect(openInlinePgp('plain', keysFor(bob))).rejects.toMatchObject({ code: 'bad-data' });
    await expect(openInlinePgp('-----BEGIN PGP MESSAGE-----\nabc', keysFor(bob))).rejects.toMatchObject({
      code: 'bad-data',
    });
    await expect(
      openInlinePgp('-----BEGIN PGP SIGNED MESSAGE-----\nzz\n-----END PGP SIGNATURE-----', keysFor(bob)),
    ).rejects.toMatchObject({ code: 'bad-data' });
  });
});

describe('toCanonicalCrlf', () => {
  // Breaks: mixed line endings would sign one byte stream and send another.
  it('normalises LF and leaves CRLF alone', () => {
    expect(toCanonicalCrlf(Buffer.from('a\nb\r\nc')).toString()).toBe('a\r\nb\r\nc');
  });
});

describe('withHeader', () => {
  // Breaks: the Autocrypt header went out as one 1000+ character line (rejected
  // by strict MTAs), or adding it disturbed the body.
  it('adds a folded header and leaves the body byte-identical', async () => {
    const value = `addr=a@example.org; keydata=${'A'.repeat(70)} ${'B'.repeat(70)} ${'C'.repeat(70)}`;
    const out = withHeader(raw, 'Autocrypt', value);
    const { headerBytes, body } = splitHeaderBody(out);
    expect(body.equals(splitHeaderBody(raw).body)).toBe(true);
    const headerText = headerBytes.toString('utf8');
    // RFC 5322's hard limit is 998; folding at the keydata's own spaces keeps lines near 80.
    const autocryptLines = headerText.slice(headerText.indexOf('Autocrypt:')).split('\r\n').filter(Boolean);
    expect(autocryptLines.length).toBeGreaterThan(1);
    expect(autocryptLines.every((line) => line.length <= 998)).toBe(true);
    expect(headerText.replace(/\r\n[ \t]/g, ' ')).toContain(`Autocrypt: ${value}`);
  });
});
