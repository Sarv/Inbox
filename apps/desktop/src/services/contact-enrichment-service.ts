/**
 * Contact Enrichment Service (renderer)
 *
 * Orchestrates enrichment for a single contact:
 *   1. Fetch recent inbound emails (via IPC).
 *   2. Extract signals (phones, URLs, social handles, signature block)
 *      using the regex pass in @sarvinbox/core.
 *   3. Build the LLM prompt and call the default AI provider.
 *   4. Parse the JSON response, normalize the mobile number to E.164.
 *   5. Persist via the `contacts:applyEnrichment` IPC — the main process
 *      writes the blob, appends to history, and resolves identity
 *      merges from the shared mobile.
 *
 * Lives in the renderer because that's where the AI provider config
 * lives. The scheduler (main process) triggers enrichment by sending
 * an IPC message with a list of contact IDs; the renderer works the
 * queue one-at-a-time.
 */

// Import from the renderer-local copy, NOT @sarvinbox/core — the core
// barrel re-exports imapflow/nodemailer which drags Node's `events`
// module into the Vite renderer bundle and fails with "Dynamic require
// of 'events' is not supported". See sibling sarv-cai-api.ts for the
// same constraint documented there.
import {
  extractDeterministicProfile,
  extractSignals,
  mergeSignals,
  normalizePhoneToE164,
  buildEnrichmentUserMessage,
  ENRICHMENT_SYSTEM_PROMPT,
  parseEnrichmentResponse,
  type ExtractedSignals,
  type ContactEnrichment,
} from '@sarvinbox/core/contact-enrichment';

import { getDefaultProvider, makeAICompletion } from './ai-service';

export interface EnrichContactOptions {
  contactId: string;
  /** Skip the 90-day cadence gate — used by the manual Enrich button. */
  force?: boolean;
  /** Abort the in-flight LLM call (Enrich button Cancel, shutdown, etc.). */
  signal?: AbortSignal;
  /** Which account's DB this contact lives in. Omitted = active account
   *  (UI Enrich button). Set by the scheduler when enriching a background
   *  account so every read/write targets that account, not the active one. */
  accountId?: string;
}

export interface EnrichContactResult {
  ok: true;
  enrichment: ContactEnrichment;
  mobileE164: string | null;
  enrichedThroughEmailAt: number;
  scannedEmailCount: number;
}

export interface EnrichContactSkipped {
  ok: false;
  reason:
    | 'no_contact'
    | 'no_provider'
    | 'no_inbound_mail'
    | 'no_signals'
    | 'llm_failed'
    | 'cadence_not_due'
    | 'automated_sender';
  detail?: string;
}

const MAX_EMAILS_TO_SCAN = 20;
const RE_ENRICH_MIN_AGE_SECONDS = 90 * 86400; // 90 days

/**
 * Local-parts that mark the mailbox as automated/transactional. Bank
 * alerts, receipt mailers, support bots, etc. — there's no human
 * behind them and no real phone or LinkedIn to extract. Running the
 * enrichment LLM on these wastes tokens and produces garbage like a
 * customer-care 1800 number stored as the contact's "personal phone".
 */
// NO-REPLY / machine tier ONLY — keep byte-identical with NOREPLY_LOCAL_PART_RE
// in packages/core/src/utils/role-address.ts (the renderer can't import the core
// node util cleanly, so the pattern is duplicated). We deliberately do NOT skip
// human-staffed role mailboxes (hr@, sales@, support@, careers@, info@…): those
// carry a real signature worth mining. The core's HUMAN_ROLE tier still keeps
// them from acquiring a bound person_id/mobile (contact-repository.applyEnrichment),
// so they're enriched as a shared mailbox showing the latest signer — not a person.
const NOREPLY_LOCAL_PART_RE =
  /^(no-?reply|do-?not-?reply|donotreply|notifications?|notify|reminders?|alerts?|alert|mailer|mailer-daemon|postmaster|bounces?|delivery|deliveries|automated|auto|system|root|daemon|cron|transactional|receipts?|statements?|invoices?|payments?|orders?|shipping|tracking|tickets?|news|newsletters?|updates?|digest|verify|verification|confirm|confirmation|subscribe|unsubscribe|abuse|webmaster|hostmaster|sysadmin|mail|email)([.\-_+].*)?$/i;

