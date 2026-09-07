/**
 * Agentic Reply Drafter
 *
 * Multi-step reply generation:
 *   1. Gather context (notes, thread, style)
 *   2. LLM decides if it needs to search old emails or the web
 *   3. Execute autonomous searches (email FTS5 + web, max 3 rounds each)
 *   4. Draft reply with full context
 *
 * The LLM acts like a real assistant — researches before responding.
 */

import type { EmailRecord } from '../types/models';
import { parseAddresses } from '../utils/email-address';
import { logger } from '../utils/logger';

import { cleanLLMJsonResponse, tryParseLLMJson } from './llm-response-utils';

/**
 * Full representation of one message in a thread passed to the LLM.
 * No truncation — we want quality over tokens so the model has the same
 * view of the conversation as the chat pane the user reads.
 */
export interface ThreadMessage {
  messageId: string | null;
  subject: string | null;
  from: string;         // "Name <email@addr>" or raw addr if no name
  to: string[];         // all recipients on the To: line
  cc: string[];         // all recipients on the Cc: line
  date: string;         // ISO timestamp
  body: string;         // full cleaned body (no truncation)
  isFromUser: boolean;  // so the LLM can find "my previous replies" at a glance
}

export interface ReplyDrafterDeps {
  userEmail: string;
  userName: string;
  /**
   * Every email address that represents the user (including userEmail).
   * Used so the LLM recognises itself in a thread when CCs, forwards, or
   * name-mentions refer to the user under a different alias.
   */
  userAliases?: string[];
  /** Call LLM */
  callAI: (systemPrompt: string, userMessage: string) => Promise<string>;
  /** Get contact notes for a sender */
  getNotes: (email: string) => string;
  /** Get the full thread — every message, untruncated, oldest → newest. */
  getThreadMessages: (threadId: string) => ThreadMessage[];
  /** Get sender memory (greeting, tone, closing) */
  getSenderMemory: (email: string) => { greeting: string | null; closing: string | null; tone: string | null };
  /** Search emails via FTS5 */
  searchEmails: (query: string, options?: { from?: string; limit?: number }) => Array<{ id: string; subject: string; from: string; date: number; snippet: string }>;
  /** Search the web — optional, enables product/pricing/info lookups */
  searchWeb?: (query: string) => Promise<Array<{ title: string; url: string; snippet: string }>>;
  /**
   * Optional hook to fetch user-edited prompt templates keyed by id
   * ('agent_plan' | 'agent_draft'). Returns `null`/`undefined` to fall
   * back to the bundled defaults. Kept optional so callers that don't
   * care about user-prompt customisation keep working unchanged.
   */
  getPromptTemplate?: (id: 'agent_plan' | 'agent_draft') => string | null | undefined;
}

export interface DraftResult {
  subject: string;
  body: string;
  suggestedCc: string[];
  reasoning: string;
  searchesPerformed: string[];
}

const MAX_SEARCH_ROUNDS = 3;

export class AgentReplyDrafter {
  constructor(private deps: ReplyDrafterDeps) {}

