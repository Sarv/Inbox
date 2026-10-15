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
  buildEnrichmentUserMessage,
  ENRICHMENT_SYSTEM_PROMPT,
  parseEnrichmentResponse,
  CONTACT_ENRICHMENT_REVIEW_VERSION,
  isIncompleteContactProfile,
  type ContactEnrichmentReview,
  type ExtractedSignals,
  type ContactEnrichment,
} from '@sarvinbox/core/contact-enrichment';
import { createLogger } from '@sarvinbox/core/logger';

import { AI_ASSIST_CHANGED_EVENT, isAIAssistEnabled } from './agent-settings';
import { getDefaultProvider, makeAICompletion } from './ai-service';
import { isOnboardingPending } from './onboarding-progress';

const log = createLogger('ContactEnrichment');

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
  /** Scheduler calls honor the master AI switch; explicit Enrich stays available. */
  automatic?: boolean;
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
    | 'unchanged_signature'
    | 'automated_sender'
    | 'awaiting_body'
    | 'onboarding'
    // Automatic batches remain retryable; no watermark is advanced.
    | 'ai_disabled';
  detail?: string;
}

const MAX_EMAILS_TO_SCAN = 20;
const RE_ENRICH_MIN_AGE_SECONDS = 90 * 86400; // 90 days

export interface EnrichmentStatus {
  running: boolean;
  processed: number;
  total: number;
  contactId?: string;
  pausedReason?: 'ai_disabled' | 'no_provider' | 'onboarding';
}
let enrichmentStatus: EnrichmentStatus = { running: false, processed: 0, total: 0 };
const statusListeners = new Set<() => void>();
export const getEnrichmentStatus = (): EnrichmentStatus => enrichmentStatus;
export function subscribeEnrichmentStatus(listener: () => void): () => void {
  statusListeners.add(listener);
  return () => { statusListeners.delete(listener); };
}
function updateStatus(patch: Partial<EnrichmentStatus>): void {
  enrichmentStatus = { ...enrichmentStatus, ...patch };
  for (const listener of statusListeners) listener();
}
function pausedReason(): EnrichmentStatus['pausedReason'] {
  if (isOnboardingPending()) return 'onboarding';
  if (!isAIAssistEnabled()) return 'ai_disabled';
  if (!getDefaultProvider()) return 'no_provider';
  return undefined;
}
function profileFields(signals: ExtractedSignals, email: string): ContactEnrichment {
  const profile = extractDeterministicProfile(signals, email);
  return {
    fullName: profile.fullName, designation: profile.title, department: profile.department,
    companyName: profile.organization, companyWebsite: profile.website, companyAddress: profile.companyAddress,
    linkedinUrl: profile.linkedinUrl, companyLinkedinUrl: profile.companyLinkedinUrl,
    twitterUrl: profile.twitterUrl, githubUrl: profile.githubUrl,
    pronouns: profile.pronouns, personalEmail: profile.personalEmail, otherSocials: profile.otherSocials,
  };
}
/** Hash only signature-derived features, never the changing message prose. */
function signatureFingerprint(signals: ExtractedSignals, email: string): string {
  const evidence = JSON.stringify({ profile: profileFields(signals, email),
    phones: signaturePhones(signals, email).sort(), urls: [...signals.urls].sort(), titles: [...signals.titleCandidates].sort() });
  return fingerprintText(evidence);
}
function signaturePhones(signals: ExtractedSignals, email: string): string[] {
  return signals.signatureBlock ? extractSignals(signals.signatureBlock, email).phones : [];
}
function fingerprintText(evidence: string): string {
  let first = 2166136261, second = 5381;
  for (let i = 0; i < evidence.length; i++) {
    first = Math.imul(first ^ evidence.charCodeAt(i), 16777619);
    second = Math.imul(second, 33) ^ evidence.charCodeAt(i);
  }
  return `${(first >>> 0).toString(16)}-${(second >>> 0).toString(16)}`;
}
function preserveProfile(contact: any, next: ContactEnrichment): ContactEnrichment {
  const prior = contact.enrichment ?? {};
  const merged = { ...prior, ...next };
  for (const [key, value] of Object.entries(prior)) {
    const incoming = merged[key];
    if (incoming == null || incoming === '' || (Array.isArray(incoming) && !incoming.length) || contact.enrichmentSource === 'user') {
      merged[key] = value;
    }
  }
  if (contact.enrichmentSource === 'user') {
    if (contact.title) merged.designation = contact.title;
    if (contact.organization) merged.companyName = contact.organization;
  }
  return merged;
}
const inFlightContacts = new Map<string, Promise<EnrichContactResult | EnrichContactSkipped>>();

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

