// PGP/MIME (RFC 3156) and inline PGP: opening received mail, wrapping outgoing
// mail. The outgoing side takes the fully built MIME from MailComposer and
// re-wraps its body, so everything the composer does — attachments, charsets,
// inline images — is exactly what gets encrypted, and every envelope header
// (From, To, Subject, Message-ID, threading) stays outside, untouched.

import { Headers } from '@zone-eu/mailsplit';
import MimeNode from 'nodemailer/lib/mime-node';
import * as openpgp from 'openpgp';

import {
  decodeTransferEncoding,
  detectInlinePgp,
  detectPgpMime,
  parseMimeEntity,
  splitHeaderBody,
  splitMultipartBody,
} from './mime-structure';
import type { MimeEntity } from './mime-structure';
import { PgpOpenError } from './types';
import type { PgpOpenResult, PgpSignatureResult } from './types';

export interface PgpOpenKeys {
  /** Unlocked private keys. */
  decryptionKeys: openpgp.PrivateKey[];
  /** Private keys we hold but cannot use yet — lets a failure say "locked", not "no key". */
  lockedKeys?: openpgp.PrivateKey[];
  /** Public keys to check signatures against (correspondents' and our own). */
  verificationKeys: openpgp.Key[];
}

/** openpgp.js does not export this type by name. */
type VerificationResult = openpgp.VerifyMessageResult['signatures'][number];

const NO_SIGNATURE: PgpSignatureResult = { status: 'none' };

// ── Opening received mail ────────────────────────────────────────────────────

/** Decrypt and/or verify an RFC 3156 message. Throws `PgpOpenError`. */
export async function openPgpMime(raw: Buffer, keys: PgpOpenKeys): Promise<PgpOpenResult> {
  const kind = detectPgpMime(raw);
  if (kind === 'encrypted') return openEncrypted(parseMimeEntity(raw), keys);
  if (kind === 'signed') {
    const { signedBytes, signature } = await verifyDetached(parseMimeEntity(raw), keys.verificationKeys);
    return { kind, wasEncrypted: false, content: { type: 'mime', bytes: signedBytes }, signature };
  }
  throw new PgpOpenError('Not a PGP/MIME message', 'bad-data');
}

async function openEncrypted(top: MimeEntity, keys: PgpOpenKeys): Promise<PgpOpenResult> {
  const parts = splitMultipartBody(top.body, top.params.boundary ?? '');
  // Part 1 is the "Version: 1" control part; part 2 carries the ciphertext.
  if (parts.length < 2) throw new PgpOpenError('Encrypted message is missing its data part', 'bad-data');
  const dataPart = parseMimeEntity(parts[1]);
  const ciphertext = decodeTransferEncoding(dataPart.body, dataPart.transferEncoding);
  const { data, signatures } = await decryptMessage(await readPgpMessage(ciphertext), keys);
  const inner = Buffer.from(data);
  const embedded = await evaluateSignatures(signatures, keys.verificationKeys);
  // Signed-then-encrypted as two layers (RFC 3156 §6.1): the plaintext is
  // itself a multipart/signed entity, whose signature is the one that counts.
  if (embedded.status === 'none' && detectPgpMime(inner) === 'signed') {
    const layered = await verifyDetached(parseMimeEntity(inner), keys.verificationKeys);
    return {
      kind: 'encrypted',
      wasEncrypted: true,
      content: { type: 'mime', bytes: layered.signedBytes },
      signature: layered.signature,
    };
  }
  return { kind: 'encrypted', wasEncrypted: true, content: { type: 'mime', bytes: inner }, signature: embedded };
}

async function readPgpMessage(ciphertext: Buffer): Promise<openpgp.Message<Uint8Array>> {
  try {
    const text = ciphertext.toString('latin1');
    return text.includes('-----BEGIN PGP MESSAGE-----')
      ? ((await openpgp.readMessage({ armoredMessage: text })) as openpgp.Message<Uint8Array>)
      : await openpgp.readMessage({ binaryMessage: new Uint8Array(ciphertext) });
  } catch (error) {
    throw new PgpOpenError(`Unreadable encrypted data: ${(error as Error).message}`, 'bad-data');
  }
}

