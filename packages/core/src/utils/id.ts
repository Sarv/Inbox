// ID generation utilities

import { createHash, randomBytes } from 'crypto';

/**
 * Generate a unique ID using timestamp + random bytes
 * Format: {timestamp}-{random}
 */
export function generateId(): string {
  const timestamp = Date.now().toString(36);
  const random = randomBytes(8).toString('hex');
  return `${timestamp}-${random}`;
}

/**
 * Normalize a Message-ID to always have angle brackets.
 * Some clients send In-Reply-To without <>, which would cause
 * a hash mismatch against the root message's messageId.
 */
function normalizeMessageId(id: string): string {
  const trimmed = id.trim();
  if (!trimmed) return trimmed;
  if (trimmed.startsWith('<') && trimmed.endsWith('>')) return trimmed;
  // Strip any stray brackets then re-wrap
  const bare = trimmed.replace(/^<|>$/g, '');
  return `<${bare}>`;
}

/**
 * Generate a thread ID using references/inReplyTo for proper threading
 *
 * Threading logic:
 * - If email has References or In-Reply-To headers → it's a reply, use root message ID
 * - If email has NO threading headers → it's a new conversation, use its own messageId
 * - If messageId is empty/missing → generate a unique thread (prevents all such emails merging)
 *
 * This prevents unrelated emails with similar subjects from being grouped together.
 */
export function generateThreadId(
  _normalizedSubject: string,
  messageId: string,
  inReplyTo?: string | null,
  references?: string | null
): string {
  // Parse references to get root message ID
  let rootMessageId: string | null = null;

  if (references) {
    // References header contains chain of message IDs, first one is the root
    const refs = references.split(/\s+/).filter(r => r.startsWith('<'));
    if (refs.length > 0) {
      rootMessageId = refs[0]; // First reference is the original message
    }
  }

  // Fall back to inReplyTo if no references
  // Normalize angle brackets — some clients omit them
  if (!rootMessageId && inReplyTo) {
    rootMessageId = normalizeMessageId(inReplyTo);
  }

  // If we have a root message ID, use it for threading (this is a reply)
  if (rootMessageId) {
    const hash = createHash('sha256')
      .update(rootMessageId.toLowerCase())
      .digest('hex')
      .substring(0, 16);
    return `thread-${hash}`;
  }

  // No threading headers - this is a NEW conversation
  // If messageId is empty/missing, generate a unique thread to prevent
  // all headerless messages from collapsing into one thread
  const idToHash = messageId || `<${randomBytes(16).toString('hex')}@generated>`;
  const hash = createHash('sha256')
    .update(idToHash.toLowerCase())
    .digest('hex')
    .substring(0, 16);

  return `thread-${hash}`;
}

/**
 * Generate a content hash for deduplication
 */
export function generateContentHash(content: string): string {
  return createHash('sha256')
    .update(content)
    .digest('hex');
}

/** Marks a Message-ID as one WE invented because the server sent none. */
export const SYNTHESIZED_MESSAGE_ID_PREFIX = '<missing-';

/**
 * A Message-ID for a message that arrived WITHOUT one.
 *
 * `emails.message_id` is UNIQUE and is the identity every dedupe decision runs
 * on, so a message with no Message-ID header still needs one — otherwise they
 * all default to `''` and dedupe against each other. The only question is what
 * to hash, and the answer has to be the message's own identity and NOTHING
 * about where we happened to find it:
 *
 *   * NOT the folder path. On Gmail one message is in INBOX and All Mail at the
 *     same time; elsewhere a move rewrites it. Folder-keyed ids mint a second
 *     id for the second sighting, and the same message is stored TWICE.
 *   * NOT the UID. UIDs are per-folder and reset wholesale on a UIDVALIDITY
 *     change, so the whole mailbox re-ingests as new mail after a server
 *     rebuild or an account re-add.
 *
 * The five fields used here all come from the message itself and survive both.
 * The trade-off is deliberate and one-directional: two DIFFERENT messages that
 * match on sender, arrival second, subject, recipients AND byte size collapse
 * into one row. That is a pathological case; a duplicate row for one real
 * message is a bug the user meets every day on a Gmail account.
 */
export function synthesizedMessageId(identity: {
  fromAddress?: string | null;
  internalDate?: Date | number | null;
  subject?: string | null;
  toAddress?: string | null;
  size?: number | null;
}): string {
  const arrivedAt =
    identity.internalDate instanceof Date
      ? identity.internalDate.getTime()
      : (identity.internalDate ?? 0);
  const key = [
    (identity.fromAddress ?? '').toLowerCase(),
    arrivedAt,
    identity.subject ?? '',
    (identity.toAddress ?? '').toLowerCase(),
    identity.size ?? 0,
  ].join('|');

  return `${SYNTHESIZED_MESSAGE_ID_PREFIX}${generateContentHash(key).substring(0, 32)}@sarvinbox.local>`;
}

/**
 * Prefix on a `content_hash` that NO body backed.
 *
 * The marker exists so "we have not seen this body yet" is a state a reader can
 * recognise, instead of being indistinguishable from a real body hash. It is what
 * a future repair/collapse pass can filter on, and what keeps two body-less rows
 * from ever looking like the same content.
 */