// Same tier written as a SUFFIX — keep byte-identical with
// NOREPLY_LOCAL_PART_SUFFIX_RE in packages/core/src/utils/role-address.ts.
// Providers put the marker at the END of a generated local-part
// (`drive-shares-dm-noreply@`, `pullrequests-reply@`), which the prefix pattern
// above cannot see, so those bodies were being run through enrichment.
const NOREPLY_LOCAL_PART_SUFFIX_RE =
  /[.\-_+](no-?reply|do-?not-?reply|donotreply|reply|notifications?|notify|alerts?|bounces?|mailer|daemon|unsubscribe)$/i;

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
  return NOREPLY_LOCAL_PART_RE.test(local) || NOREPLY_LOCAL_PART_SUFFIX_RE.test(local);
}

/**
 * Best-effort watermark bump — marks the contact "enriched through" the
 * given email timestamp so the scheduler stops re-queuing it. Never throws;
 * a failed watermark write must not fail (or crash) the enrichment call.
 * Used only when available evidence was consumed (no_signals/automated_sender).
 */
async function bumpEnrichmentWatermark(
  api: any,
  contactId: string,
  throughEmailAt: number,
  accountId?: string,
  review?: ContactEnrichmentReview,
): Promise<boolean> {
  try {
    const result = await api.contacts.recordEnrichmentWatermark(contactId, throughEmailAt, accountId, review);
    if (!result?.success) return false;
    if (typeof document !== 'undefined') document.dispatchEvent(new CustomEvent('sarvinbox:contact-enriched', { detail: { contactId } }));
    return true;
  } catch { return false; }
}

/**
 * Run enrichment for one contact. Concurrent requests share a single call;
 * successful or terminal reviews advance the source watermark.
 */
export async function enrichContact(
  opts: EnrichContactOptions,
): Promise<EnrichContactResult | EnrichContactSkipped> {
  const existing = inFlightContacts.get(opts.contactId);
  if (existing) return existing;
  const pending = runEnrichment(opts);
  inFlightContacts.set(opts.contactId, pending);
  try { return await pending; }
  finally { inFlightContacts.delete(opts.contactId); }
}