async function decryptMessage(
  message: openpgp.Message<Uint8Array | string>,
  keys: PgpOpenKeys,
): Promise<{ data: Uint8Array; signatures: VerificationResult[] }> {
  const recipientIds = message.getEncryptionKeyIDs().map((keyId) => keyId.toHex());
  const holds = (candidates: readonly openpgp.PrivateKey[]) =>
    candidates.some((key) => recipientIds.some((id) => key.getKeys().some((sub) => sub.getKeyID().toHex() === id)));
  if (!holds(keys.decryptionKeys)) {
    if (holds(keys.lockedKeys ?? [])) {
      throw new PgpOpenError('The key for this message is locked', 'locked');
    }
    throw new PgpOpenError('None of your keys can decrypt this message', 'no-key');
  }
  try {
    const result = await openpgp.decrypt({
      message,
      decryptionKeys: keys.decryptionKeys,
      verificationKeys: keys.verificationKeys,
      format: 'binary',
    });
    return { data: result.data as Uint8Array, signatures: result.signatures };
  } catch (error) {
    throw new PgpOpenError(`Could not decrypt: ${(error as Error).message}`, 'bad-data');
  }
}

async function verifyDetached(
  top: MimeEntity,
  verificationKeys: openpgp.Key[],
): Promise<{ signedBytes: Buffer; signature: PgpSignatureResult }> {
  const parts = splitMultipartBody(top.body, top.params.boundary ?? '');
  if (parts.length < 2) throw new PgpOpenError('Signed message is missing its signature part', 'bad-data');
  const [signedBytes, signaturePart] = parts;
  const signatureEntity = parseMimeEntity(signaturePart);
  const signatureData = decodeTransferEncoding(signatureEntity.body, signatureEntity.transferEncoding);
  try {
    const armored = signatureData.toString('latin1');
    const signature = armored.includes('-----BEGIN PGP SIGNATURE-----')
      ? await openpgp.readSignature({ armoredSignature: armored })
      : await openpgp.readSignature({ binarySignature: new Uint8Array(signatureData) });
    const message = await openpgp.createMessage({ binary: new Uint8Array(toCanonicalCrlf(signedBytes)) });
    const result = await openpgp.verify({ message, signature, verificationKeys });
    return { signedBytes, signature: await evaluateSignatures(result.signatures, verificationKeys) };
  } catch (error) {
    return { signedBytes, signature: { status: 'invalid', error: (error as Error).message } };
  }
}

/** Decrypt or verify inline ("traditional") PGP found in a text body. */
export async function openInlinePgp(text: string, keys: PgpOpenKeys): Promise<PgpOpenResult> {
  const kind = detectInlinePgp(text);
  if (kind === 'inline-signed') {
    const block = armoredBlock(text, 'SIGNED MESSAGE', 'SIGNATURE');
    try {
      const message = await openpgp.readCleartextMessage({ cleartextMessage: block.armored });
      const result = await openpgp.verify({ message, verificationKeys: keys.verificationKeys });
      return {
        kind,
        wasEncrypted: false,
        content: { type: 'text', text: `${block.before}${message.getText()}${block.after}` },
        signature: await evaluateSignatures(result.signatures, keys.verificationKeys),
      };
    } catch (error) {
      throw new PgpOpenError(`Unreadable signed text: ${(error as Error).message}`, 'bad-data');
    }
  }
  if (kind === 'inline-encrypted') {
    const block = armoredBlock(text, 'MESSAGE', 'MESSAGE');
    const message = await readPgpMessage(Buffer.from(block.armored, 'latin1'));
    const { data, signatures } = await decryptMessage(message, keys);
    return {
      kind,
      wasEncrypted: true,
      content: { type: 'text', text: `${block.before}${Buffer.from(data).toString('utf8')}${block.after}` },
      signature: await evaluateSignatures(signatures, keys.verificationKeys),
    };
  }
  throw new PgpOpenError('No PGP block in this text', 'bad-data');
}