export const NO_BODY_CONTENT_HASH_PREFIX = 'nobody-';

/**
 * The hash of an email's BODY, or null when there is no body to hash.
 *
 * `cleanBody` first, falling back to `rawBody`, because that is already this
 * codebase's definition of "this email has a body" (see
 * `legacyHasBodyExpression`): an HTML-only send — common for marketing mail —
 * carries its content in the raw part with an empty clean part, and hashing only
 * the clean body would call it body-less.
 *
 * Hashed with no normalisation, and from the body as FETCHED rather than as
 * encoded for storage: the raw part gets its inline images swapped for
 * `sarv-inline:` refs on the way in and expanded again on the way out, so the
 * fetched form is the one that is stable across re-fetches and across accounts,
 * while the encoded form depends on what the image store already holds.
 */
export function bodyContentHash(bodies: {
  cleanBody?: string | null;
  rawBody?: string | null;
}): string | null {
  const clean = bodies.cleanBody ?? '';
  if (clean.trim()) return generateContentHash(clean);
  const raw = bodies.rawBody ?? '';
  if (raw.trim()) return generateContentHash(raw);
  return null;
}

/**
 * The `content_hash` for a message whose body has NOT been downloaded yet.
 *
 * Keyed on the message's own identity so two body-less rows never collide, and
 * derived — not random — so a re-sync of the same message writes the same value
 * (the hash must not churn on every header refresh). The random fallback mirrors
 * `generateThreadId`'s, for the same reason: without it, every message that
 * arrived without a Message-ID would share one hash.
 */
export function noBodyContentHash(identity?: string | null): string {
  const id = (identity ?? '').trim() || `<${randomBytes(16).toString('hex')}@generated>`;
  return `${NO_BODY_CONTENT_HASH_PREFIX}${generateContentHash(id.toLowerCase())}`;
}

/**
 * An email's `content_hash` at ingest: the body's hash when a body came with it,
 * the no-body marker when it didn't.
 *
 * SINGLE RULE for the column, shared by the IMAP ingest, the body-fetch update
 * and the local (sent/draft) writers — the bug this replaces was one call site
 * hashing `cleanBody || subject`. Under headers-first sync `cleanBody` is `''`
 * for every message, so the column held a hash of the SUBJECT and was never
 * recomputed when the body later arrived. It was measurably wrong on a live
 * mailbox: 1,809 hash groups spanned more than one distinct `clean_body_len`,
 * which is impossible for a body-derived hash. Anything treating the column as
 * "same hash means same content" — the embedding freshness check, a same-body
 * collapse in the conversation view — was reading subject identity instead.
 */
export function emailContentHash(email: {
  cleanBody?: string | null;
  rawBody?: string | null;
  messageId?: string | null;
}): string {
  return bodyContentHash(email) ?? noBodyContentHash(email.messageId);
}

/**
 * Generate a folder ID from path
 */
export function generateFolderId(path: string): string {
  const hash = createHash('sha256')
    .update(path.toLowerCase())
    .digest('hex')
    .substring(0, 16);

  return `folder-${hash}`;
}

/**
 * Normalize one part of an account id: lowercased, every run of
 * non-alphanumerics collapsed to a single dash, edges trimmed. Shared so the
 * renderer and the Electron main process derive byte-identical ids.
 */
export function normAccountIdPart(s?: string): string {
  return (s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * Stable account id from email + IMAP host — also the per-account key used for
 * the credential vault and DB naming. Keying on the host as well as the address
 * means the SAME address on DIFFERENT providers (e.g. sarv IMAP vs gmail IMAP)
 * becomes two separate accounts. Falls back to email-only when no host is given.
 *
 * SINGLE SOURCE OF TRUTH: import this in both the renderer and main — never
 * hand-roll the `acct-<email>--<host>` shape again (the drift between two copies
 * caused a vault-key mismatch that broke login for a legacy account).
 */
export function accountIdFor(email: string, host?: string): string {
  const base = normAccountIdPart(email || 'default');
  const h = normAccountIdPart(host || '');
  return h ? `acct-${base}--${h}` : `acct-${base}`;
}

/**
 * Validate ID format
 */
export function isValidId(id: string): boolean {
  return /^[a-z0-9]+-[a-f0-9]{16}$/.test(id) ||
         /^(thread|folder)-[a-f0-9]{16}$/.test(id);
}

/**
 * Extract timestamp from ID (null when the id carries no decodable timestamp).
 *
 * `parseInt` NEVER throws — it returns NaN for a prefix that isn't base36 — so
 * the guard has to be on the value. A try/catch here was dead code and let NaN
 * escape through a `number | null` signature, where callers comparing/formatting
 * it silently got nonsense instead of taking their null branch.
 */
export function getIdTimestamp(id: string): number | null {
  const parts = (id || '').split('-');
  if (parts.length < 2) return null;

  const timestamp = parseInt(parts[0], 36);
  return Number.isFinite(timestamp) ? timestamp : null;
}
