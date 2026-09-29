/**
 * From a stored message's raw source to something a reader can show.
 *
 * Ingest never parses an encrypted message's body (see MessageProcessor
 * .parseBody): the row holds a placeholder, and the plaintext exists only
 * here, in memory, for as long as the reader holds it. So this is the ONE
 * place a PGP message is opened for viewing, whatever its shape — PGP/MIME
 * encrypted or signed, or inline ("traditional") PGP inside a text part.
 */
import { simpleParser } from 'mailparser';

import { SIMPLE_PARSER_OPTIONS } from '../utils/mail-parse';

import { detectPgpMime } from './mime-structure';
import { openInlinePgp, openPgpMime, type PgpOpenKeys } from './pgp-mime';
import type { PgpOpenedContent, PgpOpenResult } from './types';

export interface OpenedAttachment {
  name: string;
  contentType: string;
  size: number;
  content: Buffer;
}

export interface OpenedMessage {
  contentType: 'html' | 'text';
  /** HTML (cid: images already inlined by mailparser) or plain text. */
  body: string;
  attachments: OpenedAttachment[];
}

/** Decrypt and/or verify a stored message. Throws PgpOpenError. */
export async function openStoredPgp(raw: Buffer, keys: PgpOpenKeys): Promise<PgpOpenResult> {
  if (detectPgpMime(raw)) return openPgpMime(raw, keys);
  const outer = await simpleParser(raw, SIMPLE_PARSER_OPTIONS);
  return openInlinePgp(outer.text ?? '', keys);
}

/** The opened content as a body and its files. */
export async function readOpenedContent(content: PgpOpenedContent): Promise<OpenedMessage> {
  if (content.type === 'text') return { contentType: 'text', body: content.text, attachments: [] };
  const parsed = await simpleParser(content.bytes, SIMPLE_PARSER_OPTIONS);
  const attachments = (parsed.attachments ?? [])
    // As at ingest: cid images and related parts are the body's own.
    .filter((part) => part.contentDisposition !== 'inline' && !part.related)
    .map((part) => ({
      name: part.filename || 'attachment',
      contentType: part.contentType || 'application/octet-stream',
      size: part.content.length,
      content: part.content,
    }));
  if (parsed.html) return { contentType: 'html', body: parsed.html, attachments };
  return { contentType: 'text', body: parsed.text ?? '', attachments };
}
