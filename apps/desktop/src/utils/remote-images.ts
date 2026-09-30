// Does this message's remote content load without the reader asking?
//
// The ONE place that answers it, because there are two renderers — the classic
// card (`SandboxedEmailBody`) and the chat view (`MailChatView`, via
// chat-view-rules' `blockRemoteImagesFor`) — and the same mail must behave the
// same in both. When the rule lived inside `SandboxedEmailBody` the chat view
// kept the library's block-everything default, so a reader who had chosen
// "always" still saw the banner on half the app.
//
// The reader's explicit allowlist always applies. Beyond it, two sources are
// switched on or off INDEPENDENTLY — either, both, or neither — plus "always":
//
//   trusted senders   "Trust this sender", people this account has emailed,
//                     and verified brands (DMARC pass + a verified BIMI mark —
//                     the blue tick). Never for mail in Spam/Junk or mail
//                     whose authentication FAILED: a forged "From: trusted@x"
//                     must not make the app fetch its tracking pixels;
//   categorized mail  mail the AI filed into a real category other than
//                     Promotions, Spam or a Social category. This path does
//                     NOT check the sender: it trusts the AI's filing;
//   always            everything.
//
// One stored value (`remoteImageMode`) carries the choice, so a settings blob
// written by any earlier version still reads the same:
//
//   block        neither source;
//   trusted      trusted senders only;
//   categorized  categorized mail only;
//   safe         both (the default — the value every earlier default user has);
//   always       everything.
//
// `remoteImageSourcesOf` / `remoteImageModeFor` are the only translation
// between that value and the switches.
//
// The auth guard is only as good as the stored verdict (emails.auth_status,
// parsed by mailguard at ingest). Known gap, tracked upstream: mailguard 0.4.2
// lets a `dmarc=pass` in any Authentication-Results header win over the
// receiving server's `dmarc=fail`, so a forger who writes that header gets a
// "pass" here too. Fix it in mailguard (top-most header only, fail wins) and
// re-parse the stored verdicts; nothing here needs to change.
//
// Every source is a synchronous in-memory read (the decision runs while a
// message renders) and every source is OBSERVABLE: a list that finishes
// loading, a sender the reader just allowed, a mode change — each re-runs the
// decision for whatever is on screen (`useRemoteImageAutoLoad`,
// `useImageTrustSelector`). The old caches warmed silently, so the first
// message opened after launch kept its banner even for an allowed sender.
//
// Per account: a message's own account answers for it (the unified view shows
// other accounts' mail), and a click on "Load images" is remembered there.

import { authenticationFailed } from '@sarv-in/mailguard/verdict';
import { bareSenderAddress, imageAllowKeysFor, parseImageAllowInput, type ImageAllowEntry } from '@sarvinbox/core/image-allowlist';
import { createLogger } from '@sarvinbox/core/logger';
import { useCallback, useSyncExternalStore } from 'react';

import {
  getCachedCategorySlugs,
  getCategoryDefsVersion,
  subscribeCategoryDefs,
  warmCategoryDefs,
} from '../components/email-list/CategoryBadges';
import { isSpamFolder, type ClassifiableFolder } from '../config/folder-mapping';
import { SETTINGS_KEY, SETTINGS_WRITTEN_EVENT } from '../config/inbox-types';

import { createAccountScopedCache, resolveCacheAccount, setActiveCacheAccount } from './account-scoped-cache';
import { parseAuthStatus, type AuthStatus } from './email-security';
import { messageAccountOf } from './pane-account';
import { isVerifiedSender } from './sender-avatar';
import {
  getCachedSenderIdentity,
  getSenderIdentityVersion,
  requestSenderIdentity,
  subscribeSenderIdentity,
} from './sender-identity';
import { hasTag, parseTags } from './tags';
import { trustedSendersCache } from './trusted-senders';

const log = createLogger('RemoteImages');

// ── The mode ────────────────────────────────────────────────────────────────

/** Every value `remoteImageMode` can hold (see the top of this file). */
export const REMOTE_IMAGE_MODES = ['block', 'trusted', 'categorized', 'safe', 'always'] as const;
export type RemoteImageMode = (typeof REMOTE_IMAGE_MODES)[number];

