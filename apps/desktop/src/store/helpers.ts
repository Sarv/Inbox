import type { SMTPConfig } from '@sarvinbox/core';

import { clearCategoryBadgeCache, applyEmailCategories, getCachedCategorySlugs, warmCategoryDefs } from '../components/email-list/CategoryBadges';
import type { InboxType, InboxSection } from '../config/inbox-types';
import { DEFAULT_SECTIONS, SETTINGS_KEY } from '../config/inbox-types';
import { reportAIHealthy, reportAIUnhealthy, getDefaultProvider, syncAIProviderToMain } from '../services/ai-service';

import { normalizeIdentities } from './identities';
import type { StoredAccount , ViewMode } from './types';

// Static import — `require()` is undefined in the Vite/ESM renderer, so the
// previous lazy require threw (and was swallowed) on every categorization
// event. CategoryBadges has no store imports, so no cycle.

// Gmail-style full-page section view (clicking a section's count) always
// paginates at this fixed size, independent of the section's "Show up to"
// (maxItems) — that setting only governs the home-screen preview count.
export const SECTION_FULL_PAGE_SIZE = 50;

// Helper to get emailsPerPage from settings
export const getEmailsPerPage = (): number => {
  try {
    const stored = localStorage.getItem('sarvinbox-settings');
    if (stored) {
      const settings = JSON.parse(stored);
      return settings.emailsPerPage || 25;
    }
  } catch {
    // Ignore errors
  }
  return 25; // Default
};

// ── Sectioned-inbox reload economy ─────────────────────────────────────────
// A background reload (IMAP sync completion / IDLE flush / AI-categorization
// complete) re-runs `loadAllSections` every few seconds. Two things there used
// to make it needlessly expensive; these pure helpers bound both.

/**
 * Upper bound on how many rows a BACKGROUND reload re-fetches (and re-builds into
 * threads) per section. A reload preserves the user's current paginated depth so
 * a sync doesn't snap the list back to page 1 — but left unbounded, a
 * deeply-paginated section makes EVERY sync tick re-fetch + re-`buildThreads` +
 * re-render its whole grown set (the "lags every few seconds" beachball). Beyond
 * this cap the user re-paginates; the preview stays smooth. 100 = four pages of
 * the default 25.
 */
export const SECTION_RELOAD_MAX_ITEMS = 100;

/**
 * How many rows to re-fetch for one section on a reload. `existingOffset` is the
 * user's current paginated depth (0/undefined when they haven't paged). Preserve
 * that depth so a background sync doesn't truncate their view — but never below
 * the preview size and never above the reload cap, so the per-tick cost stays
 * bounded. Pure: no I/O, fully unit-testable.
 */
export const computeSectionFetchLimit = (
  existingOffset: number | undefined,
  previewSize: number,
  maxItems: number = SECTION_RELOAD_MAX_ITEMS,
): number => {
  const preview = previewSize > 0 ? previewSize : 25;
  const cap = Math.max(preview, maxItems);
  if (!existingOffset || existingOffset <= 0) return preview;
  return Math.max(preview, Math.min(existingOffset, cap));
};

// A section row, reduced to only the fields whose change is VISIBLE in the list
// row. `sectionDataUnchanged` compares these to detect a no-op reload.
type SectionRowLike = {
  id: string;
  updatedAt?: number;
  date?: number;
  tags?: string | null;
  flags?: string[];
  subject?: string | null;
  cleanBody?: string | null;
};
type SectionSnapshot = {
  emails?: SectionRowLike[];
  total?: number;
  hasMore?: boolean;
  loading?: boolean;
};

/**
 * A row's visual signature. Includes EVERY field a change to which alters how the
 * row renders: read state (`flags`), star/category/importance/folder (`tags`),
 * the downloaded-body preview (`cleanBody` snippet), plus id/date/subject and the
 * `updatedAt` version bump. Deliberately conservative — extra fields only make
 * two snapshots LESS likely to compare equal, so the no-op skip can only ever
 * FAIL to skip, never skip a render the user needed to see.
 */
const sectionRowSignature = (row: SectionRowLike): unknown[] => [
  row.id,
  row.updatedAt ?? 0,
  row.date ?? 0,
  row.tags ?? '',
  (row.flags || []).join(','),
  row.subject ?? '',
  row.cleanBody ?? '',
];

/** A stable signature over all sections' visible rows + header counts.
 *  `JSON.stringify` handles all escaping, so no field value can forge a
 *  section/row boundary — no separator-collision to reason about. */
export const sectionDataSignature = (sectionData: Record<string, SectionSnapshot>): string =>
  JSON.stringify(
    Object.keys(sectionData)
      .sort()
      .map((sectionId) => {
        const snapshot = sectionData[sectionId];
        return [
          sectionId,
          snapshot?.total ?? 0,
          !!snapshot?.hasMore,
          !!snapshot?.loading,
          (snapshot?.emails || []).map(sectionRowSignature),
        ];
      }),
  );

/**
 * True when a freshly-fetched section snapshot would render identically to the
 * one already on screen — so `loadAllSections` can skip the `set()` (and the
 * full thread rebuild + re-render it triggers) on a no-op background sync tick.
 */
export const sectionDataUnchanged = (
  prev: Record<string, SectionSnapshot>,
  next: Record<string, SectionSnapshot>,
): boolean => sectionDataSignature(prev) === sectionDataSignature(next);

// "All Email" (virtual-all) and "All Inboxes" (virtual-unified) are deliberate
// exceptions to the user's emailsPerPage setting: they're the firehose views, so
// they always page 100 at a time (fixed full-page pagination). Every other flat
// view honors the user's setting.
/**
 * Is `folderPath` the folder the user is currently looking at?
 *
 * Resolves the SELECTED folder by id and compares its path, rather than looking
 * the ARRIVING folder up by path and comparing ids. The two are equivalent only
 * while `folders` is complete, and during an initial sync (or a rebuilt cache)
 * it is not: the sync creates folder rows as it discovers them, so the
 * renderer's snapshot predates half of them. A `find()` on the arriving path
 * then returns undefined, the refresh is skipped, and the list sits empty while
 * mail pours into the DB — visible only as a sidebar count that disagrees with
 * an empty list, until the user hits refresh by hand.
 *
 * The selected folder is always present in the snapshot (it is where
 * `selectedFolderId` came from), so this lookup cannot go stale the same way.
 */
export const isFolderInView = (
  folders: ReadonlyArray<{ id: string; path: string }> | undefined | null,
  selectedFolderId: string | null | undefined,
  folderPath: string | null | undefined,
): boolean => {
  if (!folderPath) return false;
  return findFolderPathById(folders, selectedFolderId) === folderPath;
};

/**
 * The path of the folder the user is looking at, or null when none is selected
 * (a virtual view, or before the first folder loads).
 *
 * Shared with `isFolderInView` so the "which folder is on screen" lookup exists
 * once — the two must never disagree about what counts as the selected folder.
 */
