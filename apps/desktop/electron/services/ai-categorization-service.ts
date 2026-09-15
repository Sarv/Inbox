/**
 * AI Categorization Service — Main Process
 *
 * Handles queue-based bulk processing and stream-based realtime processing
 * of email categorization via AI providers (Gemini / OpenAI-compatible).
 *
 * Runs entirely in the Electron main process for reliability.
 */

import { cleanLLMJsonResponse, tryParseLLMJson, salvageJsonArrayWithDiagnostics, extractBalancedJsonArray, cleanEmailHtmlForLLM, isConnectionError, isUpstreamError, describeNetworkError, classifyAIError, createLogger } from '@sarvinbox/core';
import type { EmailRecord , AIErrorInfo } from '@sarvinbox/core';

import { getMainWindow, requireStorage } from '../shared';

import { chromiumFetch } from './net-fetch';
const logger = createLogger('ai-categorization-service');

// ========== Helpers ==========

/**
 * Bound a message before it goes to the log. A failed LLM call can carry a
 * multi-KB body (e.g. a proxy's full 502 HTML page); collapse whitespace and
 * cap the length so the log stays readable and one error can't flood it.
 */
function truncateForLog(msg: string, max = 300): string {
  const oneLine = msg.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}… (truncated)` : oneLine;
}

// ========== Types ==========

export interface AIProviderConfig {
  type: 'openai' | 'gemini' | 'sarv' | 'custom';
  apiKey: string;
  model: string;
  baseUrl?: string;
  /** Optional OAuth fields. When the renderer marks a provider with
   * ``authMethod: 'oauth'`` and supplies ``oauthProvider`` + ``oauthEmail``,
   * the IPC handler wraps the config with a ``resolveBearer`` closure that
   * fetches a fresh access token before each LLM request. Not serializable
   * over IPC — attached in main after the config arrives. */
  authMethod?: 'apiKey' | 'oauth';
  oauthProvider?: 'sarv';
  oauthEmail?: string;
  /** `forceRefresh` bypasses the proactive-expiry cache to recover from a 401. */
  resolveBearer?: (forceRefresh?: boolean) => Promise<string>;
}

export interface AIProcessingProgress {
  current: number;
  total: number;
  startTime: number;
  mode: 'bulk' | 'realtime';
  categorized: Record<string, number>;
  recentActivity: Array<{
    emailId: string;
    subject: string;
    fromAddress: string;
    categories: string[];
    confidence: number;
    timestamp: number;
  }>;
  failed: number;
  retried: number;
  lastError: string | null;
  currentBatch: number;
  batchSize: number;
  queueSize: number;
}

interface EmailForCategorization {
  id: string;
  subject: string;
  fromAddress: string;
  toAddress: string;
  ccAddress?: string;
  body: string;
  date: number;
  isRead: boolean;
  senderContext?: {
    tier: string;
    receivedCount: number;
    sentToCount: number;
    repliedCount: number;
    lastReplied?: number;
    lastSentTo?: number;
    readCount: number;
    deletedCount: number;
    isVip: boolean;
    isFavorite: boolean;
    isBlocked: boolean;
  };
  origin?: string; // 'internal (same domain)' or 'external (domain.com)'
  userInCc?: boolean; // true if user is in CC, not TO
  sameSubjectCount?: number; // emails from this sender with identical subject
  volumePercent?: number;    // sender's share of total inbox as percentage
  threadDepth?: number;      // total messages in this email's thread
}

interface CategorizationResult {
  emailId: string;
  categories: string[];   // slugs like ['important', 'needs_response']
  isSpam: boolean;
  confidence: number;
  reasoning: string;
}

interface LoadedCategoryDef {
  slug: string;
  name: string;
  prompt: string;
}

// ========== Constants ==========

// One email per LLM request. Bulk batching (10 then 5 emails per
// request) was producing 70% deferral rates because the model burned
// its token budget on `reasoning` fields and truncated mid-array.
// Single-email requests are immune to that — each response is a tiny
// JSON object that always fits.
//
// To preserve throughput we still pull emails in chunks of CONCURRENCY
// from the eligible list, but each chunk fires CONCURRENCY parallel
// single-email LLM calls (`Promise.allSettled`) instead of one big
// batched request. Net effect: more requests, smaller responses, zero
// truncation, comparable wall time on a multi-stream provider.
const BATCH_SIZE = 1;
const CONCURRENCY = 5;
const MAX_BODY_LENGTH = 1000;
const INTER_BATCH_DELAY_MS = 1500;
const MAX_API_RETRIES = 3;
const CIRCUIT_BREAKER_THRESHOLD = 3;
const MAX_RECENT_ACTIVITY = 20;
// Auto-process backoff: after this many consecutive fully-failed runs
// (every LLM call failed — e.g. expired API key), autoTick backs off
// exponentially instead of re-spamming ~15 doomed requests every 30s.
const AUTO_FAIL_STREAK_THRESHOLD = 3;
const AUTO_BACKOFF_BASE_MS = 2 * 60_000;
const AUTO_BACKOFF_MAX_MS = 30 * 60_000;
// Auto-restart after a bulk run is cut short by a TRANSIENT failure (network /
// gateway / rate limit). Terminal failures (bad key, no credits) never restart —
// they raise the Fix banner instead. Exponential backoff so a lingering outage
// doesn't hammer the provider; caps out but keeps retrying so processing resumes
// on its own once the provider recovers.
const BULK_RESTART_BASE_MS = 15_000;
const BULK_RESTART_MAX_MS = 5 * 60_000;

// ========== Spam Prompt (hardcoded — special behavior) ==========

const SPAM_PROMPT = `is_spam:
   - TRUE if the email is clearly spam, phishing, or unwanted promotional content
   - SPAM indicators (mark TRUE):
     * Unsolicited promotional/marketing emails from unknown senders
     * Phishing attempts (suspicious links, requests for passwords/personal info)
     * Nigerian prince / lottery / inheritance scams
     * Fake shipping notifications, fake invoices from unknown sources
     * "You've won!" / "Congratulations!" / "Claim your prize" messages
     * Suspicious subject lines with urgency (URGENT, ACT NOW, LIMITED TIME)
     * Random gibberish or garbled text
     * Crypto/forex/investment spam
     * Adult content spam
     * Unknown sender with suspicious attachment mentions
   - NOT SPAM indicators (mark FALSE):
     * Legitimate newsletters user may have subscribed to
     * Transactional emails (order confirmations, shipping updates from known stores)
     * Emails from known contacts or same domain
     * Normal business correspondence`;

// ========== Service Class ==========

export class AICategorizationService {
  private running = false;
  private abortController: AbortController | null = null;
  private config: AIProviderConfig | null = null;
  private progress: AIProcessingProgress | null = null;
  private userEmail: string = '';
  private maxEmails: number = 100;
  private skipRead: boolean = true;
  private categoryDefs: LoadedCategoryDef[] = [];
  private categorySlugs: Set<string> = new Set();
  private autoTimer: ReturnType<typeof setInterval> | null = null;
  private autoConfig: AIProviderConfig | null = null;
  private autoOptions: { userEmail?: string; maxEmails?: number; skipRead?: boolean } = {};
  // Cross-run failure tracking for autoTick backoff (see autoTick)
  private lastRunAllFailed = false;
  private autoFailStreak = 0;
  private autoBackoffUntil = 0;
  // Auto-restart of a bulk run cut short by a transient failure (see
  // scheduleBulkRestart). `lastChunkError` holds a representative rejection so
  // the circuit breaker can classify why the run stopped; `lastRunTerminal`
  // guards the completion event from clearing a Fix banner we just raised.
  private lastChunkError: unknown = null;
  private lastRunTerminal = false;
  private bulkRestartTimer: ReturnType<typeof setTimeout> | null = null;
  private bulkRestartAttempts = 0;

  /**
   * Build the categorization prompt dynamically from category definitions
   */
  private buildPrompt(categories: LoadedCategoryDef[], userEmail: string): string {
    const userName = userEmail.split('@')[0] || '';
    const categorySection = categories.map((cat, i) =>
      `${i + 1}. ${cat.slug}:\n${cat.prompt}`
    ).join('\n\n');

    return `You are an email intelligence agent for "${userEmail}" (${userName}).
