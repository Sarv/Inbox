/**
 * Unified Pipeline Service — The SINGLE service for email intelligence.
 *
 * Flow per email:
 *   1. Trigger: email:synced event (instant) OR 30s polling (fallback)
 *   2. Pipeline 1: Conversation extraction (for thread context)
 *   3. Pipeline 2: ONE LLM call → categories + priority + urgency + sender memory + action
 *   4. Save results + execute/propose action
 *
 * Tracks status per email: extraction_status, agent_status in DB.
 * Pipeline 2 ONLY runs after Pipeline 1 completes.
 */

import {
  BehaviorIntelligence,
  LogAggregator,
  MAX_API_RETRIES,
  SARV_LABEL_PARENT,
  UnifiedPipeline,
  callAIWithRetry,
  classifyCategorizationPass,
  cleanEmailHtmlForLLM,
  decideCategorizationAction,
  encodeAiCategories,
  folderPathForCategory,
  getEventBus,
  labelDrainDecision,
  mirrorableCategories,
  parseTags,
  createLogger,
  type AIProviderConfig,
  type ContactType,
  type FolderLabelMode,
  type OAuthProviderId,
  type UnifiedPipelineConfig,
  type UserActionType,
} from '@sarvinbox/core';
import { cleanBodyExpression, rawBodyExpression } from '@sarvinbox/storage-node';
import { ipcMain } from 'electron';
import pLimit from 'p-limit';
// One import for the whole barrel. It used to be five separate statements from
// the same module, which `eslint --fix` cannot merge safely — it folds the
// `import type { ... }` line into a value import and emits a stray comma,
// leaving the file syntactically invalid. Merged by hand so the fixer has
// nothing left to do here.

import { logUserAction } from '../ipc/agent-handlers';
import { saveDraftToIMAP } from '../ipc/draft-handlers';
import { sendEmailFromMain, appendSentCopy } from '../ipc/smtp-handlers';
import { getStorage, getStorageFor, getAllAccountRuntimes, getAccountRuntime, getSyncEngine, getSyncEngineForStorage, getAccountIdForStorage, getMainWindow, getSmtpClient } from '../shared';

import { resolveAccountEmail, resolveAccountIdentity } from './accounts-registry';
import { loadAgentConfig } from './agent-config-store';
import { getAutoBacklogCap } from './ai-backlog-cap';
import { decideAIErrorPolicy } from './ai-error-policy';
import { isAIProviderConfigured } from './conversation-extraction-scheduler';
import { getMeta, setMeta } from './core-db';
import { ensureGmailLabelColor, renameGmailLabel, deleteGmailLabelsUnder } from './gmail-label-api';
import { chromiumFetch } from './net-fetch';
import { notifyNewMail } from './notification-service';
import { attachOAuthBearer, getValidAccessToken } from './oauth-service';
import { getAccount as getOAuthAccount, listAccounts } from './oauth-token-store';
import { savePipelineAIConfig, loadPipelineAIConfigSync, clearPipelineAIConfig } from './pipeline-ai-config-store';
import { resolveDeferredPipelineConfig } from './pipeline-init-config';
import { SiblingCategoryCache } from './sibling-category-cache';

// Live AI-pipeline diagnostics (why categorization is / isn't running). Stored in
// the core DB's registry_meta as a JSON snapshot instead of a plaintext file, so
// the app can read/update it from the (decrypted) DB and surface it in the UI.
const PIPELINE_STATE_META_KEY = 'pipeline_ai_state';