/** What a fresh install gets: trusted senders AND categorized mail. */
export const DEFAULT_REMOTE_IMAGE_MODE: RemoteImageMode = 'safe';

export const isRemoteImageMode = (value: unknown): value is RemoteImageMode =>
  typeof value === 'string' && (REMOTE_IMAGE_MODES as readonly string[]).includes(value);

/**
 * What a stored mode switches on, beyond the allowlist (which always applies).
 * `always` loads everything, so it reports both sources as included too.
 */
export interface RemoteImageSources {
  /** Trusted senders: "Trust this sender", people emailed, verified brands. */
  trusted: boolean;
  /** Mail the AI categorized, except Social, Promotional and Spam. */
  categorized: boolean;
  /** Every remote image, whoever sent it. */
  always: boolean;
}

const SOURCES_OF: Record<RemoteImageMode, RemoteImageSources> = {
  block: { trusted: false, categorized: false, always: false },
  trusted: { trusted: true, categorized: false, always: false },
  categorized: { trusted: false, categorized: true, always: false },
  safe: { trusted: true, categorized: true, always: false },
  always: { trusted: true, categorized: true, always: true },
};

/** The switches a stored mode means — a fresh copy. Pure; a value that is not a
 *  mode reads as the default's, as {@link remoteImageModeOf} reads it. */
export function remoteImageSourcesOf(mode: RemoteImageMode): RemoteImageSources {
  return { ...SOURCES_OF[isRemoteImageMode(mode) ? mode : DEFAULT_REMOTE_IMAGE_MODE] };
}

/** The stored mode for a set of switches — the inverse of {@link remoteImageSourcesOf}. Pure. */
export function remoteImageModeFor(sources: RemoteImageSources): RemoteImageMode {
  if (sources.always) return 'always';
  if (sources.trusted && sources.categorized) return 'safe';
  if (sources.trusted) return 'trusted';
  if (sources.categorized) return 'categorized';
  return 'block';
}

/**
 * The mode a settings blob means. An explicit mode is kept verbatim; the legacy
 * 'important' (auto-load only AI-Important mail) became 'safe'; a legacy
 * boolean `autoLoadRemoteImages` maps to always/block so an existing user keeps
 * their choice; anything else is the default. Pure — the migration is the part
 * that must never silently widen a reader's choice.
 */
export function remoteImageModeOf(settings: unknown): RemoteImageMode {
  if (!settings || typeof settings !== 'object') return DEFAULT_REMOTE_IMAGE_MODE;
  const s = settings as { remoteImageMode?: unknown; autoLoadRemoteImages?: unknown };
  if (s.remoteImageMode === 'important') return 'safe';
  if (isRemoteImageMode(s.remoteImageMode)) return s.remoteImageMode;
  if (typeof s.autoLoadRemoteImages === 'boolean') return s.autoLoadRemoteImages ? 'always' : 'block';
  return DEFAULT_REMOTE_IMAGE_MODE;
}

// The settings blob carries every signature, so it can be large, and the
// decision runs for every open card and every chat bubble whenever any trust
// source changes (an avatar lookup landing anywhere is one). So the parsed mode
// is kept in memory and the blob is read again only when it may have changed:
// a choice on the Security page (`saveRemoteImageMode`), any write of the blob
// in this window (app-settings-sync announces it: SETTINGS_WRITTEN_EVENT), or a
// write from another window (the `storage` event).
let modeMemo: RemoteImageMode | null = null;

const modeListeners = new Set<() => void>();
let modeVersion = 0;
let listeningForWrites = false;

/** Re-read the mode after a write that may or may not have changed it; tell
 *  open messages only when it did (saving a signature must not re-decide
 *  every message). */
function modeMayHaveChanged(): void {
  const before = modeMemo;
  modeMemo = null;
  if (getRemoteImageMode() !== before) notifyRemoteImageModeChanged();
}