Classify each email — but ONLY assign categories when the email actually matters to this user.

CATEGORIES:
${categorySection}

SPAM:
${SPAM_PROMPT}

═══════════════════════════════════════════
KEY RULE: Think from ${userName}'s perspective.
"Would ${userName} need to ACT on this email?"
═══════════════════════════════════════════

WHO IS THE EMAIL FOR? (MOST IMPORTANT CHECK)
- Look at TO: vs CC: fields
- "User-Role: CC" = ${userName} is just looped in — DEFAULT: NOT important, NOT needs_response
- If email body greets someone else ("Hello Hrishi") but ${userName} is CC → NOT for ${userName}
- If task is for someone in TO: and ${userName} is CC → NOT ${userName}'s task
- ONLY mark CC as important if body EXPLICITLY asks for ${userName}'s input by name

BEHAVIORAL SIGNALS (use these — they show what ${userName} actually cares about):
- "Read: X%" = how often ${userName} opens this sender's emails. Low% = doesn't care
- "Keep: X%" = how often ${userName} keeps vs deletes. Low% = noise
- "Replied: N" = how often ${userName} replied. 0 = never replied = probably not needs_response
- User NEVER replying to a sender = that sender is NOT important enough for needs_response

WHAT IS "IMPORTANT"?
- ${userName} is in TO: (not CC:) AND email asks for their action/decision
- From someone ${userName} consistently replies to
- Customer/client emails directly to ${userName}
- NOT important: team loops, FYIs, tasks for others, newsletters, automated alerts

CATEGORY ASSIGNMENT RULES (STRICT):
- Prefer ONE category per email. Only assign 2+ if genuinely applicable.
- "important" is RARE — means URGENT, needs action TODAY. Not just "relevant".
- An invoice is just "invoice", NOT also "important" unless payment is overdue TODAY.
- A finance email is just "finance", NOT also "important" unless fraud alert.
- A meeting invite is just "meeting", NOT also "important" unless meeting is in the next hour.
- When in doubt, assign FEWER categories. Empty [] is valid.

SENDER MEMORY (optional — extract if visible):
- How the sender or user greets/addresses in this email
- Conversation tone and key topic
- Include "sender_memory" only when meaningful

