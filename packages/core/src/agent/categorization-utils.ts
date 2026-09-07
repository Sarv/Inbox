/**
 * Categorization Utilities
 *
 * Extracted from AICategorizationService for reuse in UnifiedPipeline.
 * Contains: prompt building, response validation, email enrichment types.
 */

import pRetry, { AbortError } from 'p-retry';

import { logger } from '../utils/logger';
import { SarvApiError, parseSarvApiError, type SarvErrorCode } from '../utils/sarv-api-error';

import { cleanLLMJsonResponse, tryParseLLMJson, salvageJsonArrayWithDiagnostics, extractBalancedJsonArray } from './llm-response-utils';

// ========== Types ==========

export interface AIProviderConfig {
  type: 'openai' | 'gemini' | 'sarv' | 'custom';
  /** For ``sarv``: historically an oauth-issued JWT; now usually empty
   * because ``resolveBearer`` supplies a fresh token per request. For
   * other providers: the provider's own API key. */
  apiKey: string;
  model: string;
  /** For ``sarv`` this MUST be the oauth-provisioned edge LLM URL
   * (e.g. ``http://localhost:<port>/edge/v1/llm`` in dev; swap host for
   * prod). The code appends ``/chat/completions``. Callers should read
   * it from the OAuth session's ``llmBaseUrl``. */
  baseUrl?: string;
  /** Optional async bearer resolver. When set, it's called on every LLM
   * request and its return value replaces ``apiKey`` in the
   * Authorization header. This is the only safe way to call OAuth-
   * backed providers where the access token rotates every ~15 minutes —
   * the caller fetches a valid token on-demand via the main-process
   * OAuth service. Not serializable over IPC, so attach it in the main
   * process right before handing the config to core.
   * `forceRefresh` bypasses the proactive-expiry cache so a 401 can force a
   * fresh token and retry. */
  resolveBearer?: (forceRefresh?: boolean) => Promise<string>;
  /** Optional fetch implementation. Node's global fetch (undici) verifies TLS
   * against only Node's bundled CA and skips AIA fetching, so an internal
   * gateway that serves an incomplete cert chain fails with
   * UNABLE_TO_VERIFY_LEAF_SIGNATURE — while the renderer (Chromium) reaches it
   * fine. The main process attaches Electron's `net.fetch` here so core's LLM
   * calls use Chromium's trust store + proxy too. Not serializable over IPC;
   * attach it in the main process right before handing the config to core.
   * Defaults to global `fetch`. Core always calls it with a string URL, so the
   * signature is narrowed accordingly (global `fetch` still satisfies it). */
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
}

/** Structured error surfaced by ``callAIProvider`` when the upstream
 * returns a recognizable Sarv-side error code. Lets the UI distinguish
 * user-fixable states (re-authorize, top up wallet) from developer bugs
 * (insufficient_scope) and platform limits (insufficient_role).
 *
 * Defined in ``utils/sarv-api-error`` (shared with the oauth catalog
 * fetchers) and re-exported here so existing importers keep working. */
export { SarvApiError, parseSarvApiError };
export type { SarvErrorCode };

export interface EnrichedEmail {
  id: string;
  subject: string;
  fromAddress: string;
  toAddress: string;
  ccAddress?: string;
  body: string;
  date: number;
  isRead: boolean;
  // Sender context
  senderContext?: SenderSignals;
  // Enrichment signals
  origin?: string;
  userInCc?: boolean;
  sameSubjectCount?: number;
  volumePercent?: number;
  threadDepth?: number;
  // Agent-specific signals
  contactType?: string;
  importanceScore?: number;
  behaviorPrediction?: { action: string; confidence: number } | null;
  /**
   * Raw auth headers parsed at ingest time (SPF / DKIM / DMARC). Surfaced
   * to the LLM as a fact rather than rolled into a pre-aggregated score
   * so the model can weigh it alongside the other signals directly.
   */
  authStatus?: {
    spf?: string;
    dkim?: string;
    dmarc?: string;
    overall?: string;
  };
  // Sender memory (from sender_stats)
  senderMemory?: {
    greeting: string | null;
    closing: string | null;
    tone: string | null;
    keyContext: string | null;
  };
  // Existing notes about this sender (for LLM context)
  existingNotes?: string; // Pre-formatted text from getNotesForPrompt()
}