function listenForSettingsWrites(): void {
  if (listeningForWrites || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
  listeningForWrites = true;
  window.addEventListener('storage', (event: StorageEvent) => {
    if (event.key === null || event.key === SETTINGS_KEY) modeMayHaveChanged();
  });
  window.addEventListener(SETTINGS_WRITTEN_EVENT, modeMayHaveChanged);
}

/** The stored mode (see {@link remoteImageModeOf}); the default when unreadable. */
export const getRemoteImageMode = (): RemoteImageMode => {
  listenForSettingsWrites();
  if (modeMemo) return modeMemo;
  let raw: string | null;
  try {
    raw = localStorage.getItem(SETTINGS_KEY);
  } catch {
    // Unreadable storage is not remembered: the next read tries again.
    return DEFAULT_REMOTE_IMAGE_MODE;
  }
  let mode: RemoteImageMode;
  try {
    mode = remoteImageModeOf(raw ? JSON.parse(raw) : null);
  } catch {
    mode = DEFAULT_REMOTE_IMAGE_MODE;
  }
  modeMemo = mode;
  return mode;
};

/** The stored mode changed: drop the parsed copy and tell every open message,
 *  so it re-decides now. */
export function notifyRemoteImageModeChanged(): void {
  modeMemo = null;
  modeVersion += 1;
  modeListeners.forEach((listener) => listener());
  catchUpEmailedAddresses();
}

/** Be told whenever the stored mode may have changed: a choice on the Security
 *  page ({@link saveRemoteImageMode}) or a write from this or another window. */
export function subscribeRemoteImageMode(listener: () => void): () => void {
  listenForSettingsWrites();
  modeListeners.add(listener);
  return () => { modeListeners.delete(listener); };
}

/** The stored mode, kept current: whatever shows it re-renders the moment it
 *  is chosen, here or in another window. */
export function useRemoteImageMode(): RemoteImageMode {
  return useSyncExternalStore(subscribeRemoteImageMode, getRemoteImageMode, getRemoteImageMode);
}

/**
 * Store a mode chosen by the reader, keeping every other setting in the blob,
 * and re-decide every open message. Returns false (and writes nothing) when the
 * stored blob cannot be read: writing a fresh one over it would throw away every
 * other setting the reader has.
 */
export function saveRemoteImageMode(mode: RemoteImageMode): boolean {
  if (!isRemoteImageMode(mode)) return false;
  let blob: Record<string, unknown> = {};
  try {
    const stored = localStorage.getItem(SETTINGS_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
      blob = parsed as Record<string, unknown>;
    }
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...blob, remoteImageMode: mode }));
  } catch (error) {
    log.warn(`Could not save the remote-image mode: ${(error as Error)?.message ?? error}`);
    return false;
  }
  notifyRemoteImageModeChanged();
  return true;
}

// ── Memoised string helpers ─────────────────────────────────────────────────
// Parsing an address or classifying a folder name is the costliest step of the
// decision, and the same few senders and folders are asked about over and over
// (every bubble, every source change). Pure functions of the string, so their
// answers are kept — bounded.

const MEMO_LIMIT = 2_000;
function memoizeByString<T>(fn: (input: string) => T): (input: string | null | undefined) => T {
  const memo = new Map<string, T>();
  return (input) => {
    const key = input ?? '';
    const hit = memo.get(key);
    if (hit !== undefined || memo.has(key)) return hit as T;
    if (memo.size >= MEMO_LIMIT) memo.clear();
    const value = fn(key);
    memo.set(key, value);
    return value;
  };
}

/** `bareSenderAddress`, remembered: the key every trust list is looked up by. */
const senderKey = memoizeByString(bareSenderAddress);
/** `imageAllowKeysFor`, remembered: the address, its domain and each parent domain. */
const allowKeysOf = memoizeByString(imageAllowKeysFor);

// ── Spam/Junk folders ───────────────────────────────────────────────────────

/**
 * Does this folder path NAME a Spam/Junk folder — any provider's name for it
 * (`Spam`, `[Gmail]/Spam`, `Junk`, `Junk Email`, `Bulk Mail`, …), under either
 * hierarchy delimiter (`INBOX/Spam`, and Dovecot/Courier's `INBOX.Junk`)? The
 * shared classifier splits on '/' only, so the last '.'-segment is asked too.
 */