/** The last AI-pipeline diagnostics snapshot (or null if none yet). */
export function getPipelineAiState(): Record<string, any> | null {
  const raw = getMeta(PIPELINE_STATE_META_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function setPipelineAiState(state: Record<string, any>): void {
  setMeta(PIPELINE_STATE_META_KEY, JSON.stringify(state));
}
const logger = createLogger('unified-pipeline-service');

// Per-email pipeline tracing (mirror / P1-start / token-resolve) fires ONCE PER
// EMAIL — thousands of synchronous main-thread log writes on a large sync/backfill,
// which stalls the event loop (rainbow-loader hang). These are per-item detail, so
// they belong at TRACE (off even at the default 'debug' level). The isLevelEnabled
// guard also skips building the message string when trace is off. See the shared
// logger's level model in packages/core/src/utils/logger.ts (SARV_LOG_LEVEL=trace).
const traceEnabled = (): boolean => logger.isLevelEnabled('trace');

/**
 * Route core's LLM calls through Chromium's network stack (see net-fetch.ts) so
 * an internal gateway with an incomplete cert chain resolves in the main process
 * just like it does in the renderer. Applied wherever the pipeline's aiConfig is
 * (re)assigned. Idempotent — safe to call on an already-wrapped config.
 */
function withChromiumFetch(config: AIProviderConfig | null): AIProviderConfig | null {
  return config ? { ...config, fetchImpl: chromiumFetch } : null;
}

// ========== Helpers ==========

/**
 * True when the user's address appears in the email's TO field. CC / BCC /
 * bystander positions return false.
 */
function isUserInToField(
  email: { toAddress?: string | null },
  userEmail: string,
): boolean {
  if (!userEmail) return false;
  const me = userEmail.toLowerCase().trim();
  const to = (email.toAddress || '').toLowerCase();
  if (!to) return false;
  const matches = to.match(/[\w.+-]+@[\w.-]+/g) || [];
  return matches.some((a) => a === me);
}

/**
 * Regex-escape a string for safe embedding in a RegExp source.
 */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * True when the email body explicitly addresses the user — greeting-form
 * with their name, an @-mention, or the user's full email appearing as a
 * token. Guards against `'Dev'` matching inside unrelated words
 * ("Devansh", "Devendra", "DevOps") by requiring a word boundary on both sides.
 *
 * Known false-positive: this scans the entire body including quoted
 * content, so forwarded threads where an earlier message addressed the
 * user will still match. Quote-stripping reliably is hard; for now we
 * accept this and let the LLM + relationship gates filter the rest.
 */
function isUserMentionedInBody(
  email: { cleanBody?: string | null; rawBody?: string | null },
  userEmail: string,
  userName: string,
): boolean {
  const body = (email.cleanBody || email.rawBody || '').toLowerCase();
  if (!body) return false;

  // 1. Full email address mention (e.g. "@you@sarv.com" or just "you@sarv.com")
  if (userEmail) {
    const me = userEmail.toLowerCase().trim();
    if (me && body.includes(me)) return true;
  }

  // 2. Greeting + @-mention forms using the user's name. Require the name
  // to be at least 2 chars so we don't match every "a", "i", "q".
  const candidateNames = new Set<string>();
  if (userName) {
    userName
      .split(/[\s,]+/)
      .map((p) => p.trim())
      .filter((p) => p.length >= 2)
      .forEach((p) => candidateNames.add(p.toLowerCase()));
  }
  if (userEmail) {
    const local = userEmail.split('@')[0] || '';
    if (local.length >= 2) candidateNames.add(local.toLowerCase());
  }
  if (candidateNames.size === 0) return false;

  for (const name of candidateNames) {
    const escaped = escapeRegex(name);
    // @mention — "@advik " or "@advik,"
    if (new RegExp(`@${escaped}\\b`, 'i').test(body)) return true;
    // Greeting — "hi advik", "hello advik,", "dear advik"
    if (
      new RegExp(
        `\\b(hi|hello|hey|dear|hola|greetings|good (?:morning|afternoon|evening))[\\s,]+${escaped}\\b`,
        'i',
      ).test(body)
    ) {
      return true;
    }
  }
  return false;
}

// ========== State ==========

let pipeline: UnifiedPipeline | null = null;
let intelligence: BehaviorIntelligence | null = null;

// ----- Multi-account processing context -----
// The single `pipeline` instance categorizes emails from EVERY account, but its
// storage-bound callbacks (getEmail, saveEmailCategoriesBatch, …) must read/write
// the DB of the account the email actually belongs to — otherwise only the
// active account ever gets category tags. `activeProcessingStorage` is set to
// that account's storage for the duration of a single email's core
// categorization (serialized via `categorizeMutex` so it's never raced), and the
// callbacks resolve against it. Falls back to the active account's storage when
// no email is being processed.
let activeProcessingStorage: import('@sarvinbox/storage-node').SQLiteStorage | null = null;
function pStorage(): any {
  return activeProcessingStorage ?? getStorage();
}
function pRepos(): any {
  try { return (pStorage() as any)?.getRepositories(); } catch { return null; }
}
// Serialize the core LLM categorization across accounts so the shared
// `activeProcessingStorage` context is deterministic (one email at a time).
// Backed by p-limit(1) — a rejected run never wedges the chain.
const categorizeLimit = pLimit(1);
function runCategorizeExclusive<T>(fn: () => Promise<T>): Promise<T> {
  return categorizeLimit(fn);
}

// ----- Cross-account category propagation -----
// The same message is often delivered to more than one account (e.g. sarv +
// gmail). We categorize it ONCE (whichever copy the pipeline reaches while it's
// still unread) and copy the categories to the same Message-ID in every other
// account — so badges are consistent across accounts with no extra LLM call,
// even for a copy that's already read (read mail is otherwise never
// categorized).
// PER-STORAGE cache — each account has its OWN ai_category_definitions, so a
// single module-level cache would return the first account's slug set for every
// account (breaks cross-account slug extraction when the two accounts' category
// sets differ). Keyed by the storage instance (stable for the session).
const categorySlugSetByStorage = new WeakMap<object, Set<string>>();
function getCategorySlugSet(storage: any): Set<string> {
  const cached = categorySlugSetByStorage.get(storage);
  if (cached) return cached;
  let set: Set<string>;
  try {
    const rows = storage.db?.prepare?.('SELECT slug FROM ai_category_definitions').all() as { slug: string }[];
    set = new Set((rows || []).map((r) => r.slug));
  } catch { set = new Set(); }
  categorySlugSetByStorage.set(storage, set);
  return set;
}
function extractCategorySlugs(tags: string, slugs: Set<string>): string[] {
  if (!tags) return [];
  const out: string[] = [];
  for (const part of tags.split('|')) { if (part && slugs.has(part)) out.push(part); }
  return out;
}

// ----- Dual-delivery de-dup (single AI call across linked accounts) -----
// In-memory record of message-ids categorized THIS session, in ANY account, so a
// dual-delivered copy (same Message-ID in e.g. sarv + gmail) that reaches P2
// slightly later reuses the result instead of making a SECOND LLM call — even
// before the first copy's categories are committed to its DB. Bounded by TTL +
// size; the per-account DB is the durable fallback (findSiblingCategories).
// The in-memory record/TTL/eviction lives in SiblingCategoryCache (a pure,
// unit-tested module); the DB fallback stays here (findSiblingCategories).
const siblingCache = new SiblingCategoryCache();
/**
 * Categories already assigned to the SAME message in ANOTHER account — the
 * dual-delivery dedup source. Checks this session's in-memory record first
 * (covers the window before the first copy's DB write), then any FINALIZED copy
 * in another account's DB. Returns null when no linked copy is categorized yet,
 * meaning THIS copy must make the (single) AI call. Called inside the serialized
 * categorize block, so the record-then-check ordering is race-free.
 */
function findSiblingCategories(messageId: string | undefined, sourceStorage: any): string[] | null {
  if (!messageId) return null;
  const mem = siblingCache.get(messageId);
  if (mem) return mem;
  for (const [, rt] of getAllAccountRuntimes()) {
    if (!rt.storage || rt.storage === sourceStorage) continue;
    try {
      const row = (rt.storage as any).db?.prepare?.('SELECT ai_categories, agent_status FROM emails WHERE message_id = ? LIMIT 1')?.get(messageId) as { ai_categories?: string | null; agent_status?: string } | undefined;
      if (!row || row.agent_status !== 'done') continue;
      // The sibling's AI VERDICT, not its tag string. Reading tags here shared a
      // Gmail `\Important` label across accounts as though the AI had decided it.
      const slugs = mirrorableCategories(row.ai_categories, getCategorySlugSet(rt.storage));
      if (slugs && slugs.length > 0) return slugs;
    } catch { /* skip a failing account */ }
  }
  return null;
}

interface PropagatePriority { priorityScore?: number | null; priorityTier?: string | null; priorityReasoning?: string | null; recommendedAction?: string | null }

function propagateCategoriesToLinkedAccounts(messageId: string | undefined, categories: string[], sourceStorage: any, priority?: PropagatePriority): void {
  if (!messageId || categories.length === 0) return;
  const now = Math.floor(Date.now() / 1000);
  const cats = categories.map((slug) => ({ slug, confidence: 0.9 }));
  for (const [, rt] of getAllAccountRuntimes()) {
    if (!rt.storage || rt.storage === sourceStorage) continue;
    try {
      const row = (rt.storage as any).db?.prepare?.('SELECT id, tags, agent_status FROM emails WHERE message_id = ? LIMIT 1')?.get(messageId) as { id?: string; tags?: string; agent_status?: string } | undefined;
      if (!row?.id) continue;
      // Never CLOBBER a copy that was independently categorized in its own
      // account: saveEmailCategoriesBatch REPLACES all category tags, so a copy
      // that already carries its own category tag(s) (e.g. [important]) must be
      // left untouched — otherwise the source's [invoice] would overwrite it.
      // Deliberately still the TAG string, not ai_categories: this is a "leave it
      // alone" guard, and tags are the broader set. A legacy copy has no recorded
      // verdict, so switching this to ai_categories would make the guard blind and
      // let a propagation clobber categories that copy already had.
      const ownCategorySlugs = extractCategorySlugs(row.tags || '', getCategorySlugSet(rt.storage));
      if (ownCategorySlugs.length > 0) continue;
      const oRepos = (rt.storage as any).getRepositories();
      // Back-fill this copy AND mark it done — even if it's still unread + pending.
      // A dual-delivered message is identical content, so it must be categorized
      // ONCE and shared. If we left an unread+pending copy to self-categorize, its
      // own (non-deterministic) run could return EMPTY and then STRIP the label we
      // just applied — the [reminders]->[]->removeLabel flip-flop. Marking it done
      // here means it never self-categorizes, so the categories can't diverge.
      // saveEmailCategoriesBatch stamps agent_status='done' + the category tags.
      oRepos.ai.saveEmailCategoriesBatch([{ emailId: row.id, categories: cats, isSpam: false, reasoning: 'propagated from a linked account (same message)', processedAt: now, confidence: 0.9 }]);
      // The propagated copy inherits the SOURCE's verdict, so it must inherit the
      // record of it too — it never runs its own P2, and without this its
      // ai_categories would stay NULL and its labels would never be mirrored.
      oRepos.agent?.recordAiCategories?.(row.id, encodeAiCategories(categories));
      // Carry the source's priority score so the back-filled copy still sorts by
      // Importance — it skips its own scoring pass now that it won't self-process.
      if (priority) oRepos.agent?.markAgentDone?.(row.id, priority);
      // Live badge for the propagated copy.
      getMainWindow()?.webContents.send('pipeline:email-processed', { emailId: row.id, categories });
      // Mirror the label onto THIS linked account's OWN server too — not just the
      // in-app badge — so the "single AI call → label on BOTH servers" holds for
      // a copy that was already read (it never runs its own P2, so nothing else
      // would label it). Best-effort, uses the linked account's own engine.
      const linkedStorage = rt.storage;
      void (async () => {
        try {
          const oEmail = await (linkedStorage as any).getEmail?.(row.id);
          if (oEmail?.uid) await mirrorCategoryLabels(linkedStorage, oEmail, categories);
        } catch { /* best-effort server label; badge already applied */ }
      })();
    } catch { /* skip a failing account */ }
  }
}

// When categorization hits a TERMINAL provider error (bad key, no credits,
// cai_account_required, 4xx), retrying every 30s just spams a doomed request
// and the failure stays invisible. Instead we surface the Fix banner once and
// PAUSE background categorization until the user re-configures the provider
// (setAIConfig clears this). Transient errors (502/429/network) are unaffected
// — they keep retrying.
const AI_TERMINAL_PAUSE_MS = 15 * 60_000;
let aiPausedUntil = 0;
let lastAIErrorReason = '';
// Cross-account category reconciliation cadence (0 = run on the first poll).
let lastReconcileAt = 0;
let lastPollMaintenanceAt = 0;
function surfaceTerminalAIError(err: unknown): { terminal: boolean; kind: string; paused: boolean } {
  // The terminal/global decision is extracted to a pure, unit-tested policy
  // (decideAIErrorPolicy); the side effects (pause deadline + renderer banner)
  // stay here. A per-email 'client' 4xx is terminal but NOT global — it must not
  // pause the whole mailbox; only auth/credit (provider-wide) pause everything.
  const decision = decideAIErrorPolicy(err);
  if (!decision.terminal) return { terminal: false, kind: decision.kind, paused: false };
  if (!decision.pauseGlobally) return { terminal: true, kind: decision.kind, paused: false };
  aiPausedUntil = Date.now() + AI_TERMINAL_PAUSE_MS;
  // Reuse the categorization error channel the renderer already listens on
  // (helpers.ts onError → reportAIUnhealthy raises the "AI inactive / Fix"
  // banner for terminal errors). De-dupe so we don't spam identical banners.
  if (lastAIErrorReason === decision.reason) return { terminal: true, kind: decision.kind, paused: true };
  lastAIErrorReason = decision.reason;
  logger.warn(`[Pipeline] Terminal AI error — pausing categorization ${Math.round(AI_TERMINAL_PAUSE_MS / 60000)}min: ${decision.reason}`);
  try {
    const win = getMainWindow();
    win?.webContents.send('ai-categorization:error', {
      message: decision.reason,
      terminal: true,
      kind: decision.kind,
      status: decision.status,
      reason: decision.reason,
    });
  } catch { /* window gone */ }
  return { terminal: true, kind: decision.kind, paused: true };
}
let aiConfig: AIProviderConfig | null = null;

/**
 * Tell the renderer whether the BACKGROUND pipeline currently has a usable AI
 * provider. Without this the pipeline could sit at hasAI=false for a whole
 * session (e.g. a main-process restart wiped the in-memory aiConfig and the
 * already-mounted renderer never re-pushed it) while every mail is silently
 * "skipped (AI not ready)" — categorization, chat extraction and contact
 * enrichment all quietly off, with zero user-facing signal. The renderer maps
 * this onto the existing AI-health banner (and attempts a self-heal re-push).
 *
 * Transition-guarded: only fires on an actual available<->unavailable change,
 * so it's safe to call it liberally (every setter + every poll tick). The
 * "unavailable" edge is only ever emitted from the 30s poll tick, never at
 * init — that grace period lets the renderer push its config on mount without
 * a spurious banner flash on every normal startup.
 */
let _lastAiAvailableEmitted: boolean | null = null;
function emitAiPipelineStatus(): void {
  const available = !!aiConfig;
  if (available === _lastAiAvailableEmitted) return;
  _lastAiAvailableEmitted = available;
  getMainWindow()?.webContents.send('ai:pipeline-status', {
    available,
    reason: available
      ? ''
      : 'No AI provider connected — background AI (sorting, chat summaries and contact info) is paused.',
  });
}

let abortController: AbortController | null = null;
let unsubscribeSync: (() => void) | null = null;
let unsubscribeBodyReady: (() => void) | null = null;
let pollingTimer: ReturnType<typeof setInterval> | null = null;
const processingLock = new Set<string>();
/**
 * serviceConfig carries runtime context that travels with the pipeline:
 * - userEmail: the account address we're drafting as
 * - userName / profileTitle / profileCompany: pushed from the renderer-side
 *   Profile settings (localStorage can't be read from main process directly)
 */
let serviceConfig: Partial<UnifiedPipelineConfig> & {
  userEmail?: string;
  userName?: string;
  profileTitle?: string;
  profileCompany?: string;
} = {};

/**
 * Merge user-profile fields into serviceConfig. Called from the agent:setConfig
 * IPC handler when the renderer saves Profile Information in Settings.
 */
export function setPipelineUserProfile(profile: {
  userName?: string;
  profileTitle?: string;
  profileCompany?: string;
  userEmail?: string;
}): void {
  if (profile.userName !== undefined) serviceConfig.userName = profile.userName;
  if (profile.profileTitle !== undefined) serviceConfig.profileTitle = profile.profileTitle;
  if (profile.profileCompany !== undefined) serviceConfig.profileCompany = profile.profileCompany;
  if (profile.userEmail) serviceConfig.userEmail = profile.userEmail;
}

/**
 * Get the current user-email the pipeline is drafting as. Empty if unknown.
 */
export function getPipelineUserEmail(): string {
  return serviceConfig.userEmail || '';
}

/**
 * Get the current user-display-name the pipeline is drafting as.
 */
export function getPipelineUserName(): string {
  return serviceConfig.userName || '';
}

/**
 * Get the AI provider config the pipeline is using (null when not
 * configured). aiConfig itself is module-local — external consumers
 * (agent:draftReply) must go through this getter.
 */
export function getPipelineAIConfig(): AIProviderConfig | null {
  return aiConfig;
}

/**
 * Re-check that the OAuth account backing the AI provider still exists, and
 * DISABLE the AI pipeline if it's gone. The Sarv OAuth session powers BOTH the
 * mailbox and the LLM, so removing the Sarv account deletes the token the
 * categorizer relies on — after which every categorization throws "No OAuth
 * account for sarv:…" forever. Call this after an account is removed: if the AI
 * config is OAuth-backed and its account is missing, clear the config (stops the
 * error spam) and surface "AI not configured" so the user reconnects a provider.
 * No-op for API-key providers or when the account is still present. Returns true
 * if it disabled AI.
 */
export async function disablePipelineAIIfProviderRemoved(): Promise<boolean> {
  const persisted = loadPipelineAIConfigSync() as
    | { authMethod?: string; oauthProvider?: OAuthProviderId; oauthEmail?: string }
    | null;
  if (!persisted || persisted.authMethod !== 'oauth' || !persisted.oauthProvider || !persisted.oauthEmail) {
    return false;
  }
  const account = await getOAuthAccount(persisted.oauthProvider, persisted.oauthEmail);
  if (account) return false; // provider account still present — nothing to do

  aiConfig = null;
  aiPausedUntil = 0;
  lastAIErrorReason = '';
  try { await clearPipelineAIConfig(); } catch { /* best-effort */ }
  logger.warn(
    `[Pipeline] AI provider ${persisted.oauthProvider}:${persisted.oauthEmail} was removed — ` +
    'disabling AI until a provider is reconnected',
  );
  emitAiPipelineStatus();
  return true;
}

const POLLING_INTERVAL_MS = 30_000;
// How often the poll runs its non-essential maintenance: the stuck-row heal,
// the read/spam sweep, the UI stats emit, and the diagnostic file write. These
// don't need 30s freshness, so throttling them off the fetch cadence keeps them
// from blocking the event loop every 30s. The bounded, index-backed work-fetch
// (and the cheap index-only backlog counts) still run every poll.
const POLL_MAINTENANCE_INTERVAL_MS = 120_000; // 2 min
// Background auto-categorization only reaches into the N most-recent emails.
// New mail always falls inside this window (so it's categorized in real time),
// while a large historical backlog is left alone rather than spending LLM calls
// on it unattended.
//
// N is the user's "AI Processing Limit" setting, pushed in from the renderer and
// persisted — see ai-backlog-cap.ts. It was a hardcoded 500 whose comment
// claimed it mirrored that setting; it did not, and raising the setting moved
// nothing. Read through a function (not captured once) so a change takes effect
// on the next tick instead of at the next restart.
const AUTO_BACKLOG_RECENT_CAP = (): number => getAutoBacklogCap();

// How old a body-less 'pending' email must be before the poll gives up on it
// and finalizes it uncategorized. Long enough that a body still in the download
// queue is never cut short (phase 1 grabs it the moment it lands), short enough
// that a body that is never coming — see the known body-fetch failure modes —
// cannot park the AI progress bar below 100% indefinitely.
const STUCK_AGENT_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

// How many pending category-label mirrors to drain per account per poll tick.
// Small + gradual so a big burst/backlog catches up over successive 30s ticks
// without a Gmail API burst (each email may issue label GET/PATCH + a STORE op).
const LABEL_DRAIN_BATCH = 12;

/**
 * user_feedback marker on an agent_decisions row meaning "this reply was
 * actually SENT via SMTP by the agent" (status stays 'auto', matching the
 * existing convention of status 'auto' + a feedback marker string). The
 * dashboard uses it to keep sent replies out of "Drafts ready", and the
 * thread-supersede step uses it to never relabel sent history.
 */
export const REPLY_SENT_FEEDBACK = 'reply-sent-by-agent';

// ========== Public API ==========

// Config from an initializeUnifiedPipeline() call that bailed on missing storage.
let pendingPipelineInit: { config?: any; providerConfig?: any } | null = null;
let pipelineInitRetryTimer: NodeJS.Timeout | null = null;

/**
 * Self-healing retry: while a pipeline init is pending (storage wasn't ready),
 * poll until storage exists and complete the init, then stop. This makes the
 * pipeline recover on its OWN regardless of what eventually provides storage
 * (account connect, switch, DB open) — so a transient "storage not ready" never
 * leaves categorization permanently dead.
 */
function schedulePipelineInitRetry(): void {
  if (pipelineInitRetryTimer) return;
  pipelineInitRetryTimer = setInterval(() => {
    if (!pendingPipelineInit) {
      if (pipelineInitRetryTimer) { clearInterval(pipelineInitRetryTimer); pipelineInitRetryTimer = null; }
      return;
    }
    if (getStorage()) retryPipelineInitOnConnect();
  }, 8000);
  pipelineInitRetryTimer.unref?.();
}

/**
 * Complete a deferred pipeline init now that storage should be available. Called
 * on account connect (immediate) and by the self-healing timer (safety net).
 */
export function retryPipelineInitOnConnect(): void {
  if (!pendingPipelineInit || !getStorage()) return;
  const { config, providerConfig } = pendingPipelineInit;
  pendingPipelineInit = null;
  // Prefer the PERSISTED agent config over the stale boot config captured when we
  // deferred. While deferred (first launch / onboarding, no account yet) the
  // renderer's agent:setConfig push could only save the AI-Assist `enabled` switch
  // to disk — there was no live pipeline to apply it to. Rebuilding from the boot
  // config alone left a first-time "login with Sarv" categorization DISABLED until
  // a manual toggle. Re-reading loadAgentConfig() here picks up that persisted
  // switch so it comes up in the user's real state.
  const merged = resolveDeferredPipelineConfig(config, loadAgentConfig());
  logger.info(`[Pipeline] storage now available — running deferred init (enabled=${merged.enabled})`);
  initializeUnifiedPipeline(merged, providerConfig);
}

export function initializeUnifiedPipeline(
  config?: Partial<UnifiedPipelineConfig> & { userEmail?: string },
  providerConfig?: AIProviderConfig,
): void {
  // Register the pipeline IPC handlers FIRST — unconditionally — so
  // setCategoryLabels / syncCategoryLabels / removeCategoryLabels (and
  // setAIConfig) exist even when storage isn't ready yet. Previously these were
  // registered AFTER the storage guard, so a transient "Storage not available"
  // left them unregistered ("No handler registered").
  registerPipelineIPC();

  const storage = getStorage();
  if (!storage) {
    // No active-account storage yet (e.g. no legacy sarvinbox.db and the active
    // account hasn't been claimed as "current" at this instant). DON'T give up
    // permanently — remember the config and retry once an account connects, so
    // categorization actually starts instead of silently never running.
    logger.warn('[Pipeline] storage not ready — deferring init (will retry automatically)');
    pendingPipelineInit = { config, providerConfig };
    schedulePipelineInitRetry();
    return;
  }
  pendingPipelineInit = null;
  if (pipelineInitRetryTimer) { clearInterval(pipelineInitRetryTimer); pipelineInitRetryTimer = null; }

  const repos = (storage as any).getRepositories();
  if (!repos?.agent) { logger.error('[Pipeline] Agent repo not available'); return; }

  serviceConfig = config || {};
  // Only (re)set aiConfig when this call actually carries a provider config.
  // A re-init WITHOUT one (e.g. the deferred/self-heal path, or a plain
  // reinitialize) must PRESERVE whatever config the renderer already pushed via
  // pipeline:setAIConfig — otherwise it clobbers it to null and every email is
  // "skipped (AI not ready)" forever. Passing a providerConfig still updates it.
  if (providerConfig) {
    aiConfig = withChromiumFetch(providerConfig);
  } else if (!aiConfig) {
    // Fresh main-process start (module reloaded → aiConfig null) and no config
    // was handed in. Restore the last provider config the renderer pushed,
    // persisted encrypted on disk, so the pipeline comes up AI-ready WITHOUT
    // waiting for the renderer to re-push — the durable fix for "AI silently
    // off after a restart" and the 30s categorization skip-loop. Re-apply
    // attachOAuthBearer (exactly as the pipeline:setAIConfig handler does) so
    // OAuth providers get their fresh-token resolver back.
    const persisted = loadPipelineAIConfigSync();
    if (persisted) {
      aiConfig = attachOAuthBearer(persisted as unknown as AIProviderConfig);
      logger.info(`[Pipeline] AI config restored from disk (${persisted.type}/${persisted.model})`);
      // If that config is OAuth-backed but its account was removed in a PREVIOUS
      // session (e.g. the Sarv mailbox that also powered the LLM), it would
      // categorize-fail forever. Revalidate and disable it here so a stale config
      // never resumes the error spam on restart. Fire-and-forget (init isn't
      // async); it clears aiConfig + re-emits status when the account is gone.
      void disablePipelineAIIfProviderRemoved();
    }
  }
  // Emit the "available" edge only when we actually have a config — never a
  // false edge at init (that would flash the "AI paused" banner on every normal
  // startup; the 30s poll tick reports genuine unavailability instead).
  if (aiConfig) emitAiPipelineStatus();
  abortController = new AbortController();
  const userEmail = serviceConfig.userEmail || '';
  const userName = userEmail.split('@')[0] || '';

  // Seed the user-editable prompt templates (idempotent — preserves any
  // content the user has already customized; refreshes label/description
  // and default_content so the Reset button reflects upstream prompt
  // changes).
  try {
    const { DEFAULT_CATEGORIZATION_TEMPLATE, DEFAULT_PLAN_TEMPLATE, DEFAULT_DRAFT_TEMPLATE } =
      require('@sarvinbox/core');
    const promptRepo = (repos as any).prompts;
    if (promptRepo?.seedDefault) {
      promptRepo.seedDefault({
        id: 'categorization_system',
        label: 'Categorization (System Prompt)',
        description:
          'How the AI classifies emails, picks categories, and decides if a reply should be drafted. Variables: {{userEmail}}, {{userName}}, {{userDomain}}, {{categorySection}}, {{spamPrompt}}.',
        content: DEFAULT_CATEGORIZATION_TEMPLATE,
      });
      promptRepo.seedDefault({
        id: 'agent_plan',
        label: 'Reply Drafter — Plan',
        description:
          'Step 1 of reply drafting: decides whether to search old emails or the web before writing. Variables: {{identity}}, {{webOption}}, {{webSearchesField}}, {{webWhenSection}}.',
        content: DEFAULT_PLAN_TEMPLATE,
      });
      promptRepo.seedDefault({
        id: 'agent_draft',
        label: 'Reply Drafter — Draft',
        description:
          'Step 2 of reply drafting: writes the actual reply body. Variables: {{identity}}, {{userName}}, {{greeting}}, {{tone}}, {{closing}}.',
        content: DEFAULT_DRAFT_TEMPLATE,
      });
    }
  } catch (err) {
    logger.warn('[Pipeline] Failed to seed prompt templates:', err);
  }

  // Create UnifiedPipeline
  pipeline = new UnifiedPipeline(
    {
      agentStorage: repos.agent,
      userEmail,
      callAI: async (sys: string, msg: string) => {
        if (!aiConfig) throw new Error('No AI provider configured');
        return callAIWithRetry(aiConfig, sys, msg, abortController?.signal);
      },
      // Storage callbacks resolve against the account CURRENTLY being processed
      // (pStorage()/pRepos()), not the account that was active at init — so a
      // background account's email is read from and categorized into ITS OWN db.
      getEmail: (id: string) => pStorage().getEmail(id),
      getSenderContextBatch: (emails: string[]) => { try { return (pStorage() as any).getSenderContextBatch(emails); } catch { return {}; } },
      getThreadDepths: (ids: string[]) => { try { return (pStorage() as any).getThreadDepths(ids); } catch { return {}; } },
      getSenderRepetitionStats: (emails: string[]) => { try { return (pStorage() as any).getSenderRepetitionStats(emails); } catch { return { sameSubject: {}, totalEmails: 0 }; } },
      getEnabledCategoryDefinitions: () => { try { return (pStorage() as any).getEnabledCategoryDefinitions(); } catch { return []; } },
      saveEmailCategoriesBatch: (batch) => { try { return pRepos().ai.saveEmailCategoriesBatch(batch); } catch { return 0; } },
      executeAction: (emailId, action, value) => executeAgentAction(emailId, action, value),
      // Goes through the storage facade rather than reaching into `.db`: the
      // contact directory is shared across accounts and lives in an ATTACHed
      // schema, so the table name is qualified in exactly one place.
      getContactType: (email: string): ContactType => {
        try { return (pStorage().getContactType(email) as ContactType) || 'unknown'; }
        catch { return 'unknown'; }
      },
      getImportanceScore: (emailId: string) => {
        try {
          const row = (pStorage() as any).db?.prepare?.('SELECT importance_score FROM emails WHERE id = ?')?.get(emailId);
          return row?.importance_score || 0;
        } catch { return 0; }
      },
      getCategoryCorrelations: () => { try { return pRepos().agent.getAllCategoryCorrelations(); } catch { return {}; } },
      saveNotes: (notes) => { try { return pRepos().agent.addNotesBatch(notes); } catch { return 0; } },
      getNotesForPrompt: (email) => { try { return pRepos().agent.getNotesForPrompt(email); } catch { return ''; } },
      getPromptTemplate: (id: string) => {
        try { return (pRepos() as any).prompts?.getContent?.(id) || null; }
        catch { return null; }
      },
      // Addressing gate — core uses this to strip needs_response (and
      // block auto-draft) for emails the user isn't addressed in. Fails
      // open when the account email isn't known yet so fresh installs
      // don't silently drop needs_response across the board.
      isUserAddressed: (enriched) => {
        const ue = serviceConfig.userEmail || '';
        const un = serviceConfig.userName || '';
        if (!ue) return true;
        const inTo = isUserInToField({ toAddress: enriched.toAddress }, ue);
        const mentioned = isUserMentionedInBody({ cleanBody: enriched.body }, ue, un);
        return inTo || mentioned;
      },
    },
    config,
  );

  // Create BehaviorIntelligence (primary scorer)
  // The storage-backed deps resolve against the CURRENTLY-PROCESSING account's
  // db (pStorage()/pRepos()), not the account active at init — otherwise a
  // background account's email is scored against the active account's
  // reply/read/thread history, yielding a wrong priority_score/tier. Mirrors the
  // categorization callbacks. Falls back to the active account when no email is
  // being processed (e.g. the getIntelligence() IPC re-score handlers).
  intelligence = new BehaviorIntelligence({
    userEmail,
    userName,
    getSenderSignalData: (s: string) => pRepos().agent.getSenderSignalData(s, userEmail),
    getThreadParticipation: (t: string) => pRepos().agent.getThreadParticipation(t, userEmail),
    getContactType: (e: string) => {
      try { return pStorage().getContactType(e); }
      catch { return 'unknown'; }
    },
    getPeakHours: () => pRepos().agent.getPeakActivityHours(),
  });

  // `isBackfilled` is a cheap flag check; the actual backfill / contact
  // classification / sender-memory build is heavy and DEFERRED below.
  const alreadyBackfilled = repos.agent.isBackfilled();

  // Start triggers immediately — the pipeline is usable right away (it just lacks
  // sender-memory personalization until the deferred learning finishes).
  startEventTrigger();
  startPollingTrigger();

  // Boot path: use the body-free lite stats. getPipelineStats() filters on
  // hasBodyClause (LENGTH(TRIM(body)) over every row), a full multi-GB body scan
  // that took ~13s cold and blocked createWindow. These raw status counts are
  // index-only (milliseconds); the precise eligible/done figures follow from the
  // first poll tick, off the startup critical path.
  const pStats = repos.agent.getPipelineStatsLite();
  logger.info(`[Pipeline] Initialized — event+30s poll | emails: total=${pStats.totalEmails} ext_status_pending=${pStats.extractionStatusPending} agent_status_pending=${pStats.agentStatusPending} | hasAI=${!!aiConfig} | userEmail="${userEmail}"`);

  // DEFER the heavy learning (backfill + classify + sender-memory build) OFF the
  // init critical path. These are synchronous better-sqlite3 passes that take
  // SECONDS on a large mailbox — running them inline here froze the main event
  // loop during startup, delaying createWindow and stalling the renderer's
  // connect/account IPC, which then flashed "No account connected". A short defer
  // lets the window + account come up first; the learning runs a moment later.
  const initialLearnTimer = setTimeout(() => {
    try {
      if (!alreadyBackfilled) {
        logger.info('[Pipeline] Backfilling behavior from existing emails...');
        const bf = repos.agent.backfillFromHistory();
        logger.info(`[Pipeline] Backfill: ${bf.actionsCreated} actions from ${bf.totalEmails} emails, ${bf.sendersProcessed} senders`);
      } else {
        const s = repos.agent.getLearningSummary();
        logger.info(`[Pipeline] Already learned: ${s.totalActions} actions (${s.fromHistory} hist, ${s.fromLive} live), ${s.uniqueSenders} senders`);
      }
      if (userEmail) {
        const cl = repos.agent.autoClassifyContacts(userEmail);
        if (cl > 0) logger.info(`[Pipeline] Classified ${cl} contacts`);
        const m = repos.agent.buildAllSenderMemories(userEmail);
        if (m > 0) logger.info(`[Pipeline] Built ${m} sender memories`);
      }
    } catch (e) {
      logger.warn('[Pipeline] deferred initial learning failed:', (e as Error).message);
    }
  }, 3000);
  initialLearnTimer.unref?.();

  // Wait for emails to exist in DB then run backfill (checks every 10s, max 2 min)
  if (!alreadyBackfilled || repos.agent.getLearningSummary().totalActions === 0) {
    let backfillAttempts = 0;
    const backfillCheck = setInterval(() => {
      backfillAttempts++;
      try {
        const emailCount = (storage as any).db?.prepare?.('SELECT COUNT(*) as c FROM emails')?.get()?.c || 0;
        if (emailCount === 0 && backfillAttempts < 12) return; // Wait for sync, max 2 min

        clearInterval(backfillCheck);

        if (emailCount === 0) {
          logger.info('[Pipeline] No emails after 2 min, skipping backfill');
          return;
        }

        // Clear any previous empty backfill
        (repos.agent as any).db?.prepare?.("DELETE FROM user_action_log WHERE source = 'history'")?.run();

        logger.info(`[Pipeline] Post-sync backfill (${emailCount} emails in DB)...`);
        const bf = repos.agent.backfillFromHistory();
        logger.info(`[Pipeline] Post-sync backfill: ${bf.actionsCreated} actions, ${bf.sendersProcessed} senders`);

        // Re-resolve userEmail via the shared identity resolver (registry-first,
        // never an arbitrary Sent from_address). Keep any value already set.
        const email = serviceConfig.userEmail || resolveAccountEmail(storage);
        if (email) {
          serviceConfig.userEmail = email;
          logger.info(`[Pipeline] Post-sync userEmail: ${email}`);
          const cl = repos.agent.autoClassifyContacts(email);
          if (cl > 0) logger.info(`[Pipeline] Classified ${cl} contacts`);
          const m = repos.agent.buildAllSenderMemories(email);
          if (m > 0) logger.info(`[Pipeline] Built ${m} sender memories`);
        }
      } catch (e) { logger.error('[Pipeline] Backfill check error:', e); clearInterval(backfillCheck); }
    }, 10_000);
  }
}

export function getUnifiedPipeline(): UnifiedPipeline | null { return pipeline; }
export function getIntelligence(): BehaviorIntelligence | null { return intelligence; }

export function updatePipelineAIConfig(config: AIProviderConfig): void { aiConfig = withChromiumFetch(config); emitAiPipelineStatus(); }

export function stopUnifiedPipeline(): void {
  if (unsubscribeSync) { unsubscribeSync(); unsubscribeSync = null; }
  if (unsubscribeBodyReady) { unsubscribeBodyReady(); unsubscribeBodyReady = null; }
  if (pollingTimer) { clearInterval(pollingTimer); pollingTimer = null; }
  if (abortController) { abortController.abort(); abortController = null; }
  pipeline = null;
  intelligence = null;
  processingLock.clear();
  logger.info('[Pipeline] Stopped');
}

// ========== Sequential Flow: P1 (extraction) → P2 (agent) ==========

async function processEmail(emailId: string, threadId: string, storage: any = getStorage()): Promise<void> {
  if (processingLock.has(emailId)) return;
  processingLock.add(emailId);

  try {
    // Pipeline 1: Conversation extraction — on the email's OWN account storage.
    await runPipeline1(emailId, threadId, storage);

    // Pipeline 2: Agent intelligence (only after P1) — same account storage.
    await runPipeline2(emailId, storage);
  } finally {
    processingLock.delete(emailId);
  }
}

// ========== Pipeline 1: Conversation Extraction ==========

async function runPipeline1(emailId: string, threadId: string, storage: any = getStorage()): Promise<void> {
  if (!storage) return;
  const repos = (storage as any).getRepositories();
  if (!repos?.agent || !repos?.ai) return;

  try {
    const threadEmails = await storage.getEmailsByThread(threadId);

    // Single-email threads: no extraction needed
    if (threadEmails.length <= 1) {
      repos.agent.markExtractionDone(emailId);
      return;
    }

    // Check if already extracted
    const existing = await repos.ai.getConversation(threadId);
    if (existing) {
      const extractedIds = existing.processedEmailIds ? JSON.parse(existing.processedEmailIds) : [];
      if (extractedIds.includes(emailId)) {
        repos.agent.markExtractionDone(emailId);
        return;
      }
    }

    // The renderer does the actual extraction — if it has no AI provider
    // configured (same flag the conversation scheduler gates on), the send
    // goes nowhere and we'd stall 5s per multi-email thread. Skip straight
    // to the raw-thread fallback.
    if (!isAIProviderConfigured()) {
      repos.agent.markExtractionDone(emailId);
      return;
    }

    // Trigger extraction via renderer
    const mainWindow = getMainWindow();
    if (mainWindow) {
      mainWindow.webContents.send('conversation:extract-batch', {
        threads: [{ id: threadId, messageCount: threadEmails.length }],
      });
    }

    // Wait up to 5s for extraction to complete
    for (let i = 0; i < 5; i++) {
      await new Promise(r => setTimeout(r, 1000));
      const conv = await repos.ai.getConversation(threadId);
      if (conv) {
        const ids = conv.processedEmailIds ? JSON.parse(conv.processedEmailIds) : [];
        if (ids.includes(emailId) || ids.length >= threadEmails.length) {
          repos.agent.markExtractionDoneByThread(threadId);
          return;
        }
      }
    }

    // Timeout — proceed anyway (P2 works with raw thread emails as fallback)
    repos.agent.markExtractionDone(emailId);
  } catch (error) {
    logger.error(`[Pipeline] P1 error for ${emailId}:`, error);
    repos.agent.markExtractionDone(emailId); // Don't block P2
  }
}

// ========== Pipeline 2: Agent Intelligence ==========

async function runPipeline2(emailId: string, storage: any = getStorage()): Promise<void> {
  if (!storage) return;

  try {
    const email = await storage.getEmail(emailId);
    if (!email) return;

    // Defense-in-depth: never run AI on a read email. Callers should gate
    // before getting here (polling query does, event trigger does), but if
    // a new code path slips through we short-circuit here and mark done so
    // we don't loop. This mirrors the intent across every trigger.
    if ((email.tags || '').includes('|read|')) {
      const repos = (storage as any).getRepositories();
      repos?.agent?.markAgentGaveUp?.(emailId, {});
      return;
    }

    // Skip emails without body — can't categorize or score content without it
    const hasBody = (email.cleanBody && email.cleanBody.length > 0) || (email.rawBody && email.rawBody.length > 0);
    if (!hasBody) {
      // Reset status so polling picks it up later when body is downloaded
      const repos = (storage as any).getRepositories();
      repos?.agent?.db?.prepare?.("UPDATE emails SET agent_status = 'pending' WHERE id = ?")?.run(emailId);
      return;
    }

    // 1. ALWAYS score with BehaviorIntelligence (no LLM needed, pure signals)
    let priorityScore = 0;
    let priorityTier = 'medium';
    let priorityReasoning = '';
    let recommendedAction: string | null = null;

    if (intelligence) {
      // Set THIS email's account as the active processing context so the
      // scorer's storage-backed deps (sender/thread/contact history) read from
      // the email's OWN account db, not the account active at pipeline init.
      // scoreEmail is fully synchronous (no await between set and restore), so
      // nothing interleaves; we save/restore the previous value rather than
      // null it, to avoid clobbering a concurrent categorization's context
      // (that block holds activeProcessingStorage across an await).
      const prevProcessingStorage = activeProcessingStorage;
      activeProcessingStorage = storage;
      try {
        const score = intelligence.scoreEmail(email);
        priorityScore = score.score;
        priorityTier = score.tier;
        priorityReasoning = score.reasoning;
        recommendedAction = score.recommendedAction || null;
      } catch (err) {
        logger.error(`[Pipeline] Scoring error for ${emailId}:`, err);
      } finally {
        activeProcessingStorage = prevProcessingStorage;
      }
    }

    // 2. Run AI categorization + action execution (only if LLM configured and pipeline enabled)
    let categories: string[] = [];
    let executed = false;
    let proposed = false;
    let categorizationFailed = false;
    // Deterministic parse failure only (LLM answered but dropped/mangled THIS
    // email) — distinct from a transient/terminal thrown error. Used to cap
    // retries so an unparseable email doesn't loop through the LLM forever.
    let categorizationParseFailed = false;
    // True when AI Assist is ON but the provider isn't READY right now — its
    // config hasn't been pushed to the pipeline yet (startup / add-provider race)
    // or a terminal-error pause is active. We must NOT mark such an email done:
    // that permanently strands it as "Everything else" and the poll (which only
    // revisits pending rows) never retries it. Leave it pending so it gets
    // categorized the moment the provider becomes ready.
    let categorizationSkipped = false;

    const aiEnabled = !!pipeline?.getConfig().enabled;
    const aiPaused = Date.now() < aiPausedUntil;
    // AI is OFF *by the user* (pipeline exists but disabled) — distinct from
    // "AI on but not ready yet" (no config pushed / paused / no pipeline). When
    // the user has AI off we must still FINALIZE the row with its local priority
    // score (markAgentDone), otherwise the score is recomputed every poll and
    // discarded and the row is stranded 'pending' forever — defeating the
    // "Important sort works even with AI off" intent. When AI is merely not
    // ready, we leave it pending to retry once the provider comes online.
    const aiDisabledByUser = !!pipeline && !aiEnabled;

    // Master AI Assist gate — when the user turns AI off in settings we stop
    // categorization *and* the agent. Pure local scoring above still runs
    // (free, useful for Important sort even when AI is off).
    if (pipeline && aiConfig && aiEnabled && !aiPaused) {
      try {
        // Serialize + set the account context so the pipeline's storage
        // callbacks (esp. saveEmailCategoriesBatch) hit THIS email's account db.
        const result = await runCategorizeExclusive(async () => {
          // Dual-delivery de-dup: if the SAME message was already categorized in
          // another account, reuse those categories — NO second AI call. Done
          // inside the serialized block so record-then-check can't interleave.
          const sib = findSiblingCategories(email.messageId, storage);
          if (sib) {
            logger.info(`[Pipeline:P2] ${emailId} reusing categories from a linked account (same Message-ID) — no AI call: [${sib.join(',')}]`);
            return { categories: sib, executed: false, proposed: false, fromSibling: true } as any;
          }
          activeProcessingStorage = storage;
          try {
            const r = await pipeline!.processEmail(email);
            // Record for sibling copies still to be processed this session.
            if (r && Array.isArray(r.categories)) siblingCache.record(email.messageId, r.categories);
            return r;
          } finally { activeProcessingStorage = null; }
        });
        if (result) {
          categories = result.categories;
          executed = result.executed;
          proposed = result.proposed;
          if (result.predictedAction) recommendedAction = result.predictedAction;
          categorizationFailed = !!result.categorizationFailed;
          categorizationParseFailed = !!result.categorizationParseFailed;
          // Label mirroring is NOT fired here anymore: it's recorded durably
          // (label_status='pending') and applied in the success branch below, so a
          // disconnected engine / restart / burst can never strand it unlabeled.
        }
      } catch (err) {
        logger.error(`[Pipeline] Categorization error for ${emailId}:`, err);
        // Auth/credit terminal errors pause categorization globally + raise the
        // Fix banner. A per-email 4xx ('client', not paused) is a doomed request
        // for THIS message only — accept it (mark done, no categories) so we
        // don't retry one bad email forever. Everything else (transient, or a
        // global auth/credit pause) leaves the email pending to retry on recovery.
        const cls = surfaceTerminalAIError(err);
        categorizationFailed = !(cls.terminal && cls.kind === 'client' && !cls.paused);
      }
    } else {
      // We did NOT run categorization this pass — either AI Assist is OFF
      // (!aiEnabled), or it's ON but not ready yet (config not pushed / paused),
      // or the pipeline isn't initialized. In every case leave agent_status
      // 'pending' rather than marking the email done-empty: marking done strands
      // it forever as "Everything else" (the poll only revisits pending rows, so
      // it never gets re-categorized once AI turns on / becomes ready). The poll
      // re-selects cheaply and makes NO LLM call while AI is off.
      categorizationSkipped = true;
    }

    // 3. Save results (always — scoring works without LLM). Exception: when the
    // categorize LLM call FAILED (transient) or was SKIPPED because AI wasn't
    // ready yet, leave agent_status pending so the 30s poll retries — marking
    // done here would permanently un-categorize the email.
    const repos = (storage as any).getRepositories();
    if (repos?.agent) {
      // Which outcome this pass had, and finalize-or-retry, are decided by the
      // pure helpers in core so the precedence between the arms is unit-tested
      // rather than re-derived from a chain of `else if`s. Every arm here
      // either finalizes or retries under a finite budget — that is what lets
      // the progress bar reach 100% instead of parking on a row nothing will
      // ever revisit.
      // A provider counts as configured if one is LIVE in memory OR persisted on
      // disk from a prior session (a main restart may not have re-applied it yet
      // — that's 'not-ready', not 'no-provider'). The `||` short-circuits when a
      // live config exists, so the disk read only happens on the no-AI path we
      // want to finalize + quiet — never on the hot AI-on path.
      const providerConfigured = !!aiConfig || !!loadPipelineAIConfigSync();
      const outcome = classifyCategorizationPass({
        parseFailed: categorizationParseFailed,
        failed: categorizationFailed,
        skipped: categorizationSkipped,
        aiDisabledByUser,
        providerConfigured,
      });
      // Count the strike BEFORE deciding, and only for outcomes that carry a
      // budget. 'not-ready' deliberately gets none: AI being unavailable is a
      // global condition with its own error banner, so charging each email for
      // it would give up on the whole mailbox during one outage.
      const strikes =
        outcome === 'parse-failure' ? (repos.ai?.incrementParseFailureCount?.(emailId) ?? 0)
        : outcome === 'call-failure' ? (repos.ai?.incrementAgentFailureCount?.(emailId) ?? 0)
        : 0;
      const decision = decideCategorizationAction(outcome, strikes, MAX_API_RETRIES);
      const finalScore = { priorityScore, priorityTier, priorityReasoning, recommendedAction };

      if (decision.type === 'retry') {
        logger.warn(`[Pipeline:P2] categorization ${outcome} for ${emailId} ` +
          `(${strikes}/${decision.limit ?? '-'}) — leaving agent_status pending for retry`);
      } else if (outcome !== 'success') {
        // Finalized WITHOUT categories: strikes exhausted, AI off by the user's
        // choice, or no provider configured at all. The local behaviour score
        // still persists so Important-sort keeps working. markAgentGaveUp (not
        // markAgentDone) because it also stamps ai_processed_at — without that the
        // row stays in the dashboard's "unprocessed" denominator forever and the
        // bar sticks just short of 100% with nothing left running.
        if (outcome === 'no-provider') {
          // Expected steady state (AI on, nothing configured) — NOT a failure.
          // Keep it out of the log so it doesn't read as churn; the one-time
          // drain is enough. Trace-only for when someone is actively debugging.
          if (traceEnabled()) logger.trace(`[Pipeline:P2] no AI provider configured — finalizing ${emailId} with local score only`);
        } else {
          logger.warn(`[Pipeline:P2] categorization ${outcome} for ${emailId} ` +
            `after ${strikes} attempt(s) — giving up, marking done with local score only`);
        }
        repos.agent.markAgentGaveUp(emailId, finalScore);
      } else {
        // Success — clear any prior failure counts so a formerly-flaky email
        // doesn't carry stale strikes.
        repos.ai?.resetParseFailureCount?.(emailId);
        repos.ai?.resetAgentFailureCount?.(emailId);
        repos.agent.markAgentDone(emailId, finalScore);
        // Copy this categorization to the same message in other accounts, so a
        // dual-delivered mail shows the same badge everywhere — free.
        if (categories.length > 0) {
          propagateCategoriesToLinkedAccounts((email as any).messageId, categories, storage, {
            priorityScore, priorityTier, priorityReasoning, recommendedAction,
          });
        }
        // Durably record that this mail still needs its labels reconciled on the
        // connected account, THEN try immediately. The immediate try applies in
        // ~1-2s when connected; if disconnected (background account / restart
        // burst) label_status stays 'pending' and the Phase-3 drain does it later.
        // NOTE: we mirror even when categories is EMPTY — that's how a mail the AI
        // just cleared gets its now-stale account label STRIPPED (mirror handles
        // both apply and stale-removal).
        // Record what the AI actually decided BEFORE marking the label pending:
        // the drain mirrors from this column, so a crash between the two must
        // leave a row the drain skips, never one it mirrors from a stale verdict.
        repos.agent.recordAiCategories(emailId, encodeAiCategories(categories));
        repos.agent.markLabelPending(emailId);
        void mirrorCategoryLabels(storage, email, categories);
        // New-mail OS notification (backfill-safe + coalesced; default 'important'
        // mode filters on these AI categories). Best-effort — never blocks.
        notifyNewMail({
          emailId,
          accountId: getAccountIdForStorage(storage) ?? 'active',
          fromName: (email as any).fromName,
          fromAddress: (email as any).fromAddress,
          subject: (email as any).subject,
          date: (email as any).date,
          categories,
          tags: (email as any).tags,
          folderId: (email as any).folderId,
        });
      }
    }

    // 4. Auto-draft reply when pipeline proposes "reply" action
    if (proposed && (recommendedAction === 'reply' || recommendedAction === 'reply_all') && aiConfig) {
      autoDraftReply(emailId).catch(err =>
        logger.error(`[Pipeline] Auto-draft failed for ${emailId}:`, err)
      );
    }

    // On the no-live-provider path this is just the local score echo (no AI ran),
    // so keep it to trace — otherwise it prints per email every drain and reads
    // as "the AI pipeline is churning" when nothing AI is happening.
    if (aiConfig) {
      logger.info(`[Pipeline:P2] ✓ ${emailId} score=${priorityScore} tier=${priorityTier} cats=[${categories.join(',')}] action=${recommendedAction || 'none'} exec=${executed} prop=${proposed}`);
    } else if (traceEnabled()) {
      logger.trace(`[Pipeline:P2] ✓ (local-only) ${emailId} score=${priorityScore} tier=${priorityTier} action=${recommendedAction || 'none'}`);
    }

    // 5. Notify renderer
    const mainWindow = getMainWindow();
    if (mainWindow) {
      mainWindow.webContents.send('pipeline:email-processed', {
        emailId, priorityScore, priorityTier, priorityReasoning,
        categories, recommendedAction, executed, proposed,
      });
    }
  } catch (error) {
    logger.error(`[Pipeline] P2 error for ${emailId}:`, error);
  }
}

// ========== Auto-Draft Reply ==========

/**
 * Auto-draft a reply for an email that the pipeline identified as needing response.
 * Runs in background after decision is saved. Finds the pending decision and
 * updates it with the drafted reply body.
 *
 * Outcome semantics (owner-defined):
 *   - draftReplies ON (default): every successfully generated draft goes
 *     STRAIGHT to the IMAP Drafts folder (decision → status 'auto'). The
 *     Drafts folder IS the review step — no separate approval stage.
 *   - autoReply ON additionally: when confidence ≥ autoActThreshold and all
 *     safety gates pass, the reply is actually SENT via SMTP instead of
 *     drafted (decision → status 'auto' + user_feedback REPLY_SENT_FEEDBACK).
 *     See tryAutoSendReply for the full gate list; any failure falls back to
 *     the Drafts append.
 *   - A decision stays 'pending' only when draft generation itself failed
 *     (LLM error, or the IMAP append failed — draft body stays attached so
 *     "Needs your review" can still surface it).
 */
async function autoDraftReply(emailId: string): Promise<void> {
  const storage = getStorage();
  if (!storage || !aiConfig) return;

  const email = await storage.getEmail(emailId);
  if (!email) return;

  const repos = (storage as any).getRepositories();
  const agentRepo = repos?.agent;
  if (!agentRepo) return;

  // Find the pending decision for this email
  const decisions = await agentRepo.getPendingDecisions();
  const decision = decisions.find((d: any) => d.emailId === emailId && (d.proposedAction === 'reply' || d.proposedAction === 'reply_all'));
  if (!decision) return;

  // One draft per THREAD, not per email. If this isn't the latest email in
  // the thread, skip — a reply to the latest supersedes any earlier draft,
  // and drafting for every mid-thread message inflates the Drafts folder
  // without adding value (user only sends one reply). When a newer email
  // arrives later, that email's own run will supersede this one.
  try {
    if (email.threadId) {
      const latest = (storage as any).db?.prepare?.(`
        SELECT id FROM emails WHERE thread_id = ? ORDER BY date DESC LIMIT 1
      `)?.get(email.threadId) as any;
      if (latest?.id && latest.id !== emailId) {
        logger.info(`[Pipeline] Skip auto-draft for ${emailId} — not latest in thread ${email.threadId} (latest=${latest.id})`);
        return;
      }
    }
  } catch { /* non-fatal — fall through to draft */ }

  // User-intent gate: if the user explicitly dismissed a draft on this
  // thread recently, respect that and skip. MUST run BEFORE the supersede
  // step below — supersede writes rejected rows (resolved_at=now) on this
  // same thread, and matching those would block every thread from its 2nd
  // reply-worthy email onward. Exclude this file's own system rejections
  // so only genuine user dismissals count (user dismissals arrive via
  // agent:resolveProposal with no feedback string → user_feedback NULL).
  try {
    if (email.threadId) {
      const rejected = (storage as any).db?.prepare?.(`
        SELECT 1
          FROM agent_decisions d
          JOIN emails e ON e.id = d.email_id
         WHERE e.thread_id = ?
           AND d.status IN ('rejected', 'dismissed')
           AND (d.user_feedback IS NULL OR d.user_feedback NOT IN (
             'superseded-by-newer-email', 'user-not-addressed',
             'body-mention-weak', 'malformed-sender',
             'empty-draft-output', 'no-recipient'
           ))
           AND d.resolved_at >= unixepoch() - 14 * 86400
         LIMIT 1
      `)?.get(email.threadId) as any;
      if (rejected) {
        logger.info(`[Pipeline] Skip auto-draft for ${emailId} — user recently dismissed a draft in thread ${email.threadId}`);
        return;
      }
    }
  } catch { /* non-fatal */ }

  // Supersede any earlier pending auto-draft decisions on this thread so we
  // don't accumulate one per email. Resolve them as 'superseded' (stored as
  // 'auto' with a feedback marker so they drop out of pending and don't
  // pollute the Drafts folder with stale reply attempts). Replies the agent
  // actually SENT are excluded — they're history, not stale drafts, and
  // relabeling them 'rejected' would falsify the record.
  try {
    if (email.threadId) {
      const staleDecisions = (storage as any).db?.prepare?.(`
        SELECT d.id FROM agent_decisions d
          JOIN emails e ON e.id = d.email_id
         WHERE e.thread_id = ?
           AND d.email_id != ?
           AND d.status IN ('pending', 'auto')
           AND (d.user_feedback IS NULL OR d.user_feedback != ?)
           AND d.proposed_action IN ('reply', 'reply_all')
      `)?.all(email.threadId, emailId, REPLY_SENT_FEEDBACK) as any[];
      for (const s of staleDecisions || []) {
        await agentRepo.updateDecisionStatus(s.id, 'rejected', 'dismissed', 'superseded-by-newer-email');
      }
    }
  } catch { /* non-fatal */ }

  // Addressing gate: draft only when there's an explicit signal that the
  // email is FOR the user. Three signals count — TO field, body greeting
  // with user's name, or an @-mention. If none, skip regardless of what
  // the categorization AI's `shouldAutoDraft` said. This closes a loophole
  // where smaller LLMs produced drafts for team FYIs / loop-ins based on
  // any stray name reference in the body.
  const userEmail = serviceConfig.userEmail || '';
  const userName = serviceConfig.userName || '';
  const inTo = isUserInToField(email, userEmail);
  const mentioned = isUserMentionedInBody(email, userEmail, userName);
  if (!inTo && !mentioned) {
    logger.info(
      `[Pipeline] Skip auto-draft for ${emailId} — user not in TO and not addressed in body`,
    );
    await agentRepo.updateDecisionStatus(
      decision.id,
      'rejected',
      'dismissed',
      'user-not-addressed',
    );
    return;
  }

  try {
    const fromAddr = (email.fromAddress || '').toLowerCase();
    if (fromAddr) {
      const stats = (storage as any).db?.prepare?.(`
        SELECT
          SUM(CASE WHEN action_type = 'reply' AND sender_address = ? THEN 1 ELSE 0 END) AS repliedTo,
          SUM(CASE WHEN action_type = 'send' AND sender_address = ? THEN 1 ELSE 0 END) AS sentTo
        FROM user_action_log
      `)?.get(fromAddr, fromAddr) as any;
      const repliedTo = stats?.repliedTo || 0;
      const sentTo = stats?.sentTo || 0;

      // Body-only addressing (CC'd but named in the body) is a weaker
      // signal than direct TO — require at least one prior reply OR high
      // confidence from the AI. Keeps the "he explicitly asked me" case
      // working while still filtering "Hi team, and @Advik, heads up".
      if (!inTo && mentioned) {
        if (repliedTo === 0 && (decision.confidence || 0) < 0.85) {
          logger.info(
            `[Pipeline] Skip auto-draft for ${emailId} — body-mention only, no reply history, confidence ${decision.confidence}`,
          );
          await agentRepo.updateDecisionStatus(
            decision.id,
            'rejected',
            'dismissed',
            'body-mention-weak',
          );
          return;
        }
      }

      // Extra signal: local-part looks automated/transactional. These rarely
      // deserve a draft even if AI said should_auto_draft=true, because the
      // AI sometimes latches onto a polite closing line as "needs response".
      const atIdx = fromAddr.indexOf('@');
      const localPart = atIdx > 0 ? fromAddr.slice(0, atIdx) : '';
      const domainPart = atIdx > 0 ? fromAddr.slice(atIdx + 1) : '';
      const AUTOMATED_HINTS = /(^|[.\-_])(noreply|no-reply|donotreply|do-not-reply|notifications?|alerts?|mailer|mailer-daemon|postmaster|bounces?|automated|system|transactional|receipt|statement|billing|info|support-bot|hello)([.\-_]|$)/i;
      // Common transactional sub-domains used for outbound-only mail
      // (Anthropic billing, Stripe receipts, marketing platforms, etc.).
      // A reply to one of these either bounces or lands in a shared
      // mailbox nobody reads, so don't auto-draft.
      const TRANSACTIONAL_SUBDOMAIN = /^(mail|email|mailer|notify|notifications?|news|updates?|alerts?|marketing|reply|do-not-reply|bounce|bounces|receipts?|invoicing|billing|transactional|info|track|tracking|messages?|hello|comms?|relay|smtp\d*|em\d+|edm)\./i;
      const looksAutomated = AUTOMATED_HINTS.test(localPart) || TRANSACTIONAL_SUBDOMAIN.test(domainPart);

      // Malformed address (no @, or no usable local-part) — likely a
      // header-parsing artefact like `"Anthropic` where the display
      // name leaked into from_address. Refuse to draft; we'd be sending
      // to a bogus recipient.
      const malformed = atIdx <= 0 || !localPart || !domainPart;
      if (malformed) {
        logger.info(`[Pipeline] Skip auto-draft for ${emailId} — malformed sender address "${fromAddr}"`);
        await agentRepo.updateDecisionStatus(decision.id, 'rejected', 'dismissed', 'malformed-sender');
        return;
      }

      // Hard skip: zero two-way history AND sender looks automated.
      if (repliedTo === 0 && sentTo === 0 && looksAutomated) {
        logger.info(`[Pipeline] Skip auto-draft for ${emailId} — no two-way history with automated-looking sender ${fromAddr}`);
        return;
      }

      // Soft skip: completely cold sender (no history) AND AI confidence is
      // below a high bar. The AI should only be trusted to initiate replies
      // to strangers when it's very confident (e.g. a direct personal ask
      // from a clearly-named human). Otherwise we wait for the user to
      // engage first.
      if (repliedTo === 0 && sentTo === 0 && (decision.confidence || 0) < 0.85) {
        logger.info(`[Pipeline] Skip auto-draft for ${emailId} — cold sender (${fromAddr}) with only ${decision.confidence} confidence`);
        return;
      }
    }
  } catch (err) {
    logger.warn('[Pipeline] Relationship gate check failed, continuing:', err);
  }

  // The AI's `should_auto_draft` decision already weighed reply-worthiness,
  // direct-addressing, contact type, and no-reply patterns (see the
  // categorization prompt in categorization-utils.ts). The pipeline only
  // proposes 'reply' when that field was true. User intent (recently
  // dismissed a draft on this thread) was checked above, before the
  // supersede step.

  logger.info(`[Pipeline] Auto-drafting reply for ${emailId}...`);

  try {
    const { AgentReplyDrafter, callAIWithRetry } = require('@sarvinbox/core');

    // ── Resolve user identity with a 4-tier priority chain ───────────────
    // Without this the LLM only sees the email local-part ("advik.d") and happily
    // refers to the user in the third person ("copy Advik on it") when a
    // thread mentions their real name.
    //   1. Profile Information → Full Name (pushed from Settings via IPC)
    //   2. accounts.name (entered during IMAP setup)
    //   3. Match incoming email's to/cc recipients to an account address,
    //      use the display name that arrived on that header line
    //   4. Fallback: split the email local-part
    // Tier 2: shared identity resolver (registry-first, legacy accounts table
    // fallback) — the same source every other pipeline path uses.
    const identity = resolveAccountIdentity(storage);
    const userEmail = identity.email;
    let userName = identity.name;
    const userAliases: string[] = identity.aliases;

    // Tier 1: profile name pushed from Settings (highest priority)
    if (serviceConfig.userName && serviceConfig.userName.trim()) {
      userName = serviceConfig.userName.trim();
    }

    // Tier 3: if still nothing, scan the incoming email's to/cc headers for
    //         an address that matches any of our accounts, use its display
    //         name. Handles multi-recipient emails where we need to find
    //         which "to" entry is us.
    if (!userName) {
      try {
        const tryMatchRecipient = (addrs: string | null, names: string | null): string | null => {
          if (!addrs) return null;
          const addrList = addrs.split(',').map(s => s.trim().toLowerCase());
          const nameList = (names || '').split(',').map(s => s.trim());
          for (let i = 0; i < addrList.length; i++) {
            if (userAliases.includes(addrList[i]) && nameList[i]) {
              return nameList[i].replace(/^["']|["']$/g, '');
            }
          }
          return null;
        };
        userName =
          tryMatchRecipient(email.toAddress, email.toNames) ||
          tryMatchRecipient(email.ccAddress, email.ccNames) ||
          '';
      } catch {}
    }

    // Tier 4: last-resort email prefix
    if (!userName) {
      userName = userEmail.split('@')[0] || '';
    }

    const drafter = new AgentReplyDrafter({
      userEmail,
      userName,
      userAliases,
      callAI: async (sys: string, msg: string) => {
        return callAIWithRetry(aiConfig!, sys, msg);
      },
      getPromptTemplate: (id: 'agent_plan' | 'agent_draft') => {
        try {
          const r = (storage as any).getRepositories?.()?.prompts;
          return r?.getContent?.(id) || null;
        } catch { return null; }
      },
      getNotes: (e: string) => agentRepo.getNotesForPrompt(e),
      getThreadMessages: (threadId: string) => {
        // Preferred source: the "chat view" conversation extraction
        // (conversation_extractions row). This is the SAME data the user
        // sees in ThreadChatView — individual messages already split out
        // from quoted/forwarded content, so if the user was looped in
        // mid-thread we still get every earlier message as its own entry.
        //
        // Fallback: raw thread emails from storage, merged with subject/
        // recipient info which the chat-view payload doesn't carry.
        try {
          const aliasSet = new Set(userAliases);
          const splitList = (s: string | null) =>
            (s || '').split(',').map(x => x.trim()).filter(Boolean);
          const labelRecipients = (addrs: string[], names: string[]): string[] =>
            addrs.map((a, i) => {
              const n = (names[i] || '').replace(/^["']|["']$/g, '').trim();
              return n ? `${n} <${a}>` : a;
            });

          // Load raw emails once — we need them either way (as fallback or
          // to enrich chat-view messages with subject/to/cc). NOTE:
          // storage.getEmailsByThread is async, but this callback must stay
          // synchronous for AgentReplyDrafter — read via better-sqlite3
          // directly, like the other raw queries in this file.
          const rawEmails = ((storage as any).db?.prepare?.(`
            SELECT id, message_id AS messageId, subject,
                   from_address AS fromAddress, from_name AS fromName,
                   to_address AS toAddress, to_names AS toNames,
                   cc_address AS ccAddress, cc_names AS ccNames,
                   date,
                   -- Both bodies through email_bodies: migration 73 empties the
                   -- inline columns, and chat-view extraction fed an empty body
                   -- produces a confidently wrong summary rather than an error.
                   ${rawBodyExpression()} AS rawBody,
                   ${cleanBodyExpression()} AS cleanBody
              FROM emails
             WHERE thread_id = ?
          `)?.all(threadId) || []) as any[];
          const rawById = new Map<string, any>();
          for (const e of rawEmails) rawById.set(e.id, e);

          // Try the chat-view extraction
          const repos = (storage as any).getRepositories?.();
          const convRow: any = repos?.ai?.getConversation
            ? // getConversation is async in the repo but synchronous at the
              // SQLite layer; call via better-sqlite3 prepare directly
              (storage as any).db?.prepare?.(
                'SELECT messages FROM conversation_extractions WHERE thread_id = ?'
              )?.get(threadId)
            : null;

          if (convRow?.messages) {
            try {
              const chatMessages = JSON.parse(convRow.messages) as Array<{
                fromAddress: string;
                fromName: string | null;
                toAddress: string;
                date: number;
                body: string;
                sourceEmailId: string;
              }>;
              const sorted = [...chatMessages].sort((a, b) => (a.date || 0) - (b.date || 0));
              return sorted.map(m => {
                // Enrich with subject + full recipient list from the source email
                const src = rawById.get(m.sourceEmailId);
                const fromAddr = (m.fromAddress || '').toLowerCase();
                const fromLabel = m.fromName
                  ? `${m.fromName} <${m.fromAddress}>`
                  : (m.fromAddress || '');
                // Compress body — chat-view bodies may still carry HTML
                // chrome that bloats the drafter prompt. cleanEmailHtmlForLLM
                // strips CSS/images/MSO/wrapping while preserving text +
                // basic structure. 2KB cap per message keeps long threads
                // within budget.
                const compressedBody = cleanEmailHtmlForLLM(m.body || '', { maxLength: 2000 });
                return {
                  messageId: src?.messageId || null,
                  subject: src?.subject || null,
                  from: fromLabel,
                  to: src
                    ? labelRecipients(splitList(src.toAddress), splitList(src.toNames))
                    : splitList(m.toAddress),
                  cc: src
                    ? labelRecipients(splitList(src.ccAddress), splitList(src.ccNames))
                    : [],
                  date: new Date((m.date || 0) * 1000).toISOString(),
                  body: compressedBody,
                  isFromUser: aliasSet.has(fromAddr),
                };
              });
            } catch (err) {
              logger.warn('[Pipeline] chat-view JSON parse failed, falling back to raw:', err);
            }
          }

          // Fallback: no extraction yet — use raw thread emails. Apply
          // the same cleanEmailHtmlForLLM compression so the drafter
          // doesn't see raw HTML chrome / inline base64 images.
          const sorted = [...rawEmails].sort((a, b) => (a.date || 0) - (b.date || 0));
          return sorted.map((e: any) => {
            const fromAddr = (e.fromAddress || '').toLowerCase();
            const fromLabel = e.fromName
              ? `${e.fromName} <${e.fromAddress}>`
              : (e.fromAddress || '');
            const rawBody = e.rawBody || e.cleanBody || '';
            const compressedBody = cleanEmailHtmlForLLM(rawBody, { maxLength: 2000 });
            return {
              messageId: e.messageId || null,
              subject: e.subject || null,
              from: fromLabel,
              to: labelRecipients(splitList(e.toAddress), splitList(e.toNames)),
              cc: labelRecipients(splitList(e.ccAddress), splitList(e.ccNames)),
              date: new Date((e.date || 0) * 1000).toISOString(),
              body: compressedBody,
              isFromUser: aliasSet.has(fromAddr),
            };
          });
        } catch { return []; }
      },
      getSenderMemory: (e: string) => {
        try {
          const row = (storage as any).db?.prepare?.(
            'SELECT greeting, closing, tone FROM sender_stats WHERE email = ?'
          )?.get(e.toLowerCase()) as any;
          return { greeting: row?.greeting || null, closing: row?.closing || null, tone: row?.tone || null };
        } catch { return { greeting: null, closing: null, tone: null }; }
      },
      searchEmails: (query: string, options?: { from?: string; limit?: number }) => {
        try {
          const results = (storage as any).fullTextSearch?.(query, {
            from: options?.from,
            limit: options?.limit || 5,
          }) || [];
          return results.map((r: any) => ({
            id: r.id,
            subject: r.subject || '',
            from: r.fromAddress || '',
            date: r.date,
            snippet: (r.cleanBody || '').substring(0, 200),
          }));
        } catch { return []; }
      },
      // Only expose web search when user has enabled it AND provided a Tavily key
      ...(() => {
        const pipelineConfig = pipeline?.getConfig();
        const webEnabled = pipelineConfig?.searchWebEnabled;
        const tavilyKey = pipelineConfig?.tavilyApiKey;
        if (!webEnabled || !tavilyKey) return {};
        return {
          searchWeb: async (query: string) => {
            try {
              const { net } = require('electron');
              return await new Promise<Array<{ title: string; url: string; snippet: string }>>((resolve) => {
                const request = net.request({
                  method: 'POST',
                  url: 'https://api.tavily.com/search',
                });
                request.setHeader('Content-Type', 'application/json');
                let body = '';
                request.on('response', (response: any) => {
                  response.on('data', (chunk: Buffer) => { body += chunk.toString(); });
                  response.on('end', () => {
                    try {
                      const data = JSON.parse(body);
                      const results = (data.results || []).slice(0, 5).map((r: any) => ({
                        title: r.title || '',
                        url: r.url || '',
                        snippet: r.content || '',
                      }));
                      resolve(results);
                    } catch { resolve([]); }
                  });
                });
                request.on('error', () => resolve([]));
                request.write(JSON.stringify({
                  api_key: tavilyKey,
                  query,
                  max_results: 3,
                  search_depth: 'basic',
                }));
                request.end();
              });
            } catch { return []; }
          },
        };
      })(),
    });

    const draftResult = await drafter.draftReply(email);

    // Refuse to persist an empty or whitespace-only draft. The LLM sometimes
    // returns an empty body (rate limit, bad prompt, model refusal, etc.),
    // and we were still writing that as an IMAP draft — so Gmail's Drafts
    // folder filled with blank "Re: ..." entries with nothing to send.
    const bodyText = String(draftResult.body || '').trim();
    if (!bodyText) {
      logger.info(`[Pipeline] Skip auto-draft for ${emailId} — LLM returned empty body`);
      await agentRepo.updateDecisionStatus(decision.id, 'rejected', 'dismissed', 'empty-draft-output');
      return;
    }

    // Refuse to save a draft with no recipient — the To header comes from
    // email.fromAddress, and if that's empty (parsing glitch, malformed
    // envelope) the draft would show up in Gmail as a fresh compose with
    // no To and no subject. Better to skip than dump garbage in Drafts.
    if (!email.fromAddress?.trim()) {
      logger.info(`[Pipeline] Skip auto-draft for ${emailId} — no sender address to reply to`);
      await agentRepo.updateDecisionStatus(decision.id, 'rejected', 'dismissed', 'no-recipient');
      return;
    }

    // Save draft to the decision row
    agentRepo.updateDecisionDraft(decision.id, {
      body: draftResult.body,
      reasoning: draftResult.reasoning,
    });

    logger.info(`[Pipeline] ✓ Auto-drafted reply for ${emailId} (${draftResult.searchesPerformed.length} searches)`);

    // ── Shared MIME ingredients ─────────────────────────────────────────
    // Auto-send and the Drafts append must build the SAME reply: identical
    // subject, threading headers, and HTML body — only the destination
    // differs (SMTP outbox vs IMAP Drafts).
    const accountEmail = serviceConfig.userEmail || '';
    const accountName = serviceConfig.userName || '';
    // Convert plain-text draft body into simple HTML paragraphs so the
    // inline editor can render it faithfully when the draft is restored.
    const htmlBody = String(draftResult.body || '')
      .split('\n')
      .map(line => `<p>${line ? escapeHtml(line) : '&nbsp;'}</p>`)
      .join('');
    const subject = draftResult.subject || (email.subject?.startsWith('Re:') ? email.subject : `Re: ${email.subject || ''}`);
    // Build the References chain the way RFC 5322 expects: parent's own
    // References header (if any) + parent's Message-ID. Without this,
    // Gmail/Outlook show our draft as a brand-new email rather than a
    // reply under the original thread.
    const parentRefs = (email as any).references || '';
    const parentMsgId = email.messageId || '';
    const referencesChain = [parentRefs, parentMsgId]
      .filter(Boolean)
      .join(' ')
      .trim();

    // ── True auto-send (autoReply ON) ───────────────────────────────────
    // When every gate passes, the reply is SENT via SMTP instead of saved
    // as a draft. Any failure (or any gate not met) falls through to the
    // Drafts append below so nothing is ever lost.
    const sentViaSmtp = await tryAutoSendReply({
      email,
      decision,
      agentRepo,
      draftBody: draftResult.body || '',
      draftReasoning: draftResult.reasoning || '',
      htmlBody,
      subject,
      referencesChain,
      userAliases,
    });
    if (sentViaSmtp) return;

    // Also save the draft to the IMAP Drafts folder so it appears alongside
    // the user's own saved drafts and auto-surfaces when the thread is re-opened.
    try {
      const result = await saveDraftToIMAP({
        to: email.fromAddress || '',
        subject,
        body: draftResult.body || '',
        htmlBody,
        // Only use a real Message-ID; email.id is an internal row id that
        // would break threading headers if sent in place of a Message-ID.
        inReplyTo: email.messageId || undefined,
        references: referencesChain || undefined,
        accountEmail,
        accountName,
        threadId: email.threadId,
        accountId: (email as any).accountId,
      } as any);
      if (result.success) {
        logger.info(`[Pipeline] ✓ AI draft saved to IMAP Drafts for ${emailId}`);
        // Mark the decision as a completed agent action (not pending) so it
        // appears in the Activity Log as "drafted" instead of accumulating in
        // an unused approval queue.
        try {
          await agentRepo.updateDecisionStatus(
            decision.id,
            'auto',
            decision.proposedAction,
            'draft saved to Drafts folder',
          );
        } catch (err) {
          logger.warn(`[Pipeline] Could not mark decision ${decision.id} as auto:`, err);
        }
        // Log in the user_action_log timeline (source='agent_auto') so the
        // Activity Log tab shows the draft alongside auto-read / auto-archive
        // actions. The agent's two surfaces of autonomous work — mark-read and
        // draft-reply — both land in the same log.
        logUserAction(emailId, decision.proposedAction as UserActionType, {
          threadId: email.threadId,
          senderAddress: email.fromAddress,
          source: 'agent_auto',
        });
      } else {
        logger.warn(`[Pipeline] IMAP draft save failed for ${emailId}: ${result.error}`);
      }
    } catch (err) {
      logger.error(`[Pipeline] IMAP draft save error for ${emailId}:`, err);
    }

    // Notify renderer that draft is ready
    const mainWindow = getMainWindow();
    if (mainWindow) {
      mainWindow.webContents.send('agent:draft-ready', {
        emailId,
        decisionId: decision.id,
        draftBody: draftResult.body,
      });
    }
  } catch (error) {
    logger.error(`[Pipeline] Auto-draft error for ${emailId}:`, error);
  }
}

/**
 * Attempt to actually SEND a drafted reply via SMTP (config.autoReply = true
 * auto-send). Returns true only when the reply was sent and the decision was
 * resolved — the caller then skips the Drafts append. Returns false for ANY
 * unmet gate or failure so the caller falls back to saving a draft:
 *
 *   - autoReply off, or confidence < autoActThreshold
 *   - drafter signaled a fallback/salvage body (never send those)
 *   - sender matches neverAutoReplyTo (re-verified at send time)
 *   - testMode (logs "[test mode] would send", draft is saved instead)
 *   - SMTP not connected (main can't connect on its own — renderer owns the
 *     credentials and connects lazily on first user send)
 *   - hourly maxAutoActionsPerHour budget exhausted (same counter as the
 *     pipeline's in-process auto-actions, via tryReserveAutoAction)
 *   - the SMTP submit itself fails
 */
async function tryAutoSendReply(params: {
  email: any;
  decision: any;
  agentRepo: any;
  draftBody: string;
  draftReasoning: string;
  htmlBody: string;
  subject: string;
  referencesChain: string;
  userAliases: string[];
}): Promise<boolean> {
  const { email, decision, agentRepo, draftBody, draftReasoning, htmlBody, subject, referencesChain, userAliases } = params;
  const emailId = email.id;

  const cfg = pipeline?.getConfig();
  if (!cfg?.autoReply) return false;

  const confidence = typeof decision.confidence === 'number' ? decision.confidence : 0;
  const threshold = typeof cfg.autoActThreshold === 'number' ? cfg.autoActThreshold : 0.85;
  if (confidence < threshold) {
    logger.info(`[Pipeline] Auto-send skipped for ${emailId} — confidence ${confidence} < threshold ${threshold}, saving draft instead`);
    return false;
  }

  // Never send a salvage body. The drafter falls back to dumping the cleaned
  // LLM text into `body` when JSON parsing fails ("Direct draft (JSON parse
  // failed)") — fine to park in Drafts for human eyes, never fine to send.
  if (/JSON parse failed|Draft skipped/i.test(draftReasoning)) {
    logger.info(`[Pipeline] Auto-send skipped for ${emailId} — drafter signaled fallback ("${draftReasoning}")`);
    return false;
  }
  if (!draftBody.trim()) return false; // caller already guards; belt-and-braces

  // Re-verify the neverAutoReplyTo safety list at send time (cheap, and the
  // list may have changed since the proposal was created). Same matching as
  // UnifiedPipeline.isSafeToAct: substring on sender address or domain.
  const sender = (email.fromAddress || '').toLowerCase();
  const senderDomain = sender.split('@')[1] || '';
  const blocked = (cfg.neverAutoReplyTo || []).some((s: string) => {
    const t = (s || '').toLowerCase().trim();
    return !!t && (sender.includes(t) || senderDomain.includes(t));
  });
  if (blocked) {
    logger.info(`[Pipeline] Auto-send skipped for ${emailId} — sender ${sender} matches neverAutoReplyTo`);
    return false;
  }

  // Test mode: everything except the actual SMTP send.
  if (cfg.testMode) {
    logger.info(`[Pipeline] [test mode] would send reply for ${emailId} (to=${sender}, confidence=${confidence}) — saving to Drafts instead`);
    return false;
  }

  // SMTP must already be connected (renderer connects it with its stored
  // credentials; main has no credential store to connect from).
  const smtp = getSmtpClient();
  if (!smtp || !smtp.isConnected()) {
    logger.warn(`[Pipeline] Auto-send skipped for ${emailId} — SMTP not connected, saving draft instead`);
    return false;
  }

  // Hourly autonomous-action budget — shared with in-pipeline auto-actions.
  if (!pipeline?.tryReserveAutoAction()) {
    logger.warn(`[Pipeline] Auto-send skipped for ${emailId} — maxAutoActionsPerHour reached, saving draft instead`);
    return false;
  }

  // ── Build send options exactly like the draft MIME ──
  const wrapId = (id: string) => (id.startsWith('<') ? id : `<${id}>`);
  const looksLikeMessageId = (id: string | null | undefined): id is string =>
    !!id && /@/.test(id) && !/\s/.test(id);

  // reply → original sender only (mirrors the draft's To header).
  // reply_all → original sender + everyone on the original To/Cc except our
  // own aliases and the sender (who is already in To).
  let cc: string[] | undefined;
  if (decision.proposedAction === 'reply_all') {
    const aliasSet = new Set(
      [...userAliases, serviceConfig.userEmail || ''].map(a => a.toLowerCase()).filter(Boolean),
    );
    const extractAddrs = (s: string | null | undefined) => (s || '').match(/[\w.+-]+@[\w.-]+/g) || [];
    const others = [...new Set(
      [...extractAddrs(email.toAddress), ...extractAddrs(email.ccAddress)].map(a => a.toLowerCase()),
    )].filter(a => !aliasSet.has(a) && a !== sender);
    if (others.length > 0) cc = others;
  }

  const sendOptions: any = {
    to: [email.fromAddress],
    subject,
    body: draftBody,
    htmlBody,
  };
  if (cc) sendOptions.cc = cc;
  if (looksLikeMessageId(email.messageId)) {
    sendOptions.inReplyTo = wrapId(email.messageId);
    const refs = referencesChain.split(/\s+/).filter(looksLikeMessageId).map(wrapId);
    sendOptions.references = refs.length > 0 ? refs : [sendOptions.inReplyTo];
  }

  try {
    const result = await sendEmailFromMain(sendOptions);
    if (!result?.success) {
      logger.warn(`[Pipeline] Auto-send FAILED for ${emailId} (${result?.error || 'unknown error'}) — falling back to Drafts`);
      return false;
    }

    logger.info(`[Pipeline] ✓ Auto-SENT reply for ${emailId} to ${sender}${cc ? ` (+${cc.length} cc)` : ''} messageId=${result.messageId || '?'}`);

    // Durable Sent copy. The agent sends OUTSIDE the outbox queue, so append the
    // Sent-folder copy here (best-effort) — otherwise an auto-sent reply exists
    // only as a local row and is lost off-device, exactly like a manual send
    // would be. Non-fatal: the send already succeeded.
    if (result.needsSentAppend && result.rawMessage && result.messageId) {
      try {
        await appendSentCopy(result.rawMessage, result.messageId, sendOptions);
      } catch (err) {
        logger.warn(`[Pipeline] Sent-folder append for auto-sent ${emailId} failed (non-fatal):`, (err as Error)?.message || err);
      }
    }

    // Resolve the decision: status 'auto' + the reply-sent feedback marker
    // (same status convention as drafted replies, distinct marker so the
    // dashboard can tell "sent for you" apart from "waiting in Drafts").
    try {
      await agentRepo.updateDecisionStatus(
        decision.id,
        'auto',
        decision.proposedAction,
        REPLY_SENT_FEEDBACK,
      );
    } catch (err) {
      logger.warn(`[Pipeline] Could not mark decision ${decision.id} as sent:`, err);
    }

    // Same activity-log surface as every other agent action (learning +
    // Activity feed + undo infrastructure all read user_action_log).
    // actionValue 'auto-sent' distinguishes it from a drafted reply.
    logUserAction(emailId, decision.proposedAction as UserActionType, {
      threadId: email.threadId,
      senderAddress: email.fromAddress,
      source: 'agent_auto',
      actionValue: 'auto-sent',
    });

    // Notify renderer. Reuses the agent:draft-ready channel with sent:true —
    // verified tolerable: AgentDashboard just refreshes; useEmailDetail's
    // handler looks up a |draft| row / pending proposal, finds neither for a
    // sent reply, and no-ops.
    const mainWindow = getMainWindow();
    if (mainWindow) {
      mainWindow.webContents.send('agent:draft-ready', {
        emailId,
        decisionId: decision.id,
        draftBody,
        sent: true,
      });
    }
    return true;
  } catch (err) {
    logger.error(`[Pipeline] Auto-send error for ${emailId} — falling back to Drafts:`, err);
    return false;
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ========== Category-label mirroring ==========
// Reflect AI categories onto the mail server so they're visible in the
// provider's own UI (Gmail labels, sarv keyword-labels, folders elsewhere).
// OFF by default; the renderer pushes the setting via pipeline:setCategoryLabels.

// Default ON to match the user-facing default (defaultSettings.categoryLabels)
// so provisioning runs even before/without the renderer's on-boot push. The
// push still flips it OFF for users who disabled it.
let categoryLabelConfig: { enabled: boolean; folderMode: FolderLabelMode } = { enabled: true, folderMode: 'copy' };

export function setCategoryLabelConfig(cfg: { enabled: boolean; folderMode: FolderLabelMode }): void {
  categoryLabelConfig = { enabled: !!cfg.enabled, folderMode: cfg.folderMode === 'move' ? 'move' : 'copy' };
}

/**
 * Resolve a valid Gmail API token by finding a stored GOOGLE-OAUTH account
 * (preferring one whose email matches `preferEmail`), rather than trusting the
 * pipeline's profile email. Returns null when no Gmail account is OAuth-
 * connected — the signal to leave labels plain (app-password / non-Gmail).
 */
async function resolveGmailToken(preferEmail?: string): Promise<string | null> {
  try {
    const gmails = (await listAccounts()).filter((a) => a.provider === 'gmail' && a.email);
    if (gmails.length === 0) {
      if (traceEnabled()) logger.trace('[Pipeline] resolveGmailToken: no gmail OAuth account on file → plain labels');
      return null;
    }
    const pick =
      (preferEmail && gmails.find((a) => a.email.toLowerCase() === preferEmail.toLowerCase())) || gmails[0];
    const token = await getValidAccessToken('gmail' as any, pick.email).catch((e) => {
      logger.warn(`[Pipeline] resolveGmailToken: token fetch failed for ${pick.email}:`, e?.message || e);
      return null;
    });
    if (traceEnabled()) logger.trace(`[Pipeline] resolveGmailToken: ${gmails.length} gmail account(s), token=${token ? 'yes' : 'no'} (${pick.email})`);
    return token;
  } catch (e) {
    logger.warn('[Pipeline] resolveGmailToken error:', (e as Error).message);
    return null;
  }
}

/**
 * Enqueue a single label op mirroring `categorySlugs` for `email` onto its
 * account's server (persist-first via the op queue → offline-safe, at-least-
 * once). Best-effort: never throws into categorization. For a Gmail account
 * connected over OAuth we additionally paint the label colors via the Gmail API;
 * everything else gets plain labels.
 */
/** A Gmail account, detected from its folder set (`[Gmail]/*` mailboxes). Only
 *  these get Gmail-API colouring; other accounts get plain IMAP labels. */
function isGmailAccount(folders: any[]): boolean {
  return folders.some((f: any) => (f.path || '').startsWith('[Gmail]'));
}

/**
 * Apply category labels to ONE email: on a Gmail account (and only there) create
 * + colour the nested label via the Gmail API first; then enqueue the IMAP
 * apply (keyword / copy-to-label / folder). Shared by the per-email hook and the
 * backfill so both behave identically.
 */
async function applyEmailLabels(
  engine: any,
  email: any,
  folderPath: string,
  cats: Array<{ slug: string; name: string }>,
  isGmail: boolean,
  token: string | null,
  bySlug: Map<string, { name?: string; color?: string }>,
): Promise<string> {
  const queue = engine?.operationQueue;
  if (!queue) return 'noop';
  // cats.length === 0 is VALID here: the mail lost all its categories, so we skip
  // the apply and fall straight to stale-removal below (strip every label).
  let res: string = 'success';
  if (cats.length > 0) {
    if (isGmail && token) {
      await ensureGmailLabelColor(token, SARV_LABEL_PARENT); // parent so children nest
      for (const c of cats) {
        await ensureGmailLabelColor(token, folderPathForCategory(c, '/'), bySlug.get(c.slug)?.color);
      }
    }
    res = await queue.applyCategoryLabels(folderPath, email.uid, { categories: cats, host: '', mode: categoryLabelConfig.folderMode });
  }

  // Gmail ONLY: reconcile away STALE labels. Mirroring is add-only (COPY), so a
  // re-categorised mail (e.g. reminders → invoice) would keep its old
  // "Sarv Inbox/Reminders" label forever. Strip every category label the mail
  // should NOT have — all defined categories minus the current set — in ONE
  // STORE -X-GM-LABELS command (no delete; a label the mail lacks is a no-op).
  // This keeps Gmail's labels == the app's categories. Best-effort.
  if (isGmail && typeof queue.removeGmailLabels === 'function') {
    const currentLabels = new Set(cats.map((c) => folderPathForCategory(c, '/')));
    const stale: string[] = [];
    for (const [slug, def] of bySlug) {
      const label = folderPathForCategory({ slug, name: def?.name || slug }, '/');
      if (!currentLabels.has(label)) stale.push(label);
    }
    if (stale.length) {
      try { await queue.removeGmailLabels(folderPath, email.uid, stale); }
      catch (e) { logger.warn('[Pipeline] stale Gmail label cleanup failed:', (e as Error).message); }
    }
  }

  // The op is persist-first: it executes inline ONLY when the account is
  // connected AND not mid-sync. A background account is almost always mid-sync
  // (realtime IDLE + periodic sync) when a fresh mail is categorized, so the op
  // is 'queued' and would otherwise wait for the NEXT sync's drain (~30s — the
  // delay the user saw). processQueue() only needs a connection (it ignores the
  // syncing flag), so nudge a drain now to apply the label in ~1-2s instead.
  if (res === 'queued' && typeof queue.processQueue === 'function') {
    setTimeout(() => { queue.processQueue().catch(() => { /* next sync drains it */ }); }, 1500);
  }
  return res;
}

/**
 * "engine not connected yet" is a PER-EMAIL condition on a burst: while an
 * account is (re)connecting, every categorized mail hits it, and the fresh
 * categorization and the Phase-3 label drain each try once — so a single burst
 * wrote hundreds of identical info lines, two per UID. The condition is worth
 * knowing about; each individual UID is not. Aggregate per account and emit one
 * line per window, which is the same treatment the IDLE-event storm gets.
 */
const MIRROR_DEFER_LOG_WINDOW_MS = 30_000;
const mirrorDeferrals = new LogAggregator<number>({
  windowMs: MIRROR_DEFER_LOG_WINDOW_MS,
  emit: (summary) => logger.info(
    `[Pipeline] mirror deferred (engine not connected yet) — ${summary};`
    + ' those messages stay label_status=pending and re-apply on the next drain',
  ),
  format: (entries) => entries
    .map(({ key, count, sample }) => `acct=${key}: ${count} message(s), first uid=${sample}`)
    .join(' | '),
});

const noteMirrorDeferred = (acct: string, uid: number): void => mirrorDeferrals.note(acct, uid);

async function mirrorCategoryLabels(storage: any, email: any, categorySlugs: string[]): Promise<void> {
  const acct = getAccountIdForStorage(storage) ?? 'active';
  try {
    // NOTE: an EMPTY categorySlugs is valid and MUST proceed — that's how a mail
    // the AI cleared gets its stale account labels stripped (applyEmailLabels
    // removes every label not in the current set). Only bail on genuinely bad input.
    if (!categoryLabelConfig.enabled || !email?.uid || !Array.isArray(categorySlugs)) return;

    // Resolve the engine STRICTLY from THIS email's own storage — the account
    // identity reliably threaded through the pipeline. The email row has no
    // accountId column, so any guess (the old `email.accountId`) fell back to
    // the ACTIVE engine and mis-labelled background accounts. We must NOT fall
    // back to the active engine here: doing so would copy this account's label
    // onto whatever account is active (exactly the bug we're killing). If the
    // account's own engine isn't available/connected yet, SKIP and log — the
    // label is re-applied later (next categorization / the backfill action).
    const engine: any = getSyncEngineForStorage(storage);
    if (!engine) {
      logger.warn(`[Pipeline] mirror skipped acct=${acct} uid=${email.uid}: no engine for this account's storage (won't apply to a wrong account)`);
      return;
    }
    if (!engine.isConnected?.() || !engine.operationQueue) {
      noteMirrorDeferred(acct, email.uid);
      return;
    }

    const folder = await storage.getFolder(email.folderId);
    if (!folder?.path) {
      logger.info(`[Pipeline] mirror skipped acct=${acct} uid=${email.uid}: folder ${email.folderId} has no path`);
      return;
    }

    const defs = storage.getCategoryDefinitions?.() ?? [];
    const bySlug = new Map<string, { name?: string; color?: string }>(defs.map((d: any) => [d.slug, d]));
    const cats = categorySlugs.map((slug) => ({ slug, name: bySlug.get(slug)?.name || slug }));

    const folders = await storage.getFolders();
    const isGmail = engine.operationQueue.isGmailCapable?.() ?? isGmailAccount(folders);
    const token = isGmail ? await resolveGmailToken(serviceConfig.userEmail || getPipelineUserEmail()) : null;
    if (traceEnabled()) logger.trace(`[Pipeline] mirror acct=${acct} uid=${email.uid} folder="${folder.path}" isGmail=${isGmail} token=${token ? 'yes' : 'no'} cats=[${cats.map((c) => c.slug).join(',')}]`);
    const result = await applyEmailLabels(engine, email, folder.path, cats, isGmail, token, bySlug);
    // Flip label_status → 'done' ONLY on a CONFIRMED apply. A merely-'queued' op
    // (background account mid-sync) is NOT yet on the server — if it later
    // dead-letters it would be silently lost, so we keep the mail 'pending' and
    // let the next drain re-apply (label ops are idempotent). This is the ONLY
    // place label_status flips 'pending'/NULL → 'done'.
    if (email.id && result !== 'queued') {
      try { (storage as any).getRepositories?.()?.agent?.markLabelDone?.(email.id); } catch { /* non-fatal */ }
    }
  } catch (e) {
    logger.warn(`[Pipeline] mirror acct=${acct} uid=${email?.uid} best-effort failed:`, (e as Error).message);
  }
}

/**
 * Backfill labels for ALREADY-categorized older mail: for each connected
 * account, take the most recent `limit` INBOX messages and mirror whatever
 * categories they already carry. Idempotent on Gmail (label) and keyword
 * servers; on folder-COPY providers it would re-copy, so it's a manual action,
 * not automatic. Returns how many mails were (re)labeled.
 */
export async function backfillCategoryLabels(limit = 50): Promise<{ accounts: number; labeled: number }> {
  // NOTE: intentionally does NOT gate on categoryLabelConfig.enabled — this is
  // an explicit user action ("Apply to recent mail"), so honor it even if the
  // on-boot enabled-push hasn't landed. Only the folderMode is taken from config.
  let accounts = 0, labeled = 0;
  for (const [, rt] of getAllAccountRuntimes()) {
    try {
      const storage: any = rt.storage;
      const engine: any = rt.syncEngine;
      if (!storage || !engine?.isConnected?.() || !engine.operationQueue) continue;
      accounts++;
      const defs = storage.getCategoryDefinitions?.() ?? [];
      const bySlug = new Map<string, { name?: string; color?: string }>(defs.map((d: any) => [d.slug, d]));
      const catSlugs = new Set<string>(defs.map((d: any) => d.slug));
      const folders = await storage.getFolders();
      const inbox = folders.find((f: any) => f.specialUse === '\\Inbox' || (f.path || '').toLowerCase() === 'inbox');
      if (!inbox) continue;
      const isGmail = engine.operationQueue.isGmailCapable?.() ?? isGmailAccount(folders);
      const token = isGmail ? await resolveGmailToken() : null;
      const emails = await storage.getEmailsByFolder(inbox.id, { limit, offset: 0 });
      for (const email of emails) {
        if (!email?.uid) continue;
        const cats = parseTags(email.tags || '')
          .filter((t) => catSlugs.has(t))
          .map((slug) => ({ slug, name: bySlug.get(slug)?.name || slug }));
        if (cats.length === 0) continue;
        await applyEmailLabels(engine, email, inbox.path, cats, isGmail, token, bySlug);
        labeled++;
      }
    } catch (e) {
      logger.warn('[Pipeline] backfill (one account) failed:', (e as Error).message);
    }
  }
  logger.info(`[Pipeline] category-label backfill: ${labeled} mail(s) across ${accounts} account(s)`);
  return { accounts, labeled };
}

/**
 * Proactively create the (empty) category labels on every provider that can
 * register a blank label up front:
 *  - Gmail — nested + coloured via the API for OAuth, else plain IMAP.
 *  - Folder providers — the "Sarv Inbox/<Category>" mailbox tree.
 *  - Keyword providers (Sarv) — `ensure()` now CREATEs the registering folder
 *    NESTED under "Sarv Inbox" (e.g. "Sarv Inbox/finance") and prunes the legacy
 *    flat top-level one. (Previously skipped, so Sarv labels only appeared as
 *    mail was tagged; they're now provisioned up front like the others.)
 * Idempotent; safe to re-run. Runs when mirroring is enabled and from the
 * "Apply to recent mail" action.
 */
/**
 * Provision one account's labels. Returns `handled: true` ONLY when the account
 * was actually online and its labels were ensured (idempotent — a re-run that
 * creates nothing is still handled). `handled: false` means the account wasn't
 * connected/ready, so a caller tracking "provisioned this session" must NOT mark
 * it done (it needs to retry on a later connect). Never throws.
 */
async function provisionAccountLabels(rt: { storage: any; syncEngine: any } | undefined): Promise<{ handled: boolean; created: number }> {
  try {
    const storage: any = rt?.storage;
    const engine: any = rt?.syncEngine;
    if (!storage || !engine?.isConnected?.() || !engine.operationQueue) return { handled: false, created: 0 };
    const defs = (storage.getCategoryDefinitions?.() ?? []).filter(
      (d: any) => d.isEnabled !== 0 && d.isEnabled !== false,
    );
    const bySlug = new Map<string, { name?: string; color?: string }>(defs.map((d: any) => [d.slug, d]));
    const cats = defs.map((d: any) => ({ slug: d.slug, name: d.name || d.slug }));
    if (cats.length === 0) return { handled: true, created: 0 };
    const folders = await storage.getFolders();
    const isGmail = engine.operationQueue.isGmailCapable?.() ?? isGmailAccount(folders);
    const token = isGmail ? await resolveGmailToken() : null;
    let created = 0;
    if (isGmail && token) {
      // Count only labels we ACTUALLY created/recoloured (ensureGmailLabelColor
      // returns false when the label already exists with the right colour), so a
      // repeat provisioning pass is a no-op that reports created=0 and stays
      // quiet — no re-hitting the Gmail API to recolour what's already correct.
      if (await ensureGmailLabelColor(token, SARV_LABEL_PARENT)) created++; // parent so children nest
      for (const c of cats) {
        if (await ensureGmailLabelColor(token, folderPathForCategory(c, '/'), bySlug.get(c.slug)?.color)) created++;
      }
    } else {
      created = await engine.operationQueue.ensureCategoryLabelsExist(cats, categoryLabelConfig.folderMode);
    }
    return { handled: true, created };
  } catch (e) {
    logger.warn('[Pipeline] provision (one account) failed:', (e as Error).message);
    return { handled: false, created: 0 };
  }
}

// Coalesce concurrent provisioning passes (connect triggers + the 0/20/60s
// schedule + category-change all call this). Without this, two overlapping runs
// each walk every account and hit the Gmail API in parallel — the doubled
// "colored"/"provisioned" logs. Overlapping callers share the one in-flight run.
let provisionInFlight: Promise<{ accounts: number; created: number }> | null = null;
export async function provisionCategoryLabels(): Promise<{ accounts: number; created: number }> {
  if (provisionInFlight) return provisionInFlight;
  provisionInFlight = (async () => {
    let accounts = 0, created = 0;
    for (const [, rt] of getAllAccountRuntimes()) {
      const { handled, created: n } = await provisionAccountLabels(rt);
      if (handled) { accounts++; created += n; }
    }
    // Only log when something actually changed — a repeat pass that finds every
    // label already present + correctly coloured stays silent.
    if (created > 0) logger.info(`[Pipeline] provisioned ${created} category label(s) across ${accounts} account(s)`);
    return { accounts, created };
  })();
  try { return await provisionInFlight; } finally { provisionInFlight = null; }
}

/**
 * Provision now, then retry a couple of times — background accounts (e.g. a
 * Gmail account while sarv is active) connect AFTER the on-enable trigger fires,
 * so a single immediate pass misses them. Idempotent, so the retries are safe.
 */
export function scheduleProvisionCategoryLabels(): void {
  void provisionCategoryLabels();
  setTimeout(() => { void provisionCategoryLabels(); }, 20_000).unref?.();
  setTimeout(() => { void provisionCategoryLabels(); }, 60_000).unref?.();
}

/**
 * Call when a category DEFINITION is added/changed. When mirroring is on, this
 * (re)provisions labels across every connected account so a new category's label
 * shows up everywhere. Idempotent — existing labels are skipped; only the new
 * one gets created. No-op when mirroring is off.
 */
export function onCategoryDefinitionsChanged(): void {
  if (categoryLabelConfig.enabled) void provisionCategoryLabels();
}

// Accounts already provisioned this session (avoids re-running on every sync).
const provisionedThisSession = new Set<string>();
// Accounts with a provisioning pass IN FLIGHT — prevents two near-simultaneous
// connect events for the SAME account from both provisioning it (double Gmail
// API work). Distinct from provisionedThisSession, which records SUCCESS.
const provisioningNow = new Set<string>();

/**
 * Provision labels once an account has actually CONNECTED. This is the reliable
 * trigger (event-driven, not timing-based): each account gets its blank labels
 * created the moment it comes online, no matter how late that is. Guarded so it
 * runs at most once per account per session.
 */
export function provisionCategoryLabelsOnConnect(accountId: string | null | undefined): void {
  if (!categoryLabelConfig.enabled || !accountId) return;
  if (provisionedThisSession.has(accountId) || provisioningNow.has(accountId)) return;
  // Provision THIS specific account, and only record it as done if it was
  // actually online and handled. Marking on *attempt* (the old bug) stranded an
  // account whose engine wasn't connected at this instant — the per-session
  // guard consumed the trigger and it never retried until restart. Now a failed
  // attempt leaves the account un-recorded, so the next connect/sync retries it.
  // provisioningNow dedupes concurrent connect events for the same account.
  provisioningNow.add(accountId);
  void (async () => {
    try {
      const { handled } = await provisionAccountLabels(getAccountRuntime(accountId));
      if (handled) provisionedThisSession.add(accountId);
    } finally {
      provisioningNow.delete(accountId);
    }
  })();
}

/** Snapshot of what mirroring can currently see — for the in-app diagnostic. */
export function getCategoryLabelDiag(): { enabled: boolean; connected: number; gmail: number } {
  let connected = 0, gmail = 0;
  for (const [, rt] of getAllAccountRuntimes()) {
    const engine: any = rt.syncEngine;
    if (!engine?.isConnected?.() || !engine.operationQueue) continue;
    connected++;
    if (engine.operationQueue.isGmailCapable?.()) gmail++;
  }
  return { enabled: categoryLabelConfig.enabled, connected, gmail };
}

/** Rename a category's server label in place across every connected account
 *  (Gmail via the API, others via IMAP RENAME; keyword providers no-op). */
export async function renameCategoryLabelEverywhere(oldName: string, newName: string): Promise<void> {
  if (!oldName || !newName || oldName === newName) return;
  for (const [, rt] of getAllAccountRuntimes()) {
    try {
      const engine: any = rt.syncEngine;
      const queue = engine?.operationQueue;
      if (!engine?.isConnected?.() || !queue) continue;
      const isGmail = queue.isGmailCapable?.();
      const token = isGmail ? await resolveGmailToken() : null;
      if (isGmail && token) {
        await renameGmailLabel(token, folderPathForCategory({ slug: '', name: oldName }, '/'), folderPathForCategory({ slug: '', name: newName }, '/'));
      } else {
        await queue.renameCategoryLabel({ slug: '', name: oldName }, { slug: '', name: newName }, categoryLabelConfig.folderMode);
      }
    } catch (e) {
      logger.warn('[Pipeline] rename label (one account) failed:', (e as Error).message);
    }
  }
}

/**
 * Called after a category definition is upserted. When mirroring is on: if the
 * display name changed, rename the server label in place; then (re)provision so
 * a brand-new category's label is created everywhere. No-op when mirroring off.
 */
export async function onCategoryDefinitionUpserted(oldName: string | undefined, newName: string | undefined): Promise<void> {
  if (!categoryLabelConfig.enabled) return;
  if (oldName && newName && oldName !== newName) {
    await renameCategoryLabelEverywhere(oldName, newName);
  }
  void provisionCategoryLabels();
}

/**
 * The "Remove all Sarv Inbox labels" cleanup: delete the whole `Sarv Inbox`
 * label/folder subtree on every connected account (Gmail via the API, others
 * via IMAP). Keyword providers (sarv) are left as-is — a keyword isn't
 * bulk-removable here; the user clears those in webmail. Returns the count.
 */
export async function removeAllCategoryLabels(): Promise<{ accounts: number; removed: number }> {
  let accounts = 0, removed = 0;
  for (const [, rt] of getAllAccountRuntimes()) {
    try {
      const engine: any = rt.syncEngine;
      const queue = engine?.operationQueue;
      if (!engine?.isConnected?.() || !queue) continue;
      accounts++;
      const isGmail = queue.isGmailCapable?.();
      const token = isGmail ? await resolveGmailToken() : null;
      if (isGmail && token) {
        removed += await deleteGmailLabelsUnder(token, SARV_LABEL_PARENT);
      } else {
        removed += await queue.removeSarvInboxLabels(categoryLabelConfig.folderMode);
      }
    } catch (e) {
      logger.warn('[Pipeline] remove labels (one account) failed:', (e as Error).message);
    }
  }
  logger.info(`[Pipeline] removed ${removed} Sarv Inbox label(s) across ${accounts} account(s)`);
  return { accounts, removed };
}

// ========== Action Execution ==========

async function executeAgentAction(emailId: string, action: UserActionType, _value?: string): Promise<void> {
  const storage = getStorage();
  if (!storage) return;
  const email = await storage.getEmail(emailId);
  if (!email) return;

  const testMode = serviceConfig.testMode || false;
  const tags = email.tags || '||';

  // Update local DB
  if (action === 'read' && !tags.includes('|read|')) {
    const tl = tags.split('|').filter((t: string) => t.length > 0); tl.push('read');
    await storage.updateEmail(emailId, { tags: '|' + tl.join('|') + '|' });
  } else if (action === 'star' && !tags.includes('|starred|')) {
    const tl = tags.split('|').filter((t: string) => t.length > 0); tl.push('starred');
    await storage.updateEmail(emailId, { tags: '|' + tl.join('|') + '|' });
  } else if (action === 'archive') {
    const folders = await storage.getFolders();
    const af = folders.find((f: any) => f.path === '[Gmail]/All Mail' || f.path.toLowerCase().includes('archive'));
    if (af) await storage.updateEmail(emailId, { folderId: af.id });
  } else if (action === 'spam') {
    const folders = await storage.getFolders();
    const sf = folders.find((f: any) => f.path.toLowerCase().includes('spam') || f.path === '[Gmail]/Spam');
    if (sf) await storage.updateEmail(emailId, { folderId: sf.id });
  }

  // IMAP sync (skip in testMode)
  if (!testMode) {
    const syncEngine = getSyncEngine();
    // NOT gated on isConnected(). These calls go through the operation queue,
    // which exists to persist an op while offline and replay it on reconnect —
    // the same path a user-initiated mark-read takes. Checking isConnected()
    // first threw that away: the local `|read|` tag was applied unconditionally
    // above, and when IMAP happened to be down the IMAP half was silently
    // dropped instead of queued. Nothing ever retried it, so the message stayed
    // read here and unread on the server forever. Observed in the field on mail
    // the Activity log showed as auto-read by the agent.
    if (syncEngine && email.uid) {
      const folder = await storage.getFolder(email.folderId);
      if (folder) {
        // Failures are logged, never swallowed to console (CLAUDE.md: always the
        // shared logger). A dropped line here is a divergence nobody can see.
        const onFail = (what: string) => (err: unknown) =>
          logger.error(`[Pipeline] agent ${what} did not reach IMAP for ${emailId}:`, err);
        if (action === 'read') syncEngine.markAsRead(folder.path, email.uid).catch(onFail('mark-read'));
        else if (action === 'star') syncEngine.markAsStarred(folder.path, email.uid, true).catch(onFail('star'));
        else if (action === 'archive') (syncEngine as any).operationQueue?.archive(folder.path, email.uid).catch(onFail('archive'));
      }
    }
  }

  logUserAction(emailId, action, { threadId: email.threadId, senderAddress: email.fromAddress, source: 'agent_auto' });
  logger.info(`[Pipeline] Executed ${action} on ${emailId} ${testMode ? '(testMode)' : '(+IMAP)'}`);
}

// ========== Event Trigger ==========

/**
 * Find the account storage that actually CONTAINS `emailId`. Email ids are
 * globally unique (per-account hash prefix), and the email:synced / body-ready
 * events don't carry a reliable accountId (the emails table has no accountId
 * column, and the sync engine doesn't know its own account). So — rather than
 * mis-routing a background account's new mail to the ACTIVE storage (where it
 * isn't found, so it silently waits for the 30s poll) — we resolve the real
 * owning account by a cheap indexed lookup, trying the hint first. This is what
 * makes event-driven categorization work for BACKGROUND accounts, not just the
 * active one.
 */
function findStorageForEmail(emailId: string, hintAccountId?: string): any | null {
  const has = (s: any) => !!s?.db?.prepare?.('SELECT 1 FROM emails WHERE id = ? LIMIT 1')?.get(emailId);
  if (hintAccountId) { const s = getStorageFor(hintAccountId); if (has(s)) return s; }
  const active = getStorage(); if (has(active)) return active;
  for (const [, rt] of getAllAccountRuntimes()) { if (has(rt.storage)) return rt.storage; }
  return null;
}

/** Categorize a freshly-available email now (event-driven). Shared by the
 *  email:synced and body-ready handlers. Resolves the OWNING account, gates on
 *  body-present / not-read / not-done, then runs the pipeline. */
async function triggerCategorizeFor(emailId: string, hintAccountId?: string, source = 'event'): Promise<void> {
  const storage = findStorageForEmail(emailId, hintAccountId);
  if (!storage) return; // not yet in any db — the 30s poll is the catch-all
  const email = await storage.getEmail(emailId);
  if (!email) return;

  const hasBody = (email.cleanBody && email.cleanBody.length > 0) || (email.rawBody && email.rawBody.length > 0);
  if (!hasBody) return; // body-less at sync time — the body-ready event re-fires when it lands

  const isRead = (email.tags || '').includes('|read|');
  if (isRead) {
    // Already triaged (opened on Gmail web / another client) — don't spend
    // tokens; mark done so the poll doesn't keep revisiting it.
    (storage as any).getRepositories()?.agent?.markAgentGaveUp?.(emailId, {});
    return;
  }

  // Already categorized (e.g. body re-fetched on open) — nothing to do.
  const status = (storage as any).db?.prepare?.('SELECT agent_status FROM emails WHERE id = ? LIMIT 1')?.get(emailId)?.agent_status;
  if (status === 'done') return;

  // Recency cap — the SAME newest-N window the poll applies (getEmailsPendingAgent).
  // Auto-categorize only the newest AUTO_BACKLOG_RECENT_CAP emails by date. This is
  // the gate that stops the historical BACKFILL from being categorised: an old mail
  // whose body just landed (body-prefetch draining the archive) fires body-ready →
  // here, but falls outside the window, so it keeps its body for SEARCH and spends
  // NO LLM call. Live/new mail is always within the window → always categorised in
  // real time. Left 'pending' (not marked done) so a manual bulk run can still
  // categorise history on demand — identical to how the poll treats it.
  const withinWindow = (storage as any).db?.prepare?.(
    `SELECT 1 FROM emails WHERE id = ? AND date >= (SELECT MIN(date) FROM (SELECT date FROM emails ORDER BY date DESC LIMIT ?)) LIMIT 1`,
  )?.get(emailId, AUTO_BACKLOG_RECENT_CAP());
  if (!withinWindow) {
    logger.debug(`[Pipeline:Event] ${source} → ${emailId} outside newest-${AUTO_BACKLOG_RECENT_CAP()} window — body kept for search, categorization skipped`);
    return;
  }

  const threadId = email.threadId;
  if (!threadId) return;
  logger.info(`[Pipeline:Event] ${source} → ${emailId} thread=${threadId} acct=${getAccountIdForStorage(storage) ?? 'active'}`);
  processEmail(emailId, threadId, storage);
}

function startEventTrigger(): void {
  if (unsubscribeSync) return;
  const eventBus = getEventBus();

  unsubscribeSync = eventBus.on('email:synced' as any, async (event: any) => {
    if (!event.isNew) return;
    const emailId = event.email?.id || event.emailId;
    if (!emailId) return;
    await triggerCategorizeFor(emailId, event.email?.accountId || event.accountId, 'email:synced');
  });

  // Body fetch completes AFTER email:synced (bodies load lazily), so new mail is
  // body-less at sync time and would otherwise wait for the 30s poll. This fires
  // the moment the body lands — near-instant categorization for every account.
  unsubscribeBodyReady = eventBus.on('email:body-ready' as any, async (event: any) => {
    const emailId = event.emailId;
    if (!emailId) return;
    await triggerCategorizeFor(emailId, undefined, 'body-ready');
  });
}

// ========== Polling Trigger (Fallback) ==========

function startPollingTrigger(): void {
  if (pollingTimer) return;

  pollingTimer = setInterval(async () => {
    // Surface the pipeline's real AI availability to the renderer once per tick.
    // Guard-deduped, so this only actually fires on a transition. The first tick
    // is ~30s in — long enough for the renderer to have pushed its config on
    // mount, so a normal startup never flashes the "AI paused" banner; only a
    // genuinely config-less pipeline reports unavailable.
    emitAiPipelineStatus();
    // Categorize EVERY account, not just the active one. Build the target set
    // from all initialized account runtimes plus the active account (covers the
    // pre-account default slot), deduped by storage instance. Each account is
    // processed against its OWN db so categories land in the right place.
    const seen = new Set<any>();
    const storages: any[] = [];
    const active = getStorage();
    if (active) { storages.push(active); seen.add(active); }
    for (const [, rt] of getAllAccountRuntimes()) {
      if (rt.storage && !seen.has(rt.storage)) { storages.push(rt.storage); seen.add(rt.storage); }
    }

    // Non-essential per-account maintenance (stuck-row heal + read/spam sweep +
    // UI stats) runs on a slower cadence than the 30s work-fetch, so it doesn't
    // block the event loop every tick per account.
    const runMaintenance = Date.now() - lastPollMaintenanceAt > POLL_MAINTENANCE_INTERVAL_MS;
    if (runMaintenance) lastPollMaintenanceAt = Date.now();

    let aggExtPending = 0;
    let aggAgentPending = 0;
    for (const storage of storages) {
     try {
      const repos = (storage as any).getRepositories();
      if (!repos?.agent) continue;

      // Live backlog counts for the UI — cheap every tick: the partial indexes
      // on extraction_status='pending' / agent_status='pending' make these
      // COUNTs O(pending), not a full scan. Keeps the dashboard counter live
      // without the full-table getPipelineStats scan (throttled below).
      // Count only ACTIONABLE backlog — pending mail within the same newest-N
      // window the poll actually processes (AUTO_BACKLOG_RECENT_CAP, applied by
      // the count helpers themselves). Without that bound, the historical
      // backfill (inserted agent_status='pending' by default, intentionally
      // never auto-categorised) would show lakhs of "pending" forever.
      try {
        // Count what each phase can ACTUALLY pick up, via the same predicates
        // getEmailsPendingExtraction / getEmailsPendingAgent select on. Both
        // counts here used to be bare `<phase>_status='pending'`, which also
        // counted rows the worker skips (no body, extraction not done,
        // read/spam/trash) — so the bar could sit at "1 pending" forever with
        // no phase ever starting and no error anywhere.
        aggExtPending += repos.agent.countExtractionEligible(AUTO_BACKLOG_RECENT_CAP());
        aggAgentPending += repos.agent.countAgentEligible(AUTO_BACKLOG_RECENT_CAP());
      } catch { /* best effort */ }

      if (runMaintenance) {
        // Self-heal the pending limbo: finalize mail that is counted 'pending'
        // but that no phase can ever select. Disqualified (read/spam/junk/trash)
        // goes at once; body-less mail only once it is old enough that the body
        // is never arriving — a recent one is left alone for phase 1 to pick up
        // when the download lands. Idempotent, so re-running is a no-op.
        try {
          const healed = repos.agent.healStuckPipelineRows(STUCK_AGENT_MAX_AGE_SECONDS);
          if (healed.disqualified > 0 || healed.abandoned > 0 || healed.extractionAbandoned > 0) {
            logger.info('[Pipeline:Poll] healed stuck rows — ' +
              `disqualified=${healed.disqualified} abandoned=${healed.abandoned} ` +
              `extractionAbandoned=${healed.extractionAbandoned}`);
          }
          // Anything still stuck is a NEW shape we have not accounted for.
          // Name it rather than let it silently park the progress bar again.
          const stillStuck = repos.agent.getStuckPipelineRows(3, AUTO_BACKLOG_RECENT_CAP());
          if (stillStuck.length > 0) {
            logger.warn(`[Pipeline:Poll] ${stillStuck.length} row(s) still stuck after heal: ` +
              stillStuck.map((r: { id: string; reason: string }) => `${r.id}(${r.reason})`).join(', '));
          }
        } catch (e) {
          logger.warn('[Pipeline:Poll] stuck-row heal failed:', (e as Error).message);
        }

        // Per-account snapshot for the log line — body-FREE. This used to call
        // getPipelineStats(), whose hasBodyClause (LENGTH(TRIM(body)) over every
        // row) is a full multi-GB body scan; running it every maintenance tick
        // froze the main thread ~13s on a large mailbox (the recurring CPU spike
        // in app.log). getPipelineStatsLite is index-only. The actionable,
        // body-aware backlog is already the cheap aggExtPending/aggAgentPending
        // above; this line just adds the raw total + raw status pending.
        const stats = repos.agent.getPipelineStatsLite();
        const hasPending = stats.extractionStatusPending > 0 || stats.agentStatusPending > 0;
        if (hasPending || Math.random() < 0.1) {
          logger.info(`[Pipeline:Poll] acct total=${stats.totalEmails} ext_status_pending=${stats.extractionStatusPending} agent_status_pending=${stats.agentStatusPending} hasAI=${!!aiConfig} lock=${processingLock.size}`);
        }
      }

      // Phase 1: Pending extraction — bounded to the recent-mail window so the
      // background pipeline never chews through the whole historical mailbox.
      const pendingExt = repos.agent.getEmailsPendingExtraction(5, AUTO_BACKLOG_RECENT_CAP());
      for (const e of pendingExt) {
        if (!processingLock.has(e.id)) {
          if (traceEnabled()) logger.trace(`[Pipeline:Poll] P1 start: ${e.id} thread=${e.threadId}`);
          processEmail(e.id, e.threadId, storage);
        }
      }

      // Phase 2: Pending agent (extraction done) — same recent-window cap.
      const pendingAgent = repos.agent.getEmailsPendingAgent(10, AUTO_BACKLOG_RECENT_CAP());
      for (const e of pendingAgent) {
        if (!processingLock.has(e.id)) {
          // With no live provider this is a local-score-only finalize pass, not
          // an AI run — keep it out of INFO so the drain doesn't read as churn.
          if (aiConfig) logger.info(`[Pipeline:Poll] P2 start: ${e.id} from=${e.fromAddress}`);
          else if (traceEnabled()) logger.trace(`[Pipeline:Poll] P2 start (no-AI finalize): ${e.id} from=${e.fromAddress}`);
          processingLock.add(e.id);
          runPipeline2(e.id, storage).finally(() => processingLock.delete(e.id));
        }
      }

      // Phase 3: Drain pending category-label mirroring. Durable per-email
      // label_status means a burst/restart eventually labels ALL categorized mail
      // (deferred 'pending' from a disconnected engine + the legacy recent-INBOX
      // backlog), not just the live-IDLE mail — the exact gap behind "only the 2
      // newest got Gmail labels". Bounded per tick (gradual, Gmail-rate-safe) and
      // only while THIS account's engine is connected.
      if (categoryLabelConfig.enabled) {
        const labelEngine: any = getSyncEngineForStorage(storage);
        if (labelEngine?.isConnected?.() && labelEngine.operationQueue) {
          const slugSet = getCategorySlugSet(storage);
          const pendingLabel = repos.agent.getEmailsPendingLabel(LABEL_DRAIN_BATCH, AUTO_BACKLOG_RECENT_CAP());
          for (const e of pendingLabel) {
            // The AI's VERDICT, never the tag string. Reading tags here is what
            // wrote our own `Sarv Inbox/Important` label onto mail whose only
            // claim to importance was Gmail's own `\Important` guess.
            const decision = labelDrainDecision(e.aiCategories, slugSet);
            // 'retire' = no recorded verdict (a row categorized before this
            // column existed). We cannot mirror it — we do not know what the AI
            // said — and we must not strip, which would pull correct labels off
            // old mail. It is retired rather than skipped so the drain does not
            // re-select the same rows every tick; see labelDrainDecision.
            if (decision.action === 'retire') { repos.agent.markLabelDone(e.id); continue; }
            // An EMPTY verdict still reconciles — that is how a mail the AI
            // cleared gets its stale account label STRIPPED (mirrorCategoryLabels
            // handles both apply and removal). It flips label_status → 'done'
            // only on a confirmed apply; a deferred/queued one stays 'pending'
            // for the next tick.
            await mirrorCategoryLabels(storage, e, decision.categories);
          }
        }
      }
     } catch (e) {
       // Isolate one account's failure so it never skips the accounts after it
       // in this tick (the loop must keep fanning out across all accounts).
       logger.warn('[Pipeline:Poll] account tick failed (isolated):', (e as Error).message);
     }
    }

    // Periodic cross-account reconciliation (~5 min; first poll runs it): copy
    // each account's existing categories onto the same message in other
    // accounts. Handles mail categorized before propagation, and read copies
    // that were skipped. Idempotent + bounded, so it's cheap after the first pass.
    if (Date.now() - lastReconcileAt > 5 * 60_000) {
      lastReconcileAt = Date.now();
      let reconciled = 0;
      for (const storage of storages) {
        try {
          const repos = (storage as any).getRepositories();
          const slugs = getCategorySlugSet(storage);
          // ai_categories, not tags: this sweep COPIES categories into other
          // accounts, so reading the tag string spread one account's Gmail
          // `\Important` guess to every linked account as an AI decision.
          // A row with no recorded verdict (NULL) has nothing to copy.
          const rows = repos.agent.db?.prepare?.(
            `SELECT message_id AS mid, ai_categories AS aiCategories FROM emails WHERE message_id IS NOT NULL AND agent_status='done' AND ai_categories IS NOT NULL ORDER BY date DESC LIMIT 500`
          )?.all() as Array<{ mid: string; aiCategories: string | null }> | undefined;
          for (const r of rows || []) {
            const cats = mirrorableCategories(r.aiCategories, slugs);
            if (cats?.length) propagateCategoriesToLinkedAccounts(r.mid, cats, storage);
            // Yield to the event loop periodically — a large sweep is up to
            // accounts×500 propagations, each a synchronous scan of every
            // account's DB, so without this it blocks the main thread in one
            // burst. Bounded work, but let IPC/IMAP/UI breathe between chunks.
            if (++reconciled % 100 === 0) await new Promise((res) => setImmediate(res));
          }
        } catch { /* skip */ }
      }
    }

    // Emit aggregate backlog stats every tick — the counts above are cheap, so
    // the dashboard counter stays live (including dropping to 0 promptly).
    const mainWindow = getMainWindow();
    if (mainWindow && (aggExtPending > 0 || aggAgentPending > 0)) {
      mainWindow.webContents.send('pipeline:stats', { extractionPending: aggExtPending, agentPending: aggAgentPending });
    }

    // Diagnostic snapshot — throttled to maintenance ticks (a sync SQLite write,
    // no need to persist every 30s). Lets us (and the UI) see WHY categorization
    // is or isn't running: AI config present? enabled? paused by a terminal
    // error? and the last error reason. Stored in the core DB (see
    // getPipelineAiState) rather than a plaintext file.
    if (runMaintenance) {
      try {
        setPipelineAiState({
          at: new Date().toISOString(),
          hasAI: !!aiConfig,
          enabled: pipeline?.getConfig().enabled ?? null,
          pausedForMs: Math.max(0, aiPausedUntil - Date.now()),
          lastAIErrorReason: lastAIErrorReason || null,
          aggAgentPending, aggExtPending,
        });
      } catch { /* ignore */ }
    }
  }, POLLING_INTERVAL_MS);
}

// ========== IPC Handlers ==========

let pipelineIpcRegistered = false;
function registerPipelineIPC(): void {
  if (pipelineIpcRegistered) return; // idempotent — init runs on every setConfig
  pipelineIpcRegistered = true;
  ipcMain.handle('pipeline:setCategoryLabels', async (_e, cfg: { enabled: boolean; folderMode: FolderLabelMode }) => {
    setCategoryLabelConfig(cfg || { enabled: false, folderMode: 'copy' });
    logger.info('[Pipeline] category-label mirroring:', cfg?.enabled ? `on (folders=${cfg.folderMode})` : 'off');
    // When turned on, proactively create the blank labels on providers that
    // support them (Gmail / folder), retrying so background accounts that
    // connect a bit later (e.g. Gmail while sarv is active) still get them.
    if (cfg?.enabled) scheduleProvisionCategoryLabels();
    return { success: true };
  });

  /** "Apply to recent mail": provision the blank labels, then backfill labels
   *  onto the most recent already-categorized mail. Manual — see
   *  backfillCategoryLabels for why it isn't automatic on folder providers. */
  ipcMain.handle('pipeline:syncCategoryLabels', async (_e, limit?: number) => {
    try {
      const prov = await provisionCategoryLabels();
      const back = await backfillCategoryLabels(typeof limit === 'number' ? limit : 50);
      // Rich diagnostic so the UI can show exactly what happened without the
      // terminal: how many accounts we SAW, how many are Gmail with a token,
      // labels provisioned, mail labeled.
      const diag = getCategoryLabelDiag();
      return { success: true, data: { provisioned: prov.created, labeled: back.labeled, accounts: back.accounts || prov.accounts, ...diag } };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  /** "Remove all Sarv Inbox labels": delete the whole subtree on every account. */
  ipcMain.handle('pipeline:removeCategoryLabels', async () => {
    try {
      const data = await removeAllCategoryLabels();
      return { success: true, data };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle('pipeline:setAIConfig', async (_e, config: AIProviderConfig) => {
    // Wrap oauth-backed configs so every LLM call fetches a fresh bearer.
    // No-op for plain-apiKey configs.
    aiConfig = attachOAuthBearer(config);
    // Mirror the RAW (pre-bearer, serializable) config to disk so a later main
    // restart can restore it without the renderer re-pushing. Best-effort.
    void savePipelineAIConfig(config);
    const authMode = aiConfig.resolveBearer ? 'oauth' : 'apiKey';
    logger.info(
      `[Pipeline] AI config set: ${config.type}/${config.model} (auth=${authMode})`,
    );
    // A fresh config means the user (re)configured / re-signed-in the provider —
    // lift any terminal-error pause and let categorization resume immediately.
    aiPausedUntil = 0;
    lastAIErrorReason = '';
    emitAiPipelineStatus();
    return { success: true };
  });

  ipcMain.handle('pipeline:processBatch', async (_e, options?: { limit?: number }) => {
    if (!pipeline) return { success: false, error: 'Not initialized' };
    try {
      const storage = getStorage();
      if (!storage) return { success: false, error: 'No storage' };
      const repos = (storage as any).getRepositories();
      const emails = repos?.ai?.getEligibleEmailsForAI?.(options?.limit || 100, true);
      if (!emails?.length) return { success: true, data: { processed: 0 } };
      const results = await pipeline.processBatch(emails);
      return { success: true, data: { processed: results.length } };
    } catch (error) { return { success: false, error: (error as Error).message }; }
  });

  ipcMain.handle('pipeline:status', async () => ({
    success: true,
    data: {
      initialized: !!pipeline,
      enabled: pipeline?.getConfig().enabled || false,
      hasAIProvider: !!aiConfig,
      hasIntelligence: !!intelligence,
      processing: processingLock.size,
    },
  }));
}