  async draftReply(email: EmailRecord, _threadEmails?: EmailRecord[]): Promise<DraftResult> {
    const sender = email.fromAddress?.toLowerCase() || '';

    // Step 1: Gather context
    const notes = this.deps.getNotes(sender);
    const memory = this.deps.getSenderMemory(sender);
    const threadMessages = email.threadId
      ? this.deps.getThreadMessages(email.threadId)
      : [];

    // Step 2+3: LLM decides what research is needed, then we execute
    const searchResults: string[] = [];
    const searchesPerformed: string[] = [];

    // First call: ask LLM what research it needs
    const planResponse = await this.deps.callAI(
      this.buildPlanPrompt(),
      this.buildPlanMessage(email, notes, threadMessages, memory),
    );

    // Parse search requests (strip <think> blocks from thinking models
    // in addition to markdown fences — otherwise JSON.parse silently
    // falls through to the no-search default). tryParseLLMJson retries
    // with control-char escaping before giving up.
    let plan: any = tryParseLLMJson(cleanLLMJsonResponse(planResponse));
    if (!plan || typeof plan !== 'object') {
      plan = { needs_search: false, email_searches: [], web_searches: [], ready_to_draft: true };
    }

    // Execute email searches (drop null / non-string non-object entries —
    // `search.query` on a null entry would TypeError outside the try)
    const rawEmailSearches = plan.email_searches || plan.searches || [];
    const emailSearches = Array.isArray(rawEmailSearches)
      ? rawEmailSearches.filter((s: any) => typeof s === 'string' || (s && typeof s === 'object'))
      : [];
    for (let i = 0; i < Math.min(emailSearches.length, MAX_SEARCH_ROUNDS); i++) {
      const search = emailSearches[i];
      const query = typeof search === 'string' ? search : search.query || search;
      const from = typeof search === 'object' ? search.from : undefined;

      try {
        const results = this.deps.searchEmails(query, { from, limit: 5 });
        searchesPerformed.push(`email: ${query}`);

        if (results.length > 0) {
          const formatted = results.map(r =>
            `[${new Date(r.date * 1000).toLocaleDateString()}] ${r.from}: ${r.subject}\n${r.snippet}`
          ).join('\n---\n');
          searchResults.push(`Email search "${query}":\n${formatted}`);
        }
      } catch (err) {
        logger.error(`[ReplyDrafter] Email search failed: ${query}`, err);
      }
    }

    // Execute web searches (for product info, pricing, documentation, etc.)
    const webSearches = plan.web_searches || [];
    if (this.deps.searchWeb && Array.isArray(webSearches)) {
      for (let i = 0; i < Math.min(webSearches.length, MAX_SEARCH_ROUNDS); i++) {
        const query = typeof webSearches[i] === 'string' ? webSearches[i] : webSearches[i]?.query || '';
        if (!query) continue;

        try {
          const results = await this.deps.searchWeb(query);
          searchesPerformed.push(`web: ${query}`);

          if (results.length > 0) {
            const formatted = results.slice(0, 5).map(r =>
              `${r.title}\n${r.url}\n${r.snippet}`
            ).join('\n---\n');
            searchResults.push(`Web search "${query}":\n${formatted}`);
          }
        } catch (err) {
          logger.error(`[ReplyDrafter] Web search failed: ${query}`, err);
        }
      }
    }

    // Step 4: Draft the reply with all gathered context
    const draftResponse = await this.deps.callAI(
      this.buildDraftPrompt(memory),
      this.buildDraftMessage(email, notes, threadMessages, searchResults),
    );

    // Parse draft (thinking-tag strip included — see plan parse above)
    let draft: any = tryParseLLMJson(cleanLLMJsonResponse(draftResponse));
    if (!draft || typeof draft !== 'object') {
      // Hard parse failure. Fall back to the CLEANED text as the body, but
      // only when it doesn't look like JSON/fenced output — raw braces or
      // fences would otherwise get saved to the user's IMAP Drafts folder.
      const cleaned = cleanLLMJsonResponse(draftResponse);
      const looksStructured = cleaned.startsWith('{') || cleaned.startsWith('[') || cleaned.startsWith('```');
      draft = {
        subject: `Re: ${email.subject || ''}`,
        body: looksStructured ? '' : cleaned,
        suggestedCc: [],
        reasoning: looksStructured
          ? 'Draft skipped — unparseable JSON-shaped response'
          : 'Direct draft (JSON parse failed)',
      };
    }

    return {
      subject: draft.subject || `Re: ${email.subject || ''}`,
      body: draft.body || '',
      suggestedCc: Array.isArray(draft.suggestedCc) ? draft.suggestedCc : [],
      reasoning: draft.reasoning || '',
      searchesPerformed,
    };
  }

  // ========== Prompts ==========

  /** Build the "YOU ARE" identity block reused by both prompts. */
  private buildIdentityBlock(): string {
    const aliases = (this.deps.userAliases || [])
      .map(a => a.toLowerCase())
      .filter((a, i, arr) => a && arr.indexOf(a) === i);
    const aliasLine = aliases.length > 1
      ? `Your email addresses (all belong to YOU): ${aliases.join(', ')}`
      : `Your email address: ${this.deps.userEmail}`;
    return `YOU ARE: ${this.deps.userName} <${this.deps.userEmail}>
${aliasLine}

CRITICAL: You are writing AS ${this.deps.userName}, in the first person.
If the thread mentions "${this.deps.userName}" or any of your addresses, that is YOU — never refer to yourself in the third person. Use "I" / "me" / "my", not "${this.deps.userName}".`;
  }