const namesSpamFolder = memoizeByString((path) =>
  isSpamFolder({ path }) || isSpamFolder({ path: path.split('.').pop() ?? '' }));

// A server's Junk folder can have any name (a localized one, or "Junk Mail")
// and say what it is only through SPECIAL-USE (\Junk). The folder list says
// so, per account, and is fed in by the store whenever it loads one.
const spamFolderPathsByAccount = new Map<string, ReadonlySet<string>>();
const spamFolderListeners = new Set<() => void>();
let spamFoldersVersion = 0;

/** Every Spam/Junk folder in an account's folder list (special-use included),
 *  for {@link isSpamFolderMail}. Called when the store loads the list. */
export function noteAccountFolders(accountId: string | null | undefined, folders: readonly ClassifiableFolder[] | null | undefined): void {
  const key = resolveCacheAccount(accountId) ?? '';
  const paths = new Set((folders ?? []).filter((folder) => isSpamFolder(folder)).map((folder) => folder.path));
  const known = spamFolderPathsByAccount.get(key);
  if (known && known.size === paths.size && [...paths].every((path) => known.has(path))) return;
  spamFolderPathsByAccount.set(key, paths);
  spamFoldersVersion += 1;
  spamFolderListeners.forEach((listener) => listener());
}

const subscribeSpamFolders = (listener: () => void): (() => void) => {
  spamFolderListeners.add(listener);
  return () => { spamFolderListeners.delete(listener); };
};

/**
 * Is the message in a Spam/Junk folder of its account? By name (every
 * provider's, either delimiter), or by the account's own folder list, which
 * knows the special-use Junk folder whatever it is called. Known gap: the
 * renderer holds only the active account's folder list, so another account's
 * message in the unified view is judged by name alone.
 */
export function isSpamFolderMail(tags?: string | null, accountId?: string | null): boolean {
  const known = spamFolderPathsByAccount.get(resolveCacheAccount(accountId) ?? '');
  return parseTags(tags || '').some((tag) => namesSpamFolder(tag) || !!known?.has(tag));
}

/** Whether a mail is Promotional or Spam: the AI promotions category, or any Spam/Junk folder. */
export const isPromoOrSpam = (tags?: string | null, accountId?: string | null): boolean =>
  hasTag(tags, 'promotions') || isSpamFolderMail(tags, accountId);

// ── Categorized mail ────────────────────────────────────────────────────────

/**
 * Is this AI category a Social one? The app ships no built-in Social category;
 * a reader's own takes its slug from its name ("Social" → `social`, "Social
 * Media" → `social_media`, "Socials", "SocialNetworks"), so any word of the
 * slug that starts with "social" counts. Errs toward blocking.
 */
export const isSocialCategorySlug: (slug: string) => boolean = memoizeByString((slug) =>
  slug.toLowerCase().split(/[^a-z0-9]+/).some((word) => word.startsWith('social')));

/** Categories whose mail is marketing or social noise: never auto-loaded by
 *  category — Promotions and any Social category. */
export const isImageExcludedCategory = (slug: string): boolean =>
  slug === 'promotions' || isSocialCategorySlug(slug);

/**
 * Is this mail eligible for auto-load as categorized mail (the `categorized`
 * source — stored as 'categorized' or 'safe'): the AI gave it a REAL enabled
 * category, that category is not Promotions or a Social one,
 * and it is not in Spam. Uncategorized mail stays behind the banner — only mail
 * the AI positively recognised is trusted this way. It does not check the
 * sender: that is the trusted senders' guard, not this path's.
 *
 * `tags` refreshes when categorization completes, and the slug list is
 * observable, so a freshly categorised mail flips to auto-load on its own.
 */