export interface SenderSignals {
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
  /**
   * Optional windowed stats (default 90d). Prompt builder prefers these
   * over the lifetime counters above when recent signal is dense enough
   * (see buildEmailText). Absent for first-time senders or when the
   * storage layer didn't compute a window.
   */
  recent?: {
    windowDays: number;
    receivedCount: number;
    readCount: number;
    deletedCount: number;
    repliedCount: number;
  };
}

export interface CategoryDef {
  slug: string;
  name: string;
  prompt: string;
}

export interface CategorizationResult {
  emailId: string;
  categories: string[];
  isSpam: boolean;
  confidence: number;
  reasoning: string;
  /**
   * AI's end-to-end judgement on whether a reply draft should be prepared
   * for this email. TRUE only when the user is directly addressed, a
   * response is genuinely expected, and the sender is a real human/contact
   * (not a no-reply / newsletter / automated notification). Replaces the
   * old split between `needs_response` + deterministic `scoreReplyPrediction`
   * heuristics.
   */
  shouldAutoDraft?: boolean;
  /** AI's short explanation for the shouldAutoDraft decision. */
  autoDraftReason?: string;
  senderMemory?: {
    greeting?: string;
    tone?: string;
    keyContext?: string;
  };
  notes?: Array<{
    note: string;
    category: string;
  }>;
}

// ========== Constants ==========

export const MAX_BODY_LENGTH = 1000;
export const MAX_API_RETRIES = 3;

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

// ========== Prompt Builder ==========

/**
 * Default categorization system prompt, exported as a template so it can
 * be seeded into the DB and replaced by a user-edited version. Placeholder
 * syntax is `{{name}}` — substituted at call time by buildCategorizationPrompt.
 */