Return JSON array:
[{"emailId":"...","categories":[],"is_spam":false,"confidence":0.8,"reasoning":"...","sender_memory":{"greeting":"Hi Advik","tone":"formal","key_context":"Invoice follow-up"}}]
- Single email (depth 1) from occasional sender = likely lower priority unless content signals otherwise`;
  }

  /**
   * Start AI categorization processing
   */
  async start(
    config: AIProviderConfig,
    mode: 'bulk' | 'realtime',
    options?: {
      emailIds?: string[];
      systemPrompt?: string;
      userEmail?: string;
      maxEmails?: number;
      skipRead?: boolean;
    }
  ): Promise<void> {
    if (this.running) {
      logger.info('[AICategorizationService] Already running, ignoring start');
      return;
    }

    // A fresh run supersedes any pending auto-restart from a prior interrupted
    // run (whether this start() is the restart firing, a manual re-run, or an
    // autoTick), so cancel the timer and reset the per-run terminal flag.
    this.cancelBulkRestart();
    this.lastRunTerminal = false;

    this.config = config;
    this.running = true;
    this.abortController = new AbortController();

    if (options?.userEmail) {
      this.userEmail = options.userEmail;
    }
    if (options?.maxEmails) {
      this.maxEmails = options.maxEmails;
    }
    this.skipRead = options?.skipRead !== false;

    // Load category definitions from DB
    const storage = requireStorage();
    const defs = storage.getEnabledCategoryDefinitions();
    this.categoryDefs = defs.map(d => ({ slug: d.slug, name: d.name, prompt: d.prompt }));
    this.categorySlugs = new Set(defs.map(d => d.slug));

    logger.info(`[AICategorizationService] Starting in ${mode} mode (skipRead=${this.skipRead}, maxEmails=${this.maxEmails}, categories=${this.categoryDefs.length})`);

    try {
      if (mode === 'bulk') {
        await this.processBulk();
      } else {
        await this.processImmediate(options?.emailIds || []);
      }
    } catch (error) {
      logger.error('[AICategorizationService] Processing error:', error);
      this.emitError((error as Error).message);
    } finally {
      this.running = false;
      this.abortController = null;
      this.emitComplete();
    }
  }

  /**
   * Stop processing
   */
  stop(): void {
    logger.info('[AICategorizationService] Stopping');
    this.running = false;
    // A user-initiated stop also cancels any queued transient auto-restart —
    // "stop" must mean stop, not "pause until the backoff timer fires".
    this.cancelBulkRestart();
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  /**
   * Get current status
   */
  getStatus(): { running: boolean; progress: AIProcessingProgress | null } {
    return { running: this.running, progress: this.progress };
  }

  // ========== Auto-Processing Timer ==========

  /**
   * Start the 30-second auto-processing timer.
   * Each tick checks for eligible emails and runs processBulk if any found.
   */
  startAutoProcess(
    config: AIProviderConfig,
    options?: { userEmail?: string; maxEmails?: number; skipRead?: boolean }
  ): void {
    if (this.autoTimer) {
      // Already running — adopt the new config/options in place so e.g. a
      // fixed API key from Settings takes effect on the next tick (the
      // renderer never calls stopAutoProcess; dropping the new config here
      // kept a dead key until restart).
      this.autoConfig = config;
      this.autoOptions = options || {};
      this.autoFailStreak = 0;
      this.autoBackoffUntil = 0;
      logger.info('[AICategorizationService] Auto-process already running — config updated in place');
      return;
    }

    this.autoConfig = config;
    this.autoOptions = options || {};
    this.autoFailStreak = 0;
    this.autoBackoffUntil = 0;
    logger.info('[AICategorizationService] Starting auto-process timer (30s interval)');

    // Run first tick immediately
    this.autoTick();

    this.autoTimer = setInterval(() => this.autoTick(), 30000);
  }

  /**
   * Stop the auto-processing timer
   */
  stopAutoProcess(): void {
    if (this.autoTimer) {
      clearInterval(this.autoTimer);
      this.autoTimer = null;
      this.autoConfig = null;
      logger.info('[AICategorizationService] Auto-process timer stopped');
    }
  }

  /**
   * Whether the auto-process timer is active
   */
  isAutoProcessing(): boolean {
    return this.autoTimer !== null;
  }

  private async autoTick(): Promise<void> {
    if (this.running || !this.autoConfig) return;
    // Backing off after repeated fully-failed runs (bad key, dead endpoint)
    if (Date.now() < this.autoBackoffUntil) return;

    try {
      const storage = requireStorage();
      const skipRead = this.autoOptions.skipRead !== false;
      const eligible = storage.getEligibleEmailsForAI(1, skipRead);

      if (eligible.length === 0) return;

      // There are eligible emails — run a full bulk process
      const count = await storage.getUnprocessedEmailCount(10000, skipRead);
      logger.info(`[AICategorizationService] Auto-tick: ${count} eligible emails`);

      await this.start(this.autoConfig, 'bulk', {
        userEmail: this.autoOptions.userEmail,
        maxEmails: this.autoOptions.maxEmails,
        skipRead,
      });

      // Track consecutive fully-failed runs; back off exponentially so a
      // persistently-failing provider isn't hit with a fresh volley of
      // requests every 30 seconds. Any successful email resets the streak.
      if (this.lastRunAllFailed) {
        this.autoFailStreak++;
        if (this.autoFailStreak >= AUTO_FAIL_STREAK_THRESHOLD) {
          const backoffMs = Math.min(
            AUTO_BACKOFF_MAX_MS,
            AUTO_BACKOFF_BASE_MS * Math.pow(2, this.autoFailStreak - AUTO_FAIL_STREAK_THRESHOLD),
          );
          this.autoBackoffUntil = Date.now() + backoffMs;
          this.emitError(
            `AI categorization failed ${this.autoFailStreak} runs in a row — pausing auto-processing for ${Math.round(backoffMs / 60000)} min. Check your AI provider settings.`,
          );
        }
      } else {
        this.autoFailStreak = 0;
      }
    } catch (error) {
      logger.error('[AICategorizationService] Auto-tick error:', error);
    }
  }

  /**
   * Queue an automatic restart of a bulk run that a TRANSIENT failure cut short
   * (network / gateway / rate limit). Exponential backoff, no hard cap on
   * attempts: `getEligibleEmailsForAI` only returns still-unprocessed emails, so
   * a restart naturally resumes where the run left off, and once every eligible
   * email is processed the next run finds nothing and stops — the loop is
   * self-terminating. A terminal failure never reaches here (see the circuit
   * breaker), so this can't spin on a bad key.
   */
  private scheduleBulkRestart(): void {
    if (this.bulkRestartTimer) return; // one pending restart at a time
    if (!this.config) return;

    this.bulkRestartAttempts++;
    const delay = Math.min(
      BULK_RESTART_MAX_MS,
      BULK_RESTART_BASE_MS * Math.pow(2, this.bulkRestartAttempts - 1),
    );
    this.emitLog(
      'warn',
      `AI categorization interrupted by a transient error — auto-retrying in ${Math.round(delay / 1000)}s (attempt ${this.bulkRestartAttempts})`,
    );

    this.bulkRestartTimer = setTimeout(() => {
      this.bulkRestartTimer = null;
      if (this.running || !this.config) return;
      void this.start(this.config, 'bulk', {
        userEmail: this.userEmail,
        maxEmails: this.maxEmails,
        skipRead: this.skipRead,
      });
    }, delay);
  }

  /** Cancel a queued transient auto-restart (on stop / new run). */
  private cancelBulkRestart(): void {
    if (this.bulkRestartTimer) {
      clearTimeout(this.bulkRestartTimer);
      this.bulkRestartTimer = null;
    }
  }

  // ========== Bulk Processing ==========

  private async processBulk(): Promise<void> {
    const storage = requireStorage();
    this.lastRunAllFailed = false;
    this.lastChunkError = null;

    // Get eligible emails directly — no queue needed
    const eligible = storage.getEligibleEmailsForAI(this.maxEmails, this.skipRead);
    const totalEligible = eligible.length;

    this.emitLog('info', `Found ${totalEligible} eligible emails (skipRead=${this.skipRead})`);

    // Initialize categorized counts from loaded category defs
    const categorizedInit: Record<string, number> = { spam: 0 };
    for (const def of this.categoryDefs) {
      categorizedInit[def.slug] = 0;
    }

    this.progress = {
      current: 0,
      total: totalEligible,
      startTime: Date.now(),
      mode: 'bulk',
      categorized: categorizedInit,
      recentActivity: [],
      failed: 0,
      retried: 0,
      lastError: null,
      currentBatch: 0,
      batchSize: BATCH_SIZE,
      queueSize: totalEligible,
    };
    this.emitProgress();

    if (totalEligible === 0) {
      logger.info('[AICategorizationService] No emails to process');
      return;
    }

    let consecutiveFailures = 0;
    let processed = 0;

    // Process in chunks of CONCURRENCY emails. Each chunk fires
    // CONCURRENCY parallel single-email LLM calls — one email per
    // request, no batching. This eliminates the truncation problem
    // that plagued bulk batching (the model would emit valid JSON for
    // the first 2-3 emails then truncate the rest, causing 70% of
    // each batch to need retry).
    for (let offset = 0; offset < totalEligible && this.running; offset += CONCURRENCY) {
      // Circuit breaker — the run has stalled (N chunks failed in a row).
      // WHY it stalled decides what happens next:
      //   • terminal (bad key / no credits / other 4xx) → surface a Fix banner
      //     so the user knows to act; do NOT auto-retry (it can't recover).
      //   • transient (network / gateway / rate limit) → auto-restart with
      //     backoff so processing resumes on its own once the provider is back.
      if (consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
        const info = classifyAIError(this.lastChunkError);
        const msg = `AI categorization stopped: ${info.reason}`;
        logger.error(`[AICategorizationService] Circuit breaker after ${CIRCUIT_BREAKER_THRESHOLD} consecutive failures — ${info.kind} (${info.reason})`);
        this.progress.lastError = info.reason;
        this.emitError(msg, info);
        if (info.terminal) {
          this.lastRunTerminal = true;
        } else if (!this.autoTimer) {
          // Only self-restart a one-shot (manual) run. In auto mode the 30s
          // autoTick already re-drives processing (with its own fail-streak
          // backoff), so scheduling a second driver would double up.
          this.scheduleBulkRestart();
        }
        break;
      }

      const chunk = eligible.slice(offset, offset + CONCURRENCY);
      if (chunk.length === 0) break;

      this.progress.currentBatch++;
      const emailIds = chunk.map(e => e.id);

      // Fetch enriched email data (sender context, thread depth, etc.)
      // for the whole chunk in one DB pass — fetchEmails is already a
      // batch operation so this stays cheap even with N>1.
      const emails = await this.fetchEmails(emailIds);
      if (emails.length === 0) {
        // All emails were filtered out at fetch time (e.g. became read
        // since the eligible query). Skip the chunk silently — they
        // never enter the LLM path so nothing to save or defer.
        continue;
      }

      // Fire N parallel single-email LLM calls. allSettled so one
      // failed call doesn't poison the rest of the chunk.
      const settled = await Promise.allSettled(
        emails.map(email => this.callAI([email])),
      );

      const toSave: CategorizationResult[] = [];
      let transientFailuresThisChunk = 0;
      let networkFailuresThisChunk = 0;
      let lastNetworkErrMsg = '';

      for (let i = 0; i < emails.length; i++) {
        const email = emails[i];
        const settle = settled[i];

        if (settle.status === 'rejected') {
          // Transient failure (network / quota / abort). Don't save —
          // ai_processed_at stays NULL and the next sync picks it up.
          transientFailuresThisChunk++;
          // Remember a representative failure so the circuit breaker can
          // classify WHY the run stalled (terminal vs transient). Ignore user
          // aborts — those aren't provider failures.
          if ((settle.reason as Error)?.name !== 'AbortError') {
            this.lastChunkError = settle.reason;
          }
          const errMsg = (settle.reason as Error)?.message || String(settle.reason);
          // The LLM endpoint being unreachable — whether at the socket level
          // (DNS/refused/reset) or an HTTP upstream failure (502/503/504 from a
          // gateway/proxy) — fails every email in the chunk identically.
          // Collapse those into ONE concise log after the loop instead of N
          // stack-traced errors (a 502 otherwise dumps the full nginx HTML page
          // per email). Both are transient and retried next cycle. Genuine
          // per-email failures still log individually (with a bounded message).
          if (isConnectionError(settle.reason) || isUpstreamError(settle.reason)) {
            networkFailuresThisChunk++;
            const host = (settle.reason as any)?.endpoint;
            const status = (settle.reason as any)?.status;
            const hostSuffix = host ? ` [host: ${host}]` : '';
            // For an HTTP upstream failure, prefer a compact "HTTP 502" label
            // over the proxy's multi-KB HTML error page. Otherwise unwrap
            // undici's hidden cause (ENOTFOUND / ECONNREFUSED / cert…) and name
            // the host so the failure stays diagnosable, not opaque.
            lastNetworkErrMsg = status
              ? `HTTP ${status}${hostSuffix}`
              : `${truncateForLog(describeNetworkError(settle.reason))}${hostSuffix}`;
          } else {
            // Bound the message — a failed LLM call can carry a multi-KB HTML
            // body; never spill the whole thing into the log.
            this.emitLog('error', `Email ${email.id} LLM call failed: ${truncateForLog(errMsg)}`);
          }
          continue;
        }

        const aiResults = settle.value;
        const found = aiResults.find(r => r.emailId === email.id);

        if (found) {
          toSave.push(found);
        } else {
          // LLM call succeeded but returned no usable result for this
          // email (empty array, wrong emailId, malformed past salvage).
          // Save with empty categories — the LLM had its chance and
          // didn't deliver. The email gets ai_processed_at set so we
          // don't loop on it forever; user can manually re-categorize
          // if needed.
          toSave.push({
            emailId: email.id,
            categories: [],
            isSpam: false,
            confidence: 0,
            reasoning: 'LLM returned no usable result',
          });
        }
      }

      if (networkFailuresThisChunk > 0) {
        this.emitLog(
          'warn',
          `${networkFailuresThisChunk} email(s) could not reach the AI endpoint (${lastNetworkErrMsg}) — will retry next cycle`,
        );
      }

      if (toSave.length > 0) {
        await this.saveBatch(toSave, emails);
      }
      consecutiveFailures = transientFailuresThisChunk === emails.length ? consecutiveFailures + 1 : 0;

      this.progress.retried += transientFailuresThisChunk;
      this.progress.failed += transientFailuresThisChunk;

      processed += toSave.length;
      this.progress.current = processed;
      this.progress.queueSize = Math.max(0, totalEligible - processed);
      this.emitProgress();

      // Inter-chunk delay — small breather between concurrent
      // chunks so we don't hammer the provider. Each chunk already
      // does CONCURRENCY parallel calls, so we don't need a long pause.
      if (this.running && offset + CONCURRENCY < totalEligible) {
        await this.delay(INTER_BATCH_DELAY_MS);
      }
    }

    // Run-level outcome for autoTick's backoff: nothing saved AND at least
    // one LLM failure means every call in the run failed.
    this.lastRunAllFailed = processed === 0 && (this.progress?.failed || 0) > 0;

    // Any forward progress means the provider is reachable again — reset the
    // transient auto-restart backoff so a fresh outage starts from the short
    // delay rather than a stale long one.
    if (processed > 0) {
      this.bulkRestartAttempts = 0;
    }
  }

  // ========== Realtime Processing ==========

  private async processImmediate(emailIds: string[]): Promise<void> {
    if (emailIds.length === 0) return;

    const categorizedInit: Record<string, number> = { spam: 0 };
    for (const def of this.categoryDefs) {
      categorizedInit[def.slug] = 0;
    }

    this.progress = {
      current: 0,
      total: emailIds.length,
      startTime: Date.now(),
      mode: 'realtime',
      categorized: categorizedInit,
      recentActivity: [],
      failed: 0,
      retried: 0,
      lastError: null,
      currentBatch: 1,
      batchSize: emailIds.length,
      queueSize: 0,
    };
    this.emitProgress();

    try {
      const emails = await this.fetchEmails(emailIds);
      if (emails.length === 0) return;

      const results = await this.callAI(emails);
      if (results.length > 0) {
        await this.saveBatch(results, emails);
      }

      this.progress.current = emailIds.length;
      this.emitProgress();
    } catch (error) {
      logger.error('[AICategorizationService] Realtime processing failed:', error);
      this.progress.failed += emailIds.length;
      this.progress.lastError = (error as Error).message;
      this.emitProgress();
    }
  }

  // ========== Fetch Emails ==========

  private async fetchEmails(emailIds: string[]): Promise<EmailForCategorization[]> {
    const storage = requireStorage();
    const rawEmails: EmailRecord[] = [];

    for (const id of emailIds) {
      const email = await storage.getEmail(id) as EmailRecord | null;
      if (email) rawEmails.push(email);
    }

    // Batch-fetch sender context for all from-addresses
    const senderEmails = rawEmails
      .map(e => e.fromAddress)
      .filter(Boolean) as string[];
    const senderContextMap = senderEmails.length > 0
      ? storage.getSenderContextBatch(senderEmails)
      : {};

    // Batch-fetch same-subject counts and total email count for volume %
    const repetitionStats = senderEmails.length > 0
      ? storage.getSenderRepetitionStats(senderEmails)
      : { sameSubject: {}, totalEmails: 0 };

    // Batch-fetch thread depths for conversation depth signal
    const threadIds = rawEmails.map(e => e.threadId).filter(Boolean) as string[];
    const threadDepthMap = threadIds.length > 0
      ? storage.getThreadDepths(threadIds)
      : {};

    const userDomain = this.userEmail ? this.userEmail.split('@')[1]?.toLowerCase() : '';

    const emails: EmailForCategorization[] = [];
    for (const email of rawEmails) {
      // Hard per-email gate: even if an upstream query somehow let a read
      // email through, we never categorize it here. This matches the policy
      // in getEligibleEmailsForAI (read emails have been user-triaged and
      // don't warrant AI tokens).
      if ((email.tags || '').includes('|read|')) {
        continue;
      }
      // Body strategy for the LLM prompt:
      //
      //   1. Threads — use the chat-view's already-parsed body for this
      //      specific message. The chat-view extractor separated the
      //      sender's own content from the quoted/forwarded history
      //      below, so the LLM sees only what THIS sender wrote.
      //
      //   2. Single emails (or threads not yet chat-view-parsed) —
      //      fall back to email.rawBody and run cleanEmailHtmlForLLM
      //      to strip CSS, inline images, MSO/Outlook chrome, and
      //      every attribute except <a href>. The LLM keeps text +
      //      basic structure (paragraphs, lists, tables, links) for
      //      categorization context.
      //
      //   3. Last-resort — cleanBody if rawBody is missing.
      const chatViewBody = email.threadId
        ? (storage as any).getChatViewBodyForEmail(email.threadId, email.id)
        : null;
      let body: string;
      if (chatViewBody) {
        body = chatViewBody;
      } else if (email.rawBody) {
        body = cleanEmailHtmlForLLM(email.rawBody, { maxLength: MAX_BODY_LENGTH });
      } else {
        body = email.cleanBody || '';
      }
      const fromAddr = (email.fromAddress || '').toLowerCase();
      const senderDomain = fromAddr.split('@')[1] || '';

      // Determine origin
      let origin = `external (${senderDomain})`;
      if (userDomain && senderDomain === userDomain) {
        origin = 'internal (same domain)';
      }

      // Detect if user is in CC (not direct TO recipient)
      const toAddrs = (email.toAddress || '').toLowerCase();
      const ccAddrs = (email.ccAddress || '').toLowerCase();
      const userLower = this.userEmail?.toLowerCase() || '';
      const userInCc = userLower
        ? (!toAddrs.includes(userLower) && ccAddrs.includes(userLower))
        : false;

      // Read status from tags
      const isRead = (email.tags || '').includes('|read|');

      // Sender context
      const ctx = senderContextMap[fromAddr];

      // Same-subject count: how many emails from this sender have the exact same subject
      const subjectMap = repetitionStats.sameSubject[fromAddr];
      const sameSubjectCount = subjectMap ? (subjectMap[email.subject || ''] || 0) : 0;

      // Volume %: sender's received_count as percentage of total inbox
      const senderReceived = ctx ? ctx.receivedCount : 0;
      const volumePercent = repetitionStats.totalEmails > 0
        ? Math.round((senderReceived / repetitionStats.totalEmails) * 1000) / 10
        : 0;

      emails.push({
        id: email.id,
        subject: email.subject || '',
        fromAddress: email.fromAddress || '',
        toAddress: email.toAddress || '',
        ccAddress: email.ccAddress || '',
        body: body.length > MAX_BODY_LENGTH ? body.substring(0, MAX_BODY_LENGTH) : body,
        date: email.date,
        isRead,
        origin,
        userInCc,
        sameSubjectCount,
        volumePercent,
        threadDepth: email.threadId ? (threadDepthMap[email.threadId] || 1) : 1,
        senderContext: ctx ? {
          tier: ctx.tier,
          receivedCount: ctx.receivedCount,
          sentToCount: ctx.sentToCount,
          repliedCount: ctx.repliedCount,
          lastReplied: ctx.lastReplied,
          lastSentTo: ctx.lastSentTo,
          readCount: ctx.readCount,
          deletedCount: ctx.deletedCount,
          isVip: ctx.isVip,
          isFavorite: ctx.isFavorite,
          isBlocked: ctx.isBlocked,
        } : undefined,
      });
    }

    return emails;
  }

  // ========== AI API Calls ==========

  private async callAI(emails: EmailForCategorization[]): Promise<CategorizationResult[]> {
    if (!this.config) throw new Error('No AI config');

    const prompt = this.buildPrompt(this.categoryDefs, this.userEmail || 'unknown');

    const categorySlugs = this.categoryDefs.map(c => `"${c.slug}"`).join(', ');

    const nowSec = Math.floor(Date.now() / 1000);

    const emailsText = emails.map((email, index) => {
      // Build sender context line
      let senderLine = '';
      if (email.senderContext) {
        const ctx = email.senderContext;
        const flags = [
          ctx.isVip ? 'VIP' : '',
          ctx.isFavorite ? 'Favorite' : '',
          ctx.isBlocked ? 'BLOCKED' : '',
        ].filter(Boolean).join(', ');
        const readRate = ctx.receivedCount > 0
          ? ` | Read: ${Math.round((ctx.readCount / ctx.receivedCount) * 100)}%`
          : '';
        const keepRate = ctx.receivedCount > 0
          ? ` | Keep: ${Math.round(((ctx.receivedCount - ctx.deletedCount) / ctx.receivedCount) * 100)}%`
          : '';
        const replied = ctx.repliedCount ? ` | Replied: ${ctx.repliedCount}` : '';
        const lastReply = ctx.lastReplied
          ? ` | Last-Reply: ${Math.max(1, Math.round((nowSec - ctx.lastReplied) / 86400))}d ago`
          : '';
        const lastSent = ctx.lastSentTo
          ? ` | Last-Sent: ${Math.max(1, Math.round((nowSec - ctx.lastSentTo) / 86400))}d ago`
          : '';
        const sameSubj = email.sameSubjectCount ? ` | Same-Subject: ${email.sameSubjectCount}` : '';
        const volume = email.volumePercent ? ` | Volume: ${email.volumePercent}%` : '';
        senderLine = `Sender: ${ctx.tier} | Received: ${ctx.receivedCount} | Sent-to: ${ctx.sentToCount}${replied}${lastReply}${lastSent}${readRate}${keepRate}${sameSubj}${volume}${flags ? ` | ${flags}` : ''}`;
      } else {
        senderLine = 'Sender: first-time | Received: 0 | Sent-to: 0 | No prior relationship';
      }

      const recipientRole = email.userInCc ? 'CC (not direct recipient)' : 'TO (direct recipient)';
      const threadDepthLine = email.threadDepth && email.threadDepth > 1
        ? `\nThread-Depth: ${email.threadDepth}`
        : '';

      return `--- Email ${index + 1} (ID: ${email.id}) ---