export const qualifiesForCategorizedAutoLoad = (tags?: string | null, accountId?: string | null): boolean => {
  const t = tags || '';
  // Any Social-looking tag excludes, enabled category or not: conservative.
  if (isPromoOrSpam(t, accountId) || parseTags(t).some(isSocialCategorySlug)) return false;
  const slugs = getCachedCategorySlugs();
  // Slugs not loaded yet (cold open before the list rendered): stay
  // conservative, warm the cache, and re-decide when it lands.
  if (slugs.length === 0) { warmCategoryDefs(); return false; }
  return slugs.some((slug) => !isImageExcludedCategory(slug) && hasTag(t, slug));
};

// ── The explicit allowlist ──────────────────────────────────────────────────
// A reader who clicks "Load images" allows that SENDER; the Security page can
// add a sender or a whole DOMAIN (`@x.com`, which also covers `news.x.com`).
// Persisted per account (image_allowed_senders); keys normalised by the shared
// `image-allowlist` module, so "Name <addr>", "addr" and the domain all match.

/** Every account's allowlist — observable. */
export const imageAllowlist = createAccountScopedCache<string>({
  name: 'image-allowlist',
  load: async (accountId) => {
    const res = await window.electronAPI.emails.getImageAllowedSenders(accountId);
    if (!res?.success || !Array.isArray(res.data)) throw new Error(res?.error || 'getImageAllowedSenders failed');
    return res.data;
  },
  keyOf: (key) => (key ?? '').trim().toLowerCase(),
});

/** Load (or re-load) one account's allowlist; no account = the active one. */
export const warmImageAllowedSenders = (accountId?: string | null): Promise<void> => imageAllowlist.reload(accountId);

/** Forget every account's allowlist; the next read re-loads it. */
export const clearImageAllowedCache = (): void => imageAllowlist.clear();

/** Has the reader chosen to always load images from this sender (or its domain)
 *  in this account? Synchronous: false on a cold cache, which starts the load
 *  and re-decides when it lands. */
export const isSenderImagesAllowed = (address?: string | null, accountId?: string | null): boolean => {
  const bare = senderKey(address);
  if (!bare) return false;
  const entries = imageAllowlist.keys(accountId);
  // `isImageAllowedFor`, over the remembered keys (see senderKey).
  return allowKeysOf(bare).some((key) => entries.has(key));
};

/** Backoff for a write the main process could not store — a transient failure
 *  (storage busy, account runtime still opening) should not lose the choice. */
export const PERSIST_RETRY_DELAYS_MS: readonly number[] = [500, 2_000];

async function persistWithRetry(what: string, attempt: () => Promise<{ success?: boolean; error?: string } | undefined>): Promise<boolean> {
  let lastError = '';
  for (let tryNo = 0; tryNo <= PERSIST_RETRY_DELAYS_MS.length; tryNo++) {
    if (tryNo > 0) await new Promise((resolve) => setTimeout(resolve, PERSIST_RETRY_DELAYS_MS[tryNo - 1]));
    try {
      const res = await attempt();
      if (res?.success) return true;
      lastError = res?.error || 'not stored';
    } catch (error) {
      lastError = (error as Error)?.message ?? String(error);
    }
  }
  log.warn(`${what} was not saved (${lastError}); it no longer applies`);
  return false;
}

/** Remember an allowance — a sender address OR a whole domain — in the
 *  message's own account (none = the active one). Applies at once to every
 *  open message it covers, persists in the background (retrying a transient
 *  failure), and is withdrawn if it cannot be stored. Returns the entry, or
 *  null when the input is neither an address nor a domain. */
export const rememberImagesAllowed = (input?: string | null, accountId?: string | null): ImageAllowEntry | null => {
  const entry = parseImageAllowInput(input);
  if (!entry) return null;
  const account = resolveCacheAccount(accountId);
  void imageAllowlist.write(account, { add: entry.key }, () =>
    persistWithRetry(`Image allowance for ${entry.label}`, () =>
      window.electronAPI.emails.allowImagesForSender(entry.key, account)));
  return entry;
};

/**
 * Would trusting this message's From address trust a forgery? Mail in
 * Spam/Junk, or mail whose authentication FAILED (mailguard's
 * `authenticationFailed`, the rule the shield and the spam filter use): the
 * From address is exactly what a forger copies.
 */
