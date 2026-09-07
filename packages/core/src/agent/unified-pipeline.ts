/**
 * Unified Email Intelligence Pipeline
 *
 * Handles AI categorization + action execution in ONE LLM call per batch.
 * Priority scoring is done EXTERNALLY by BehaviorIntelligence (caller's responsibility).
 *
 * Steps:
 *   1. ENRICH — gather sender stats, contact type, thread context
 *   2. AI CATEGORIZE — one LLM call with full enriched context
 *   3. SAVE — categories as tags, ai metadata
 *   4. EXECUTE/PROPOSE — confidence-based action routing
 *
 * Platform-agnostic — no Electron deps, everything injected.
 */

import type {
  IAgentStorage,
  AgentConfig,
  UserActionType,
  ContactType,
} from '../types/agent';
import type { EmailRecord } from '../types/models';
import { logger } from '../utils/logger';

import {
  buildCategorizationPrompt,
  buildEmailText,
  validateCategorizationResponse,
  type EnrichedEmail,
  type CategoryDef,
  type CategorizationResult,
  MAX_BODY_LENGTH,
} from './categorization-utils';


// ========== Types ==========

export interface UnifiedPipelineDeps {
  agentStorage: IAgentStorage;
  userEmail: string;
  callAI: (systemPrompt: string, userMessage: string) => Promise<string>;
  getEmail: (id: string) => Promise<EmailRecord | null>;
  getSenderContextBatch: (emails: string[]) => Record<string, any>;
  getThreadDepths: (threadIds: string[]) => Record<string, number>;
  getSenderRepetitionStats: (emails: string[]) => { sameSubject: Record<string, Record<string, number>>; totalEmails: number };
  getEnabledCategoryDefinitions: () => CategoryDef[];
  saveEmailCategoriesBatch: (batch: Array<{
    emailId: string;
    categories: { slug: string; confidence: number }[];
    isSpam: boolean;
    reasoning: string;
    processedAt: number;
    confidence: number;
  }>) => number;
  executeAction: (emailId: string, action: UserActionType, value?: string) => Promise<void>;
  getContactType: (email: string) => ContactType;
  getImportanceScore: (emailId: string) => number;
  getCategoryCorrelations: () => Record<string, { action: string; rate: number }>;
  /** Save extracted contact notes */
  saveNotes?: (notes: Array<{ email: string; note: string; category: string; sourceEmailId?: string }>) => number;
  /** Get existing notes for a sender (for LLM prompt) */
  getNotesForPrompt?: (email: string) => string;
  /**
   * Optional hook to fetch user-edited prompt templates by id. Keys used:
   *   'categorization_system' — categorization prompt scaffolding
   *   'agent_plan' / 'agent_draft' — reply drafter (consumed directly by
   *      AgentReplyDrafter, not this pipeline)
   */
  getPromptTemplate?: (id: string) => string | null | undefined;
  /**
   * Optional addressing gate. When provided and it returns false for an
   * enriched email, the pipeline strips the `needs_response` category and
   * forces `shouldAutoDraft=false` on the categorization result — keeping
   * the user-facing invariant "every needs_response has a draft, and
   * nothing gets either if the email is not addressed to me".
   *
   * Wired from the service layer where the addressing helpers live.
   */
  isUserAddressed?: (email: EnrichedEmail) => boolean;
}

export interface PipelineResult {
  emailId: string;
  categories: string[];
  isSpam: boolean;
  categorizationConfidence: number;
  reasoning: string;
  predictedAction: UserActionType | null;
  actionConfidence: number;
  executed: boolean;
  proposed: boolean;
  /** ID of the agent_decisions row (if created) */
  decisionId?: string;
  /**
   * True when the categorize LLM call failed (threw, or returned no
   * result for this email despite enabled categories) — as opposed to a
   * legitimately empty categorization. Lets the caller leave the email
   * pending for retry instead of marking it done un-categorized.
   */
  categorizationFailed?: boolean;
  /**
   * True ONLY for a deterministic parse failure: the LLM responded but this
   * email was absent from / unparseable in that response (validator returned no
   * result for it) — NOT a thrown transient/auth/credit error. Lets the caller
   * cap retries on genuinely un-parseable emails while keeping transient
   * failures pending for retry indefinitely.
   */
  categorizationParseFailed?: boolean;
}