export const findFolderPathById = (
  folders: ReadonlyArray<{ id: string; path: string }> | undefined | null,
  folderId: string | null | undefined,
): string | null => {
  if (!folderId) return null;
  return (folders ?? []).find((folder) => folder.id === folderId)?.path ?? null;
};

/**
 * How long the view must settle between two sync-progress refreshes.
 *
 * A batch commit fires progress every ~50 messages, so a first sync of a 25k
 * mailbox reports ~500 times. Refreshing on each one would re-query and
 * re-render the list continuously for the whole sync — the progressive fill has
 * to be visible, not a treadmill. Under a second feels alive; much more and the
 * list looks stuck again.
 */
export const SYNC_PROGRESS_REFRESH_MS = 1_500;

/** What the last sync-progress-driven refresh saw. Caller-owned, so the rule below stays pure. */
export interface SyncProgressRefreshGate {
  /** `messagesProcessed` at the last refresh — the engine's cumulative count for this sync. */
  lastProcessed: number;
  /** `Date.now()` at the last refresh. */
  lastRefreshAt: number;
}

/**
 * Should this sync-progress tick refresh the visible list?
 *
 * Mail used to appear only when the WHOLE sync resolved — INBOX, Sent and
 * Starred, every one of them to the per-folder cap — because that is where
 * `syncEmails` calls `_reloadCurrentView`. On a first-run account (or a rebuilt
 * cache) that is minutes of an empty list next to a sidebar already counting
 * mail. The engine reports progress after each batch is COMMITTED to the DB, so
 * every one of those ticks is a point where stored mail could already be shown.
 *
 * Refresh when the count has MOVED (a tick that processed nothing stored
 * nothing — a flags-only pass or a folder that was already up to date — and a
 * reload would re-query for the same rows), and no more often than
 * SYNC_PROGRESS_REFRESH_MS. A count that went BACKWARDS is a new sync's reset,
 * which must refresh rather than be read as "no progress".
 */
export const shouldRefreshOnSyncProgress = (
  status: { messagesProcessed?: number | null } | null | undefined,
  gate: SyncProgressRefreshGate,
  now: number,
): boolean => {
  const processed = status?.messagesProcessed;
  if (typeof processed !== 'number' || !Number.isFinite(processed)) return false;
  if (processed === gate.lastProcessed) return false;
  return now - gate.lastRefreshAt >= SYNC_PROGRESS_REFRESH_MS;
};

export const ALL_MAIL_PAGE_SIZE = 100;
const FIXED_PAGE_VIEWS = new Set(['virtual-all', 'virtual-unified']);

/** The page size for a given view: the fixed 100 for the firehose views ("All
 *  Email" / "All Inboxes"), otherwise the user's emailsPerPage. Single source of
 *  truth so the initial load, the Paginator label, and prev/next all agree — a
 *  mismatch is exactly what makes the count jump (e.g. 20 → 50) between the first
 *  render and the next page. */
export const getPageSizeForView = (selectedVirtualFolder?: string | null): number =>
  selectedVirtualFolder && FIXED_PAGE_VIEWS.has(selectedVirtualFolder) ? ALL_MAIL_PAGE_SIZE : getEmailsPerPage();

/** Resolve a folder view's "of N" total. The read-model paginates folders by
 *  THREAD (getByFolder → thread_folders), so when it's ready the denominator is
 *  the folder's thread count; otherwise getByFolder falls back to message
 *  pagination and we keep the legacy message-count total. `threadMode` tells the
 *  caller which unit `total` is in, so hasMore is computed consistently (thread
 *  offset vs message length). */
export const resolveFolderTotal = async (
  folder: { path?: string; totalCount?: number; serverMessageCount?: number } | undefined,
  viewFilter?: unknown,
): Promise<{ total: number; threadMode: boolean }> => {
  try {
    const res = await window.electronAPI.emails.folderThreadCount(folder?.path, viewFilter as any);
    if (res?.success && res.data != null) return { total: res.data, threadMode: true };
  } catch {
    // fall through to the legacy message-count total
  }
  const localTotal = folder?.totalCount || 0;
  const serverTotal = folder?.serverMessageCount || 0;
  return { total: Math.max(localTotal, serverTotal), threadMode: false };
};

/** The "of N" denominator for an AI-category view — the TOTAL mails (read+unread)
 *  in the category, from the SAME query the chip uses but in `'total'` mode, so it
 *  equals the number of rows getEmailsByDynamicCategory pages over. (The CHIP badge
 *  uses the default `'unread'` mode — a DIFFERENT number, by design: chip = unread,
 *  pager = total.) Shared by loadAICategoryEmails and the goToEmailPage AI branch.
 *  Returns 0 on any failure. */
export const fetchAICategoryTotal = async (params: {
  category: string;
  selectedFolderId: string | null;
  selectedVirtualFolder: string | null;
  unifiedAccountIds: string[];
}): Promise<number> => {
  const { category, selectedFolderId, selectedVirtualFolder, unifiedAccountIds } = params;
  try {
    let counts: Record<string, number> | undefined;
    if (selectedVirtualFolder === 'virtual-unified') {
      const r = await window.electronAPI.accounts.unifiedCategoryCounts(unifiedAccountIds, 'total');
      if (r?.success && r.data) counts = r.data as Record<string, number>;
    } else {
      const r = await window.electronAPI.ai.getCategoryCounts(selectedFolderId ?? undefined, 'total');
      if (r?.success && r.data) counts = r.data as Record<string, number>;
    }
    return counts?.[category] ?? 0;
  } catch {
    return 0;
  }
};

/** How received-mail remote images load: 'block' (banner), 'safe' (auto-load
 *  everywhere EXCEPT Promotional/Spam), or 'always'. New installs default to
 *  'safe'. Legacy 'important' migrates to 'safe'; a legacy boolean
 *  (autoLoadRemoteImages) maps to always/block so existing users keep their
 *  choice. Kept in sync with the migration in components/settings/Settings.tsx. */
export const getRemoteImageMode = (): 'block' | 'safe' | 'always' => {
  try {
    const stored = localStorage.getItem('sarvinbox-settings');
    if (stored) {
      const s = JSON.parse(stored);
      // Legacy 'important' → 'safe' (broader: auto-load unless Promo/Spam).
      if (s.remoteImageMode === 'important') return 'safe';
      if (s.remoteImageMode === 'block' || s.remoteImageMode === 'safe' || s.remoteImageMode === 'always') {
        return s.remoteImageMode;
      }
      if (typeof s.autoLoadRemoteImages === 'boolean') {
        return s.autoLoadRemoteImages ? 'always' : 'block';
      }
    }
  } catch {
    // Ignore errors
  }
  return 'safe';
};