export function isSuspectSender(message: RemoteImageMessage): boolean {
  return isSpamFolderMail(message.tags, message.accountId)
    || authenticationFailed(parseAuthStatus(message.authStatus ?? null));
}

/**
 * "Load images" on a message: remember its sender in the message's own account
 * so their future mail auto-loads. Not on a suspect message
 * ({@link isSuspectSender}): the allowlist outranks every guard, so
 * remembering a forged From would load every later forgery's pixels in every
 * mode. Its images still load this once — the caller shows them. Returns the
 * entry remembered, or null.
 */
export const rememberSenderImagesAllowed = (message: RemoteImageMessage | null | undefined): ImageAllowEntry | null => {
  if (!message || isSuspectSender(message)) return null;
  return rememberImagesAllowed(message.fromAddress, message.accountId);
};

/** Drop one allowance (the Security page's revoke), from open messages too. */
export const forgetImagesAllowed = (key?: string | null, accountId?: string | null): void => {
  const stored = (key ?? '').trim().toLowerCase();
  if (!stored) return;
  const account = resolveCacheAccount(accountId);
  void imageAllowlist.write(account, { remove: stored }, async () => {
    const res = await window.electronAPI.emails.disallowImagesForSender?.(stored, account);
    return !!res?.success;
  });
};

// ── People this account has emailed (trusted senders) ───────────────────────

/** Every account's correspondents (bare, lowercased addresses) — observable. */
export const emailedAddresses = createAccountScopedCache<string>({
  name: 'emailed-addresses',
  load: async (accountId) => {
    const res = await window.electronAPI.emails.getEmailedAddresses(accountId);
    if (!res?.success || !Array.isArray(res.data)) throw new Error(res?.error || 'getEmailedAddresses failed');
    return res.data;
  },
  // Main hands back bare lowercased addresses; re-parsing thousands of them
  // would cost more than the lookup it serves.
  keyOf: (address) => (address ?? '').trim().toLowerCase(),
});

/** How long a burst of Sent-folder arrivals is gathered into one re-read. */
export const EMAILED_REFRESH_DELAY_MS = 2_000;
const emailedRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Does the decision consult the correspondents list under the stored mode?
 *  Only with trusted senders on, and not overruled by "always" (which consults
 *  nothing). */
const correspondentsInUse = (): boolean => {
  const sources = remoteImageSourcesOf(getRemoteImageMode());
  return sources.trusted && !sources.always;
};

/** Accounts ('' = the active one) whose loaded list a Sent copy was NOT
 *  re-read for, because the list was not in use at the time: it may be missing
 *  someone written to since, so it is re-read once it is in use again
 *  ({@link catchUpEmailedAddresses}). */
const emailedStaleAccounts = new Set<string>();

/**
 * A Sent-folder message was stored in this account (none = the active one):
 * re-read its correspondents, once per {@link EMAILED_REFRESH_DELAY_MS} however
 * many arrived. Only once something has read them (nothing else needs it), and
 * only while the decision uses them ({@link correspondentsInUse}) — the re-read
 * is a scan of the account's sender stats. While they are not in use the
 * account is only marked stale, and re-read the moment trusted senders are
 * switched back on. Keeps the current list visible until the new one lands; a
 * failure keeps it too.
 */
export function refreshEmailedAddresses(accountId?: string | null): void {
  const account = resolveCacheAccount(accountId);
  if (!emailedAddresses.isLoaded(account)) return;
  const key = account ?? '';
  if (!correspondentsInUse()) {
    emailedStaleAccounts.add(key);
    return;
  }
  if (emailedRefreshTimers.has(key)) return;
  emailedRefreshTimers.set(key, setTimeout(() => {
    emailedRefreshTimers.delete(key);
    void emailedAddresses.reload(account);
  }, EMAILED_REFRESH_DELAY_MS));
}

/**
 * The mode changed: if the correspondents list is in use again (trusted
 * senders switched back on, or "always" switched off), re-read now every loaded
 * list a Sent copy was skipped for meanwhile — without this, someone written to
 * while trusted senders was off stays a stranger until restart or an account
 * switch. Nothing to do (not even a mode read) when no list was skipped.
 */