/**
 * Should we SKIP enrichment for this address? True only for the no-reply/machine
 * tier — mailboxes that never carry a human signature and whose bodies are full
 * of transaction IDs / helplines a scraper would mistake for personal phones.
 * Human-staffed role mailboxes (hr@, sales@…) are NOT skipped — we mine their
 * signature. Defense before we waste an LLM call AND before the regex extractor
 * scrapes a transactional body.
 */
function isLikelyAutomatedSender(email: string): boolean {
  if (!email) return false;
  const local = email.split('@')[0]?.toLowerCase() || '';
  return NOREPLY_LOCAL_PART_RE.test(local);
}

/**
 * Best-effort watermark bump — marks the contact "enriched through" the
 * given email timestamp so the scheduler stops re-queuing it. Never throws;
 * a failed watermark write must not fail (or crash) the enrichment call.
 * Shared by every terminal path (no_signals, automated_sender, llm_failed).
 */
async function bumpEnrichmentWatermark(
  api: any,
  contactId: string,
  throughEmailAt: number,
  accountId?: string,
): Promise<void> {
  try {
    await api.contacts.recordEnrichmentWatermark(contactId, throughEmailAt, accountId);
  } catch { /* best effort — ignore */ }
}

/**
 * Run enrichment for one contact. Idempotent — safe to call twice, the
 * watermark on the contact row will be bumped either way.
 */