export interface UnifiedPipelineConfig extends AgentConfig {
  batchSize: number;
  interBatchDelayMs: number;
}

/** Enrichment inputs fetched once per chunk and shared across its emails. */
interface EnrichmentContext {
  senderContextMap: Record<string, any>;
  threadDepthMap: Record<string, number>;
  repetitionStats: { sameSubject: Record<string, Record<string, number>>; totalEmails: number };
}

const DEFAULT_CONFIG: UnifiedPipelineConfig = {
  // Default ON: the agent categorizes, prioritizes, and drafts replies out
  // of the box. This is the passive/safe surface — autonomous ACTIONS
  // (auto-triage, auto-read, auto-SEND) stay individually opt-in below and
  // default off, so enabling the agent never sends or deletes anything.
  enabled: true,
  autoActThreshold: 0.85,
  suggestThreshold: 0.5,
  autoTriage: false,
  autoRead: true,
  draftReplies: true,
  autoReply: false,
  autoStar: false,
  autoPrioritize: true,
  neverAutoDeleteFrom: [],
  neverAutoReplyTo: [],
  requireApprovalForNew: true,
  maxAutoActionsPerHour: 50,
  searchWebEnabled: false,
  tavilyApiKey: '',
  testMode: false,
  batchSize: 10,
  interBatchDelayMs: 1500,
};

// ========== Pipeline ==========

export class UnifiedPipeline {
  private config: UnifiedPipelineConfig;
  private processingSet = new Set<string>();
  private autoActionsThisHour = 0;
  private lastHourReset = 0;