function catchUpEmailedAddresses(): void {
  if (emailedStaleAccounts.size === 0 || !correspondentsInUse()) return;
  const stale = [...emailedStaleAccounts];
  emailedStaleAccounts.clear();
  for (const key of stale) {
    const account = key || undefined;
    if (emailedAddresses.isLoaded(account)) void emailedAddresses.reload(account);
  }
}

/** Has this account ever sent mail to this address? */
export const hasEmailedAddress = (accountId: string | null | undefined, address?: string | null): boolean => {
  const addr = senderKey(address);
  return !!addr && emailedAddresses.has(accountId, addr);
};

// ── Trusted senders ─────────────────────────────────────────────────────────

/** The blue tick: DMARC passed AND the domain's verified BIMI mark checks out.
 *  An identity not looked up yet is asked for, and re-decided when it lands. */
const isVerifiedBrand = (address: string | null | undefined, auth: AuthStatus | null): boolean => {
  const dmarcPass = auth?.dmarc === 'pass';
  if (!dmarcPass) return false;
  const identity = getCachedSenderIdentity(address);
  if (!identity) { requestSenderIdentity(address); return false; }
  return isVerifiedSender({ bimiStatus: identity.bimi?.status ?? null, dmarcPass });
};

/**
 * Does the sender count as trusted for images — "Trust this sender", someone
 * this account has emailed, or a verified brand — for THIS message?
 *
 * Never for mail in Spam/Junk, and never when the message's authentication
 * FAILED (mailguard's `authenticationFailed`, the rule the shield and the
 * spam filter use): the From address is exactly what a forger copies, so
 * trusting it there would let a spoof fetch its tracking pixels.
 */
export function isTrustedForImages(message: RemoteImageMessage): boolean {
  const { fromAddress, authStatus, accountId } = message;
  const sender = senderKey(fromAddress);
  if (!sender) return false;
  if (isSuspectSender(message)) return false;
  const auth = parseAuthStatus(authStatus ?? null);
  // The trusted-senders cache is keyed by the same bare address
  // (`isTrustedSenderIn`, without parsing it a second time).
  return trustedSendersCache.has(accountId, sender)
    || emailedAddresses.has(accountId, sender)
    || isVerifiedBrand(sender, auth);
}

// ── The decision ────────────────────────────────────────────────────────────

/** What the decision needs to know about one message. */
export interface RemoteImageMessage {
  fromAddress?: string | null;
  /** The pipe-delimited tags: folders + AI categories. */
  tags?: string | null;
  /** The stored emails.auth_status JSON. */
  authStatus?: string | null;
  /** The account the message belongs to; null/undefined = the active account. */
  accountId?: string | null;
}

/**
 * The facts of an email for {@link shouldAutoLoadRemoteImages}. The account is
 * the row's own (`accountId`, set on unified-view rows) or else the reading
 * pane's (`paneAccountOf`: the account the open thread was read from), passed
 * as the second argument; neither means the active account.
 */
export function remoteImageFactsOf(
  email: { fromAddress?: string | null; tags?: string | null; authStatus?: string | null; accountId?: string | null } | null | undefined,
  viewAccountId?: string | null,
): RemoteImageMessage | null {
  if (!email) return null;
  return {
    fromAddress: email.fromAddress ?? null,
    tags: email.tags ?? null,
    authStatus: email.authStatus ?? null,
    accountId: messageAccountOf(email, viewAccountId),
  };
}

/**
 * Does this message's remote content load without the reader asking? See the
 * top of this file for the sources. The reader's explicit allowlist applies
 * whatever is switched on; trusted senders and categorized mail each load only
 * when their own switch is on — neither implies the other. Lazy: only the
 * switched-on sources are read, and a cold source answers "no" and starts
 * loading (the caller re-decides when it lands).
 */
export function shouldAutoLoadRemoteImages(message: RemoteImageMessage | null | undefined): boolean {
  const sources = remoteImageSourcesOf(getRemoteImageMode());
  if (sources.always) return true;
  if (!message) return false;
  if (isSenderImagesAllowed(message.fromAddress, message.accountId)) return true;
  if (sources.trusted && isTrustedForImages(message)) return true;
  return sources.categorized && qualifiesForCategorizedAutoLoad(message.tags, message.accountId);
}