export const DEFAULT_CATEGORIZATION_TEMPLATE = `You are an email intelligence agent for the user "{{userEmail}}".
Your job: classify each email AND determine if it actually matters to THIS user.

USER: {{userEmail}} (name: {{userName}}, domain: {{userDomain}})

CATEGORIES — assign ONLY when clearly relevant to the user:
{{categorySection}}

SPAM:
{{spamPrompt}}

═══════════════════════════════════════════════════
CORE PRINCIPLE: Think from the USER's perspective.
═══════════════════════════════════════════════════

Ask yourself: "Would {{userName}} need to ACT on this email, or is it just noise?"

Each email includes behavioral data about the sender. USE IT:

SENDER BEHAVIOR DATA:
- "Behavior:" line shows how the user historically handles this sender's emails
- "Read: X%" = what % of this sender's emails the user actually opens
- "Keep: X%" = what % the user keeps (doesn't delete)
- "Replied: N" = how many times user replied to this sender
- Low Read% + Low Keep% = user doesn't care about this sender → NOT important
- High Replied count = user values this relationship → likely important
- If user NEVER replies to this sender → probably not needs_response

SENDER MEMORY:
- "Memory:" line shows how the user communicates with this sender
- Greeting style (e.g., "Hi John" vs "Dear Sir") reveals relationship formality
- Key context shows what they've been discussing recently
- Use this to understand the relationship depth

CONTACT TYPE:
- "Type:" shows the sender's classification
- "colleague" = same organization — only important if directly addressing the user
- "existing_customer" / "potential_customer" = high priority
- "automated" / "newsletter" = almost never important
- "unknown" = use the behavioral data to judge

WHO IS THE EMAIL ACTUALLY FOR? (MOST CRITICAL RULE)
- Check TO: and CC: fields carefully against user's email ({{userEmail}})
- "Role: CC" = user is just looped in, NOT the primary recipient
- If email body greets someone by name who is NOT the user → user is NOT the target
- If task/request is for someone in TO: field and user is in CC: → NOT user's task
- CC emails: DEFAULT is NOT important, NOT needs_response
- Only override CC default if user's name "{{userName}}" appears in the body with a direct request
- Team conversations where user is CC'd but work is for others → NOT important for user

WHAT MAKES AN EMAIL "IMPORTANT"?
- The user is directly addressed (TO:, not CC:)
- The email asks the user a question or requests their action
- It's from someone the user consistently replies to (high Replied count)
- It's from a customer or prospect (external, high value)
- It contains a deadline, decision request, or financial matter FOR THE USER
- NOT important: team loops, general announcements, tasks for others, newsletters

WHAT "NEEDS_RESPONSE"?
- A direct question to the user
- A request that only the user can fulfill
- A customer/client waiting for the user's reply
- HARD RULE: a HUMAN must be waiting for a HUMAN reply. Bills, ticket
  updates, bank confirmations, billing reminders, status alerts,
  marketing platforms, and any sender whose address looks automated
  (noreply / mail. / notifications. / alerts. / billing. / etc.) are
  NEVER needs_response — replies to those addresses bounce or vanish
  into a shared mailbox. They might still need the user's attention →
  use "important" for that, NOT needs_response.
- NOT needs_response: team FYI, newsletters, automated alerts, tasks
  assigned to others, billing/payment reminders, ticket auto-updates,
  bank confirmations, calendar invites, "verify your email" prompts.

SHOULD_AUTO_DRAFT — single authoritative decision for the reply-drafting pipeline
═══════════════════════════════════════════════════════════════════════
This field supersedes the legacy heuristic pipeline. Return TRUE only when
EVERY one of the following is true:
  1. The user is DIRECTLY addressed (sole or primary TO recipient, OR clearly
     named in the body even if on CC)
  2. A human response is genuinely expected — the email asks a question,
     requests an action, awaits confirmation, or is a personal/business
     conversation that normally gets a reply
  3. The sender is a real person or organization that REPLIES to replies —
     NOT a no-reply address, notifications bot, mailer-daemon, bounce,
     alerts system, ticketing auto-responder, or marketing blast
  4. Drafting a reply would plausibly SAVE the user time (an AI can take a
     reasonable first pass at the response). If the correct reply requires
     data the user alone holds (specific numbers, private context the user
     hasn't shared, approvals) STILL return TRUE — the user can edit. Only
     return FALSE if no reply is appropriate at all.

🚨 CONSISTENCY RULE (violating this is a bug in your output):
If should_auto_draft=TRUE, the categories array MUST contain "needs_response".
They are logically equivalent — a draftable reply IS a needs_response email.
Never set should_auto_draft=true without needs_response, and never set
needs_response without also considering should_auto_draft. If you can't
justify needs_response for this email, you cannot justify a draft either —
set should_auto_draft=false.

Return FALSE for: newsletters, transactional notifications (invoices,
receipts, shipping, password resets, login alerts), team-wide FYIs where
the user isn't named, calendar invites (they get accepted, not replied to),
bounces, auto-responders, spam-adjacent promotional mail, and anything
from a sender whose local-part matches noreply / no-reply / notifications
/ mailer-daemon / postmaster / bounce / alerts / automated.

RETURN FORMAT:
CONTACT KNOWLEDGE EXTRACTION:
For each email, extract useful facts about the sender as "notes" — like a CRM assistant:
- Role/title if mentioned
- Products/services discussed
- Financial amounts (invoices, payments, dues)
- Deadlines or commitments
- Complaints or appreciation
- Personal details shared (holidays, preferences)
- How they address the user / how user addresses them
- Key decisions made

Each note = one fact, one line. Category = role|product|financial|complaint|appreciation|deadline|personal|style|preference|general
Only extract REAL facts from this email. Don't speculate. Empty "notes":[] is fine.
If existing notes are shown for a sender, DON'T repeat them — only add NEW facts.

STYLE MEMORY (optional):
If you can see how the sender or user communicates, include "sender_memory":
- greeting: how they/user greets
- tone: formal/casual/brief
- key_context: current topic being discussed

STATIC PRIORITY SCORE:
- Some emails include "Static-Priority-Score: X/100" from a rule-based algorithm
- Use this as a SUPPORTING signal: high score (70+) suggests the email may be important
- But don't blindly trust it — the score is from static rules, you have content understanding
- A high-score CC email addressed to someone else is still NOT important for this user

CATEGORY ASSIGNMENT RULES (STRICT):
- Prefer ONE category per email. Only assign 2+ if genuinely applicable.
- "important" is RARE — means URGENT, needs action TODAY. Not just "relevant".
- An invoice is just "invoice", NOT also "important" unless payment is overdue TODAY.
- A finance email is just "finance", NOT also "important" unless it's a fraud alert.
- A meeting invite is just "meeting", NOT also "important" unless the meeting is in the next hour.
- "needs_response" + another category is OK if the email clearly asks a question AND fits another category.
- When in doubt, assign FEWER categories. Empty [] is perfectly valid.

RETURN FORMAT:

[
  {
    "emailId": "...",
    "categories": [],
    "is_spam": false,
    "confidence": 0.85,
    "reasoning": "CC'd on team task for Hrishi",
    "should_auto_draft": false,
    "auto_draft_reason": "User is CC'd; request is addressed to Hrishi by name",
    "notes": [
      {"note": "Working on console app icon redesign", "category": "product"},
      {"note": "Reports to Hrishi for design tasks", "category": "role"}
    ],
    "sender_memory": {"greeting": "Hello Hrishi", "tone": "formal", "key_context": "Icon changes for console app"}
  }
]

"should_auto_draft" and "auto_draft_reason" are REQUIRED fields — they are
the single source of truth for whether the auto-draft pipeline runs.
"notes" and "sender_memory" are optional. Include only when there are real facts to capture.`;