function armoredBlock(text: string, begin: string, end: string): { before: string; armored: string; after: string } {
  const start = text.indexOf(`-----BEGIN PGP ${begin}-----`);
  const endMarker = `-----END PGP ${end}-----`;
  const stop = text.indexOf(endMarker, start);
  if (start < 0 || stop < 0) throw new PgpOpenError('Incomplete PGP block', 'bad-data');
  const blockEnd = stop + endMarker.length;
  return { before: text.slice(0, start), armored: text.slice(start, blockEnd), after: text.slice(blockEnd) };
}

/**
 * The strongest verdict among a message's signatures. A key we do not hold is
 * checked BEFORE awaiting `verified`, because openpgp.js reports it as a
 * failed verification — and "signed by someone unknown" must never read as
 * "forged".
 */
async function evaluateSignatures(
  signatures: readonly VerificationResult[],
  verificationKeys: readonly openpgp.Key[],
): Promise<PgpSignatureResult> {
  if (signatures.length === 0) return NO_SIGNATURE;
  const results = await Promise.all(signatures.map((signature) => evaluateOne(signature, verificationKeys)));
  const rank = { valid: 3, invalid: 2, 'unknown-key': 1, none: 0 } as const;
  return results.reduce((best, next) => (rank[next.status] > rank[best.status] ? next : best));
}

async function evaluateOne(
  verification: VerificationResult,
  verificationKeys: readonly openpgp.Key[],
): Promise<PgpSignatureResult> {
  const signerKeyId = verification.keyID.toHex().toUpperCase();
  const signer = verificationKeys.find((key) => key.getKeys(verification.keyID).length > 0);
  if (!signer) return { status: 'unknown-key', signerKeyId };
  const identity = {
    signerKeyId,
    signerFingerprint: signer.getFingerprint().toUpperCase(),
    signerEmails: signer.users
      .map((user) => user.userID?.email?.toLowerCase() ?? '')
      .filter((email) => email.length > 0),
  };
  try {
    await verification.verified;
    const packet = (await verification.signature).packets[0];
    return { status: 'valid', ...identity, signedAt: packet?.created?.toISOString() };
  } catch (error) {
    return { status: 'invalid', ...identity, error: (error as Error).message };
  }
}

// ── Wrapping outgoing mail ──────────────────────────────────────────────────

export interface EncryptOptions {
  /** Every recipient's key AND the sender's own, so the Sent copy stays readable. */
  encryptionKeys: openpgp.Key[];
  signingKeys?: openpgp.PrivateKey[];
}

/**
 * Add one header to a built message, folded to the wire's line limit. Used for
 * the Autocrypt header, which travels outside any encryption so the recipient
 * can read the key before they can read anything else.
 */
export function withHeader(raw: Buffer, name: string, value: string): Buffer {
  const { headerBytes, body } = splitHeaderBody(raw);
  const headers = new Headers(headerBytes);
  headers.add(name, value, headers.getList().length);
  return Buffer.concat([headers.build(), body]);
}

/** Turn a built message into an RFC 3156 multipart/encrypted one. */
export async function encryptOutgoingMime(raw: Buffer, options: EncryptOptions): Promise<Buffer> {
  const { outer, inner } = splitForWrapping(raw);
  const armored = await openpgp.encrypt({
    message: await openpgp.createMessage({ binary: new Uint8Array(inner) }),
    encryptionKeys: options.encryptionKeys,
    signingKeys: options.signingKeys?.length ? options.signingKeys : undefined,
    format: 'armored',
  });
  const wrapper = new MimeNode('multipart/encrypted; protocol="application/pgp-encrypted"');
  wrapper
    .createChild('application/pgp-encrypted')
    .setHeader('Content-Description', 'PGP/MIME version identification')
    .setHeader('Content-Transfer-Encoding', '7bit')
    .setContent('Version: 1\r\n');
  wrapper
    .createChild('application/octet-stream; name="encrypted.asc"')
    .setHeader('Content-Description', 'OpenPGP encrypted message')
    .setHeader('Content-Disposition', 'inline; filename="encrypted.asc"')
    .setHeader('Content-Transfer-Encoding', '7bit')
    .setContent(toCanonicalCrlf(Buffer.from(armored as string, 'utf8')).toString('utf8'));
  return joinWrapped(outer, await buildNode(wrapper));
}