// ── Observing it ────────────────────────────────────────────────────────────

interface TrustSource { subscribe: (listener: () => void) => () => void; getVersion: () => number }

// Built on first use, not at import: a test that stubs one of these modules
// must not have its stub touched just because this module was loaded.
let sources: TrustSource[] | null = null;
const trustSources = (): TrustSource[] => (sources ??= [
  imageAllowlist,
  emailedAddresses,
  trustedSendersCache,
  { subscribe: subscribeSenderIdentity, getVersion: getSenderIdentityVersion },
  { subscribe: subscribeCategoryDefs, getVersion: getCategoryDefsVersion },
  { subscribe: subscribeRemoteImageMode, getVersion: () => modeVersion },
  { subscribe: subscribeSpamFolders, getVersion: () => spamFoldersVersion },
]);

/** Be told whenever anything the decision reads may have changed. */
export function subscribeImageTrust(listener: () => void): () => void {
  const offs = trustSources().map((source) => source.subscribe(listener));
  return () => offs.forEach((off) => off());
}

/** Grows whenever {@link subscribeImageTrust} fires (every source only counts up). */
export function getImageTrustVersion(): number {
  return trustSources().reduce((sum, source) => sum + source.getVersion(), 0);
}

/**
 * Re-render when `select()` — a function of the trust sources, memoised by the
 * caller — returns something different. Only a changed ANSWER re-renders: an
 * avatar lookup landing elsewhere in the app does not repaint every bubble.
 */
export function useImageTrustSelector<T>(select: () => T): T {
  return useSyncExternalStore(subscribeImageTrust, select, select);
}

/**
 * {@link shouldAutoLoadRemoteImages} for one message, kept current: flips the
 * moment a source it depends on loads or changes. `enabled` false (content the
 * app itself wrote — signatures, quotes, previews) skips the decision entirely.
 */
export function useRemoteImageAutoLoad(message: RemoteImageMessage | null | undefined, enabled = true): boolean {
  const present = !!message;
  const fromAddress = message?.fromAddress ?? null;
  const tags = message?.tags ?? null;
  const authStatus = message?.authStatus ?? null;
  const accountId = message?.accountId ?? null;
  const select = useCallback(
    () => enabled && shouldAutoLoadRemoteImages(present ? { fromAddress, tags, authStatus, accountId } : null),
    [enabled, present, fromAddress, tags, authStatus, accountId],
  );
  return useImageTrustSelector(select);
}

// ── Account switches ────────────────────────────────────────────────────────

/** Load (or refresh) every trust source for one account, eagerly — so the
 *  first message opened after launch or a switch is decided on real data. */
export function warmImageTrust(accountId?: string | null): void {
  void imageAllowlist.reload(accountId);
  emailedStaleAccounts.delete(resolveCacheAccount(accountId) ?? ''); // re-read here, fresh
  void emailedAddresses.reload(accountId);
  void trustedSendersCache.reload(accountId);
  warmCategoryDefs();
}

/**
 * The active account is now `accountId` (startup, a switch, a new account,
 * none after the last one is removed): reads that name no account resolve to
 * it from here on, and its trust sources load at once. Other accounts' lists
 * stay — they are keyed by account.
 */
export function setImageTrustAccount(accountId: string | null | undefined): void {
  setActiveCacheAccount(accountId);
  if (accountId) warmImageTrust(accountId);
}

/** A removed account: drop every list held for it, so a later account with
 *  the same id (the same address re-added) never starts from the old lists. */
export function forgetImageTrustAccount(accountId: string): void {
  imageAllowlist.forget(accountId);
  emailedAddresses.forget(accountId);
  emailedStaleAccounts.delete(accountId);
  trustedSendersCache.forget(accountId);
  if (spamFolderPathsByAccount.delete(accountId)) {
    spamFoldersVersion += 1;
    spamFolderListeners.forEach((listener) => listener());
  }
}