/**
 * Naive {{placeholder}} substitution — replaces every occurrence of {{key}}
 * with vars[key]. Missing keys are left as-is so a malformed user template
 * produces visible errors rather than silent empty strings.
 */
function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : match,
  );
}

/**
 * Build the categorization system prompt. If `override` is supplied (user
 * edited the template in Settings → AI → Agent), we render that instead
 * of the bundled default. All `{{placeholder}}` tokens are substituted
 * either way.
 */
export function buildCategorizationPrompt(
  categories: CategoryDef[],
  userEmail: string,
  override?: string,
): string {
  const userName = userEmail.split('@')[0] || '';
  const userDomain = userEmail.split('@')[1] || '';

  const categorySection = categories.map((cat, i) =>
    `${i + 1}. ${cat.slug}:\n${cat.prompt}`
  ).join('\n\n');

  const template = override?.trim() || DEFAULT_CATEGORIZATION_TEMPLATE;
  return renderTemplate(template, {
    userEmail,
    userName,
    userDomain,
    categorySection,
    spamPrompt: SPAM_PROMPT,
  });
}


// ========== Email Text Builder ==========

export function buildEmailText(emails: EnrichedEmail[], userEmail: string, categorySlugs: string[]): string {
  const nowSec = Math.floor(Date.now() / 1000);

  const emailsText = emails.map((email, index) => {
    // Build behavioral context. Prefer the windowed (recent) stats when
    // there's enough signal — a sender you exchanged 50 emails with two
    // years ago but zero in the last 90 days should not read as "high
    // engagement". Falls back to lifetime counters when the window is
    // sparse. Minimum 3 received emails in-window to avoid flipping the
    // prompt based on a single outlier.
    let behaviorBlock = '';
    if (email.senderContext) {
      const ctx = email.senderContext;
      const useRecent = !!(ctx.recent && ctx.recent.receivedCount >= 3);
      const src = useRecent && ctx.recent ? ctx.recent : {
        receivedCount: ctx.receivedCount,
        readCount: ctx.readCount,
        deletedCount: ctx.deletedCount,
        repliedCount: ctx.repliedCount,
      };

      const readPct = src.receivedCount > 0 ? Math.round((src.readCount / src.receivedCount) * 100) : 0;
      const keepPct = src.receivedCount > 0 ? Math.round(((src.receivedCount - src.deletedCount) / src.receivedCount) * 100) : 0;
      const scopeLabel = useRecent ? `90d` : 'lifetime';
      const repliedInfo = src.repliedCount > 0
        ? `User replied ${src.repliedCount} times${ctx.lastReplied ? ` (last ${Math.max(1, Math.round((nowSec - ctx.lastReplied) / 86400))}d ago)` : ''}`
        : 'User NEVER replied to this sender';
      const sameSubj = email.sameSubjectCount && email.sameSubjectCount > 5 ? ` | Same-Subject: ${email.sameSubjectCount} (repetitive)` : '';
      const volume = email.volumePercent && email.volumePercent > 2 ? ` | Volume: ${email.volumePercent}% of inbox` : '';
      const flags = [ctx.isVip ? 'VIP' : '', ctx.isBlocked ? 'BLOCKED' : ''].filter(Boolean).join(' ');

      behaviorBlock = `Behavior (${scopeLabel}): Read ${readPct}% | Keep ${keepPct}% | ${repliedInfo} | Received: ${src.receivedCount}${sameSubj}${volume}${flags ? ' | ' + flags : ''}`;
    } else {
      behaviorBlock = 'Behavior: First-time sender, no history';
    }

    // Sender memory
    let memoryBlock = '';
    if (email.senderMemory) {
      const m = email.senderMemory;
      const parts: string[] = [];
      if (m.greeting) parts.push(`User greets: "${m.greeting}"`);
      if (m.tone) parts.push(`Tone: ${m.tone}`);
      if (m.keyContext) parts.push(`Context: ${m.keyContext}`);
      if (parts.length > 0) memoryBlock = `\nMemory: ${parts.join(' | ')}`;
    }

    // Contact type
    const typeLine = email.contactType && email.contactType !== 'unknown'
      ? `\nType: ${email.contactType}` : '';

    // Thread
    const threadLine = email.threadDepth && email.threadDepth > 1
      ? `\nThread: ${email.threadDepth} messages` : '';

    // Auth — raw SPF/DKIM/DMARC so the LLM can weigh it directly instead of
    // seeing an opaque pre-aggregated score. We only surface the line when
    // there's actual data; "unknown" across the board is dropped because
    // it adds noise without information.
    let authLine = '';
    if (email.authStatus) {
      const parts: string[] = [];
      if (email.authStatus.spf && email.authStatus.spf !== 'unknown') parts.push(`SPF=${email.authStatus.spf}`);
      if (email.authStatus.dkim && email.authStatus.dkim !== 'unknown') parts.push(`DKIM=${email.authStatus.dkim}`);
      if (email.authStatus.dmarc && email.authStatus.dmarc !== 'unknown') parts.push(`DMARC=${email.authStatus.dmarc}`);
      if (parts.length > 0) {
        const overall = email.authStatus.overall && email.authStatus.overall !== 'none'
          ? ` (overall: ${email.authStatus.overall})` : '';
        authLine = `\nAuth: ${parts.join(' ')}${overall}`;
      }
    }

    // Existing notes about this sender (so LLM doesn't repeat them)
    const notesBlock = email.existingNotes
      ? `\nExisting-Notes:\n${email.existingNotes}` : '';

    // Recipient role (critical for CC detection)
    const role = email.userInCc ? 'CC (just looped in, NOT primary recipient)' : 'TO (direct recipient)';

    return `--- Email ${index + 1} (ID: ${email.id}) ---
From: ${email.fromAddress}
To: ${email.toAddress}${email.ccAddress ? `\nCC: ${email.ccAddress}` : ''}
Role: ${role}
Subject: ${email.subject}
Date: ${new Date(email.date * 1000).toISOString()}
${behaviorBlock}${memoryBlock}${typeLine}${threadLine}${authLine}${notesBlock}

${email.body}`;
  }).join('\n\n');

  const slugList = categorySlugs.map(s => `"${s}"`).join(', ');

  return `Classify these ${emails.length} emails for user ${userEmail}.
Be STRICT — only assign categories when clearly relevant to the user. Empty categories [] is fine.

${emailsText}

Return JSON array (categories from: ${slugList}):
[{"emailId":"...","categories":[],"is_spam":false,"confidence":0.8,"reasoning":"..."}]`;
}

