/**
 * Notification-card sanitisation.
 *
 * An extension is third-party code, so everything it hands the renderer is
 * untrusted input: unbounded strings that would blow out the card layout, a
 * `fields` array with thousands of entries, an `expiresAt` in the year 40000
 * that renders a nonsense countdown, or values that are not strings at all
 * because the extension was written in plain JavaScript and never type-checked.
 *
 * This is the single boundary where that is normalised. It is pure — no IPC, no
 * window, no clock beyond the one injected — so the rules are unit-testable on
 * their own, and both the Electron backend and any future host share them
 * rather than each re-deriving what "a reasonable card" means.
 */

import type { ExtensionUIField, ExtensionUINotification } from './types';

/** Longest a card may ask to stay on screen, and the furthest `expiresAt` may sit. */
export const MAX_NOTIFICATION_LIFETIME_MS = 24 * 60 * 60 * 1000;

/** Shortest auto-dismiss worth honouring — below this the card is unreadable. */
export const MIN_NOTIFICATION_TIMEOUT_MS = 1_000;

/** Longest auto-dismiss for a card with no expiry, so none can pin itself open. */
export const MAX_NOTIFICATION_TIMEOUT_MS = 120_000;

/** Caps chosen to match what the card can render without truncation artefacts. */
export const LIMITS = {
  id: 128,
  title: 120,
  body: 240,
  fieldLabel: 40,
  fieldValue: 200,
  fields: 6,
  emailId: 128,
  accountId: 128,
} as const;

/**
 * A sanitised card, with the originating extension recorded by the host.
 *
 * `id` is namespaced as `<extensionId>:<card id>` so two extensions choosing
 * the same card id cannot replace or dismiss each other's cards.
 */
export interface SanitizedExtensionNotification extends ExtensionUINotification {
  extensionId: string;
}

/** Trim, collapse newlines, and cap. Returns '' for anything that is not a string. */
function clampText(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, max);
}

function sanitizeField(field: unknown): ExtensionUIField | null {
  if (!field || typeof field !== 'object') return null;
  const candidate = field as Partial<ExtensionUIField>;
  const label = clampText(candidate.label, LIMITS.fieldLabel);
  const value = clampText(candidate.value, LIMITS.fieldValue);
  // A field with no value has nothing to show and no reason to occupy a row.
  if (!value) return null;
  return {
    label,
    value,
    copyable: candidate.copyable === true,
    emphasis: candidate.emphasis === true,
  };
}

/**
 * Normalise a card an extension asked to show.
 *
 * Returns null when the card cannot be rendered meaningfully — no id (the
 * renderer could not replace or dismiss it) or no title (nothing to read).
 * Every other malformed part is dropped rather than rejected, so one bad field
 * never costs the user the whole notification.
 */
export function sanitizeExtensionNotification(
  extensionId: string,
  notification: unknown,
  now: number = Date.now()
): SanitizedExtensionNotification | null {
  const id = clampText(extensionId, LIMITS.id);
  if (!id) return null;
  if (!notification || typeof notification !== 'object') return null;

  const candidate = notification as Partial<ExtensionUINotification>;
  const cardId = clampText(candidate.id, LIMITS.id);
  const title = clampText(candidate.title, LIMITS.title);
  if (!cardId || !title) return null;

  const rawFields = Array.isArray(candidate.fields) ? candidate.fields : [];
  const fields = rawFields
    .slice(0, LIMITS.fields)
    .map(sanitizeField)
    .filter((field): field is ExtensionUIField => field !== null);

  const sanitized: SanitizedExtensionNotification = {
    extensionId: id,
    id: `${id}:${cardId}`,
    title,
  };

  const body = clampText(candidate.body, LIMITS.body);
  if (body) sanitized.body = body;
  if (fields.length > 0) sanitized.fields = fields;

  // An expiry already in the past would render a card that is instantly stale,
  // and one far in the future a countdown nobody will watch. Drop the first,
  // clamp the second.
  if (typeof candidate.expiresAt === 'number' && Number.isFinite(candidate.expiresAt)) {
    const expiresAt = Math.min(candidate.expiresAt, now + MAX_NOTIFICATION_LIFETIME_MS);
    if (expiresAt > now) sanitized.expiresAt = expiresAt;
  }

  // `timeoutMs` is only meaningful without an expiry — with one, the countdown
  // owns the card's lifetime and a second timer would fight it.
  if (
    sanitized.expiresAt === undefined &&
    typeof candidate.timeoutMs === 'number' &&
    Number.isFinite(candidate.timeoutMs)
  ) {
    sanitized.timeoutMs = Math.min(
      Math.max(candidate.timeoutMs, MIN_NOTIFICATION_TIMEOUT_MS),
      MAX_NOTIFICATION_TIMEOUT_MS
    );
  }

  const emailId = clampText(candidate.emailId, LIMITS.emailId);
  if (emailId) sanitized.emailId = emailId;

  const accountId = clampText(candidate.accountId, LIMITS.accountId);
  if (accountId) sanitized.accountId = accountId;

  return sanitized;
}

/** Namespace a dismiss request the same way `notify` namespaces a card id. */
export function namespaceNotificationId(
  extensionId: string,
  notificationId: unknown
): string | null {
  const id = clampText(extensionId, LIMITS.id);
  const cardId = clampText(notificationId, LIMITS.id);
  if (!id || !cardId) return null;
  return `${id}:${cardId}`;
}