/**
 * Whether a mail is Promotional or Spam. Both live in the pipe-delimited `tags`
 * string (AI category `|promotions|`, and the server's Spam/Junk folder as
 * `|Junk|` / `|Spam|` / `|[Gmail]/Spam|`), so this is a synchronous check.
 */
export const isPromoOrSpam = (tags?: string | null): boolean => {
  const t = tags || '';
  return t.includes('|promotions|')
    || t.includes('|Junk|')
    || t.includes('|Spam|')
    || t.includes('|[Gmail]/Spam|');
};

/**
 * Whether a mail is eligible for remote-image auto-load under the 'safe' mode:
 * the AI has assigned it a REAL category AND that category isn't Promotional or
 * Spam. Uncategorized mail (AI hasn't classified it yet, or "everything else")
 * stays behind the banner — we only trust mail the AI positively recognised.
 *
 * Category slugs are written into the pipe-delimited `tags` string by the
 * pipeline; the enabled-slug set comes from the badge-definition cache. Both are
 * synchronous, and `tags` refreshes when categorization completes (the view
 * reloads), so a freshly-categorised mail flips to auto-load on that refresh.
 */
export const qualifiesForSafeAutoLoad = (tags?: string | null): boolean => {
  const t = tags || '';
  if (isPromoOrSpam(t)) return false;
  const slugs = getCachedCategorySlugs();
  // Slugs not loaded yet (cold open before the list rendered): stay
  // conservative (don't auto-load) and warm the cache for next time.
  if (slugs.length === 0) { warmCategoryDefs(); return false; }
  return slugs.some((slug) => t.includes(`|${slug}|`));
};

// ── Per-account "always load images from this sender" allowlist ────────────
// When a user manually loads images on a blocked message, we remember that
// SENDER so future mail from them auto-loads — regardless of the global mode /
// category. Persisted PER ACCOUNT in the DB (image_allowed_senders), like the
// blocked-senders list; the renderer keeps an in-memory Set so the block-vs-load
// decision (inside the sandboxed-iframe render) stays SYNCHRONOUS. The set is
// loaded lazily and cleared on account switch (see clearImageAllowedCache) —
// mirroring the category-slug cache. Only the bare address is keyed, so
// "Name <addr>" and "addr" match.
let imageAllowedCache: Set<string> | null = null;
let imageAllowedWarming = false;

/** Bare, lowercased address from "Name <addr>" or a plain address. */
const normalizeSenderAddress = (address?: string | null): string => {
  const raw = (address || '').trim();
  const m = raw.match(/<([^>]+)>/);
  return (m ? m[1] : raw).trim().toLowerCase();
};

/** Load the active account's allowlist into the in-memory cache (once). */
export const warmImageAllowedSenders = async (): Promise<void> => {
  if (imageAllowedWarming) return;
  imageAllowedWarming = true;
  try {
    const res = await window.electronAPI.emails.getImageAllowedSenders();
    imageAllowedCache = new Set((res?.success && res.data ? res.data : []).map((e) => e.toLowerCase()));
  } catch {
    imageAllowedCache = new Set();
  } finally {
    imageAllowedWarming = false;
  }
};

/** Drop the cache so it re-loads for the next (switched-to) account. */
export const clearImageAllowedCache = (): void => { imageAllowedCache = null; };

/** Has the user chosen to always load images from this sender? Synchronous: on a
 *  cold cache it warms in the background and stays conservative (returns false)
 *  for this render — the re-render after warming picks up the real answer. */
export const isSenderImagesAllowed = (address?: string | null): boolean => {
  const a = normalizeSenderAddress(address);
  if (!a) return false;
  if (imageAllowedCache === null) { void warmImageAllowedSenders(); return false; }
  return imageAllowedCache.has(a);
};

/** Does this message's remote content load without the reader asking?
 *
 *  The ONE place that answers it, because there are two renderers — the classic
 *  card (`SandboxedEmailBody`) and the chat view (`MailChatView`) — and the same
 *  mail must behave the same in both. When this lived inside `SandboxedEmailBody`
 *  the chat view silently kept the library's block-everything default, so a
 *  reader who had chosen "always" still saw the banner on half the app.
 *
 *  Precedence: a sender the reader has allowlisted beats the global mode; then
 *  'always'; then 'safe', which defers to the AI category via `safeAutoLoad`
 *  (the caller computes it with {@link qualifiesForSafeAutoLoad}, since only the
 *  caller has the message's tags). */
export const shouldAutoLoadRemoteImages = (
  senderAddress?: string | null,
  safeAutoLoad = false,
): boolean => {
  if (isSenderImagesAllowed(senderAddress)) return true;
  const mode = getRemoteImageMode();
  return mode === 'always' || (mode === 'safe' && safeAutoLoad);
};

/** Remember this sender so their future mail auto-loads images (write-through:
 *  update the cache immediately, persist to the account DB in the background). */
export const rememberSenderImagesAllowed = (address?: string | null): void => {
  const a = normalizeSenderAddress(address);
  if (!a) return;
  (imageAllowedCache ??= new Set()).add(a);
  void window.electronAPI.emails.allowImagesForSender(a).catch(() => { /* best-effort */ });
};

// Helper to get maxEmailsPerFolder from settings.
// Defaults must match `defaultSettings` in components/settings/types.ts —
// otherwise a fresh install (no localStorage entry yet) syncs at 1/10
// the configured limit until the user opens Settings and clicks Save.
export const getMaxEmailsPerFolder = (): number => {
  try {
    const stored = localStorage.getItem('sarvinbox-settings');
    if (stored) {
      const settings = JSON.parse(stored);
      return settings.maxEmailsPerFolder || 1000;
    }
  } catch {
    // Ignore errors
  }
  return 1000; // matches defaultSettings.maxEmailsPerFolder
};

// Helper to get bodyDownloadLimit from settings
export const getBodyDownloadLimit = (): number => {
  try {
    const stored = localStorage.getItem('sarvinbox-settings');
    if (stored) {
      const settings = JSON.parse(stored);
      return settings.bodyDownloadLimit || 1000;
    }
  } catch {
    // Ignore errors
  }
  return 1000; // matches defaultSettings.bodyDownloadLimit
};

// Helper to get maxAIProcessingEmails from settings
export const getMaxAIProcessingEmails = (): number => {
  try {
    const stored = localStorage.getItem('sarvinbox-settings');
    if (stored) {
      const settings = JSON.parse(stored);
      return settings.maxAIProcessingEmails || 500;
    }
  } catch {
    // Ignore errors
  }
  return 500; // matches defaultSettings.maxAIProcessingEmails
};

// ===== Secret handling (keep passwords/tokens OUT of localStorage) ==========
// IMAP/SMTP passwords and OAuth tokens must never sit in plaintext on disk in
// the renderer. They live in the main-process safeStorage vault
// (window.electronAPI.secureCreds); localStorage keeps only non-secret metadata.
// These helpers strip secrets before any localStorage write and pull them out
// for storing in the vault.
const SECRET_KEYS = ['password', 'accessToken', 'refreshToken'] as const;
type SecretBag = { password?: string; accessToken?: string; refreshToken?: string };