/** Turn a built message into an RFC 3156 multipart/signed one. */
export async function signOutgoingMime(raw: Buffer, signingKeys: openpgp.PrivateKey[]): Promise<Buffer> {
  const { outer, inner } = splitForWrapping(raw);
  const signed = toCanonicalCrlf(inner);
  const armoredSignature = (await openpgp.sign({
    message: await openpgp.createMessage({ binary: new Uint8Array(signed) }),
    signingKeys,
    detached: true,
    format: 'armored',
  })) as string;
  const hash = await signatureHashName(armoredSignature);
  const wrapper = new MimeNode(
    `multipart/signed; protocol="application/pgp-signature"; micalg=pgp-${hash}`,
  );
  // setRaw replaces the child's whole output, headers included, so the
  // placeholder type never reaches the wire.
  wrapper.createChild('text/plain').setRaw(signed.toString('latin1'));
  wrapper
    .createChild('application/pgp-signature; name="signature.asc"')
    .setHeader('Content-Description', 'OpenPGP digital signature')
    .setHeader('Content-Disposition', 'attachment; filename="signature.asc"')
    .setHeader('Content-Transfer-Encoding', '7bit')
    .setContent(toCanonicalCrlf(Buffer.from(armoredSignature, 'utf8')).toString('utf8'));
  return joinWrapped(outer, await buildNode(wrapper));
}

async function signatureHashName(armoredSignature: string): Promise<string> {
  const signature = await openpgp.readSignature({ armoredSignature });
  const hashId = signature.packets[0]?.hashAlgorithm;
  const name = Object.entries(openpgp.enums.hash).find(([, id]) => id === hashId)?.[0] ?? 'sha256';
  return name.toLowerCase();
}

/**
 * Split a built message into the envelope headers that stay in the clear and
 * the inner entity that is protected: the body plus the headers that describe
 * it (Content-Type, Content-Transfer-Encoding). Header lines are carried over
 * byte for byte — re-encoding them would risk mangling an encoded Subject.
 */
function splitForWrapping(raw: Buffer): { outer: Headers; inner: Buffer } {
  const { headerBytes, body } = splitHeaderBody(raw);
  const outer = new Headers(headerBytes);
  const innerHeaders = new Headers(headerBytes);
  const contentKeys = new Set(['content-type', 'content-transfer-encoding']);
  const otherKeys = new Set(innerHeaders.getList().map((line) => line.key).filter((key) => !contentKeys.has(key)));
  otherKeys.forEach((key) => innerHeaders.remove(key));
  outer.remove('content-type');
  outer.remove('content-transfer-encoding');
  return { outer, inner: Buffer.concat([innerHeaders.build(), body]) };
}

/** Put the untouched envelope headers on top of a freshly built wrapper body. */
function joinWrapped(outer: Headers, wrapperMime: Buffer): Buffer {
  const { headerBytes, body } = splitHeaderBody(wrapperMime);
  const contentType = new Headers(headerBytes).get('content-type')[0];
  outer.addFormatted('content-type', contentType, outer.getList().length);
  return Buffer.concat([outer.build(), body]);
}

function buildNode(node: MimeNode): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    node.build((error, message) => (error ? reject(error) : resolve(message)));
  });
}

/** CRLF line endings throughout — what RFC 3156 signs and what SMTP carries. */
export function toCanonicalCrlf(bytes: Buffer): Buffer {
  return Buffer.from(bytes.toString('latin1').replace(/\r?\n/g, '\r\n'), 'latin1');
}