// ========== Response Validator ==========

export function validateCategorizationResponse(raw: string, knownSlugs: Set<string>, categoryDefs?: CategoryDef[]): CategorizationResult[] {
  // Small models often emit a category NAME or a cased/spaced variant of the
  // slug ("Needs Response", "invoice_billing", "Important") instead of the
  // exact slug. An exact-slug membership test silently drops those, leaving the
  // email marked done + uncategorized. Build a normalized (lowercase + trim)
  // lookup — from the slugs themselves AND the display names when provided —
  // and map each returned token back to its canonical slug. Purely defensive:
  // never throws; unmappable tokens are logged so the loss stays visible.
  const norm = (s: string): string => s.toLowerCase().trim();
  const spaced = (s: string): string => norm(s).replace(/[_\s-]+/g, ' ');
  const canonicalBySlug = new Map<string, string>();
  for (const slug of knownSlugs) {
    canonicalBySlug.set(norm(slug), slug);
    canonicalBySlug.set(spaced(slug), slug);
  }
  for (const def of categoryDefs || []) {
    if (def?.slug && def.name && knownSlugs.has(def.slug)) {
      canonicalBySlug.set(norm(def.name), def.slug);
      canonicalBySlug.set(spaced(def.name), def.slug);
    }
  }
  const toCanonicalSlug = (token: unknown): string | null => {
    if (typeof token !== 'string') return null;
    return canonicalBySlug.get(norm(token)) ?? canonicalBySlug.get(spaced(token)) ?? null;
  };
  // cleanLLMJsonResponse strips <think>/<thinking>/<reasoning>/<thought>
  // blocks (thinking models like DeepSeek R1 emit these inline) and
  // markdown code fences. Without the thinking-tag strip, JSON.parse
  // throws and the entire batch silently returns [].
  const clean = cleanLLMJsonResponse(raw);

  // Three-pass parse (mirrors AICategorizationService.validateResponse):
  //   1. Direct JSON.parse on the cleaned response.
  //   2. Retry after escaping unescaped control chars (raw \n in reasoning).
  //   3. Per-object salvage — walk the array, parse each {...} entry
  //      independently. Survives truncation, a single bad reasoning
  //      string, and trailing prose that would kill the whole batch.
  let parsed = tryParseLLMJson<any[]>(clean);
  if (parsed === null) {
    const { items: salvaged, diagnostics } = salvageJsonArrayWithDiagnostics<any>(clean);
    const diagSummary =
      `inputLen=${diagnostics.inputLength} ` +
      `attempted=${diagnostics.objectsAttempted} ` +
      `closed=${diagnostics.objectsClosed} ` +
      `parsed=${diagnostics.objectsParsed} ` +
      `truncated=${diagnostics.truncatedMidObject} ` +
      `reachedEnd=${diagnostics.reachedArrayEnd}`;
    if (salvaged.length > 0) {
      logger.warn(`[CategorizationUtils] Whole-array parse failed; salvaged ${salvaged.length} object(s) [${diagSummary}]`);
      parsed = salvaged;
    } else {
      // Last resort: the array may be buried in reasoning prose / model markers
      // that neither the tag-stripper nor the object-salvage handled (e.g.
      // gpt-oss's analysis channel). Bracket-match the first balanced [...] and
      // parse that as a unit.
      const arr = extractBalancedJsonArray(clean);
      if (arr && arr !== clean) {
        const retry = tryParseLLMJson<any[]>(arr);
        if (Array.isArray(retry)) parsed = retry;
      }
      if (parsed === null) {
        // Not a usable array/object → skip (caller leaves it for retry). Log a
        // SHORT, single-line preview of what we got so the breaking shape is
        // visible without dumping the whole response.
        const got = clean.replace(/\s+/g, ' ').trim().slice(0, 200);
        logger.error(`[CategorizationUtils] No usable JSON in response [${diagSummary}] got="${got}"`);
        return [];
      }
    }
  }

  if (!Array.isArray(parsed)) return [];

  const results: CategorizationResult[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object' || !item.emailId) continue;

    let categories: string[];
    if (Array.isArray(item.categories)) {
      // Normalize each token to its canonical slug (handles display names /
      // case variants); dedupe; log anything that still can't be mapped.
      const seen = new Set<string>();
      categories = [];
      for (const token of item.categories) {
        const slug = toCanonicalSlug(token);
        if (slug) {
          if (!seen.has(slug)) { seen.add(slug); categories.push(slug); }
        } else if (token != null && String(token).trim() !== '') {
          logger.warn(`[CategorizationUtils] Dropping unmappable category token ${JSON.stringify(token)} for email ${item.emailId}`);
        }
      }
    } else {
      categories = [];
      if (item.is_important === true) categories.push('important');
      if (item.is_reminder === true) categories.push('reminders');
      if (item.is_needs_response === true) categories.push('needs_response');
      if (item.is_meeting_related === true) categories.push('meeting');
      if (item.is_invoice_billing === true) categories.push('invoice');
      categories = categories.filter(s => knownSlugs.has(s));
    }

    const isSpam = item.is_spam === true;
    if (isSpam) categories = [];

    // Extract sender memory if present
    let senderMemory: CategorizationResult['senderMemory'];
    if (item.sender_memory && typeof item.sender_memory === 'object') {
      senderMemory = {
        greeting: item.sender_memory.greeting || undefined,
        tone: item.sender_memory.tone || undefined,
        keyContext: item.sender_memory.key_context || item.sender_memory.keyContext || undefined,
      };
    }

    // Extract notes if present
    let notes: CategorizationResult['notes'];
    if (Array.isArray(item.notes)) {
      notes = item.notes
        .filter((n: any) => n && typeof n === 'object' && typeof n.note === 'string' && n.note.length > 0)
        .map((n: any) => ({
          note: String(n.note).substring(0, 500), // Cap note length
          category: String(n.category || 'general'),
        }));
    }

    // Auto-draft decision — honor explicit value if provided; otherwise
    // default to false (safer to skip than draft by accident). Enforce
    // the consistency rule: should_auto_draft=true REQUIRES needs_response
    // in categories. If the AI violates this, treat should_auto_draft as
    // false so the Drafts folder never exceeds the Needs Response count.
    const rawShouldAutoDraft = item.should_auto_draft === true;
    const shouldAutoDraft = rawShouldAutoDraft && categories.includes('needs_response');
    const autoDraftReason = typeof item.auto_draft_reason === 'string'
      ? item.auto_draft_reason
      : undefined;

    results.push({
      emailId: String(item.emailId),
      categories,
      isSpam,
      confidence: typeof item.confidence === 'number' ? item.confidence : 0.5,
      reasoning: item.reasoning || '',
      shouldAutoDraft,
      autoDraftReason,
      senderMemory,
      notes: notes && notes.length > 0 ? notes : undefined,
    });
  }

  return results;
}