Subject: ${email.subject}
From: ${email.fromAddress}
To: ${email.toAddress}${email.ccAddress ? `\nCC: ${email.ccAddress}` : ''}
Date: ${new Date(email.date * 1000).toISOString()}
Origin: ${email.origin || 'unknown'}
${senderLine}
User-Role: ${recipientRole}
Read: ${email.isRead ? 'yes' : 'no'}${threadDepthLine}
Body:
${email.body}`;
    }).join('\n\n');

    const userMessage = `Analyze these ${emails.length} emails FOR THE USER (${this.userEmail || 'unknown'}) and return a JSON array with classifications:

${emailsText}

Return format (categories is an array of matching slugs from: ${categorySlugs}):
[
  {
    "emailId": "email_id_here",
    "categories": ["important", "needs_response"],
    "is_spam": false,
    "confidence": 0.9,
    "reasoning": "Brief explanation from user's perspective"
  },
  ...
]`;

    const responseText = await this.callAPIWithRetry(prompt, userMessage);
    return this.validateResponse(responseText);
  }

  private async callAPIWithRetry(systemPrompt: string, userMessage: string, retryCount = 0): Promise<string> {
    try {
      return await this.callAPIOnce(systemPrompt, userMessage);
    } catch (error: any) {
      // User cancelled — never retry an aborted request.
      if (error?.name === 'AbortError') throw error;

      const status = error.status || error.statusCode;
      // Transient failures worth retrying: server-side 429/500, gateway/proxy
      // upstream errors (502/503/504), AND network-level errors (undici `fetch
      // failed`, ECONNREFUSED, DNS, etc.).
      // Previously a bare `fetch failed` had no `.status`, so it fell straight
      // through and every email in the chunk failed on a momentary blip; and
      // 502/504 were omitted here, so a gateway blip skipped the fast in-call
      // backoff and failed the whole chunk until the next 30s cycle.
      const isNetworkError = isConnectionError(error);
      const isUpstream = isUpstreamError(error);
      const isRetryable = status === 429 || status === 500 || isNetworkError || isUpstream;

      if (isRetryable && retryCount < MAX_API_RETRIES) {
        const waitTime = Math.min(2000 * Math.pow(2, retryCount), 30000);
        const reason = isNetworkError ? 'network' : `HTTP ${status}`;
        logger.info(`[AICategorizationService] Retryable error (${reason}), waiting ${waitTime}ms (retry ${retryCount + 1}/${MAX_API_RETRIES})`);
        await this.delay(waitTime);
        return this.callAPIWithRetry(systemPrompt, userMessage, retryCount + 1);
      }

      throw error;
    }
  }

  private async callAPIOnce(systemPrompt: string, userMessage: string): Promise<string> {
    if (!this.config) throw new Error('No AI config');

    if (this.config.type === 'gemini') {
      return this.callGeminiAPI(systemPrompt, userMessage);
    } else {
      return this.callOpenAICompatibleAPI(systemPrompt, userMessage);
    }
  }

  private async callOpenAICompatibleAPI(systemPrompt: string, userMessage: string): Promise<string> {
    const config = this.config!;
    const baseUrls: Record<string, string> = {
      openai: 'https://api.openai.com/v1',
    };
    const baseUrl = config.baseUrl || baseUrls[config.type] || baseUrls.openai;
    const endpoint = `${baseUrl}/chat/completions`;
    // One HTTP attempt with a resolved bearer. `forceRefresh` forces a fresh
    // OAuth token (used on the 401 retry below). Other providers use apiKey.
    const attempt = async (forceRefresh: boolean) => {
      const bearer = config.resolveBearer ? await config.resolveBearer(forceRefresh) : config.apiKey;
      // Guard against an empty bearer — we'd otherwise ship
      // `Authorization: Bearer ` which the gateway logs as
      // "Illegal header value" and returns 502.
      if (typeof bearer !== 'string' || bearer.trim() === '') {
        throw new Error(
          `[AICategorizationService] Empty bearer token from provider '${config.type}'. ` +
          `OAuth token may have failed to refresh, or apiKey is missing.`,
        );
      }
      return this.doFetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${bearer}`,
        },
        body: JSON.stringify({
          model: config.model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMessage },
          ],
          max_completion_tokens: 16000,
          // See packages/core/src/agent/categorization-utils.ts for the
          // full rationale: vLLM-hosted thinking models (Gemma 3/4, Qwen3)
          // burn the token budget on inline <think> blocks and truncate
          // before emitting the JSON. Disable via the chat-template kwarg.
          chat_template_kwargs: { enable_thinking: false },
        }),
        signal: this.abortController?.signal,
      });
    };

    let response = await attempt(false);

    // OAuth token rejected: the LLM edge refused a token our local expiry
    // heuristic thought was still valid (skew, server-side revocation, or a
    // token that aged out while the app was idle). Force a fresh token once
    // and retry — this is what makes an expired access token self-heal instead
    // of killing the whole categorization run. If the REFRESH itself fails
    // (refresh token revoked/expired), surface a clear re-auth signal (401) so
    // the Fix banner points the user at re-authenticating the provider.
    if ((response.status === 401 || response.status === 403) && config.resolveBearer) {
      this.emitLog('warn', `AI endpoint returned ${response.status} — refreshing OAuth token and retrying once`);
      try { await response.body?.cancel?.(); } catch { /* ignore */ }
      try {
        response = await attempt(true);
      } catch (refreshErr) {
        const e = new Error(
          `AI OAuth token refresh failed — re-authenticate the provider in Settings → AI → Providers. ` +
          `(${(refreshErr as Error)?.message || refreshErr})`,
        );
        (e as any).status = 401;
        throw e;
      }
    }

    if (!response.ok) {
      const errorText = await response.text();
      const error = new Error(`API request failed: ${response.status} - ${errorText}`);
      (error as any).status = response.status;
      throw error;
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content?.trim() || '';
  }

  private async callGeminiAPI(systemPrompt: string, userMessage: string): Promise<string> {
    const config = this.config!;
    const baseUrl = config.baseUrl || 'https://generativelanguage.googleapis.com/v1beta';
    const endpoint = `${baseUrl}/models/${config.model}:generateContent?key=${config.apiKey}`;

    const response = await this.doFetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          { parts: [{ text: `${systemPrompt}\n\n${userMessage}` }] },
        ],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 16000,
          // Disable Gemini 2.5 Flash thinking — see ai-service.ts for
          // the rationale. Ignored by non-thinking Gemini variants.
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
      signal: this.abortController?.signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      const error = new Error(`API request failed: ${response.status} - ${errorText}`);
      (error as any).status = response.status;
      throw error;
    }

    const data = await response.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
  }

  /**
   * fetch wrapper using Chromium's network stack (see chromiumFetch). On a
   * network-level failure it tags the error with the target host so logs
   * pinpoint WHICH endpoint was unreachable.
   */
  private async doFetch(endpoint: string, init: RequestInit): Promise<Response> {
    try {
      // Chromium's network stack — matches the renderer's TLS trust + proxy, so
      // internal gateways with incomplete cert chains resolve here too.
      return await chromiumFetch(endpoint, init);
    } catch (err) {
      if (err && typeof err === 'object' && !(err as any).endpoint) {
        try { (err as any).endpoint = new URL(endpoint).host; } catch { /* keep raw */ }
      }
      throw err;
    }
  }

  // ========== Validation ==========

  private validateResponse(raw: string): CategorizationResult[] {
    // Strips <think>/<thinking>/<reasoning>/<thought> blocks (reasoning
    // models like Gemma and DeepSeek R1 emit these inline) before fences.
    const clean = cleanLLMJsonResponse(raw);

    // Three-pass parse:
    //   1. Direct JSON.parse on the cleaned response.
    //   2. Retry after escaping unescaped control chars (raw \n in reasoning).
    //   3. Per-object salvage — walk the array, parse each {...} entry
    //      independently. Survives truncation, single bad reasoning
    //      string, trailing prose, and other partial corruption that
    //      would kill the whole batch.
    let parsed = tryParseLLMJson<any[]>(clean);
    if (parsed === null) {
      // Salvage — return whatever objects we can extract individually.
      const { items: salvaged, diagnostics } = salvageJsonArrayWithDiagnostics<any>(clean);
      const diagSummary =
        `inputLen=${diagnostics.inputLength} ` +
        `attempted=${diagnostics.objectsAttempted} ` +
        `closed=${diagnostics.objectsClosed} ` +
        `parsed=${diagnostics.objectsParsed} ` +
        `truncated=${diagnostics.truncatedMidObject} ` +
        `reachedEnd=${diagnostics.reachedArrayEnd}`;
      if (salvaged.length > 0) {
        this.emitLog('warn', `Whole-array parse failed; salvaged ${salvaged.length} object(s) [${diagSummary}]`);
        if (diagnostics.truncatedMidObject) {
          this.emitLog('warn', `↳ response was TRUNCATED mid-object — model hit token limit. Consider smaller batch or higher max_tokens.`);
        }
        parsed = salvaged;
      } else {
        // Last resort: the array may be buried in reasoning prose / model markers
        // that the tag-stripper and object-salvage missed (e.g. gpt-oss's analysis
        // channel). Bracket-match the first balanced [...] and parse it as a unit.
        const arr = extractBalancedJsonArray(clean);
        const retry = arr && arr !== clean ? tryParseLLMJson<any[]>(arr) : null;
        if (Array.isArray(retry)) {
          this.emitLog('warn', `Recovered array via bracket-match after salvage failed [${diagSummary}]`);
          parsed = retry;
        } else {
          // Not a usable array/object → skip this batch (agent_status stays
          // pending, so it retries). Log a SHORT, single-line preview of what we
          // actually got so the breaking shape is visible without a full dump.
          const got = clean.replace(/\s+/g, ' ').trim().slice(0, 200);
          this.emitLog('error', `No usable JSON in response [${diagSummary}] got="${got}"`);
          return [];
        }
      }
    }

    if (!Array.isArray(parsed)) {
      this.emitLog('error', `Response is not an array — got: ${typeof parsed}`);
      return [];
    }

    // Salvage valid items from partially malformed responses
    const results: CategorizationResult[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== 'object' || !item.emailId) {
        logger.warn('[AICategorizationService] Skipping invalid item:', item);
        continue;
      }

      // Parse categories — either new format (array of slugs) or legacy boolean format
      let categories: string[];
      if (Array.isArray(item.categories)) {
        // New format: filter out unknown slugs
        categories = item.categories.filter((s: any) => typeof s === 'string' && this.categorySlugs.has(s));
      } else {
        // Legacy boolean format — convert to slug array
        categories = [];
        if (item.is_important === true) categories.push('important');
        if (item.is_reminder === true) categories.push('reminders');
        if (item.is_needs_response === true) categories.push('needs_response');
        if (item.is_meeting_related === true) categories.push('meeting');
        if (item.is_invoice_billing === true) categories.push('invoice');
        // Filter to only known slugs
        categories = categories.filter(s => this.categorySlugs.has(s));
      }

      const isSpam = item.is_spam === true;
      // If spam, clear categories
      if (isSpam) {
        categories = [];
      }

      results.push({
        emailId: String(item.emailId),
        categories,
        isSpam,
        confidence: typeof item.confidence === 'number' ? item.confidence : 0.5,
        reasoning: item.reasoning || '',
      });
    }

    if (results.length < parsed.length) {
      logger.warn(`[AICategorizationService] Salvaged ${results.length}/${parsed.length} valid items`);
    }

    return results;
  }

  // ========== Save ==========

  private async saveBatch(results: CategorizationResult[], originalEmails: EmailForCategorization[]): Promise<void> {
    const storage = requireStorage();
    const processedAt = Math.floor(Date.now() / 1000);

    const batch = results.map(r => ({
      emailId: r.emailId,
      categories: r.categories.map(slug => ({ slug, confidence: r.confidence })),
      isSpam: r.isSpam,
      reasoning: r.reasoning || '',
      processedAt,
      confidence: r.confidence,
    }));

    const saved = storage.saveEmailCategoriesBatch(batch);
    const categoryCounts = results.reduce((acc, r) => {
      if (r.isSpam) acc['spam'] = (acc['spam'] || 0) + 1;
      for (const c of r.categories) acc[c] = (acc[c] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    const categorySummary = Object.entries(categoryCounts).map(([k, v]) => `${k}:${v}`).join(' ') || 'none';
    this.emitLog('info', `Saved ${saved} categorizations (${categorySummary})`);

    // Update progress with category breakdown and recent activity
    if (this.progress) {
      for (const r of results) {
        if (r.isSpam) {
          this.progress.categorized['spam'] = (this.progress.categorized['spam'] || 0) + 1;
        }
        for (const slug of r.categories) {
          this.progress.categorized[slug] = (this.progress.categorized[slug] || 0) + 1;
        }

        const cats: string[] = r.isSpam ? ['spam'] : [...r.categories];
        const original = originalEmails.find(e => e.id === r.emailId);

        this.progress.recentActivity.unshift({
          emailId: r.emailId,
          subject: original?.subject || 'Unknown',
          fromAddress: original?.fromAddress || 'Unknown',
          categories: cats,
          confidence: r.confidence,
          timestamp: Date.now(),
        });

        if (this.progress.recentActivity.length > MAX_RECENT_ACTIVITY) {
          this.progress.recentActivity.pop();
        }
      }
    }

    // Handle AI-detected spam — move to spam folder
    const spamResults = results.filter(r => r.isSpam);
    if (spamResults.length > 0) {
      logger.info(`[AICategorizationService] Moving ${spamResults.length} spam emails`);
      // We can't move emails here directly since moveToSpam requires IMAP.
      // The renderer will handle this after receiving the progress event.
    }
  }

  // ========== IPC Events ==========

  /**
   * Mirror a log line into the renderer console. The categorization
   * service runs in main, so its `console.log` calls don't surface in
   * the renderer devtools window (the user's main debugging surface).
   * Critical signals (batch saved, parse failures, retries) flow through
   * here so the user can SEE what's happening from devtools.
   *
   * Also emits to main's console for the case where the user IS
   * tailing the Electron stderr — so we don't lose logs to either side.
   */
  private emitLog(level: 'info' | 'warn' | 'error', message: string, extra?: any): void {
    const tag = '[AICategorizationService]';
    const line = extra !== undefined ? `${tag} ${message}` : `${tag} ${message}`;
    if (level === 'error') logger.error(line, extra ?? '');
    else if (level === 'warn') logger.warn(line, extra ?? '');
    else logger.info(line, extra ?? '');
    try {
      const win = getMainWindow();
      if (win && !win.isDestroyed()) {
        win.webContents.send('ai-categorization:log', {
          level,
          message: extra !== undefined ? `${message} ${typeof extra === 'string' ? extra : JSON.stringify(extra).slice(0, 500)}` : message,
          ts: Date.now(),
        });
      }
    } catch {
      // Window may be closed
    }
  }

  private emitProgress(): void {
    try {
      const win = getMainWindow();
      if (win && !win.isDestroyed() && this.progress) {
        win.webContents.send('ai-categorization:progress', { ...this.progress });
      }
    } catch {
      // Window may be closed
    }
  }

  private emitComplete(): void {
    try {
      const win = getMainWindow();
      if (win && !win.isDestroyed()) {
        // `ok` = this run categorized at least one email and did NOT end on a
        // terminal error. The renderer uses it to clear a stale "AI inactive"
        // banner once processing is demonstrably working again.
        const ok = (this.progress?.current || 0) > 0 && !this.lastRunTerminal;
        win.webContents.send('ai-categorization:complete', {
          progress: this.progress ? { ...this.progress } : null,
          ok,
        });
      }
    } catch {
      // Window may be closed
    }
    this.progress = null;
  }

  private emitError(message: string, info?: AIErrorInfo): void {
    try {
      const win = getMainWindow();
      if (win && !win.isDestroyed()) {
        // `terminal`/`reason`/`status` let the renderer decide whether to raise
        // the Fix banner (terminal) or stay quiet while main auto-retries.
        win.webContents.send('ai-categorization:error', {
          message,
          terminal: info?.terminal ?? false,
          kind: info?.kind,
          status: info?.status,
          reason: info?.reason ?? message,
        });
      }
    } catch {
      // Window may be closed
    }
  }

  // ========== Utility ==========

  private delay(ms: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const signal = this.abortController?.signal;
      const onAbort = () => {
        clearTimeout(timer);
        reject(new Error('Aborted'));
      };
      const timer = setTimeout(() => {
        // Detach the abort listener on normal resolution — otherwise long
        // runs accumulate one orphaned listener per chunk on the signal.
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}