export async function enrichContact(
  opts: EnrichContactOptions,
): Promise<EnrichContactResult | EnrichContactSkipped> {
  const api = window.electronAPI as any;

  // 1. Load contact + recent inbound emails in parallel. The contact
  // gives us the watermark + name; the emails give us signatures.
  const [contactRes, emailsRes] = await Promise.all([
    api.contacts.get(opts.contactId, opts.accountId),
    api.contacts.recentInbound(opts.contactId, MAX_EMAILS_TO_SCAN, opts.accountId),
  ]);

  if (!contactRes?.success || !contactRes.data) {
    return { ok: false, reason: 'no_contact' };
  }
  const contact = contactRes.data;

  // Skip automated senders entirely. Their bodies are full of
  // transaction IDs, account numbers, and customer-care helplines that
  // the regex extractor would otherwise mistake for the contact's
  // "personal" phones. Bumping the watermark prevents the scheduler
  // from re-queuing these on every tick.
  if (isLikelyAutomatedSender(contact.email)) {
    await bumpEnrichmentWatermark(api, opts.contactId, Math.floor(Date.now() / 1000), opts.accountId);
    return { ok: false, reason: 'automated_sender' };
  }

  const emails = emailsRes?.success && Array.isArray(emailsRes.data) ? emailsRes.data : [];

  if (emails.length === 0) {
    return { ok: false, reason: 'no_inbound_mail' };
  }

  // 2. Cadence gate — data-driven, not clock-driven. We compare the
  // newest email date against the stored watermark, not Date.now().
  const newestEmailAt = Math.max(...emails.map((e: any) => e.date || 0));
  if (!opts.force) {
    const watermark = contact.enrichedThroughEmailAt || 0;
    if (watermark && newestEmailAt <= watermark + RE_ENRICH_MIN_AGE_SECONDS) {
      return { ok: false, reason: 'cadence_not_due' };
    }
  }

  // 3. Extract signals from each email (body + html fallback), then
  // merge across emails for rank-by-frequency. Pass the email's actual
  // From: address — the extractor strips quoted tails and validates the
  // signature against the From: domain so we don't pick up a quoted
  // user signature from deeper in a thread chain.
  const perEmail: ExtractedSignals[] = [];
  for (const e of emails) {
    const body: string = e.cleanBody || e.plainBody || e.textBody || '';
    const htmlFallback = body.length < 50 && e.htmlBody ? stripHtml(e.htmlBody) : '';
    // Prefer the HTML fallback whenever the plain body is too short to
    // carry a signature (< 50 chars) — `body || htmlFallback` only used
    // the fallback when body was the empty string exactly.
    const text = body.length >= 50 ? body : (htmlFallback || body);
    if (!text) continue;
    perEmail.push(extractSignals(text, e.fromAddress || contact.email));
  }
  const signals = mergeSignals(perEmail);

  const hasAnySignal =
    signals.phones.length > 0 ||
    signals.linkedinUrls.length > 0 ||
    signals.titleCandidates.length > 0 ||
    !!signals.signatureBlock;

  if (!hasAnySignal) {
    // Nothing to enrich from; still bump the watermark so we don't
    // keep re-scanning the same emails.
    await bumpEnrichmentWatermark(api, opts.contactId, newestEmailAt, opts.accountId);
    return { ok: false, reason: 'no_signals' };
  }

  // 4. Call the LLM. We rely on the user's default provider — same as
  // categorization/summarization paths.
  const provider = getDefaultProvider();
  if (!provider) {
    // No AI configured is not the same as nothing to learn. The signature was
    // already parsed, so name / title / company / socials can be written
    // deterministically — otherwise a contact stays on its email local part
    // ("Pkh") forever purely because no provider is set up.
    const fallback = extractDeterministicProfile(signals, contact.email);
    if (fallback.fullName || fallback.title || fallback.organization) {
      const applied = await api.contacts.applyEnrichment({
        contactId: opts.contactId,
        accountId: opts.accountId,
        enrichment: {
          fullName: fallback.fullName,
          designation: fallback.title,
          companyName: fallback.organization,
          companyWebsite: fallback.website,
          linkedinUrl: fallback.linkedinUrl,
          twitterUrl: fallback.twitterUrl,
          githubUrl: fallback.githubUrl,
        } as ContactEnrichment,
        mobileE164: null, // phones stay owned by the deterministic classifier
        enrichedThroughEmailAt: newestEmailAt,
        sourceEmailId: emails[0]?.id || null,
        source: 'llm',
      });
      if (applied?.success) {
        try {
          if (typeof document !== 'undefined') {
            document.dispatchEvent(new CustomEvent('sarvinbox:contact-enriched', { detail: { contactId: opts.contactId } }));
          }
        } catch { /* non-DOM context */ }
      }
    }
    await bumpEnrichmentWatermark(api, opts.contactId, newestEmailAt, opts.accountId);
    return { ok: false, reason: 'no_provider' };
  }

  const userMessage = buildEnrichmentUserMessage({
    contactEmail: contact.email,
    contactName: contact.displayName || contact.name,
    signals,
    existingOrganization: contact.organization,
    existingTitle: contact.title,
  });

  // On any llm_failed path we bump the watermark to newestEmailAt (same as
  // no_signals / automated_sender). This trades a lost retry for loop-safety:
  // without it, a contact whose output reliably errors or won't parse has
  // enriched_through_email_at IS NULL forever and the scheduler re-selects it
  // every 6h, burning tokens on a call that will never succeed. A future
  // email past the 90-day cadence still re-opens the contact for enrichment.
  let raw: string;
  try {
    raw = await makeAICompletion({
      systemPrompt: ENRICHMENT_SYSTEM_PROMPT,
      userPrompt: userMessage,
      maxTokens: 1000,
    });
  } catch (err) {
    await bumpEnrichmentWatermark(api, opts.contactId, newestEmailAt, opts.accountId);
    return { ok: false, reason: 'llm_failed', detail: (err as Error).message };
  }

  const enrichment = parseEnrichmentResponse(raw);
  if (!enrichment) {
    await bumpEnrichmentWatermark(api, opts.contactId, newestEmailAt, opts.accountId);
    return { ok: false, reason: 'llm_failed', detail: 'unparseable LLM response' };
  }

  // Phones are owned by the deterministic cross-domain classifier (run during a
  // scan), not the LLM — it splits a shared office line from a personal number
  // by looking across the whole domain, which a single-contact LLM pass can't.
  // Keep any classifier-written phones over the LLM's guess.
  const priorEnrichment = contact.enrichment as ContactEnrichment | undefined;
  if (priorEnrichment?.companyPhone) enrichment.companyPhone = priorEnrichment.companyPhone;
  if (priorEnrichment?.personalPhone) enrichment.personalPhone = priorEnrichment.personalPhone;
  // Keep a scan-mined LinkedIn (/in/) profile when the LLM didn't produce one.
  if (!enrichment.linkedinUrl && priorEnrichment?.linkedinUrl) enrichment.linkedinUrl = priorEnrichment.linkedinUrl;

  // 5. Normalize the mobile number for identity matching. ONLY use a
  // number the LLM classified as personal/WhatsApp — never fall back to
  // signals.phones[0], which is usually the company switchboard. That
  // fallback would write an office landline as the contact's mobile_e164
  // and then merge every colleague sharing that number into one "person".
  const rawMobile =
    enrichment.personalPhone ||
    enrichment.whatsappNumber ||
    null;
  const mobileE164 = rawMobile ? normalizePhoneToE164(rawMobile) : null;

  // 6. Persist. The main process handles identity merge + history
  // inside a transaction.
  // Backfill anything the model left null but the signature plainly states.
  // The LLM is better at ambiguity; it is not better at reading a line that
  // says "CBO", and a null there costs the user a visible field for no reason.
  const derived = extractDeterministicProfile(signals, contact.email);
  if (!enrichment.fullName && derived.fullName) enrichment.fullName = derived.fullName;
  if (!enrichment.designation && derived.title) enrichment.designation = derived.title;
  if (!enrichment.companyName && derived.organization) enrichment.companyName = derived.organization;
  if (!enrichment.companyWebsite && derived.website) enrichment.companyWebsite = derived.website;
  if (!enrichment.linkedinUrl && derived.linkedinUrl) enrichment.linkedinUrl = derived.linkedinUrl;

  const applyRes = await api.contacts.applyEnrichment({
    contactId: opts.contactId,
    accountId: opts.accountId,
    enrichment,
    mobileE164,
    enrichedThroughEmailAt: newestEmailAt,
    sourceEmailId: emails[0]?.id || null,
    source: 'llm',
  });
  if (!applyRes?.success) {
    // Bump the watermark here too — applyEnrichment normally writes it inside
    // its transaction, but on failure it didn't, so without this the contact
    // stays eligible and re-runs every tick. (Loop-safety over retry.)
    await bumpEnrichmentWatermark(api, opts.contactId, newestEmailAt, opts.accountId);
    return { ok: false, reason: 'llm_failed', detail: applyRes?.error || 'apply failed' };
  }

  // Tell the Contacts UI a contact was enriched so it refreshes without a
  // reload (name/company/phone/avatar land live).
  try {
    if (typeof document !== 'undefined') {
      document.dispatchEvent(new CustomEvent('sarvinbox:contact-enriched', { detail: { contactId: opts.contactId } }));
    }
  } catch { /* non-DOM context */ }

  return {
    ok: true,
    enrichment,
    mobileE164,
    enrichedThroughEmailAt: newestEmailAt,
    scannedEmailCount: emails.length,
  };
}