// ========== AI API Client ==========

export async function callAIProvider(
  config: AIProviderConfig,
  systemPrompt: string,
  userMessage: string,
  signal?: AbortSignal,
): Promise<string> {
  if (config.type === 'gemini') {
    return callGeminiAPI(config, systemPrompt, userMessage, signal);
  }
  return callOpenAICompatibleAPI(config, systemPrompt, userMessage, signal);
}

async function callOpenAICompatibleAPI(
  config: AIProviderConfig,
  systemPrompt: string,
  userMessage: string,
  signal?: AbortSignal,
): Promise<string> {
  // No default for ``sarv`` any more — the old ``https://ai.sarv.com/llm/v1``
  // is dead. The caller must pass the oauth-provisioned ``llmBaseUrl`` via
  // ``config.baseUrl``; in prod that's the zone edge (e.g.
  // https://jpr1-ai-edge.sarv.com/edge/v1/llm), in dev it's
  // http://localhost:<port>/edge/v1/llm.
  const defaultBaseUrls: Record<string, string | undefined> = {
    openai: 'https://api.openai.com/v1',
    sarv: undefined,
  };
  const baseUrl = config.baseUrl || defaultBaseUrls[config.type];
  if (!baseUrl) {
    throw new Error(
      `callOpenAICompatibleAPI: no baseUrl configured for provider '${config.type}'. ` +
      `For Sarv, pass the oauth-issued llmBaseUrl (e.g. from the 'sarv' provider config).`,
    );
  }

  const doFetch = config.fetchImpl || fetch;

  // Per-request timeout. Categorization/drafting LLM calls are serialized behind
  // a single mutex in the pipeline, so a half-open socket to the gateway (no
  // response, never times out on its own) would freeze categorization for EVERY
  // account indefinitely. Abort the whole request — both attempts AND the body
  // read — after this budget. Chained to the caller's `signal` (pipeline shutdown).
  const LLM_REQUEST_TIMEOUT_MS = 60_000;
  const timeoutCtl = new AbortController();
  const timer = setTimeout(
    () => { try { timeoutCtl.abort(new Error('AI request timed out')); } catch { /* ignore */ } },
    LLM_REQUEST_TIMEOUT_MS,
  );
  const onOuterAbort = () => { try { timeoutCtl.abort((signal as any)?.reason); } catch { /* ignore */ } };
  if (signal) {
    if (signal.aborted) onOuterAbort();
    else signal.addEventListener('abort', onOuterAbort);
  }

  try {
    // One HTTP attempt with a resolved bearer. `forceRefresh` forces a fresh
    // OAuth token (used on the 401 retry below).
    const attempt = async (forceRefresh: boolean): Promise<Response> => {
      const bearer = config.resolveBearer ? await config.resolveBearer(forceRefresh) : config.apiKey;
      // Guard against empty bearer — `Authorization: Bearer ` is an illegal
      // header value and triggers a generic 502 at the gateway that would
      // otherwise look like an upstream outage.
      if (typeof bearer !== 'string' || bearer.trim() === '') {
        throw new Error(
          `callOpenAICompatibleAPI: empty bearer token for provider '${config.type}'. ` +
          `OAuth token refresh may have returned no accessToken, or apiKey is missing.`,
        );
      }
      return doFetch(`${baseUrl}/chat/completions`, {
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
          // Disable chain-of-thought when the backend is a vLLM-hosted model
          // with thinking mode enabled by default (Gemma 3/4, Qwen3, etc.).
          // vLLM's OpenAI-compatible server forwards chat_template_kwargs to
          // the tokenizer's chat template, which branches on enable_thinking.
          // Ignored by backends that don't recognise the field (OpenAI,
          // Anthropic proxies, Sarv edge for non-thinking models).
          // Why off for categorization/drafting: these produce structured
          // JSON output. A thinking pass burns the token budget on reasoning
          // and often truncates before the JSON even starts.
          chat_template_kwargs: { enable_thinking: false },
        }),
        signal: timeoutCtl.signal,
      });
    };

    let response = await attempt(false);

    // OAuth token rejected: the edge refused a token our local expiry heuristic
    // thought was still valid. Force a fresh token once and retry — an expired
    // access token self-heals instead of failing the run. Only for OAuth
    // providers; if the refresh itself fails it throws and callers treat it as
    // terminal (re-auth needed).
    if ((response.status === 401 || response.status === 403) && config.resolveBearer) {
      try { await (response as { body?: { cancel?: () => Promise<void> } }).body?.cancel?.(); } catch { /* ignore */ }
      response = await attempt(true);
    }

    if (!response.ok) {
      throw await parseSarvApiError(response);
    }

    const data: any = await response.json();
    return data.choices?.[0]?.message?.content?.trim() || '';
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onOuterAbort);
  }
}