/** A shallow copy of a config with all secret fields removed (safe for disk). */
export const stripSecrets = <T extends Record<string, any> | null | undefined>(config: T): T => {
  if (!config) return config;
  const clean: Record<string, any> = { ...config };
  for (const k of SECRET_KEYS) delete clean[k];
  return clean as T;
};

/** Just the secret fields (or undefined when there are none). */
export const extractSecrets = (config: Record<string, any> | null | undefined): SecretBag | undefined => {
  if (!config) return undefined;
  const out: SecretBag = {};
  for (const k of SECRET_KEYS) if (config[k]) out[k] = config[k];
  return Object.keys(out).length ? out : undefined;
};

/**
 * Fetch an account's secrets from the vault, trying each candidate id in order.
 * A legacy account whose registry id predates host-keying (e.g. `acct-foo`) may
 * have had its secret stored under the host-suffixed derived id (`acct-foo--host`)
 * or vice-versa, so callers pass BOTH and we return the first hit. Returns null
 * if nothing is stored under any candidate.
 */
export const fetchVaultSecrets = async (
  candidateIds: (string | undefined | null)[],
): Promise<{ imap?: SecretBag; smtp?: SecretBag } | null> => {
  const api = (window as any)?.electronAPI?.secureCreds;
  if (!api) return null;
  const seen = new Set<string>();
  for (const id of candidateIds) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    try {
      const res = await api.get(id);
      if (res?.success && res.data && (res.data.imap || res.data.smtp)) return res.data;
    } catch { /* try next candidate */ }
  }
  return null;
};

/**
 * One-time migration: move any IMAP/SMTP secrets into the encrypted main-process
 * vault, then rewrite localStorage WITHOUT them. Reads the IN-MEMORY accounts
 * (passed by the caller) as the source of truth — NOT localStorage — because the
 * module-load account migration (`migrateAccounts`) may already have stripped
 * localStorage via `saveAccounts`, whereas the in-memory registry still carries
 * the secrets. Idempotent — a no-op once everything's migrated.
 */
export const migrateCredentialsToVault = async (accounts: StoredAccount[]): Promise<void> => {
  try {
    const api = (window as any)?.electronAPI?.secureCreds;
    if (!api) return;

    let allStored = true;
    const store = async (id: string, imap?: SecretBag, smtp?: SecretBag): Promise<void> => {
      if (!imap && !smtp) return;
      try {
        const res = await api.set(id, { imap, smtp });
        if (!res?.success) allStored = false;
      } catch { allStored = false; }
    };

    for (const a of accounts) {
      await store(a.id, extractSecrets(a.imapConfig), extractSecrets(a.smtpConfig as any));
    }

    // Legacy single-account keys (pre multi-account, or if they still hold a
    // plaintext secret). Store under the MATCHING account's real registry id
    // when we can find it (its id may predate host-keying), falling back to the
    // derived id — so rehydration (which tries both) always finds it.
    const legacyImap = loadSavedCredentials();
    if (legacyImap?.username) {
      const matchId = findAccountByEmailHost(accounts, legacyImap.username, legacyImap.host)?.id
        ?? accountIdFor(legacyImap.username, legacyImap.host);
      await store(
        matchId,
        extractSecrets(legacyImap),
        extractSecrets(loadSavedSmtpCredentials() as any),
      );
    }

    // Only strip plaintext once every secret is confirmed in the vault — a disk
    // failure must never leave localStorage stripped AND the vault empty. On the
    // rare failure we keep localStorage as-is and retry next launch. saveAccounts
    // / saveCredentials / saveSmtpCredentials all strip on write.
    if (allStored) {
      saveAccounts(accounts);
      if (legacyImap) saveCredentials(legacyImap);
      const legacySmtp = loadSavedSmtpCredentials();
      if (legacySmtp) saveSmtpCredentials(legacySmtp);
    } else {
      console.warn('[Store] Credential vault migration incomplete — leaving plaintext in place for safety');
    }
  } catch (e) {
    console.warn('[Store] Credential vault migration skipped:', e);
  }
};

// Load saved credentials from localStorage
export const loadSavedCredentials = () => {
  try {
    const saved = localStorage.getItem('sarvinbox-credentials');
    if (saved) {
      const credentials = JSON.parse(saved);
      console.log('[Store] Loaded saved credentials:', { host: credentials.host, username: credentials.username });
      return credentials;
    } else {
      console.log('[Store] No saved credentials found');
    }
  } catch (error) {
    console.error('[Store] Failed to load saved credentials:', error);
  }
  return null;
};

// Save credentials to localStorage
export const saveCredentials = (config: any) => {
  try {
    // Strip secrets — the password/tokens live in the encrypted vault, never here.
    localStorage.setItem('sarvinbox-credentials', JSON.stringify(stripSecrets(config)));
    console.log('[Store] Credentials saved:', { host: config.host, username: config.username });
  } catch (error) {
    console.error('[Store] Failed to save credentials:', error);
  }
};

// Clear saved credentials
export const clearCredentials = () => {
  try {
    localStorage.removeItem('sarvinbox-credentials');
    console.log('[Store] Credentials cleared');
  } catch (error) {
    console.error('[Store] Failed to clear credentials:', error);
  }
};

// Load saved SMTP credentials from localStorage
export const loadSavedSmtpCredentials = (): SMTPConfig | null => {
  try {
    const saved = localStorage.getItem('sarvinbox-smtp-credentials');
    if (saved) {
      const credentials = JSON.parse(saved);
      console.log('[Store] Loaded saved SMTP credentials:', { host: credentials.host, username: credentials.username });
      return credentials;
    }
  } catch (error) {
    console.error('[Store] Failed to load saved SMTP credentials:', error);
  }
  return null;
};

// Save SMTP credentials to localStorage
export const saveSmtpCredentials = (config: SMTPConfig) => {
  try {
    // Strip secrets — the SMTP password/tokens live in the encrypted vault.
    localStorage.setItem('sarvinbox-smtp-credentials', JSON.stringify(stripSecrets(config)));
    console.log('[Store] SMTP credentials saved:', { host: config.host, username: config.username });
  } catch (error) {
    console.error('[Store] Failed to save SMTP credentials:', error);
  }
};

// Clear saved SMTP credentials from localStorage (e.g. on account removal, so a
// stale sending config can't be picked up by a later account).
export const clearSmtpCredentials = () => {
  try {
    localStorage.removeItem('sarvinbox-smtp-credentials');
    console.log('[Store] SMTP credentials cleared');
  } catch (error) {
    console.error('[Store] Failed to clear SMTP credentials:', error);
  }
};