  constructor(
    private deps: UnifiedPipelineDeps,
    config?: Partial<UnifiedPipelineConfig>,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  updateConfig(updates: Partial<UnifiedPipelineConfig>): void {
    this.config = { ...this.config, ...updates };
  }

  getConfig(): UnifiedPipelineConfig { return { ...this.config }; }

  /**
   * Reserve one slot of the hourly auto-action budget (maxAutoActionsPerHour).
   * Returns false when the circuit breaker is tripped. The service layer's
   * SMTP auto-send (autoReply) draws from the SAME counter as in-pipeline
   * auto-executions, so every autonomous action shares one budget.
   */
  tryReserveAutoAction(): boolean {
    if (!this.checkRateLimit()) return false;
    this.autoActionsThisHour++;
    return true;
  }

  /**
   * Process single email: enrich → categorize → execute/propose.
   */
  async processEmail(email: EmailRecord): Promise<PipelineResult | null> {
    if (this.processingSet.has(email.id)) return null;
    this.processingSet.add(email.id);
    try {
      const enriched = this.enrichEmail(email);
      let catResult: CategorizationResult | null = null;
      let catFailed = false;
      // Deterministic parse failure (LLM answered but dropped/mangled this
      // email) vs a thrown transient/terminal error. Only the former is safe to
      // give up on after a retry cap; transient errors must stay pending.
      let catParseFailed = false;

      try {
        const results = await this.categorize([enriched]);
        catResult = results.find(r => r.emailId === email.id) || null;
        if (!catResult) {
          // No result despite enabled categories = LLM/parse failure (the
          // validator returns [] on bad JSON). Empty category defs is the
          // only legitimately-empty case.
          catFailed = this.deps.getEnabledCategoryDefinitions().length > 0;
          catParseFailed = catFailed;
        }
      } catch (error) {
        catFailed = true;
        logger.error(`[Pipeline] Categorize failed for ${email.id}:`, error);
      }

      const prediction = this.predictFromCategories(email, catResult);
      const execution = await this.executeOrPropose(email, prediction);

      return {
        emailId: email.id,
        categories: catResult?.categories || [],
        isSpam: catResult?.isSpam || false,
        categorizationConfidence: catResult?.confidence || 0,
        reasoning: catResult?.reasoning || '',
        predictedAction: prediction?.action || null,
        actionConfidence: prediction?.confidence || 0,
        executed: execution.executed,
        proposed: execution.proposed,
        decisionId: execution.decisionId,
        categorizationFailed: catFailed,
        categorizationParseFailed: catParseFailed,
      };
    } finally {
      this.processingSet.delete(email.id);
    }
  }

  /**
   * Process batch of emails.
   */
  async processBatch(emails: EmailRecord[]): Promise<PipelineResult[]> {
    const results: PipelineResult[] = [];
    for (let i = 0; i < emails.length; i += this.config.batchSize) {
      const chunk = emails.slice(i, i + this.config.batchSize).filter(e => !this.processingSet.has(e.id));
      if (chunk.length === 0) continue;

      for (const e of chunk) this.processingSet.add(e.id);
      try {
        // Fetch sender/thread/repetition stats ONCE for the whole chunk, then
        // enrich each email from those shared maps (was 3 storage calls per
        // email — 30 per 10-email chunk).
        const context = this.buildEnrichmentContext(chunk);
        const enriched = chunk.map(e => this.enrichWithContext(e, context));
        let catResults: CategorizationResult[] = [];
        try { catResults = await this.categorize(enriched); } catch (e) { logger.error('[Pipeline] Batch categorize failed:', e); }
        const catMap = new Map(catResults.map(r => [r.emailId, r]));

        for (const email of chunk) {
          const catResult = catMap.get(email.id) || null;
          const prediction = this.predictFromCategories(email, catResult);
          const execution = await this.executeOrPropose(email, prediction);
          results.push({
            emailId: email.id,
            categories: catResult?.categories || [],
            isSpam: catResult?.isSpam || false,
            categorizationConfidence: catResult?.confidence || 0,
            reasoning: catResult?.reasoning || '',
            predictedAction: prediction?.action || null,
            actionConfidence: prediction?.confidence || 0,
            executed: execution.executed,
            proposed: execution.proposed,
            decisionId: execution.decisionId,
          });
        }
      } finally {
        for (const e of chunk) this.processingSet.delete(e.id);
      }
      if (i + this.config.batchSize < emails.length) {
        await new Promise(r => setTimeout(r, this.config.interBatchDelayMs));
      }
    }
    return results;
  }

  // ========== Enrich ==========

  /**
   * Shared per-chunk enrichment inputs. The three batch deps are keyed/grouped
   * by sender address or thread id (and totalEmails is a global count), so
   * fetching them ONCE for the whole chunk and indexing by key yields exactly
   * the same per-email values as the old per-email single-element calls — but
   * with 3 storage calls per chunk instead of 3 per email.
   */
  private buildEnrichmentContext(emails: EmailRecord[]): EnrichmentContext {
    const fromAddrs = new Set<string>();
    const threadIds = new Set<string>();
    for (const email of emails) {
      fromAddrs.add((email.fromAddress || '').toLowerCase());
      if (email.threadId) threadIds.add(email.threadId);
    }
    const addrList = [...fromAddrs];
    return {
      senderContextMap: addrList.length > 0 ? this.deps.getSenderContextBatch(addrList) : {},
      threadDepthMap: threadIds.size > 0 ? this.deps.getThreadDepths([...threadIds]) : {},
      repetitionStats: addrList.length > 0
        ? this.deps.getSenderRepetitionStats(addrList)
        : { sameSubject: {}, totalEmails: 0 },
    };
  }

  private enrichEmail(email: EmailRecord): EnrichedEmail {
    return this.enrichWithContext(email, this.buildEnrichmentContext([email]));
  }

  private enrichWithContext(email: EmailRecord, context: EnrichmentContext): EnrichedEmail {
    const fromAddr = (email.fromAddress || '').toLowerCase();
    const userDomain = this.deps.userEmail?.split('@')[1]?.toLowerCase() || '';
    const senderDomain = fromAddr.split('@')[1] || '';

    const { senderContextMap, threadDepthMap, repetitionStats } = context;
    const ctx = senderContextMap[fromAddr];
    const body = email.cleanBody || email.rawBody || '';

    const origin = userDomain && senderDomain === userDomain
      ? 'internal (same domain)' : `external (${senderDomain})`;
    const toAddrs = (email.toAddress || '').toLowerCase();
    const ccAddrs = (email.ccAddress || '').toLowerCase();
    const userLower = this.deps.userEmail?.toLowerCase() || '';
    // Exact address comparison — substring matching made "joann@example.com"
    // match user "ann@example.com" and fed the LLM the wrong TO/CC role.
    const extractAddrs = (s: string) => s.match(/[\w.+-]+@[\w.-]+/g) || [];
    const userInTo = userLower ? extractAddrs(toAddrs).some(a => a === userLower) : false;
    const userInCc = userLower ? (!userInTo && extractAddrs(ccAddrs).some(a => a === userLower)) : false;
    const subjectMap = repetitionStats.sameSubject[fromAddr];
    const sameSubjectCount = subjectMap ? (subjectMap[email.subject || ''] || 0) : 0;
    const senderReceived = ctx ? ctx.receivedCount : 0;
    const volumePercent = repetitionStats.totalEmails > 0 ? Math.round((senderReceived / repetitionStats.totalEmails) * 1000) / 10 : 0;

    // Parse the stored auth_status JSON (if present) — sent as a raw fact
    // in the prompt rather than rolled into a score.
    let authStatus: EnrichedEmail['authStatus'] | undefined;
    if (email.authStatus) {
      try {
        const parsed = typeof email.authStatus === 'string'
          ? JSON.parse(email.authStatus)
          : email.authStatus;
        if (parsed && typeof parsed === 'object') {
          authStatus = {
            spf: parsed.spf,
            dkim: parsed.dkim,
            dmarc: parsed.dmarc,
            overall: parsed.overall,
          };
        }
      } catch { /* malformed JSON — drop silently */ }
    }

    return {
      id: email.id,
      subject: email.subject || '',
      fromAddress: fromAddr,
      toAddress: email.toAddress || '',
      ccAddress: email.ccAddress || '',
      body: body.length > MAX_BODY_LENGTH ? body.substring(0, MAX_BODY_LENGTH) : body,
      date: email.date,
      isRead: (email.tags || '').includes('|read|'),
      origin,
      userInCc,
      sameSubjectCount,
      volumePercent,
      threadDepth: email.threadId ? (threadDepthMap[email.threadId] || 1) : 1,
      senderContext: ctx || undefined,
      contactType: this.deps.getContactType(fromAddr),
      importanceScore: email.importanceScore || this.deps.getImportanceScore(email.id),
      authStatus,
      existingNotes: this.deps.getNotesForPrompt?.(fromAddr) || undefined,
    };
  }

  // ========== Categorize (LLM) ==========

  private async categorize(emails: EnrichedEmail[]): Promise<CategorizationResult[]> {
    const categoryDefs = this.deps.getEnabledCategoryDefinitions();
    if (categoryDefs.length === 0) return [];
    const slugs = categoryDefs.map(c => c.slug);
    const slugSet = new Set(slugs);

    const promptOverride = this.deps.getPromptTemplate?.('categorization_system') || undefined;
    const systemPrompt = buildCategorizationPrompt(categoryDefs, this.deps.userEmail, promptOverride);
    const userMessage = buildEmailText(emails, this.deps.userEmail, slugs);
    const responseText = await this.deps.callAI(systemPrompt, userMessage);
    const results = validateCategorizationResponse(responseText, slugSet, categoryDefs);

    // Addressing gate: if the user is not in TO and not mentioned in body,
    // the email is not for them — strip needs_response and force
    // shouldAutoDraft=false. Keeps needs_response ↔ auto-draft in 1:1
    // correspondence and prevents the Needs Response chip from filling up
    // with team FYIs / loop-ins the user shouldn't reply to.
    if (this.deps.isUserAddressed && results.length > 0) {
      const enrichedById = new Map(emails.map(e => [e.id, e]));
      for (const r of results) {
        const enriched = enrichedById.get(r.emailId);
        if (!enriched) continue;
        if (!this.deps.isUserAddressed(enriched)) {
          if (r.categories.includes('needs_response')) {
            r.categories = r.categories.filter(c => c !== 'needs_response');
          }
          r.shouldAutoDraft = false;
          r.autoDraftReason = undefined;
        }
      }
    }

    // Automated-sender gate: bills, ticketing systems, bank alerts, and
    // marketing platforms cannot satisfy `needs_response` — they don't read
    // replies. The LLM frequently over-tags these because the body asks the
    // user to "confirm" or "respond", but a reply lands in /dev/null. Strip
    // needs_response and force shouldAutoDraft=false; preserve `important`
    // if the LLM set it (a billing reminder genuinely needs attention, just
    // not a reply). Mirrors the runtime check in autoDraftReply so the two
    // surfaces stay consistent — the Needs Response chip count and the
    // draft pipeline both agree on what counts as needs_response.
    if (results.length > 0) {
      const enrichedById = new Map(emails.map(e => [e.id, e]));
      const AUTOMATED_LOCAL =
        /(^|[.\-_])(noreply|no-reply|donotreply|do-not-reply|notifications?|alerts?|mailer|mailer-daemon|postmaster|bounces?|automated|system|transactional|receipt|statement|billing|info|support-bot|hello)([.\-_]|$)/i;
      const TRANSACTIONAL_SUBDOMAIN =
        /^(mail|email|mailer|notify|notifications?|news|updates?|alerts?|marketing|reply|do-not-reply|bounce|bounces|receipts?|invoicing|billing|transactional|info|track|tracking|messages?|hello|comms?|relay|smtp\d*|em\d+|edm)\./i;
      for (const r of results) {
        const enriched = enrichedById.get(r.emailId);
        if (!enriched) continue;
        const from = (enriched.fromAddress || '').toLowerCase().trim();
        const at = from.indexOf('@');
        const local = at > 0 ? from.slice(0, at) : from;
        const domain = at > 0 ? from.slice(at + 1) : '';
        const malformed = at <= 0 || !local || !domain;
        const automated =
          malformed ||
          AUTOMATED_LOCAL.test(local) ||
          TRANSACTIONAL_SUBDOMAIN.test(domain);
        if (!automated) continue;
        if (r.categories.includes('needs_response')) {
          r.categories = r.categories.filter((c) => c !== 'needs_response');
        }
        r.shouldAutoDraft = false;
        r.autoDraftReason = undefined;
      }
    }

    if (results.length > 0) {
      const processedAt = Math.floor(Date.now() / 1000);
      this.deps.saveEmailCategoriesBatch(results.map(r => ({
        emailId: r.emailId,
        categories: r.categories.map(slug => ({ slug, confidence: r.confidence })),
        isSpam: r.isSpam,
        reasoning: r.reasoning,
        processedAt,
        confidence: r.confidence,
      })));

      // Save extracted contact notes
      if (this.deps.saveNotes) {
        const allNotes: Array<{ email: string; note: string; category: string; sourceEmailId?: string }> = [];
        for (const result of results) {
          if (result.notes && result.notes.length > 0) {
            const enriched = emails.find(e => e.id === result.emailId);
            const senderEmail = enriched?.fromAddress || '';
            for (const n of result.notes) {
              allNotes.push({ email: senderEmail, note: n.note, category: n.category, sourceEmailId: result.emailId });
            }
          }
        }
        if (allNotes.length > 0) {
          const saved = this.deps.saveNotes(allNotes);
          if (saved > 0) logger.info(`[Pipeline] Saved ${saved} contact notes from ${results.length} emails`);
        }
      }
    }
    return results;
  }

  // ========== Predict from categories (no LLM — uses the AI's own decision) ==========

  private predictFromCategories(
    email: EmailRecord,
    catResult: CategorizationResult | null,
  ): { action: UserActionType; confidence: number; reasoning: string } | null {
    if (!catResult) return null;
    if (catResult.isSpam) return { action: 'spam', confidence: 0.9, reasoning: 'AI detected spam' };

    // Needs Response ⟺ Draft are COUPLED 1:1. The driver is the
    // `needs_response` category, NOT the separate `should_auto_draft`
    // flag — so every email that genuinely needs a reply also gets a
    // drafted one (and nothing else does). By this point the categorize()
    // addressing- and automated-sender gates have already stripped
    // needs_response from anything not addressed to the user or sent by a
    // no-reply system, so `needs_response` here means "the user owes a
    // reply." `should_auto_draft` is kept only as supplementary reasoning,
    // never as a gate (it used to silently suppress drafts for real
    // needs_response mail — the source of "0 drafts").
    const categories = new Set(catResult.categories);
    if (this.config.draftReplies && categories.has('needs_response')) {
      // One tiny deterministic safety net: NEVER auto-draft to a bounce /
      // mailer-daemon sender, regardless of what the model says. This is the
      // only guard that's not a judgement call; sending to these addresses
      // either fails or spams a shared inbox.
      const localPart = (email.fromAddress || '').toLowerCase().split('@')[0] || '';
      const HARD_NOREPLY = /^(mailer-daemon|postmaster|bounce|bounces)$/;
      if (HARD_NOREPLY.test(localPart)) return null;

      const confidence = typeof catResult.confidence === 'number' ? catResult.confidence : 0.8;
      return {
        action: 'reply',
        confidence: Math.max(0.5, Math.min(1, confidence)),
        reasoning: catResult.autoDraftReason || catResult.reasoning || 'AI: draft reply',
      };
    }

    // FALLBACK: learned per-category correlations from past user actions.
    // Still useful for non-reply actions (auto-archive a newsletter the user
    // always archives, auto-spam obvious junk, etc.).
    //
    // Confidence = rate directly (capped at 0.95 so we never claim 100%
    // certainty). Previously used rate * 0.9 with a cap of 0.85, which made
    // the effective floor for auto-action ~94% — almost impossible for any
    // real user's category to cross. Using rate directly means a 0.85
    // autoActThreshold fires at an 85% pattern, which is realistic.
    const correlations = this.deps.getCategoryCorrelations();
    for (const cat of catResult.categories) {
      const corr = correlations[cat];
      if (corr && corr.rate >= 0.5) {
        return {
          action: corr.action as UserActionType,
          confidence: Math.min(0.95, corr.rate),
          reasoning: `Learned: ${Math.round(corr.rate * 100)}% of "${cat}" → ${corr.action}`,
        };
      }
    }

    return null;
  }

  // ========== Execute/Propose ==========

  private async executeOrPropose(
    email: EmailRecord,
    prediction: { action: UserActionType; confidence: number; reasoning: string } | null,
  ): Promise<{ executed: boolean; proposed: boolean; decisionId?: string; predictedAction?: string }> {
    if (!prediction) return { executed: false, proposed: false };
    // 'enabled' only gates auto-execution, not proposals (suggestions are passive)
    if (!this.isSafeToAct(email, prediction.action)) return { executed: false, proposed: false };

    const now = Math.floor(Date.now() / 1000);

    // Reply-style actions are NEVER auto-executed here. Drafting and the
    // optional SMTP auto-send (config.autoReply) happen service-side in
    // unified-pipeline-service.autoDraftReply, which needs a decision row
    // to attach the draft to — so replies always go down the proposal path
    // below, regardless of autoReply/confidence.
    const isReplyAction = prediction.action === 'reply' || prediction.action === 'reply_all';

    if (!isReplyAction && this.config.enabled && prediction.confidence >= this.config.autoActThreshold && this.canAutoAct(prediction.action)) {
      if (!this.checkRateLimit()) return { executed: false, proposed: false };
      const decisionId = `dec-${now}-${Math.random().toString(36).substr(2, 9)}`;
      try {
        await this.deps.executeAction(email.id, prediction.action);
        this.autoActionsThisHour++;
        await this.deps.agentStorage.saveDecision({
          id: decisionId,
          emailId: email.id, threadId: email.threadId || null,
          senderAddress: email.fromAddress?.toLowerCase() || null,
          proposedAction: prediction.action, proposedValue: null,
          confidence: prediction.confidence, reasoning: `[AUTO] ${prediction.reasoning}`,
          status: 'auto', actualAction: prediction.action, userFeedback: null,
          proposedAt: now, resolvedAt: now, createdAt: now,
        });
        return { executed: true, proposed: false, decisionId, predictedAction: prediction.action };
      } catch { return { executed: false, proposed: false }; }
    }

    // Only create a decision row for reply-style actions — the draft follow-up
    // (autoDraftReply) looks it up by id to attach the generated draft body
    // (and, with autoReply on, to auto-send it). All other actions either
    // auto-execute above or are dropped here so we don't accumulate a
    // "pending approval" queue the user never resolves. Gated on
    // draftReplies: with drafting off there's nothing downstream to do with
    // a reply decision (the learned-correlation fallback can also predict
    // 'reply', so the gate in predictFromCategories alone isn't enough).
    if (isReplyAction && this.config.draftReplies && prediction.confidence >= this.config.suggestThreshold) {
      const decisionId = `dec-${now}-${Math.random().toString(36).substr(2, 9)}`;
      // Mirror the auto path's try/catch — an SQLite error here must not
      // abort the caller's whole batch.
      try {
        await this.deps.agentStorage.saveDecision({
          id: decisionId,
          emailId: email.id, threadId: email.threadId || null,
          senderAddress: email.fromAddress?.toLowerCase() || null,
          proposedAction: prediction.action, proposedValue: null,
          confidence: prediction.confidence, reasoning: prediction.reasoning,
          status: 'pending', actualAction: null, userFeedback: null,
          proposedAt: now, resolvedAt: null, createdAt: now,
        });
        return { executed: false, proposed: true, decisionId, predictedAction: prediction.action };
      } catch { return { executed: false, proposed: false }; }
    }

    return { executed: false, proposed: false };
  }

  private isSafeToAct(email: EmailRecord, action: UserActionType): boolean {
    const sender = email.fromAddress?.toLowerCase() || '';
    const domain = sender.split('@')[1] || '';
    if (['delete', 'spam'].includes(action) && this.config.neverAutoDeleteFrom.some(s => sender.includes(s.toLowerCase()) || domain.includes(s.toLowerCase()))) return false;
    if (['reply', 'reply_all'].includes(action) && this.config.neverAutoReplyTo.some(s => sender.includes(s.toLowerCase()) || domain.includes(s.toLowerCase()))) return false;
    return true;
  }

  private canAutoAct(action: UserActionType): boolean {
    switch (action) {
      case 'archive': case 'delete': case 'spam': return this.config.autoTriage;
      case 'read': return this.config.autoRead;
      // Replies are excluded from in-pipeline auto-execution entirely
      // (executeOrPropose routes them to a proposal before consulting this).
      // config.autoReply now means SMTP auto-send, applied service-side in
      // autoDraftReply with its own confidence/safety/rate gates.
      case 'reply': case 'reply_all': return false;
      // Auto-star / auto-important removed — the agent should not mutate
      // star flags based on learned behavior. Users rely on star/flag as
      // their own manual triage signal.
      default: return false;
    }
  }

  private checkRateLimit(): boolean {
    const now = Math.floor(Date.now() / 1000);
    const hourStart = Math.floor(now / 3600) * 3600;
    if (hourStart !== this.lastHourReset) { this.lastHourReset = hourStart; this.autoActionsThisHour = 0; }
    return this.autoActionsThisHour < this.config.maxAutoActionsPerHour;
  }
}