  private buildPlanPrompt(): string {
    const hasWeb = !!this.deps.searchWeb;
    const override = this.deps.getPromptTemplate?.('agent_plan')?.trim();
    const template = override || DEFAULT_PLAN_TEMPLATE;
    return renderReplyTemplate(template, {
      identity: this.buildIdentityBlock(),
      webOption: hasWeb
        ? '2. Search the web — find product info, pricing, documentation, company details, current facts'
        : '',
      webSearchesField: hasWeb ? `
  "web_searches": [
    "product name pricing plans",
    "company name services offered"
  ],` : '',
      webWhenSection: hasWeb ? `WHEN TO SEARCH THE WEB:
- Sender asks about products, services, pricing, features you need facts for
- Need current information (dates, events, releases)
- Need to verify company/product details before replying
- Questions like "Do you offer X?" — search your company website or docs` : '',
    });
  }

  private buildPlanMessage(
    email: EmailRecord,
    notes: string,
    thread: ThreadMessage[],
    _memory: { greeting: string | null; closing: string | null; tone: string | null },
  ): string {
    // Full thread, no truncation. Even if the user was looped into the thread
    // midway, every earlier message is included so the model has the same
    // context the chat view shows.
    const threadJson = JSON.stringify(thread, null, 2);

    const incoming = {
      from: email.fromAddress,
      subject: email.subject,
      date: new Date(email.date * 1000).toISOString(),
      body: email.cleanBody || email.rawBody || '',
    };

    return `INCOMING EMAIL TO REPLY TO:
${JSON.stringify(incoming, null, 2)}

EXISTING NOTES ABOUT THIS SENDER:
${notes || '(none)'}

FULL THREAD (oldest → newest, every message, untruncated):
${thread.length > 0 ? threadJson : '(single email, no prior thread)'}

What research do I need before drafting a reply? Read the whole thread first.`;
  }

  private buildDraftPrompt(memory: { greeting: string | null; closing: string | null; tone: string | null }): string {
    const override = this.deps.getPromptTemplate?.('agent_draft')?.trim();
    const template = override || DEFAULT_DRAFT_TEMPLATE;
    return renderReplyTemplate(template, {
      identity: this.buildIdentityBlock(),
      userName: this.deps.userName,
      greeting: memory.greeting || 'Use appropriate greeting',
      tone: memory.tone || 'professional',
      closing: memory.closing || 'Best,',
    });
  }

  private buildDraftMessage(
    email: EmailRecord,
    notes: string,
    thread: ThreadMessage[],
    searchResults: string[],
  ): string {
    // Full thread JSON — every message, full body, all participants. Isolate
    // the user's previous replies so the LLM can mirror their style exactly.
    const myReplies = thread.filter(m => m.isFromUser);
    const threadJson = JSON.stringify(thread, null, 2);
    const myRepliesJson = myReplies.length > 0
      ? JSON.stringify(myReplies, null, 2)
      : '(no prior replies from you in this thread)';

    const incoming = {
      messageId: email.messageId,
      from: email.fromAddress,
      subject: email.subject,
      to: parseAddresses(email.toAddress),
      cc: parseAddresses(email.ccAddress),
      date: new Date(email.date * 1000).toISOString(),
      body: email.cleanBody || email.rawBody || '',
    };

    const searchText = searchResults.length > 0
      ? `\n\nRESEARCH RESULTS:\n${searchResults.join('\n\n')}`
      : '';

    return `INCOMING EMAIL TO REPLY TO — this is the ONLY message you are replying to:
${JSON.stringify(incoming, null, 2)}

CONTACT NOTES:
${notes || '(none)'}

FULL THREAD (context only — for understanding what is being discussed, NOT
a list of items to respond to). Oldest → newest, untruncated. Includes
anything sent before you were looped in.
${threadJson}

YOUR PREVIOUS REPLIES IN THIS THREAD (study these closely — match phrasing,
tone, depth, and the kind of commitments you make):
${myRepliesJson}${searchText}

Now draft the reply to the INCOMING EMAIL above. Only respond to items the
sender is directly asking of you in that email. Keep it to the point.
Do not invent facts that aren't in the thread or research results.`;
  }
}