async function callGeminiAPI(
  config: AIProviderConfig,
  systemPrompt: string,
  userMessage: string,
  signal?: AbortSignal,
): Promise<string> {
  const baseUrl = config.baseUrl || 'https://generativelanguage.googleapis.com/v1beta';

  const doFetch = config.fetchImpl || fetch;
  const response = await doFetch(`${baseUrl}/models/${config.model}:generateContent?key=${config.apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [
        { parts: [{ text: `${systemPrompt}\n\n${userMessage}` }] },
      ],
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens: 16000,
        // Disable Gemini 2.5 Flash thinking — same rationale as the
        // OpenAI-compat chat_template_kwargs flag above. Ignored by
        // non-thinking Gemini variants which don't recognise the field.
        thinkingConfig: { thinkingBudget: 0 },
      },
    }),
    signal,
  });

  if (!response.ok) {
    // Gemini / other non-Sarv providers don't emit the Sarv error-code JSON
    // shape, so ``parseSarvApiError`` will fall through to ``upstream_error``
    // — which is correct. Keeps the retry loop's type discrimination uniform.
    throw await parseSarvApiError(response);
  }

  const data: any = await response.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
}

export async function callAIWithRetry(
  config: AIProviderConfig,
  systemPrompt: string,
  userMessage: string,
  signal?: AbortSignal,
): Promise<string> {
  return pRetry(
    async () => {
      try {
        return await callAIProvider(config, systemPrompt, userMessage, signal);
      } catch (error: any) {
        const status: number = error?.status ?? error?.statusCode ?? 0;
        const code: SarvErrorCode | undefined = error instanceof SarvApiError ? error.code : undefined;

        // Only retry transient failures. ``invalid_token`` /
        // ``insufficient_scope`` / ``insufficient_role`` /
        // ``cai_account_required`` / ``insufficient_balance`` (and any other
        // 4xx / bad key) are user-facing — retrying won't help and would burn
        // the user's wallet or surface a confusing retry spinner. Wrapping in
        // ``AbortError`` stops p-retry immediately and rethrows the ORIGINAL
        // error, so callers see the same rejection they did before.
        // Include 502/504 (gateway errors) alongside 500/503 — a gateway that
        // couldn't reach the backend is just as transient, and omitting them
        // wrapped those in AbortError so they were never retried in-call.
        const transient = code === 'rate_limit_exceeded' || status === 429 ||
          status === 500 || status === 502 || status === 503 || status === 504;
        if (!transient) throw new AbortError(error);
        throw error;
      }
    },
    {
      // Exponential back-off: 2s, 4s, 8s … capped at 30s, up to
      // MAX_API_RETRIES retries.
      retries: MAX_API_RETRIES,
      minTimeout: 2000,
      factor: 2,
      maxTimeout: 30000,
      onFailedAttempt: (_error) => {
        // Do NOT manually sleep the server ``Retry-After`` here: p-retry has
        // already scheduled its own exponential back-off (2s/4s/8s… capped at
        // 30s) before the next attempt, and awaiting Retry-After ON TOP of that
        // double-waited. Because the whole call runs under pLimit(1), that stall
        // blocked categorization for ALL accounts. p-retry's back-off already
        // covers the retry delay, so we just let it handle the timing.
      },
    },
  );
}