/**
 * Minimal HTML → text: strip tags and collapse whitespace. Only used
 * as a fallback when the email record has no clean_body cached.
 */
function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Wire up to the `contact-enrichment:run-batch` IPC from the scheduler.
 * Processes the list serially with a short throttle between contacts
 * — we never run two LLM calls in parallel (the user asked explicitly
 * for one-by-one). Listens once per app lifetime; the caller should
 * invoke exactly once at renderer startup.
 */
let batchListenerInstalled = false;
const THROTTLE_MS = 2000;

export function installEnrichmentBatchListener(): void {
  if (batchListenerInstalled) return;

  // electronAPI is injected by the preload contextBridge. If it (or the
  // contactEnrichment channel) isn't ready yet — early startup before preload
  // attaches, HMR, or a non-Electron context — skip WITHOUT marking installed,
  // so a later call can wire it up. Guarding `api` itself (not just
  // `?.contactEnrichment`) is the fix for the Sentry crash "Cannot read
  // properties of undefined (reading 'contactEnrichment')": `api.contactEnrichment?.`
  // still throws when `api` is undefined.
  const api = window.electronAPI as any;
  if (!api?.contactEnrichment?.onRunBatch) return;

  batchListenerInstalled = true;
  api.contactEnrichment.onRunBatch(async (payload: { contactIds: string[]; accountId?: string }) => {
    if (!payload || !Array.isArray(payload.contactIds)) return;
    for (const contactId of payload.contactIds) {
      try {
        const result = await enrichContact({ contactId, accountId: payload.accountId });
        // Fire-and-forget progress report; the scheduler doesn't block on this.
        api.contactEnrichment?.reportProgress?.({
          contactId,
          ok: result.ok,
          reason: result.ok ? null : result.reason,
        });
      } catch (err) {
        console.error('[enrichment] contact', contactId, 'failed:', err);
      }
      await sleep(THROTTLE_MS);
    }
    api.contactEnrichment?.reportBatchDone?.();
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