/**
 * Best-effort SMTP defaults derived from the IMAP config — used to PREFILL the
 * SMTP setup form (the user reviews/edits + verifies before it's used). Known
 * providers map to their SMTP host; otherwise `imap.` → `smtp.`. Defaults to
 * implicit-TLS 465 (a sane secure default; the user can switch to 587/STARTTLS).
 * NOTE: the password is deliberately NOT carried over — an SMTP password can
 * differ from the IMAP one, so it must be entered explicitly.
 */
export const deriveSmtpFromImap = (imap: {
  host: string; username: string;
  authMethod?: 'password' | 'oauth2'; oauthProvider?: 'gmail' | 'microsoft' | 'yahoo';
}): SMTPConfig => {
  const h = imap.host || '';
  let host = h;
  if (h.includes('gmail.com') || h.includes('googlemail.com')) host = 'smtp.gmail.com';
  else if (h.includes('outlook.com') || h.includes('office365.com')) host = 'smtp.office365.com';
  else if (h.includes('yahoo.com')) host = 'smtp.mail.yahoo.com';
  else if (h.includes('icloud.com') || h.includes('me.com')) host = 'smtp.mail.me.com';
  else host = h.replace(/^imap\./i, 'smtp.');
  return {
    host,
    port: 465,
    secure: true,
    username: imap.username,
    password: '',
    from: imap.username,
    authMethod: imap.authMethod,
    oauthProvider: imap.oauthProvider,
  };
};

/**
 * The SMTP config to actually USE (and display) for an account.
 *
 * OAuth accounts ALWAYS send via their provider's SMTP with OAuth, DERIVED from
 * IMAP — never a stored password config. This is the single source of the fix
 * for the "Gmail account shows smtp.sarv.com" cross-contamination: two accounts
 * that share an email address (e.g. the same address via Sarv IMAP and via Gmail
 * IMAP) could get each other's stored SMTP written onto them. An OAuth account's
 * SMTP is fully determined by its IMAP provider + the OAuth token (injected in
 * the main process), so deriving it is both correct and immune to the crossing.
 *
 * Password accounts keep using their stored, verified SMTP config.
 */
export const effectiveSmtpConfig = (account: StoredAccount | null | undefined): SMTPConfig | null => {
  const imap = account?.imapConfig as { host?: string; username?: string; authMethod?: 'password' | 'oauth2'; oauthProvider?: 'gmail' | 'microsoft' | 'yahoo' } | undefined;
  if (!imap?.host || !imap.username) return null;
  if (imap.authMethod === 'oauth2') {
    return deriveSmtpFromImap({ host: imap.host, username: imap.username, authMethod: 'oauth2', oauthProvider: imap.oauthProvider });
  }
  return account?.smtpConfigured ? (account.smtpConfig ?? null) : null;
};

const SMTP_CONFIGURED_KEY = 'sarvinbox-smtp-configured';

/** Whether the user has explicitly verified SMTP (sending) for this account. */
export const loadSmtpConfigured = (): boolean => {
  try { return localStorage.getItem(SMTP_CONFIGURED_KEY) === 'true'; } catch { return false; }
};

export const saveSmtpConfigured = (value: boolean) => {
  try {
    if (value) localStorage.setItem(SMTP_CONFIGURED_KEY, 'true');
    else localStorage.removeItem(SMTP_CONFIGURED_KEY);
  } catch { /* ignore */ }
};

// ===== Multi-account registry (Stage 1) =====================================
// A list of configured accounts, plus which one is active. Migrated from the
// legacy single-account keys (sarvinbox-credentials / -smtp-credentials) so
// existing users become "Account 1" with no data loss.

const ACCOUNTS_KEY = 'sarvinbox-accounts';
const ACTIVE_ACCOUNT_KEY = 'sarvinbox-active-account';

export const loadAccounts = (): StoredAccount[] => {
  try {
    const raw = localStorage.getItem(ACCOUNTS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
};

export const saveAccounts = (accounts: StoredAccount[]) => {
  try {
    // Persist only non-secret metadata — each account's IMAP/SMTP secrets are
    // kept in the encrypted vault (keyed by account id), never in localStorage.
    const safe = accounts.map((a) => ({
      ...a,
      imapConfig: stripSecrets(a.imapConfig),
      smtpConfig: stripSecrets(a.smtpConfig as any),
    }));
    localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(safe));
    // Mirror the (stripped) snapshot into the durable DB registry — the source
    // of truth that survives a localStorage wipe. Fire-and-forget: the DB does
    // an UPSERT-only merge (never wipes on an empty/partial snapshot), so this
    // can only ever ADD durability. Phase 1 keeps localStorage as the fallback.
    try { (window as any)?.electronAPI?.accounts?.save?.(safe); } catch { /* ignore */ }
  } catch { /* ignore */ }
};

/**
 * Persist the registry WITHOUT stripping secrets. Used ONLY by the module-load
 * `migrateAccounts` normalize/backfill, which runs before the vault migration —
 * stripping there would drop the secrets from disk before they're safely in the
 * vault. Every other write goes through `saveAccounts` (which strips).
 */
const saveAccountsRaw = (accounts: StoredAccount[]) => {
  try { localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(accounts)); } catch { /* ignore */ }
};

const QUOTA_CACHE_KEY = 'sarvinbox-quota-cache';

/**
 * Mailbox storage usage, per account id. A `null` value is a real answer —
 * "asked, this server advertises no quota" — which is what stops the bar from
 * flashing a placeholder at every refresh on such an account. A MISSING key
 * means "never asked".
 */
export type QuotaCache = Record<string, { used: number; limit: number } | null>;

/**
 * Last-known quota per account. Persisted so a switch (or a cold start) can
 * paint the storage bar from the previous answer instead of an empty gap,
 * while the live QUOTA lookup runs behind it. Informational and self-correcting
 * — a stale entry is replaced by the fresh reply moments later.
 */
export const loadQuotaCache = (): QuotaCache => {
  try {
    const raw = localStorage.getItem(QUOTA_CACHE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== 'object') return {};
    // Keep only a numeric pair or an explicit null — a corrupt entry would
    // render as "NaN of NaN" rather than simply not rendering.
    return Object.fromEntries(
      Object.entries(parsed as QuotaCache).filter(
        ([, v]) => v === null || (Number.isFinite(v?.used) && Number.isFinite(v?.limit)),
      ),
    );
  } catch {
    return {};
  }
};

export const saveQuotaCache = (cache: QuotaCache): void => {
  try { localStorage.setItem(QUOTA_CACHE_KEY, JSON.stringify(cache)); } catch { /* ignore */ }
};

export const loadActiveAccountId = (): string | null => {
  try { return localStorage.getItem(ACTIVE_ACCOUNT_KEY); } catch { return null; }
};