async function runEnrichment(opts: EnrichContactOptions): Promise<EnrichContactResult | EnrichContactSkipped> {
  const paused = opts.automatic ? pausedReason() : undefined;
  if (paused) return { ok: false, reason: paused };
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
    if (!await bumpEnrichmentWatermark(api, opts.contactId, Math.floor(Date.now() / 1000), opts.accountId)) return { ok: false, reason: 'llm_failed', detail: 'Could not record signature review' };
    return { ok: false, reason: 'automated_sender' };
  }

  const received = emailsRes?.success && Array.isArray(emailsRes.data) ? emailsRes.data : [];

  if (received.length === 0) {
    return { ok: false, reason: 'no_inbound_mail' };
  }
  // Never consume header-only mail: its signature can arrive after sync.
  const emails = received.filter((email: any) =>
    [email.cleanBody, email.plainBody, email.textBody, email.htmlBody].some(body => typeof body === 'string' && body.trim()));
  if (!emails.length) return { ok: false, reason: 'awaiting_body' };

  // Recovery and signature comparison happen after reading available bodies;
  // a legacy failed attempt's timestamp is not proof its signature was read.
  const newestEmailAt = Math.max(...emails.map((e: any) => e.date || 0));

  // 3. Extract signals from each email (body + html fallback), then
  // merge across emails for rank-by-frequency. Pass the email's actual
  // From: address — the extractor strips quoted tails and validates the
  // signature against the From: domain so we don't pick up a quoted
  // user signature from deeper in a thread chain.
  const perEmail: ExtractedSignals[] = [];
  for (const e of emails) {
    const body: string = e.miningText || e.cleanBody || e.plainBody || e.textBody || '';
    const htmlFallback = body.length < 50 && e.htmlBody ? stripHtml(e.htmlBody) : '';
    // Prefer the HTML fallback whenever the plain body is too short to
    // carry a signature (< 50 chars) — `body || htmlFallback` only used
    // the fallback when body was the empty string exactly.
    const text = body.length >= 50 ? body : (htmlFallback || body);
    if (!text) continue;
    perEmail.push(extractSignals(text, e.fromAddress || contact.email));
  }
  const signals = mergeSignals(perEmail);
  // The newest usable signature defines the revision. Older signatures falling
  // out of the bounded sample, or a new unsigned note, must not buy another call.
  const fingerprintSignals = perEmail.find(candidate => signaturePhones(candidate, contact.email).length || candidate.urls.length || candidate.titleCandidates.length
    || Object.values(profileFields(candidate, contact.email)).some(value => Array.isArray(value) ? value.length : Boolean(value))) ?? perEmail[0] ?? signals;
  const review: ContactEnrichmentReview = { version: CONTACT_ENRICHMENT_REVIEW_VERSION, signatureFingerprint: signatureFingerprint(fingerprintSignals, contact.email), throughEmailAt: newestEmailAt };
  const previousReview = contact.metadata?.contactEnrichmentReview as ContactEnrichmentReview | undefined;
  const watermark = contact.enrichedThroughEmailAt || 0;
  const needsRecovery = (previousReview?.version ?? 0) < CONTACT_ENRICHMENT_REVIEW_VERSION && isIncompleteContactProfile(contact.enrichment);
  if (!opts.force) {
    if (previousReview?.version === review.version && previousReview.signatureFingerprint === review.signatureFingerprint) {
      if (!await bumpEnrichmentWatermark(api, opts.contactId, Math.max(watermark, newestEmailAt), opts.accountId, review)) return { ok: false, reason: 'llm_failed', detail: 'Could not record signature review' };
      return { ok: false, reason: 'unchanged_signature' };
    }
    const changedSignature = !!previousReview?.signatureFingerprint && newestEmailAt > (previousReview.throughEmailAt ?? watermark);
    if (!needsRecovery && !changedSignature && watermark && newestEmailAt <= watermark + RE_ENRICH_MIN_AGE_SECONDS) {
      return { ok: false, reason: 'cadence_not_due' };
    }
  }

  const hasAnySignal =
    signals.phones.length > 0 ||
    signals.linkedinUrls.length > 0 ||
    signals.titleCandidates.length > 0 ||
    !!signals.signatureBlock;

  if (!hasAnySignal) {
    // Nothing to enrich from; still bump the watermark so we don't
    // keep re-scanning the same emails.
    if (!await bumpEnrichmentWatermark(api, opts.contactId, newestEmailAt, opts.accountId, review)) return { ok: false, reason: 'llm_failed', detail: 'Could not record signature review' };
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
    const fallback = profileFields(signals, contact.email);
    if (Object.values(fallback).some(value => Array.isArray(value) ? value.length : Boolean(value))) {
      const applied = await api.contacts.applyEnrichment({
        contactId: opts.contactId,
        accountId: opts.accountId,
        enrichment: preserveProfile(contact, fallback),
        mobileE164: null, // phones stay owned by the deterministic classifier
        enrichedThroughEmailAt: contact.enrichedThroughEmailAt ?? 0,
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
    return { ok: false, reason: 'no_provider' };
  }

  const userMessage = buildEnrichmentUserMessage({
    contactEmail: contact.email,
    contactName: contact.displayName || contact.name,
    signals,
    existingOrganization: contact.organization,
    existingTitle: contact.title,
  });

  // Failed calls remain eligible. The scheduler applies a temporary cooldown
  // and excludes them from the next batch so other contacts can make progress.
  let raw: string;
  // The user can switch AI off while contact/body IPC is in flight.
  const pausedBeforeSend = opts.automatic ? pausedReason() : undefined;
  if (pausedBeforeSend) return { ok: false, reason: pausedBeforeSend };
  try {
    raw = await makeAICompletion({
      systemPrompt: ENRICHMENT_SYSTEM_PROMPT,
      userPrompt: userMessage,
      maxTokens: 1000,
    });
  } catch (err) {
    return { ok: false, reason: 'llm_failed', detail: (err as Error).message };
  }

  const parsed = parseEnrichmentResponse(raw, signals);
  if (!parsed) {
    return { ok: false, reason: 'llm_failed', detail: 'unparseable LLM response' };
  }
  const derived = profileFields(signals, contact.email);
  for (const [key, value] of Object.entries(derived)) {
    if ((parsed as Record<string, unknown>)[key] == null || (Array.isArray(parsed[key as keyof ContactEnrichment]) && !(parsed[key as keyof ContactEnrichment] as unknown[]).length)) {
      (parsed as Record<string, unknown>)[key] = value;
    }
  }
  const enrichment = preserveProfile(contact, parsed);

  // Phones are owned by the deterministic cross-domain classifier (run during a
  // scan), not the LLM — it splits a shared office line from a personal number
  // by looking across the whole domain, which a single-contact LLM pass can't.
  // Keep any classifier-written phones over the LLM's guess.
  const priorEnrichment = contact.enrichment as ContactEnrichment | undefined;
  if (priorEnrichment?.companyPhone) enrichment.companyPhone = priorEnrichment.companyPhone;
  if (priorEnrichment?.personalPhone) enrichment.personalPhone = priorEnrichment.personalPhone;
  // Keep a scan-mined LinkedIn (/in/) profile when the LLM didn't produce one.
  if (!enrichment.linkedinUrl && priorEnrichment?.linkedinUrl) enrichment.linkedinUrl = priorEnrichment.linkedinUrl;

  // Identity requires the cross-contact phone classifier's existing verdict.
  // A model seeing a shared switchboard in a signature cannot prove ownership.
  const mobileE164 = contact.mobileE164 || null;

  // 6. Persist. The main process handles identity merge + history
  // inside a transaction.
  // Backfill anything the model left null but the signature plainly states.
  // The LLM is better at ambiguity; it is not better at reading a line that
  // says "CBO", and a null there costs the user a visible field for no reason.
  const applyRes = await api.contacts.applyEnrichment({
    contactId: opts.contactId,
    accountId: opts.accountId,
    enrichment,
    mobileE164,
    enrichedThroughEmailAt: newestEmailAt,
    sourceEmailId: emails[0]?.id || null,
    source: 'llm',
    review,
  });
  if (!applyRes?.success) {
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
  const sessionId = `${Date.now()}-${Math.random()}`;
  let lastReady: boolean | undefined;
  let lastProviderRevision: string | undefined;
  const syncReadiness = () => {
    const reason = pausedReason();
    if (enrichmentStatus.pausedReason !== reason) updateStatus({ pausedReason: reason });
    const ready = !reason;
    const provider = getDefaultProvider();
    const providerRevision = provider ? fingerprintText(JSON.stringify([provider.id, provider.type, provider.model, provider.baseUrl, provider.apiKey, provider.oauthEmail])) : undefined;
    if (lastReady === ready && lastProviderRevision === providerRevision) return;
    lastReady = ready;
    lastProviderRevision = providerRevision;
    Promise.resolve(api.contactEnrichment.setReady?.(ready, sessionId, providerRevision)).catch(() => { lastReady = undefined; });
  };
  // Provider credentials can hydrate after App mounts. The timer also catches
  // same-window provider writes, which do not emit the browser storage event.
  window.addEventListener(AI_ASSIST_CHANGED_EVENT, syncReadiness);
  window.addEventListener('storage', syncReadiness);
  window.addEventListener('sarvinbox:ai-provider-changed', syncReadiness);
  setInterval(syncReadiness, 30_000);

  let serialBatch = Promise.resolve();
  const processBatch = async (payload: { contactIds: string[]; accountId?: string; batchId?: string }) => {
    if (!payload || !Array.isArray(payload.contactIds)) return;
    updateStatus({ running: true, total: payload.contactIds.length, processed: 0, contactId: undefined });
    try {
      for (const contactId of payload.contactIds) {
        if (pausedReason()) break;
        updateStatus({ contactId });
        try {
          const result = await enrichContact({ contactId, accountId: payload.accountId, automatic: true });
          await api.contactEnrichment?.reportProgress?.({ contactId, batchId: payload.batchId, ok: result.ok, reason: result.ok ? null : result.reason });
        } catch (err) {
          log.error('Contact enrichment failed:', contactId, err);
          try { await api.contactEnrichment?.reportProgress?.({ contactId, batchId: payload.batchId, ok: false, reason: 'llm_failed' }); } catch { /* transport unavailable */ }
        }
        updateStatus({ processed: enrichmentStatus.processed + 1 });
        if (pausedReason()) break;
        if (enrichmentStatus.processed < payload.contactIds.length) await sleep(THROTTLE_MS);
      }
    } finally {
      // Even a skipped batch must release native scheduler's in-flight lock.
      syncReadiness();
      updateStatus({ running: false, contactId: undefined });
      try { await api.contactEnrichment?.reportBatchDone?.({ batchId: payload.batchId, continue: !pausedReason() }); } catch { /* renderer teardown */ }
    }
  };
  api.contactEnrichment.onRunBatch((payload: { contactIds: string[]; accountId?: string; batchId?: string }) => {
    serialBatch = serialBatch.then(() => processBatch(payload)).catch(error => { log.error('Enrichment batch failed:', error); });
    return serialBatch;
  });
  // Register the receiver BEFORE advertising readiness: native work can start
  // immediately after this handshake, including an existing contacts backlog.
  syncReadiness();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
