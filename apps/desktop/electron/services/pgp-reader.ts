/**
 * Opening OpenPGP mail for the reader — decrypt on view, never on disk.
 *
 * An encrypted row stores a placeholder (see MessageProcessor.parseBody), so
 * the plaintext exists only here: produced from the message source when the
 * reader asks, handed to the renderer, and held in a small in-memory cache so
 * saving one of its attachments needs no second decryption. Nothing is written
 * back — not the body, not a snippet, not an FTS row — which is what keeps it
 * out of search, AI prompts, extensions and summaries.
 *
 * Signed (not encrypted) mail comes through here too, for the signature
 * verdict; its body is already stored and shown as usual.
 */
import { createLogger } from '@sarvinbox/core';
import {
  PgpOpenError,
  openStoredPgp,
  readOpenedContent,
  type OpenedAttachment,
  type OpenedMessage,
  type PgpOpenErrorCode,
  type PgpSignatureStatus,
} from '@sarvinbox/core/pgp';

import { normalizeEmail } from './pgp-key-store';
import type { PgpKeyring } from './pgp-keyring';

const logger = createLogger('pgp-reader');

/** How many opened messages stay in memory. Small: plaintext is kept only for the one being read. */
export const OPENED_CACHE_SIZE = 8;

export interface PgpSignatureView {
  status: PgpSignatureStatus;
  signerFingerprint?: string;
  signerEmails?: string[];
  /** UTC ISO-8601. */
  signedAt?: string;
  /**
   * A valid signature is only worth a green badge when the key speaks for the
   * address in From. A good signature by someone else is shown as such.
   */
  fromMatches: boolean;
}

export interface PgpViewAttachment {
  index: number;
  name: string;
  contentType: string;
  size: number;
}

export type PgpViewResult =
  | {
      ok: true;
      wasEncrypted: boolean;
      signature: PgpSignatureView;
      contentType: 'html' | 'text';
      body: string;
      attachments: PgpViewAttachment[];
    }
  | { ok: false; code: PgpOpenErrorCode | 'unavailable'; error: string };

/**
 * An encrypted draft, opened back into the composer. Unlike a view, its
 * attachments cross WITH their bytes: the composer holds the files it will
 * send, and these are the user's own files, attached by them.
 */
export interface PgpDraftAttachment {
  filename: string;
  contentType: string;
  size: number;
  /** Base64. */
  content: string;
  encoding: 'base64';
}

export type PgpDraftResult =
  | { ok: true; contentType: 'html' | 'text'; body: string; attachments: PgpDraftAttachment[] }
  | Extract<PgpViewResult, { ok: false }>;

/** The stored message a view is opened from. */
export interface StoredSource {
  /** Lossless latin1 raw source, as the sync engine returns it. */
  raw: string;
  fromAddress: string | null;
}

export interface PgpReaderDeps {
  keyring: () => Pick<PgpKeyring, 'openingKeys'>;
  source: (emailId: string, accountId?: string) => Promise<StoredSource | null>;
}

const cacheKey = (emailId: string, accountId?: string): string => `${accountId ?? ''}\u0000${emailId}`;

export class PgpReader {
  private readonly opened = new Map<string, OpenedMessage>();

  constructor(private readonly deps: PgpReaderDeps) {}

  async open(emailId: string, accountId?: string): Promise<PgpViewResult> {
    let source: StoredSource | null;
    try {
      source = await this.deps.source(emailId, accountId);
    } catch (error) {
      return { ok: false, code: 'unavailable', error: `Could not load the message: ${(error as Error).message}` };
    }
    if (!source) return { ok: false, code: 'unavailable', error: 'The message source is not available' };
    try {
      const keys = await this.deps.keyring().openingKeys(source.fromAddress);
      const result = await openStoredPgp(Buffer.from(source.raw, 'latin1'), keys);
      const content = await readOpenedContent(result.content);
      this.remember(cacheKey(emailId, accountId), content);
      const from = source.fromAddress ? normalizeEmail(source.fromAddress) : null;
      return {
        ok: true,
        wasEncrypted: result.wasEncrypted,
        signature: {
          status: result.signature.status,
          signerFingerprint: result.signature.signerFingerprint,
          signerEmails: result.signature.signerEmails,
          signedAt: result.signature.signedAt,
          fromMatches: from !== null && (result.signature.signerEmails ?? []).includes(from),
        },
        contentType: content.contentType,
        body: content.body,
        attachments: content.attachments.map(({ name, contentType, size }, index) => ({ index, name, contentType, size })),
      };
    } catch (error) {
      if (error instanceof PgpOpenError) return { ok: false, code: error.code, error: error.message };
      logger.warn(`Could not open OpenPGP message ${emailId}: ${(error as Error)?.message ?? String(error)}`);
      return { ok: false, code: 'unavailable', error: (error as Error)?.message ?? String(error) };
    }
  }

  /** An encrypted draft's body and files, for the composer to reopen it with. */
  async openDraft(emailId: string, accountId?: string): Promise<PgpDraftResult> {
    const view = await this.open(emailId, accountId);
    if (!view.ok) return view;
    const files = this.opened.get(cacheKey(emailId, accountId))?.attachments ?? [];
    return {
      ok: true,
      contentType: view.contentType,
      body: view.body,
      attachments: files.map(({ name, contentType, size, content }) => ({
        filename: name,
        contentType,
        size,
        content: content.toString('base64'),
        encoding: 'base64' as const,
      })),
    };
  }

  /** An attachment of a message opened earlier this session, or null. */
  attachment(emailId: string, accountId: string | undefined, index: number): OpenedAttachment | null {
    return this.opened.get(cacheKey(emailId, accountId))?.attachments[index] ?? null;
  }

  /** Drop every plaintext held — after a key is deleted or the user locks up. */
  forget(): void {
    this.opened.clear();
  }

  private remember(key: string, content: OpenedMessage): void {
    this.opened.delete(key);
    this.opened.set(key, content);
    while (this.opened.size > OPENED_CACHE_SIZE) {
      const oldest = this.opened.keys().next().value as string;
      this.opened.delete(oldest);
    }
  }
}