export const saveActiveAccountId = (id: string | null) => {
  try {
    if (id) localStorage.setItem(ACTIVE_ACCOUNT_KEY, id);
    else localStorage.removeItem(ACTIVE_ACCOUNT_KEY);
    // Mirror the active pointer into the durable registry (lightweight — no
    // runtime side effects, unlike accounts.setActive). Fire-and-forget.
    try { (window as any)?.electronAPI?.accounts?.setActivePointer?.(id); } catch { /* ignore */ }
  } catch { /* ignore */ }
};

// MUST stay byte-identical to accountIdFor + normAccountIdPart in
// @sarvinbox/core (packages/core/src/utils/id.ts) — that is the canonical copy
// used by the Electron main process. The renderer keeps this MIRROR because it
// cannot import core's runtime barrel (it transitively pulls mailparser →
// node 'stream', which the renderer bundle can't load). Any change here must be
// mirrored there, or account ids drift and vault-key lookups break.
const normIdPart = (s: string): string =>
  (s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

export const accountIdFor = (email: string, host?: string): string => {
  const base = normIdPart(email || 'default');
  const h = normIdPart(host || '');
  return h ? `acct-${base}--${h}` : `acct-${base}`;
};

/**
 * Human label for an account, disambiguated by IMAP host when the same address
 * is connected via more than one provider (so the color-dot tooltip in the list
 * and the opened mail tells the two apart). Plain email otherwise.
 */
// ===== Account display (single source of truth) ============================
// All account-identity rendering (switcher, settings, From bar, list/detail
// dots, signatures) goes through these so behavior is consistent everywhere and
// future account-specific settings can reuse them without divergence.

/** The account's IMAP host (used to disambiguate same-address accounts). */
export const accountHost = (account?: StoredAccount | null): string =>
  (account?.imapConfig?.host as string) || '';

/** True when the given email is connected via more than one provider — i.e. the
 *  host is needed to tell the accounts apart. */
export const isAccountEmailDuplicated = (accounts: StoredAccount[], email?: string): boolean =>
  accounts.filter((a) => (a.email || '').toLowerCase() === (email || '').toLowerCase()).length > 1;

/** Human label for an account, disambiguated by IMAP host when the same address
 *  is connected via more than one provider ("email (host)"), else plain email. */
export const accountDisplayLabel = (accounts: StoredAccount[], accountId?: string): string => {
  const a = accounts.find((x) => x.id === accountId);
  if (!a) return '';
  const email = a.email || '';
  const host = accountHost(a);
  return isAccountEmailDuplicated(accounts, email) && host ? `${email} (${host})` : email;
};

/**
 * Find an existing account by email + IMAP host (case-insensitive), so a
 * reconnect reuses the stored account (its id + DB) — while the same address on
 * another host is treated as a new, separate account. Existing single-host
 * accounts (whose id predates host-keying) are matched here and keep their id.
 */
export const findAccountByEmailHost = (
  accounts: StoredAccount[],
  email: string,
  host?: string,
): StoredAccount | undefined =>
  accounts.find(
    (a) =>
      (a.email || '').toLowerCase() === (email || '').toLowerCase() &&
      ((a.imapConfig?.host as string) || '').toLowerCase() === (host || '').toLowerCase(),
  );

/**
 * Return the accounts registry, migrating the legacy single account into it on
 * first run. Persists the migrated list so subsequent loads are stable.
 */
export const migrateAccounts = (): { accounts: StoredAccount[]; activeAccountId: string | null } => {
  const existing = loadAccounts();
  if (existing.length > 0) {
    const active = loadActiveAccountId();
    // Backfill color + preference flags for accounts stored before these fields
    // existed, preserving each account's already-assigned color.
    const normalized = existing.reduce<StoredAccount[]>(
      (acc, a) => [...acc, normalizeAccount(a, acc)],
      [],
    );
    // Raw (non-stripping) write: this runs at module load, BEFORE the vault
    // migration, so secrets must stay on disk until they're safely vaulted.
    saveAccountsRaw(normalized);
    return {
      accounts: normalized,
      activeAccountId: normalized.some((a) => a.id === active) ? active : normalized[0].id,
    };
  }
  const imap = loadSavedCredentials();
  if (!imap?.username) return { accounts: [], activeAccountId: null };
  const account: StoredAccount = normalizeAccount({
    id: accountIdFor(imap.username, imap.host),
    email: imap.username,
    imapConfig: imap,
    smtpConfig: loadSavedSmtpCredentials(),
    smtpConfigured: loadSmtpConfigured(),
  });
  saveAccountsRaw([account]);
  saveActiveAccountId(account.id);
  return { accounts: [account], activeAccountId: account.id };
};

/**
 * One-time account-id canonicalization. Older builds minted host-less ids
 * (`acct-<email>`); the current scheme is `acct-<email>--<host>`. This rewrites
 * every legacy account in the registry to its canonical id and, for each, asks
 * the main process to move its id-keyed state (DB file, credential vault,
 * primary pointer, in-memory runtime) via `accounts:rekey`. Idempotent — once
 * ids are canonical it's a no-op — and safe to run on every startup. The
 * read-time multi-id vault fallback remains as a safety net until this is
 * proven, so a failed rekey never locks anyone out.
 *
 * MUST run before the app activates/connects an account so main re-keys the
 * stores before they're opened under the new id. Returns the canonicalized
 * registry (or null if nothing changed) so the caller can also update the
 * in-memory store — the CURRENT session must use the new ids too, else
 * `ensureAccountRuntime(oldId)` would open a fresh empty DB at the old hash.
 */
export const canonicalizeAccountIds = async (): Promise<{ accounts: StoredAccount[]; activeAccountId: string | null } | null> => {
  const accounts = loadAccounts();
  if (accounts.length === 0) return null;
  let active = loadActiveAccountId();
  let changed = false;
  const next: StoredAccount[] = [];
  for (const a of accounts) {
    const username = (a.imapConfig?.username as string) || a.email || '';
    const host = (a.imapConfig?.host as string) || '';
    // Can only canonicalize when we know the host (email+host is the target).
    const canonical = host ? accountIdFor(username, host) : a.id;
    if (canonical && canonical !== a.id) {
      try {
        const res = await window.electronAPI.accounts.rekey?.(a.id, canonical);
        if (res && res.success === false) throw new Error(res.error || 'rekey failed');
        if (active === a.id) active = canonical;
        next.push({ ...a, id: canonical });
        changed = true;
        console.log('[AccountMigration] canonicalized', a.id, '->', canonical);
      } catch (e) {
        // Keep the legacy id as-is; the read-time fallback still resolves it,
        // and the next startup retries the rekey.
        console.warn('[AccountMigration] rekey failed for', a.id, (e as Error)?.message);
        next.push(a);
      }
    } else {
      next.push(a);
    }
  }
  if (!changed) return null;
  saveAccounts(next);
  saveActiveAccountId(active);
  return { accounts: next, activeAccountId: active };
};

/** Insert or replace an account in the registry (by id) and persist. */
export const upsertAccount = (accounts: StoredAccount[], account: StoredAccount): StoredAccount[] => {
  const idx = accounts.findIndex((a) => a.id === account.id);
  if (idx >= 0) {
    // Preserve the existing color + preference flags across a reconnect/update,
    // only overriding with any explicitly-provided values on the incoming record.
    const merged = normalizeAccount({ ...accounts[idx], ...account }, accounts);
    const next = accounts.map((a) => (a.id === account.id ? merged : a));
    saveAccounts(next);
    return next;
  }
  const next = [...accounts, normalizeAccount(account, accounts)];
  saveAccounts(next);
  return next;
};

/** Remove an account from the registry and persist. */
export const removeAccount = (accounts: StoredAccount[], id: string): StoredAccount[] => {
  const next = accounts.filter((a) => a.id !== id);
  saveAccounts(next);
  return next;
};

/**
 * Curated, theme-safe account colors (readable on light + dark) — 15 hand-picked
 * hues covering the realistic account range. Beyond these, colors are GENERATED
 * (see accountColorForIndex) so any number of accounts still gets a distinct dot.
 */
export const ACCOUNT_COLORS = [
  '#2563eb', // blue
  '#16a34a', // green
  '#db2777', // pink
  '#d97706', // amber
  '#7c3aed', // violet
  '#0891b2', // cyan
  '#dc2626', // red
  '#4f46e5', // indigo
  '#ca8a04', // yellow
  '#0d9488', // teal
  '#ea580c', // orange
  '#0ea5e9', // sky
  '#c026d3', // fuchsia
  '#65a30d', // lime
  '#78716c', // stone
];

/** HSL (h 0-360, s/l 0-100) -> #rrggbb. Pure, no deps. */
const hslToHex = (h: number, s: number, l: number): string => {
  const sn = s / 100;
  const ln = l / 100;
  const a = sn * Math.min(ln, 1 - ln);
  const f = (n: number): string => {
    const k = (n + h / 30) % 12;
    const c = ln - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(255 * c).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
};

// Even hue spacing for generated colors: the golden angle spreads successive
// hues around the wheel so adjacent indices never look alike.
const GOLDEN_ANGLE = 137.508;

/**
 * Deterministic, distinct color for the account at 0-based index `i`. The first
 * ACCOUNT_COLORS.length indices use the curated palette; beyond that, colors are
 * generated by walking the hue wheel — so ANY number of accounts (10, 20, 100…)
 * each get a unique-looking dot with no wrap/repeat.
 */
export const accountColorForIndex = (i: number): string => {
  if (i < ACCOUNT_COLORS.length) return ACCOUNT_COLORS[i];
  const hue = ((i - ACCOUNT_COLORS.length) * GOLDEN_ANGLE) % 360;
  return hslToHex(hue, 68, 45);
};

/** Pick the lowest-index color not already used by an existing account, so a
 *  removed account's color is reused before generating new ones. Scales to any
 *  number of accounts (no wrap/repeat). */
export const pickAccountColor = (accounts: StoredAccount[]): string => {
  const used = new Set(accounts.map((a) => a.color).filter(Boolean));
  for (let i = 0; i < accounts.length + 1; i++) {
    const c = accountColorForIndex(i);
    if (!used.has(c)) return c;
  }
  return accountColorForIndex(accounts.length);
};

/**
 * Ensure an account has a color and the per-account preference flags. Undefined
 * flags default to enabled so legacy (pre-multi-account) accounts behave like
 * they always did. `others` is the rest of the registry, used to avoid color
 * collisions when assigning.
 *
 * Also SELF-HEALS the SMTP config: an OAuth account's sending config is fully
 * determined by its provider, so we overwrite any stale/crossed stored SMTP
 * (e.g. a `smtp.sarv.com` password config that leaked onto a Gmail account that
 * shares an email address) with the correct derived one. Since normalizeAccount
 * runs on load + every upsert, the wrong value is rewritten in localStorage, not
 * just ignored at runtime.
 */
export const normalizeAccount = (account: StoredAccount, others: StoredAccount[] = []): StoredAccount => {
  const normalized: StoredAccount = {
    ...account,
    color: account.color ?? pickAccountColor(others),
    includeInUnified: account.includeInUnified ?? true,
    backgroundSync: account.backgroundSync ?? true,
    notify: account.notify ?? true,
    identities: normalizeIdentities(account.email, account.identities),
  };
  if ((normalized.imapConfig as { authMethod?: string })?.authMethod === 'oauth2') {
    const derived = effectiveSmtpConfig(normalized);
    if (derived) {
      normalized.smtpConfig = derived;
      normalized.smtpConfigured = true;
    }
  } else if ((normalized.smtpConfig as { authMethod?: string } | null)?.authMethod === 'oauth2') {
    // The account is no longer oauth2 (e.g. repaired back to app-password auth)
    // but still carries the SMTP config DERIVED for it above — token-based, with
    // no password and no vault secret behind it. `smtpConfigured: true` then
    // makes SmtpConnector attempt a doomed connect on every IMAP connect. Drop
    // it so sending shows as un-set-up, which is the truth.
    normalized.smtpConfig = null;
    normalized.smtpConfigured = false;
  }
  return normalized;
};

// Load saved view mode from localStorage
export const loadSavedViewMode = (): ViewMode => {
  try {
    const saved = localStorage.getItem('sarvinbox-view-mode');
    if (saved && ['no-split', 'vertical', 'horizontal'].includes(saved)) {
      return saved as ViewMode;
    }
  } catch (error) {
    console.error('[Store] Failed to load saved view mode:', error);
  }
  return 'no-split'; // Default view mode
};

// Save view mode to localStorage
export const saveViewMode = (mode: ViewMode) => {
  try {
    localStorage.setItem('sarvinbox-view-mode', mode);
  } catch (error) {
    console.error('[Store] Failed to save view mode:', error);
  }
};

// Load inbox settings from localStorage
export const loadInboxSettings = (): { inboxType: InboxType; showImportanceMarkers: boolean; inboxSections: InboxSection[] } => {
  const defaults = { inboxType: 'priority_first' as InboxType, showImportanceMarkers: true, inboxSections: DEFAULT_SECTIONS['priority_first'] || [] };
  try {
    const stored = localStorage.getItem(SETTINGS_KEY);
    if (stored) {
      const settings = JSON.parse(stored);
      const inboxType: InboxType = settings.inboxType || defaults.inboxType;
      const showImportanceMarkers = typeof settings.showImportanceMarkers === 'boolean' ? settings.showImportanceMarkers : defaults.showImportanceMarkers;
      let inboxSections: InboxSection[];
      if (settings.inboxSections && settings.inboxSections.length > 0) {
        inboxSections = settings.inboxSections;
      } else if (inboxType !== 'default') {
        inboxSections = DEFAULT_SECTIONS[inboxType] || [];
      } else {
        inboxSections = [];
      }
      return { inboxType, showImportanceMarkers, inboxSections };
    }
  } catch (e) {
    console.error('[Store] Failed to load inbox settings:', e);
  }
  return defaults;
};

// Set up AI categorization IPC event listeners (called once at module load)
export function setupAICategorizationListeners(useEmailStore: { setState: (state: any) => void; getState: () => any }): void {
  if (typeof window === 'undefined' || !window.electronAPI?.aiCategorization) return;

  window.electronAPI.aiCategorization.onProgress((progress) => {
    // Clear badge cache so newly categorized emails show their tags
    clearCategoryBadgeCache();
    useEmailStore.setState({
      aiProcessingProgress: progress,
      aiCategoryCountsLastUpdate: Date.now(),
    });
  });

  window.electronAPI.aiCategorization.onComplete((data) => {
    // Clear category badge cache so badges refresh with new data
    clearCategoryBadgeCache();
    useEmailStore.setState({
      aiProcessing: false,
      aiProcessingProgress: null,
      aiCategoryCountsLastUpdate: Date.now(),
    });
    // A run that categorized emails without a terminal failure proves the
    // provider works again — clear any stale "AI inactive" banner.
    if (data?.ok) reportAIHealthy();
    // Reload the current view so new category tags appear without manual refresh
    useEmailStore.getState()._reloadCurrentView?.();
  });

  window.electronAPI.aiCategorization.onError((error) => {
    useEmailStore.setState({
      aiProcessing: false,
      aiProcessingProgress: null,
    });
    // Terminal failure (bad key / no credits / 4xx): surface the "AI inactive"
    // banner with its Fix button so the user knows to act. Transient failures
    // aren't raised here — the main process auto-restarts those on its own.
    if (error?.terminal) {
      reportAIUnhealthy(error.reason || error.message || 'AI is unavailable.', error.status);
    }
    console.error('[Store] AI categorization error from main process:', error?.message || error);
  });

  // Live per-email categorization from the unified (background) pipeline — for
  // ANY account. Without this, the pipeline writes category tags to the DB but
  // the UI never hears about it, so badges/counts only appear after a manual
  // refresh or a tab switch (exactly the "I don't see the tag" symptom).
  let liveCountTimer: ReturnType<typeof setTimeout> | null = null;
  window.electronAPI.agent?.onEmailProcessed?.((data) => {
    if (!data?.emailId) return;
    // 1. Update the specific row's badge in place (no remount/refetch).
    applyEmailCategories(data.emailId, data.categories || []);
    // 2. Debounced: bump category counts, and if a category tab is the active
    //    view, rebuild it so newly-matching mail appears / non-matching drops —
    //    coalesced so a burst of background categorizations refreshes once.
    if (liveCountTimer) clearTimeout(liveCountTimer);
    liveCountTimer = setTimeout(() => {
      liveCountTimer = null;
      const state = useEmailStore.getState();
      useEmailStore.setState({ aiCategoryCountsLastUpdate: Date.now() });
      // Only when a category tab is the active view do we rebuild the list (so
      // newly-matching mail appears / non-matching drops). _reloadCurrentView
      // clears the badge cache itself, so no separate clear is needed.
      if (state.viewingAICategory) state._reloadCurrentView?.();
    }, 600);
  });

  // Background pipeline AI availability. The main pipeline is the source of
  // truth for whether background AI (categorization, chat extraction, contact
  // enrichment) is actually running — the renderer having a provider in Settings
  // does NOT mean the pipeline received it (a main-process restart wipes its
  // in-memory config, and the already-mounted renderer never re-pushes). This
  // closes that silent-failure gap: either self-heal, or tell the user.
  window.electronAPI.agent?.onPipelineAIStatus?.((data) => {
    if (data?.available) {
      // Pipeline has AI again — clear any "AI paused" banner.
      reportAIHealthy();
      return;
    }
    // Pipeline reports NO AI. If a provider IS configured here, the config just
    // didn't reach (or was lost by) the pipeline — re-push it (self-heal). The
    // push sets the pipeline's config, which emits `available:true` back to us
    // and clears the banner, so we don't flash it in this common case.
    if (getDefaultProvider()) {
      void syncAIProviderToMain();
      return;
    }
    // Genuinely no provider configured — nothing to re-push. Surface the
    // actionable "AI inactive" banner so the user knows AI is off and can set
    // one up via its Fix button, instead of AI silently doing nothing.
    reportAIUnhealthy(data?.reason || 'No AI provider connected — AI features are paused.');
  });

  // F3: a background AI-drafted reply landed in the Drafts folder. Refresh the
  // sidebar Drafts count, and if the Drafts folder is the active view, its list.
  window.electronAPI.agent?.onDraftReady?.(() => {
    const s = useEmailStore.getState();
    s.loadFolders?.();
    const cur = (s.folders || []).find((f: any) => f.id === s.selectedFolderId);
    const p = (cur?.path || '').toLowerCase();
    if (cur && (cur.specialUse === '\\Drafts' || p.includes('draft'))) {
      s._reloadCurrentView?.();
    }
  });

  // Main removed the thread's draft(s) after a reply was sent (the AI auto-draft
  // or a manual one) — drop them from every open view so the stale draft doesn't
  // linger in the Drafts list / thread until a refresh.
  window.electronAPI.drafts?.onRemoved?.(({ threadId, messageIds }) => {
    const s = useEmailStore.getState();
    const ids = new Set(messageIds || []);
    const isDraftRow = (e: any) => {
      const t = e?.tags || '';
      return t.includes('|draft|') || t.includes('|Drafts|') || t.includes('|[Gmail]/Drafts|');
    };
    const rowIds = new Set<string>();
    for (const e of [...s.emails, ...s.threadEmails, ...s.searchResults] as any[]) {
      if (e?.messageId && ids.has(e.messageId)) rowIds.add(e.id);
      else if (threadId && e?.threadId === threadId && isDraftRow(e)) rowIds.add(e.id);
    }
    rowIds.forEach((id) => s.removeDraftFromViews?.(id));
    s.loadFolders?.();
  });

  // Mirror main-process categorization logs into the renderer console.
  // The categorization service runs in main, so its console.log doesn't
  // surface in devtools — without this, the user sees an empty console
  // and can't tell if AI calls are succeeding, failing, or returning
  // unparseable JSON. Each line is prefixed [main:cat] so they're
  // easy to spot among the renderer-side logs.
  window.electronAPI.aiCategorization.onLog?.(({ level, message }) => {
    const prefix = '[main:cat]';
    if (level === 'error') console.error(prefix, message);
    else if (level === 'warn') console.warn(prefix, message);
    else console.log(prefix, message);
  });
}