// ========== Editable prompt templates (exposed for DB seeding) ==========
// Placeholder syntax: {{key}}. Values are substituted at runtime by
// renderReplyTemplate. When the user hasn't edited a template in Settings,
// these defaults are used verbatim. The seeder in the app layer inserts
// these as the initial default_content for the corresponding prompt ids.

export const DEFAULT_PLAN_TEMPLATE = `{{identity}}

You are planning a reply. Before drafting, decide what research you need.

You can:
1. Search old emails — find past conversations, agreements, invoices, context
{{webOption}}

Return JSON:
{
  "needs_search": true/false,
  "email_searches": [
    {"query": "search terms", "from": "optional@sender.com"},
    "simple search query"
  ],{{webSearchesField}}
  "reasoning": "Why I need/don't need to search"
}

WHEN TO SEARCH EMAILS:
- Email references a past conversation, invoice, or agreement
- Need to check what was previously discussed with this sender
- Looking for a specific document or decision

{{webWhenSection}}

Max 3 searches each. Keep queries specific.
If notes and thread give enough context, set needs_search: false.`;

export const DEFAULT_DRAFT_TEMPLATE = `{{identity}}

You are drafting YOUR reply to the email below.

BEFORE YOU WRITE ANYTHING:
1. Read the ENTIRE thread carefully, oldest message first. Do not skim.
   The thread is context so you understand what is being discussed — it is
   NOT a checklist of items to respond to.
2. Look at ONLY the most recent incoming email. Within that email, find the
   items where the sender is directly asking YOU ({{userName}}) for
   a decision, answer, action, or information. Ignore:
     • items addressed to other recipients
     • status updates and FYIs that don't need a response from you
     • points that were already resolved earlier in the thread
     • your own previous replies (they're context, not questions)
3. Pay attention to YOUR previous replies in this thread — they show how
   you actually talk to this person (length, formality, structure).
4. Only then draft the reply.

MATCH YOUR OWN STYLE (taken from your past replies):
- Greeting: {{greeting}}
- Tone: {{tone}}
- Sign-off: {{closing}}

RULES:
- Write in the first person — you ARE {{userName}}, not an assistant acting on their behalf
- If the sender asks you to do something, reply as though YOU will do it ("I'll send…", not "{{userName}} will send…")
- Respond ONLY to items the sender is directly asking of you in the latest
  email. Do not re-open every point from the whole thread. Do not answer
  things the sender asked someone else.
- If the latest email is just an FYI / acknowledgement / update with no
  actual ask, keep the reply to a short acknowledgement — or set
  "body" to "" if no reply is warranted at all
- Get to the point. No preamble, no recap of what was already discussed,
  no restating their message back to them
- Ground every claim in the thread or the search results — DO NOT invent
  numbers, dates, prices, names, policies, or commitments that are not
  already in the conversation
- If you don't know something, say so plainly or ask — do not fabricate
- Mirror the phrasing and depth of your own past replies in this thread
- Be the length YOUR past replies are — not longer, not shorter
- Suggest CC recipients ONLY if clearly needed based on thread history
- DO NOT add a signature — you have your own

Return JSON:
{
  "body": "plain text reply body here — no HTML tags",
  "suggestedCc": [],
  "reasoning": "Why I drafted it this way and what sources I used"
}

Do NOT include a subject — replies keep the original subject.`;

/**
 * Reply-drafter variant of the {{placeholder}} renderer. Kept local to this
 * module so the core categorization renderer can evolve independently.
 * Missing keys leave the {{placeholder}} intact — a user template with
 * typos will show the raw token in the prompt rather than swallowing it
 * silently.
 */
function renderReplyTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : match,
  );
}
