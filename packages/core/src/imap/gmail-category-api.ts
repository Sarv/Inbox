import { isOAuthTokenError, isTerminalOAuthError } from '../oauth/oauth-errors';
import { IMAPError } from '../types/imap';

export const GMAIL_NATIVE_CATEGORY_SLUGS = ['promotions', 'social', 'updates', 'forums', 'personal'] as const;
export type GmailNativeCategory = typeof GMAIL_NATIVE_CATEGORY_SLUGS[number];

/** Safe for durable failed-action metadata: no token, response body, or raw cause. */
export class GmailCategoryError extends IMAPError {
  constructor(message: string, code: string, public readonly retryable: boolean, public readonly status?: number) {
    super(message, code);
  }
}
export interface GmailNativeCategoryChange {
  /** Exact decimal X-GM-MSGID; a JS number can already have lost uint64 precision. */
  messageId: string | bigint;
  /** Resolver for this mailbox's OAuth identity, never a stored static token. */
  resolveBearer?: (forceRefresh?: boolean) => Promise<string>;
  add: readonly string[];
  remove: readonly string[];
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}
export function gmailMessageIdHex(messageId: string | bigint): string {
  if ((typeof messageId !== 'string' && typeof messageId !== 'bigint') ||
      (typeof messageId === 'string' && !/^[0-9]+$/.test(messageId))) {
    throw new GmailCategoryError('Gmail message identity is invalid. Sync this folder and try again.', 'GMAIL_MESSAGE_ID_INVALID', false);
  }
  const id = BigInt(messageId);
  if (id <= 0n || id > 0xffffffffffffffffn) {
    throw new GmailCategoryError('Gmail message identity is invalid. Sync this folder and try again.', 'GMAIL_MESSAGE_ID_INVALID', false);
  }
  return id.toString(16);
}
/** Modify only native tab labels, retaining Important, stars, and mailbox membership. */
export async function modifyGmailNativeCategories(change: GmailNativeCategoryChange): Promise<void> {
  if (!change.resolveBearer) {
    throw new GmailCategoryError('Sign in to this Gmail account with Google OAuth to change its native categories.', 'GMAIL_CATEGORY_OAUTH_REQUIRED', false);
  }
  const hex = gmailMessageIdHex(change.messageId);
  const canonical = new Set<string>(GMAIL_NATIVE_CATEGORY_SLUGS);
  if (![...change.add, ...change.remove].every((slug) => canonical.has(slug)) || change.add.some((slug) => change.remove.includes(slug))) {
    throw new GmailCategoryError('Gmail native category selection is invalid.', 'GMAIL_CATEGORY_INVALID', false);
  }
  const addLabelIds = [...new Set(change.add)].map((slug) => `CATEGORY_${slug.toUpperCase()}`);
  const removeLabelIds = [...new Set(change.remove)].map((slug) => `CATEGORY_${slug.toUpperCase()}`);
  if (!addLabelIds.length && !removeLabelIds.length) return;
  const timeoutMs = change.timeoutMs ?? 15_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120_000) {
    throw new GmailCategoryError('Gmail category timeout is invalid.', 'GMAIL_CATEGORY_INVALID', false);
  }
  const controller = new AbortController();
  const timeoutError = () => new GmailCategoryError('Gmail category request timed out. The saved change will retry.', 'GMAIL_CATEGORY_TIMEOUT', true);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(timeoutError()); }, timeoutMs);
  });
  const execute = async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      let token: string;
      try { token = await change.resolveBearer!(attempt === 1); }
      catch (error) {
        if (controller.signal.aborted) throw timeoutError();
        const terminal = isOAuthTokenError(error) && isTerminalOAuthError(error);
        throw new GmailCategoryError(terminal ? 'Google OAuth sign-in is required for this account.' : 'Gmail OAuth token fetch failed. The saved change will retry.',
          terminal ? 'GMAIL_CATEGORY_AUTH_REQUIRED' : 'GMAIL_CATEGORY_TOKEN_UNAVAILABLE', !terminal);
      }
      if (controller.signal.aborted) throw timeoutError();
      if (typeof token !== 'string' || !token.trim()) {
        throw new GmailCategoryError('Google OAuth sign-in is required for this account.', 'GMAIL_CATEGORY_AUTH_REQUIRED', false);
      }
      let response: Response;
      try {
        response = await (change.fetch ?? globalThis.fetch)(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${hex}/modify`, {
          method: 'POST', redirect: 'error', signal: controller.signal,
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ addLabelIds, removeLabelIds }),
        });
      } catch {
        if (controller.signal.aborted) throw timeoutError();
        throw new GmailCategoryError('Gmail category request fetch failed. The saved change will retry.', 'GMAIL_CATEGORY_NETWORK', true);
      }
      // Release without reading potentially sensitive message/error data.
      void response.body?.cancel().catch(() => undefined);
      if (response.ok) return;
      if (response.status === 401 && attempt === 0) continue;
      const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
      const message = retryable
        ? `Gmail category request fetch failed (HTTP ${response.status}). The saved change will retry.`
        : `Gmail category change was rejected (HTTP ${response.status}). Check this account's Google authorization.`;
      throw new GmailCategoryError(message, retryable ? 'GMAIL_CATEGORY_TEMPORARY' : 'GMAIL_CATEGORY_REJECTED', retryable, response.status);
    }
  };
  try { await Promise.race([execute(), deadline]); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}
