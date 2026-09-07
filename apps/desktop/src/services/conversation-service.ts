// Conversation extraction service — AI-powered extraction of individual messages
// from quoted/forwarded email content for unified conversation view

import type { EmailRecord } from '@sarvinbox/core';

import { parseHumanDateToEpochSec } from '../utils/human-date';
import { cleanLLMJsonResponse, truncate } from '../utils/llm-json';
import { cacheHasHealedMojibake } from '../utils/mojibake';

import { makeAICompletion, getDefaultProvider, loadAIFeatures } from './ai-service';
import { registerImage } from './image-cache';

// Bump this when extraction logic changes to invalidate stale caches.
// Exported so the renderer's pre-cache shortcut (useEmailDetail's
// runAIExtraction) can honor it too — otherwise that path returns
// stale-version cached bubbles on thread open and only re-extracts
// when the user clicks refresh.
export const EXTRACTION_VERSION = 36;

// ========== Types ==========

export interface ConversationMessage {
  id: string;                  // 'extracted-0', 'extracted-1', or real email.id
  fromAddress: string;
  fromName: string | null;
  toAddress: string;
  date: number;                // Unix timestamp (seconds)
  /**
   * True when `date` is SYNTHETIC — the attribution line was
   * unparseable, so the date was approximated backwards from the
   * source email (sourceEmail.date − 60s per step) purely so the
   * bubble sorts correctly and lands in a real date group instead of
   * "Unknown date". A synthetic date must NEVER participate in any
   * date-window dedup/matching predicate — treat it exactly like
   * date-unknown there (see processThread, mergeIncrementalMessages,
   * useEmailDetail's handleReExtractMessage).
   */
  dateApprox?: boolean;
  body: string;                // Cleaned HTML content of this message only
  isExtracted: boolean;        // true = AI-extracted from quotes
  sourceEmailId: string;       // ID of email this was extracted from
  /**
   * True when the AI cleanup for THIS message failed and we fell back to the
   * deterministic heuristic slice (or skipped the LLM via the circuit breaker).
   * The bubble shows an error + a "Process with AI" button to retry just this
   * message. Undefined/false = cleanly AI-processed (a truncated-but-usable AI
   * result is NOT flagged). Persisted in the thread cache JSON.
   */
  extractionFailed?: boolean;
}

export interface ConversationResult {
  messages: ConversationMessage[];
  fromCache: boolean;
  /**
   * True if a Phase 2 per-email AI call fell back to DOM cleaning
   * (transient LLM failure or low content overlap). UI surfaces this
   * to offer a retry.
   */
  partial: boolean;
}

/**
 * Progressive-extraction update (T3). Fired once when extraction
 * starts (done=0, messages=whatever is already known — cached bubbles
 * on the incremental path, Phase-1 split results once they land) and
 * again after EACH email's extraction completes.
 */
export interface ConversationProgress {
  /**
   * All conversation messages assembled SO FAR — sorted by date, same
   * shape as the final ConversationResult.messages. Safe to render
   * directly.
   */
  messages: ConversationMessage[];
  /** Emails whose extraction has completed in this run. */
  done: number;
  /** Emails this run is processing. */
  total: number;
  /**
   * Optional human-readable status forwarded from the AI layer
   * (rate-limit waits, retries) — e.g. "AI provider busy — retrying
   * in 8s".
   */
  status?: string;
}

export type ConversationProgressCallback = (update: ConversationProgress) => void;

/**
 * Conversation-cache row as returned by `ai.getConversation` IPC —
 * minimal fields the extraction pipeline reads. Used by the T2
 * `cachedHint` option so a caller that already fetched the row can
 * hand it over instead of the service re-reading it over IPC.
 */
export interface ConversationCacheRow {
  messages: string;
  processedEmailIds?: string | null;
  modelUsed?: string | null;
}

export interface ExtractConversationOptions {
  forceRefresh?: boolean;
  /**
   * T2 — skip the duplicate cache read. When present, the caller has
   * ALREADY read the conversation cache via IPC: `row` carries the
   * fetched row, or null for a confirmed miss/stale-version row (the
   * service then goes straight to extraction). Callers that omit this
   * (background batch listener, store auto-extract) keep the old
   * behavior — the service reads the cache itself.
   */
  cachedHint?: { row: ConversationCacheRow | null };
  /** T3 — progressive rendering callback. See ConversationProgress. */
  onProgress?: ConversationProgressCallback;
}

/**
 * Date-match tolerance (seconds) when comparing a Phase-1 EXTRACTED
 * message (synthetic 'extracted-' id) against a real email or another
 * bubble. Attribution lines ("On May 11, 2025 at 5:14 PM … wrote:")
 * carry no timezone and often no seconds, so the parsed epoch can be
 * off from the real email's exact date by hours. ±26h covers every
 * UTC offset (±14h) plus DST slop — same calendar day. Real-vs-real
 * comparisons must stay strict; never apply this between two real
 * emails. A 0 (unknown) date must never match anything.
 */
export const EXTRACTED_MATCH_TOLERANCE_S = 26 * 3600;

// CSS selectors for signature DOM elements (safe to remove — no content loss)
const SIGNATURE_DOM_SELECTORS = [
  '.gmail_signature',              // matches div.gmail_signature AND table.gmail_signature
  '[data-smartmail="gmail_signature"]',
  'div.AppleMailSignature',
  'div.email-signature',
  'table.signature',
  '.sig',
];

// Selectors that MAY be signatures but Outlook sometimes uses as body wrappers.
// Only remove if they contain little text (< 500 chars) — real signatures are short.
const SIGNATURE_MAYBE_SELECTORS = [
  '#Signature',
  '#signature',
  'div[id*="signature" i]',
  'div.signature',
];

// ========== Feature Toggle ==========

export function isConversationModeEnabled(): boolean {
  const features = loadAIFeatures();
  const feature = features.find(f => f.id === 'conversation-mode');
  return feature?.enabled !== false;
}

export function isAutoChatViewEnabled(): boolean {
  const features = loadAIFeatures();
  const feature = features.find(f => f.id === 'auto-chat-view');
  return feature?.enabled === true;
}

export function isAutoChatExtractEnabled(): boolean {
  const features = loadAIFeatures();
  const feature = features.find(f => f.id === 'auto-chat-extract');
  return feature?.enabled === true;
}

// ========== Quote-marker Detection ==========

/**
 * Detect whether a raw HTML/plain body contains an embedded conversation —
 * i.e. quoted, forwarded, or replied content from a previous message.
 *
 * Used to decide:
 *   • Whether Phase 2 AI cleanup is worth running on a given email.
 *   • Whether a SINGLE-email view should still flip to Chat View
 *     (the "loop me in" case: someone forwards a long thread to you,
 *     so threadEmails.length === 1 but the body holds the whole history).
 *
 * Detects:
 *   • Gmail / Apple Mail "On <date>, <name> wrote:" — checked on the RAW
 *     HTML with `[\s\S]` so an inline <a>address</a> tag inside the
 *     attribution doesn't break the match.
 *   • Outlook reply headers (`From:` / `Sent:` at line start, after
 *     stripping tags so wrapped <b>From:</b><br> still matches).
 *   • Outlook "-----Original Message-----" / Gmail "---------- Forwarded message ----------" banners.
 *   • `<blockquote>` AND `class="gmail_quote"` containers (Sarv webmail
 *     uses divs with the class — no <blockquote>).
 *   • Plain-text "> " quoting at line start.
 */
export function hasQuotedHistory(rawBody: string | null | undefined): boolean {
  const body = rawBody || '';
  if (!body) return false;
  const stripped = body
    .replace(/<[^>]*>/g, '\n')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
  // Cap at 800 chars between "On" and "wrote:" — long enough for the
  // longest sane attribution, short enough that a stray "On" and a
  // distant "wrote:" elsewhere in the document don't false-positive.
  const onWroteRaw = /\bOn\b[\s\S]{1,800}?\bwrote:/i;
  return (
    onWroteRaw.test(body) ||                                  // raw HTML — handles inline tags inside attribution
    /^\s*From:\s/m.test(stripped) ||
    /^\s*Sent:\s/m.test(stripped) ||
    /-{2,}\s*Original Message\s*-{2,}/i.test(stripped) ||
    /-{2,}\s*Forwarded message\s*-{2,}/i.test(stripped) ||
    /Begin forwarded message:/i.test(stripped) ||
    /<blockquote/i.test(body) ||
    /class\s*=\s*["'][^"']*gmail_quote/i.test(body) ||        // Sarv / Gmail quote-container div
    /^\s*>\s/m.test(stripped)
  );
}

/**
 * STRICT variant used to decide whether a SINGLE email should open as a
 * chat conversation. A normal single email — including a plain reply that
 * quotes one message — stays in the standard card. We only flip a lone
 * email to chat view when it genuinely embeds a MULTI-message thread, i.e.
 * someone looped you into the middle of an ongoing chain.
 *
 * `hasQuotedHistory` is deliberately loose (one quote marker is enough —
 * it gates the Phase-1 splitter once chat view is ALREADY showing). For
 * the auto-open decision that's too eager: a lone "From:" line or a single
 * blockquote would wrongly turn a boarding pass / OTP / one-line reply into
 * a chat view. So this requires BOTH signals the way a real thread shows them:
 *
 *   1. a recognized quote / reply CONTAINER (provider "thread classes":
 *      <blockquote>, gmail_quote, Outlook divRplyFwdMsg / appendonsend /
 *      OutlookMessageHeader / OLK_SRC_BODY_SECTION, moz-cite) OR an explicit
 *      Forwarded / Original-Message banner; AND
 *   2. evidence of >=2 embedded messages — counted from attribution lines
 *      ("On … wrote:"), Outlook "From: …" header blocks, and forward banners.
 *      A back-and-forth chain has two or more; a single reply has one.
 *      A high distinct-participant count (>=4 addresses in the quoted text)
 *      also qualifies — group forwards that lack clean attributions.
 */
export function hasEmbeddedConversation(rawBody: string | null | undefined): boolean {
  const body = rawBody || '';
  if (!body) return false;
  const stripped = body
    .replace(/<[^>]*>/g, '\n')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>');

  // 1. Recognized quote / reply container or forward banner.
  const hasContainer =
    /<blockquote/i.test(body) ||
    /class\s*=\s*["'][^"']*gmail_quote/i.test(body) ||
    /class\s*=\s*["'][^"']*(OutlookMessageHeader|moz-cite-prefix)/i.test(body) ||
    /id\s*=\s*["']?(x_)?(divRplyFwdMsg|appendonsend|OLK_SRC_BODY_SECTION|mail-editor-reference)/i.test(body) ||
    /-{2,}\s*Original Message\s*-{2,}/i.test(stripped) ||
    /-{2,}\s*Forwarded message\s*-{2,}/i.test(stripped) ||
    /Begin forwarded message:/i.test(stripped);
  if (!hasContainer) return false;

  // 2. Count embedded message boundaries — a real chain has >= 2.
  const onWrote = (body.match(/\bOn\b[\s\S]{1,800}?\bwrote:/gi) || []).length;
  const fromHdr = (stripped.match(/^\s*From:\s.+$/gim) || []).length;
  const fwdBanner =
    (stripped.match(/-{2,}\s*(Original|Forwarded) message\s*-{2,}/gi) || []).length +
    (stripped.match(/Begin forwarded message:/gi) || []).length;
  if (onWrote + fromHdr + fwdBanner >= 2) return true;

  // Corroborating: a clearly multi-party forwarded thread.
  const addrs = new Set(
    (stripped.match(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi) || []).map(a => a.toLowerCase()),
  );
  return addrs.size >= 4;
}

/**
 * Heuristic: does this body look like it has a signature that DOM
 * cleanup probably won't catch? Used to decide whether to spend an LLM
 * call on a no-quote-marker email — the existing CSS-selector
 * signature scrub only matches a known set of `.gmail_signature` /
 * `#Signature` patterns, so custom corporate sign-offs slip through.
 *
 * False positives (running LLM on emails that don't actually need
 * cleanup) are cheap — the LLM will return the body roughly unchanged.
 * False negatives (skipping LLM on emails that do need cleanup) leave
 * a visible signature in the chat bubble — the symptom the user sees.
 */
export function looksLikeSignaturePresent(stripped: string): boolean {
  // Must be long enough that there's plausibly something to extract;
  // very short emails are usually 1-line replies with no signature.
  if (stripped.length < 200) return false;
  return /\b(regards|thanks|sincerely|best,|warm regards|best wishes|cheers,|sent from my|warmly|kind regards|yours truly)\b/i.test(stripped);
}

// ========== HTML Cleaning for AI ==========

/**
 * Clean HTML for AI processing — optimize tokens while preserving content.
 *
 * @param rawBody - Original HTML email body
 * @param stripQuotes - If true, remove quoted content via DOM selectors (for subsequent emails).
 *                      If false, keep everything (for oldest email with embedded conversation).
 */
export function cleanHtmlForAI(rawBody: string, stripQuotes: boolean): string {
  const parser = new DOMParser();
  const doc = parser.parseFromString(rawBody, 'text/html');

  // Remove MSO XML conditionals: <!--[if gte mso...]-->...<!--[endif]-->
  const html = doc.documentElement.outerHTML;
  const cleaned = html.replace(/<!--\[if[\s\S]{0,4096}?<!\[endif\]-->/gi, '');

  // Re-parse after MSO removal
  const doc2 = parser.parseFromString(cleaned, 'text/html');

  // Remove <style> and <script> blocks
  doc2.querySelectorAll('style, script').forEach(el => el.remove());

  // Remove ALL signature elements at every nesting level FIRST. Any
  // images inside signature blocks (logos, social icons) get removed
  // along with their parent — no need for an extra image scrub.
  for (const selector of SIGNATURE_DOM_SELECTORS) {
    try {
      doc2.querySelectorAll(selector).forEach(el => el.remove());
    } catch { /* skip */ }
  }

  // Remove tracking pixels — invisible 1×1 / 0×0 images used by
  // marketing platforms (sendclean, mailchimp, hubspot, etc.) for
  // open-receipt tracking. They have no visual or informational value
  // and just add noise + privacy leak. Heuristic: explicit width OR
  // height ≤ 2px OR matches known tracker URL patterns. Content
  // images survive — those get translated to ![alt](src) markdown
  // in the AI extraction step.
  doc2.querySelectorAll('img').forEach(el => {
    const w = parseInt(el.getAttribute('width') || '', 10);
    const h = parseInt(el.getAttribute('height') || '', 10);
    const style = el.getAttribute('style') || '';
    const styleW = parseInt((style.match(/(?:^|;)\s*width\s*:\s*(\d+)/i) || [])[1] || '', 10);
    const styleH = parseInt((style.match(/(?:^|;)\s*height\s*:\s*(\d+)/i) || [])[1] || '', 10);
    const tinyAttr = (Number.isFinite(w) && w <= 2) || (Number.isFinite(h) && h <= 2);
    const tinyStyle = (Number.isFinite(styleW) && styleW <= 2) || (Number.isFinite(styleH) && styleH <= 2);
    const src = (el.getAttribute('src') || '').toLowerCase();
    const trackerSrc = /track\.|\/o\/\?|\/open\?|\/pixel|\/tracking|\/beacon|\/__track|sendclean|hs-analytics|mailchimp\.com\/track|sendgrid\.net\/wf|mailgun.*\/o\/|salesforce\.com\/servlet\/servlet\.ImageServer/i.test(src);
    if (tinyAttr || tinyStyle || trackerSrc) {
      el.remove();
    }
  });
  // Remove maybe-signature elements only if they're short (< 500 chars).
  // Outlook wraps entire reply bodies in id="Signature" divs — don't nuke those.
  for (const selector of SIGNATURE_MAYBE_SELECTORS) {
    try {
      doc2.querySelectorAll(selector).forEach(el => {
        const textLen = (el.textContent || '').trim().length;
        if (textLen < 500) el.remove();
      });
    } catch { /* skip */ }
  }
  doc2.querySelectorAll('.gmail_extra').forEach(el => el.remove());

  // Remove <hr> elements (visual separators, no content)
  doc2.querySelectorAll('hr').forEach(el => el.remove());

  // Remove email disclaimers by content pattern
  doc2.querySelectorAll('div').forEach(el => {
    const text = el.textContent?.trim() || '';
    if (
      (text.startsWith('Email Disclaimer') && text.length > 200) ||
      (text.startsWith('This email, including any attachments, is intended solely') && text.length > 200)
    ) {
      el.remove();
    }
  });

  // ── Strip quoted content BEFORE removing class/id attributes ──
  // (Quote selectors like .gmail_quote rely on class/id being present)
  if (stripQuotes) {
    // Remove blockquotes
    doc2.querySelectorAll('blockquote').forEach(el => el.remove());

    // Remove Gmail quote containers
    doc2.querySelectorAll('.gmail_quote').forEach(el => el.remove());

    // Remove Outlook-style quote containers
    doc2.querySelectorAll('[id*="mail-editor-ref"]').forEach(el => el.remove());
    doc2.querySelectorAll('[data-marker*="__"]').forEach(el => el.remove());

    // Remove "On ... wrote:" attribution lines
    doc2.querySelectorAll('div').forEach(el => {
      const text = el.textContent?.trim() || '';
      if (/^On .+ wrote:$/.test(text)) {
        el.remove();
      }
    });

    // Also try plain-text style "On ... wrote:" followed by ">" quoted lines
    // (some clients use plain text quoting even in HTML bodies)
    doc2.querySelectorAll('div, p').forEach(el => {
      const text = el.textContent?.trim() || '';
      if (/^On\s+.+\s+wrote:\s*$/.test(text)) {
        // Remove this attribution AND any following blockquote/quoted siblings
        let next = el.nextElementSibling;
        el.remove();
        while (next && (next.tagName === 'BLOCKQUOTE' || next.textContent?.trim().startsWith('>'))) {
          const toRemove = next;
          next = next.nextElementSibling;
          toRemove.remove();
        }
      }
    });
  }

  // ── Now strip attributes (AFTER quote removal so selectors work) ──
  // Strip ALL style, class, id attributes — saves massive tokens on deeply nested emails
  doc2.querySelectorAll('*').forEach(el => {
    el.removeAttribute('style');
    el.removeAttribute('class');
    el.removeAttribute('id');
    el.removeAttribute('dir');
    el.removeAttribute('data-outlook-id');
    el.removeAttribute('data-smartmail');
    el.removeAttribute('role');
    el.removeAttribute('cellspacing');
    el.removeAttribute('cellpadding');
  });

  // Remove empty anchor tags (tracking links with no text)
  doc2.querySelectorAll('a').forEach(el => {
    if (!el.textContent?.trim()) {
      el.remove();
    } else {
      el.removeAttribute('href');
      el.removeAttribute('target');
      el.removeAttribute('rel');
    }
  });

  // Remove empty elements (leftover after img/signature/quote removal)
  doc2.querySelectorAll('td, div, span, p, table').forEach(el => {
    if (!el.textContent?.trim() && !el.querySelector('table, blockquote')) {
      el.remove();
    }
  });

  let result = doc2.body.innerHTML;

  // Collapse repeated &nbsp;
  result = result.replace(/(&nbsp;\s*){2,}/g, ' ');

  // Remove excessive whitespace and empty tags
  result = result.replace(/\n\s*\n\s*\n/g, '\n\n');
  result = result.replace(/<(div|p|span|td)>\s*<\/\1>/gi, '');
  result = result.replace(/(<br\s*\/?>[\s\n]*){3,}/gi, '<br><br>');

  // Strip markdown auto-link wrapping that an upstream HTML→markdown
  // round-trip leaves embedded inside HTML — common in our pipeline
  // when an email gets converted to markdown for display then patched
  // back into HTML. The LLM then faithfully copies `[email](mailto:email)`
  // into from_address / body fields, polluting the parsed conversation.
  // Patterns we collapse:
  //   [text](mailto:user@x)        →  user@x      (preserve the address)
  //   [text](http(s)://...)        →  text        (preserve the visible label)
  //   <a>[text](url)</a>           →  same as above (the surrounding <a> was empty anyway)
  //   <a href="...">[text](url)</a> →  <a href="...">text</a>
  // The mailto branch keeps the address (the visible text and link target are usually
  // the same address, but we want the canonical one in case they diverge).
  result = result.replace(/\[([^\]\n]+?)\]\(mailto:([^)\s]+)\)/g, '$2');
  result = result.replace(/\[([^\]\n]+?)\]\(https?:\/\/[^)\s]+\)/g, '$1');

  return result.trim();
}

/**
 * Compress HTML to plain text + light structure for the Phase 1
 * splitter LLM. Walks the DOM, drops images/styles/scripts/heads, then
 * flattens the tree to plain text with `> ` prefixes for blockquote
 * indentation. Output is typically 5-10x smaller than the cleaned
 * HTML for typical Outlook/Gmail bodies, which lets the prompt fit
 * comfortably in small-context models (gemma-4 with 16K limit) while
 * preserving every sender's words verbatim.
 *
 * Quoted/forwarded structure is PRESERVED via "> " prefixes, "On X
 * wrote:" attributions, and "From:/Sent:/To:" header blocks — the
 * LLM uses these to find message boundaries. We only DROP visual
 * chrome (CSS, font tags, table-based signatures, tracking pixels,
 * MSO conditional comments).
 *
 * Tested with both gpt-oss-120b and sarv-mati-flash via
 * scripts/phase1-prompt-test/ — both score GOOD on the canonical
 * 12-deep VAPT thread fixture using the V3 prompt with this body
 * compression.
 */
export function compressHtmlToPlainTextForLLM(rawBody: string): string {
  if (!rawBody) return '';
  const parser = new DOMParser();
  const doc = parser.parseFromString(rawBody, 'text/html');

  // Strip MSO conditionals before any DOM walk — they break parsers.
  const html = doc.documentElement.outerHTML.replace(/<!--\[if[\s\S]{0,4096}?<!\[endif\]-->/gi, '');
  const doc2 = parser.parseFromString(html, 'text/html');

  // Drop noise.
  doc2.querySelectorAll('style, script, head, meta, link, title, noscript').forEach(el => el.remove());
  // Image handling: drop tracking pixels (≤2px or known tracker URL),
  // drop signature logos (small + inside small parents). For genuine
  // content images, replace base64 src with a content-hash ref via the
  // image cache so the LLM gets a tiny placeholder instead of kilobytes
  // of base64. The LLM is instructed to preserve refs verbatim.
  doc2.querySelectorAll('img').forEach(el => {
    const src = el.getAttribute('src') || '';
    const w = parseInt(el.getAttribute('width') || '0', 10);
    const h = parseInt(el.getAttribute('height') || '0', 10);
    const tinyAttr = (w > 0 && w <= 2) || (h > 0 && h <= 2);
    const trackerSrc = /track\.|\/o\/\?|\/open\?|\/pixel|\/tracking|\/beacon|\/__track|sendclean|hs-analytics|mailchimp\.com\/track|sendgrid\.net\/wf|mailgun.*\/o\/|salesforce\.com\/servlet\/servlet\.ImageServer/i.test(src);
    if (tinyAttr || trackerSrc || !src) {
      el.remove();
      return;
    }
    if (src.startsWith('data:image/')) {
      // Lazy import to avoid pulling cache module into every code path.
      const ref = registerImage(src);
      const placeholder = doc2.createTextNode(` ![](${ref}) `);
      el.parentNode?.replaceChild(placeholder, el);
    } else {
      // External http(s) image — keep markdown ref so the LLM sees the
      // URL (one short line) instead of an opaque <img> we'd lose.
      const placeholder = doc2.createTextNode(` ![](${src}) `);
      el.parentNode?.replaceChild(placeholder, el);
    }
  });
  // Drop signature DOM elements (gmail signature, Apple Mail, etc).
  for (const sel of ['.gmail_signature', '[data-smartmail="gmail_signature"]', 'div.AppleMailSignature', 'div.email-signature', 'table.signature', '.sig']) {
    try { doc2.querySelectorAll(sel).forEach(el => el.remove()); } catch { /* skip */ }
  }
  // Drop maybe-signature divs only if short (< 500 text chars).
  for (const sel of ['#Signature', '#signature', 'div[id*="signature" i]', 'div.signature']) {
    try {
      doc2.querySelectorAll(sel).forEach(el => {
        if ((el.textContent || '').trim().length < 500) el.remove();
      });
    } catch { /* skip */ }
  }

  // Mark blockquote boundaries with sentinel strings, walk text-by-text
  // so we can emit "> " prefixes per quoted line below. The sentinels are
  // NUL-padded ("\x00OPENQ\x00") rather than space-padded: the per-line
  // trim below strips spaces at line boundaries (which made " OPENQ "
  // unfindable and leaked literal OPENQ/CLOSEQ tokens into LLM prompts),
  // while NUL survives trim() and can never occur in parsed HTML content
  // (the HTML parser replaces NUL with U+FFFD), so no false matches.
  doc2.querySelectorAll('blockquote').forEach(el => {
    const open = doc2.createTextNode('\x00OPENQ\x00');
    const close = doc2.createTextNode('\x00CLOSEQ\x00');
    el.parentNode?.insertBefore(open, el);
    el.parentNode?.insertBefore(close, el.nextSibling);
  });

  // Replace <br>/end-of-block tags with newlines so the text reads
  // sensibly when flattened. Cell separator → tab so a flattened
  // table is at least readable as columns.
  let text = doc2.body.innerHTML
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<\/td>/gi, '\t')
    .replace(/<[^>]+>/g, '');

  // Decode entities.
  text = text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'");

  // Collapse runs of spaces. Trim every line. Collapse 3+ blank lines.
  text = text.replace(/[ \t]+/g, ' ');
  text = text.split('\n').map(l => l.trim()).join('\n');
  text = text.replace(/\n{3,}/g, '\n\n');

  // Walk lines, applying "> " depth from the OPENQ/CLOSEQ markers.
  const lines = text.split('\n');
  const out: string[] = [];
  let depth = 0;
  for (const line of lines) {
    let rest = line;
    while (rest.length > 0) {
      const open = rest.indexOf('\x00OPENQ\x00');
      const close = rest.indexOf('\x00CLOSEQ\x00');
      const next = (open === -1) ? close : (close === -1) ? open : Math.min(open, close);
      if (next === -1) {
        const t = rest.trim();
        if (t) out.push('> '.repeat(depth) + t);
        break;
      }
      const before = rest.slice(0, next).trim();
      if (before) out.push('> '.repeat(depth) + before);
      if (rest.startsWith('\x00OPENQ\x00', next)) {
        depth++;
        rest = rest.slice(next + '\x00OPENQ\x00'.length);
      } else {
        depth = Math.max(0, depth - 1);
        rest = rest.slice(next + '\x00CLOSEQ\x00'.length);
      }
    }
  }
  let result = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();

  // Strip residual Sarv signature boilerplate.
  result = result
    .replace(/www\.sarv\.com\s*\|\s*\+91-\d{4}-\d{4}-\d{2,}/gi, '')
    .replace(/1800-12345-6001/g, '')
    .replace(/Email Disclaimer\s*[–-]\s*[^:\n]{1,60}:[\s\S]*?explicitly stated\.?/gi, '')
    .replace(/Get\s*Outlook for iOS/gi, '')
    .trim();

  return result;
}


// ========== Phase 2 Subsequent Email Prompt ==========

// ========== Per-email body extraction (v25 — LLM rewrites body) ==========
//
// The LLM receives the email body (light HTML cleanup, structural
// cues preserved) and returns the cleaned HTML containing only the
// sender's new content. Signatures, quoted history, and disclaimers
// are removed by the LLM — including empty container chrome left
// behind by Outlook etc. (which the older marker-based pipeline
// couldn't strip).
//
// Trade-offs vs the prior marker approach:
//   • +Quality: handles Outlook's deeply-nested empty containers,
//     interleaved signatures, and whitespace-fragmented quote
//     attributions that markers couldn't.
//   • -Cost: LLM output is ~25× larger than the old 200-byte marker
//     JSON.
//   • -Risk: paraphrase/hallucination potential — mitigated by a
//     token-overlap grounding check (drop output if <50% of its
//     words exist in the input).

/**
 * Prepare an HTML body for the marker-extraction LLM. Unlike
 * cleanHtmlForAI (which strips signature DOM containers) and unlike
 * compressHtmlToPlainTextForLLM (which flattens everything to text),
 * this keeps the HTML structure INTACT — including signature
 * containers (`<div class="gmail_signature">` etc.) — so the LLM can
 * use them as visual cues when identifying where the signature
 * starts.
 *
 * What we still strip (noise, no info value for marker detection):
 *   • <script>, <style>, <head> contents — CSS/JS bloat
 *   • MSO XML conditionals (<!--[if gte mso]...-->)
 *   • Tracking pixels (<img> with tiny dimensions)
 *   • base64 data: image src attributes (replaced with a short
 *     placeholder so the LLM sees an <img> tag but not the 50KB
 *     of base64 inside it)
 *
 * What we keep:
 *   • All semantic tags (<p>, <div>, <span>, <a>, <table>, <ul>, etc.)
 *   • Inline styles (small, may carry signature/quote signals)
 *   • Class names (specifically helpful for signature detection:
 *     gmail_signature, OutlookMessageHeader, moz-signature, etc.)
 *   • Visible text content
 */
function prepareHtmlForMarkerLLM(rawBody: string): string {
  if (!rawBody) return '';
  // Cheap regex-only pass — DOM-parse round-trip is overkill for
  // this and risks the DOMParser dropping <body>'s style attr we
  // want preserved.
  let out = rawBody;
  // <head>...</head>
  out = out.replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, '');
  // <style>...</style>
  out = out.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
  // <script>...</script>
  out = out.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  // MSO conditionals
  out = out.replace(/<!--\[if[\s\S]{0,4096}?<!\[endif\]-->/gi, '');
  // HTML comments
  out = out.replace(/<!--[\s\S]*?-->/g, '');
  // Base64 image src → image-cache ref (sarv-image:HASH). The full
  // base64 payload is stored in memory; the LLM sees a short ref
  // (~25 bytes vs 5-50KB of base64), preserves it verbatim per the
  // prompt, and the renderer's resolveRefsInHtml swaps it back to
  // the data URL before injecting into the iframe. Saves tokens
  // AND lets content images survive the round-trip — without this,
  // images returned by the LLM as "[base64-image]" placeholders
  // never render and look broken.
  out = out.replace(
    /<img\b([^>]*?)src\s*=\s*("|')(data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+)\2([^>]*)>/gi,
    (_full, before: string, quote: string, dataUrl: string, after: string) => {
      const ref = registerImage(dataUrl);
      return `<img${before}src=${quote}${ref}${quote}${after}>`;
    },
  );
  // Collapse runs of whitespace to single space, but preserve
  // newlines around block-level tags (signal for the LLM).
  out = out.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n');
  return out.trim();
}

/**
 * Decide whether to run Phase 1 (multi-message split) on the OLDEST
 * email in the thread. Any oldest email with quoted history is a
 * candidate — it likely contains at least one earlier message
 * embedded as quoted text (a reply with the original below, a
 * forward with the original below, a looped-in-late multi-level
 * chain). Phase 1 LLM decides how many messages to break it into.
 *
 * The earlier multi-signal voting classifier was too restrictive:
 * a simple "Re:" reply with one quoted message didn't trigger
 * Phase 1, so the embedded earlier message got stripped by Phase 2
 * and lost — the bubble showed only the reply text and the
 * original was gone. Now: just check hasQuotedHistory. Cost is one
 * extra LLM call per thread (only for the oldest email), worth it
 * to preserve embedded earlier messages.
 */
export function classifyCompressedThread(email: EmailRecord): boolean {
  const rawBody = email.rawBody || email.cleanBody || '';
  return hasQuotedHistory(rawBody);
}

/**
 * Ask the LLM to return the CLEANED HTML body — sender's new content
 * only, signatures + quoted history + disclaimers stripped. Returns
 * { body, truncated } (truncated=true when the response had to be
 * salvaged from a cut-off output — caller marks the bubble partial),
 * or null on LLM failure.
 *
 * Replaces the marker-based approach: markers worked for simple cases
 * but failed on Outlook's deeply-nested empty containers (we'd cut
 * visible text but leave 60KB of HTML scaffolding behind) and on
 * threads where whitespace/HTML rendering made the marker text
 * non-substring (e.g. "ann@ example.com" with stray space from rendering).
 * A full rewrite lets the LLM restructure the HTML so the output is
 * actually concise.
 *
 * Grounding: after the LLM returns, we strip both input and output to
 * plain visible text and require the output text to be a (close)
 * substring of the input. Catches paraphrase / hallucination. If the
 * check fails we discard the output and fall back to the heuristic
 * slicer.
 */
async function aiExtractCleanedBody(
  email: EmailRecord,
  onStatus?: (s: string) => void,
): Promise<{ body: string; truncated: boolean } | null> {
  const provider = getDefaultProvider();
  if (!provider) return null;
  const rawBody = email.rawBody || email.cleanBody || '';
  if (!rawBody.trim()) return null;
  // Input: HTML with structural cues preserved (signature/quote
  // containers, paragraphs, lists, tables) and noise stripped
  // (CSS/JS/MSO/base64 image payloads).
  let bodyForAI = prepareHtmlForMarkerLLM(rawBody);
  if (!bodyForAI.trim()) return null;
  // Drop deeply-nested quoted history before any blind truncation.
  // The model only needs the boundary (attribution + first-level
  // quote) to know where the sender's new content ends — it does NOT
  // need 20K chars of history-of-history that the prompt tells it to
  // drop anyway. Safe because this pipeline is a REWRITE (the LLM
  // returns the cleaned HTML itself — no marker offsets into the
  // original body exist; see trimDeepQuotedTail docs). Gated on size
  // so short bodies skip the DOMParser round-trip entirely.
  const PHASE2_TRIM_THRESHOLD_CHARS = 8000;
  if (bodyForAI.length > PHASE2_TRIM_THRESHOLD_CHARS) {
    // New-Outlook / OWA replies wrap quoted history in NO container —
    // just an #appendonsend / #divRplyFwdMsg boundary followed by the
    // quoted body as siblings. trimDeepQuotedTail (container-based)
    // can't see it, so a 339KB Outlook thread used to bloat past the
    // 30K hard slice and get marked `partial`. Cut the Outlook reply
    // tail FIRST, then let trimDeepQuotedTail handle any container-
    // nested history that survives (e.g. a mixed Gmail+Outlook chain).
    // Safe for the Phase-2 REWRITE contract — see stripOutlookReplyTail
    // docs; grounding compares against the untrimmed rawBody below.
    bodyForAI = stripOutlookReplyTail(bodyForAI);
    bodyForAI = trimDeepQuotedTail(bodyForAI);
  }
  // Truncate very long bodies to keep within context — for Outlook
  // threads the bottom is almost always quoted history that the LLM
  // would strip anyway. Prefer dropping whole quote containers
  // (deepest first — same utility Phase 1 uses) over a blind slice
  // that can cut the sender's own content mid-tag; blind slice stays
  // as the last resort for quote-free giant bodies.
  const MAX_INPUT_CHARS = 30000;
  if (bodyForAI.length > MAX_INPUT_CHARS) {
    bodyForAI = shrinkByDroppingDeepestQuotes(bodyForAI, MAX_INPUT_CHARS);
    bodyForAI = truncate(bodyForAI, MAX_INPUT_CHARS, '\n[...input truncated]');
  }

  const systemPrompt = `Clean this email body. Input is HTML. Output JSON only: {"body":"<html string>"}.

Your ONLY job is to drop CONTENT that isn't the sender's new message. Do NOT touch styling, attributes, or formatting — the renderer normalizes typography downstream.

DROP these CONTENT blocks:
- Quoted/forwarded history: <blockquote class="gmail_quote">, <div id="OLK_SRC_BODY_SECTION">, <div class="OutlookMessageHeader">, <div id="mail-editor-reference-message-container">, plain Outlook <blockquote>, "On <date>, <name> wrote:" attribution lines, "From: ... Sent: ... To: ..." header blocks, "---------- Forwarded message ----------" banners, "-----Original Message-----" banners.
- The sender's signature block: <div class="gmail_signature">, <div data-smartmail="gmail_signature">, <div id="ms-outlook-mobile-signature">, <table class="moz-signature">, "-- " line, or trailing "Regards,/Thanks,/Best,/Sincerely,\\n<name>\\n<title>\\n<phone>\\n<social handles>". Also drop any images/logos that travel with the signature (company logos, profile photos, social-icon strips, banner GIFs).
- Legal/confidentiality footers: "This email is confidential", "DISCLAIMER:", "NOTICE:", "[**EXTERNAL EMAIL**]" banners, "Sent from my iPhone" mobile tags, MSO conditionals.
- Empty container chrome — if a wrapper <div>/<table> is left holding nothing after stripping, drop it too.

KEEP everything else BYTE-FOR-BYTE:
- Every tag the sender wrote (<p>, <div>, <span>, <strong>, <b>, <em>, <i>, <u>, <a>, <ul>, <ol>, <li>, <table>, <tr>, <td>, <th>, <h1>-<h6>, <pre>, <code>, <img>, <br>, <hr>, <font>).
- Every attribute on those tags VERBATIM — class, id, style="font-size:Xpx;font-family:Foo;color:#abc", data-*, href, src, alt, colspan, rowspan, width, height. Do not strip, normalize, or rewrite a single attribute. The renderer handles typography normalization (font-family, font-size, spacing) at display time.
- The ONLY attribute kind to drop is on* event handlers (onclick, onerror, onload, etc.) for security.
- <img src="sarv-image:HASH"> tags are REAL inline-image references. Preserve VERBATIM where they sit in the content. The HASH portion (8 hex chars) is opaque — copy it exactly. Do not invent new sarv-image refs. Drop sarv-image <img> only if it sits inside the signature block (company logos, social-icon strips).
- Do NOT convert to markdown. Do NOT paraphrase. Do NOT fix typos. Do NOT add or invent content.

If the sender wrote nothing new (e.g. forwarded without comment), return {"body":""}.

The output must be valid JSON: escape " as \\" inside the body string. HTML tags themselves (<p>, <a href="...">) are fine inside JSON strings. Output starts with { and ends with }. No prose, no fences.`;

  // Same tighter budget as Phase 1: 13K-token input cap with a
  // 2.5 chars/token estimator (HTML with class/style attrs tokenizes
  // denser than plain text — 3.5 was over-optimistic and pushed
  // total request past the 32K context limit on dense Outlook
  // threads).
  const MODEL_CONTEXT = 32768;
  const INPUT_TOKEN_CAP = 13000;
  const SAFETY_MARGIN = 1000;
  const CHARS_PER_TOKEN = 2.5;
  const headerOverhead = systemPrompt.length + 200;
  const maxBodyChars = Math.floor(INPUT_TOKEN_CAP * CHARS_PER_TOKEN - headerOverhead);
  if (bodyForAI.length > maxBodyChars) {
    const before = bodyForAI.length;
    // Quote-aware first (drop deepest quote containers), blind slice
    // only when there's nothing quote-shaped left to drop.
    bodyForAI = shrinkByDroppingDeepestQuotes(bodyForAI, maxBodyChars);
    bodyForAI = truncate(bodyForAI, maxBodyChars, '\n[...input truncated to fit context]');
    console.log(`[Conversation] Phase 2: input truncated ${before}→${bodyForAI.length} chars`);
  }
  const inputTokens = Math.ceil((headerOverhead + bodyForAI.length) / CHARS_PER_TOKEN);
  // This is a rewrite task — output ≈ input for a long quote-free
  // email, so a fixed 4096 cap truncated anything bigger and the
  // "repaired" JSON prefix then cached as if complete. Scale the
  // budget with the input estimate (plus slack for JSON escaping),
  // capped like Phase 1 at 16384 and by the remaining context.
  const estimatedOutputTokens = Math.ceil(bodyForAI.length / CHARS_PER_TOKEN) + 512;
  let responseBudget = Math.min(
    Math.max(4096, estimatedOutputTokens),
    16384,
    MODEL_CONTEXT - inputTokens - SAFETY_MARGIN,
  );
  if (responseBudget < 256) responseBudget = 256;

  const userPrompt = `From: ${email.fromName ? `${email.fromName} <${email.fromAddress}>` : email.fromAddress}
Date: ${new Date(email.date * 1000).toISOString()}

${bodyForAI}`;

  let response: string;
  try {
    response = await makeAICompletion({
      systemPrompt,
      userPrompt,
      maxTokens: responseBudget,
      responseFormat: 'json_object',
      onStatus,
    });
  } catch (err) {
    console.warn('[Conversation] Body-rewrite LLM call failed:', err);
    return null;
  }
  if (!response) return null;

  const parsed = parseJsonResponse(response);
  // Read synchronously after the parse — no await in between.
  const wasTruncated = lastParseRepairedTruncation;
  if (!parsed || typeof parsed !== 'object' || typeof parsed.body !== 'string') {
    console.warn('[Conversation] Body-rewrite response unparseable', { response_head: response.slice(0, 200) });
    return null;
  }

  const out = unescapeDoubleEscapedLLMBody(parsed.body);
  if (!out.trim()) {
    // LLM claims "no new content". Sanity-check against the
    // heuristic slicer before trusting it — branded Outlook
    // signatures (logo tables, social-icon strips) + legal
    // disclaimer footers + dense quoted history occasionally trip
    // the LLM into stripping the visible top content too. If the
    // heuristic finds any meaningful text, prefer the heuristic
    // output (caller treats null as LLM failure → heuristic path)
    // so the user at least sees the new content even if some
    // signature noise leaks through.
    try {
      const heur = sliceBodyHeuristic(rawBody);
      const heurText = heur
        .replace(/<[^>]*>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (heurText.length >= 3) {
        console.warn(
          `[Conversation] LLM returned empty but heuristic found "${heurText.slice(0, 80)}" for ${email.id} — falling through to heuristic`,
        );
        return null;
      }
    } catch { /* heuristic failed — accept LLM empty */ }
    // Both empty — accept "no new content (forwarded without comment)".
    return { body: '', truncated: wasTruncated };
  }

  // Grounding check: every word in the output's visible text should
  // appear somewhere in the input's visible text. If the LLM
  // hallucinated or paraphrased, this catches it.
  const stripToText = (s: string) => s
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

  const inputText = stripToText(rawBody);
  const outputText = stripToText(out);
  if (outputText.length > 0 && inputText.length > 0) {
    // Token-overlap heuristic: fraction of output words that appear
    // in input. 0.7+ = solid grounding. Below 0.5 = likely
    // hallucination — discard.
    const outWords = outputText.split(' ').filter(w => w.length >= 4);
    if (outWords.length > 0) {
      let hits = 0;
      for (const w of outWords) if (inputText.includes(w)) hits++;
      const overlap = hits / outWords.length;
      if (overlap < 0.5) {
        console.warn(
          `[Conversation] Body-rewrite grounding too low (${Math.round(overlap * 100)}%) for ${email.id} — discarding`,
        );
        return null;
      }
    }
  }

  return { body: out, truncated: wasTruncated };
}


/**
 * Heuristic fallback when the LLM marker call fails. Pure regex —
 * no LLM. Cuts at common quote markers. Less precise than LLM but
 * never silent.
 */
export function sliceBodyHeuristic(html: string): string {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  // CSS selectors for quoted-history wrappers + signature blocks.
  // Covers Gmail, Outlook (desktop + mobile), Mozilla/Thunderbird,
  // Apple Mail.
  const sigSelectors = [
    // Quoted history wrappers
    'blockquote.gmail_quote',
    '.gmail_quote_container',
    '.gmail_attr',
    'blockquote[type="cite"]',
    'div.OutlookMessageHeader',
    'div#OLK_SRC_BODY_SECTION',
    'div#mail-editor-reference-message-container',
    'div.moz-cite-prefix',
    // Plain <blockquote> is almost always a quoted reply in
    // Outlook (no class attr). Drop it.
    'blockquote',
    // Signature blocks
    '.gmail_signature',
    '[data-smartmail="gmail_signature"]',
    'div.moz-signature',
    'div#ms-outlook-mobile-signature',
    'div[id*="signature" i]',
    'div.AppleMailSignature',
  ];
  for (const sel of sigSelectors) {
    try { doc.body.querySelectorAll(sel).forEach(el => el.remove()); } catch { /* skip */ }
  }

  // Drop the legal/confidentiality disclaimer footer. Convention:
  // an <hr> followed by boilerplate ("contents of this e-mail",
  // "confidential", "DISCLAIMER", "privileged"). Remove the <hr>
  // and everything after it when the trailing text matches.
  try {
    const hrs = Array.from(doc.body.querySelectorAll('hr'));
    for (const hr of hrs) {
      // Collect text from siblings after this <hr>.
      const tail: string[] = [];
      let n: ChildNode | null = hr.nextSibling;
      while (n) {
        tail.push(n.textContent || '');
        n = n.nextSibling;
      }
      const tailText = tail.join(' ').toLowerCase();
      if (
        /\b(confidential|privileged|disclaimer|intended recipient|notify the sender|delete it from|virus|external (?:e-?mail|sender))\b/.test(tailText)
      ) {
        // Walk forward and remove every sibling after this <hr>.
        let next: ChildNode | null = hr.nextSibling;
        while (next) {
          const toRemove = next;
          next = next.nextSibling;
          toRemove.parentNode?.removeChild(toRemove);
        }
        hr.remove();
        break; // one disclaimer per email is the norm
      }
    }
  } catch { /* skip */ }

  // Regex-cut on common markers in the remaining HTML.
  const cleaned = doc.body.innerHTML
    .replace(/<div[^>]*>\s*On\s+[^<]{4,200}\s+wrote\s*:[\s\S]*$/i, '')
    .replace(/<p[^>]*>\s*On\s+[^<]{4,200}\s+wrote\s*:[\s\S]*$/i, '')
    .replace(/On\s+[^\n<]{4,200}\s+wrote\s*:[\s\S]*$/i, '')
    .replace(/----+\s*Forwarded message\s*----+[\s\S]*$/i, '')
    .replace(/-----\s*Original Message\s*-----[\s\S]*$/i, '')
    // Outlook header block: "From: ... Sent: ... To: ... Subject: ..."
    .replace(/<div[^>]*>\s*From:\s*[\s\S]*?Subject:\s*[\s\S]*$/i, '')
    .replace(/From:\s*[^\n<]{2,200}\s*(?:Sent|Date):\s*[\s\S]*$/i, '')
    // Outlook underscore separator that precedes a quoted "From:/Sent:/On …" header.
    .replace(/_{10,}[\s\S]{0,400}?(?:From:|Sent:|Date:|On\s)[\s\S]*$/i, '')
    // Full "From: … Sent/Date: … To: …" header where tags (<br>/<div>) separate
    // the fields, so the [^\n<] variant above can't span them. Requiring To:
    // keeps it from cutting a legitimate mention of "From:".
    .replace(/From:[\s\S]{0,200}?(?:Sent|Date):[\s\S]{0,200}?To:[\s\S]*$/i, '');

  return cleaned;
}

/**
 * Per-email extraction (replaces Phase 2). Pipeline:
 *   1. Look up cached signature marker for sender → if matches body,
 *      slice deterministically. No LLM call.
 *   2. Otherwise ask LLM for markers (1 small call).
 *   3. Slice body by markers.
 *   4. Cache signatureStart for this sender (future emails skip the
 *      LLM).
 *   5. If LLM fails entirely → heuristic regex slice (deterministic
 *      fallback; marks bubble as `partial` for the cache).
 *
 * Returns { body, partial } where partial=true means we used the
 * heuristic fallback (less precise than LLM cleanup).
 */
/**
 * Per-email extraction. The LLM rewrites the body to keep only the
 * sender's new content (signatures, quoted history, disclaimers
 * stripped). On LLM failure → heuristic regex slice as a fallback.
 *
 * Returns { body, partial } where partial=true means we used the
 * heuristic fallback (LLM unreachable / output failed grounding) OR
 * the LLM output was salvaged from a truncated response (half the
 * email may be missing — don't cache as complete).
 */
async function extractEmailContent(
  email: EmailRecord,
  onStatus?: (s: string) => void,
): Promise<{ body: string; partial: boolean; failed: boolean }> {
  const rawBody = email.rawBody || email.cleanBody || '';
  if (!rawBody.trim()) return { body: '', partial: false, failed: false };

  const cleaned = await aiExtractCleanedBody(email, onStatus);
  if (cleaned !== null) {
    // Defensive X1/X2/X3 post-processing — the LLM is INSTRUCTED to
    // drop attributions/quote-wrappers/signatures but provably leaks
    // them (owner screenshots); the deterministic cleanup catches
    // whatever slipped through. A truncated result still has AI content, so
    // it counts as partial (thread-level) but NOT failed (per-message).
    return { body: cleanExtractedBody(cleaned.body), partial: cleaned.truncated, failed: false };
  }

  // Fallback: deterministic regex slice of known quote/signature
  // patterns. Less precise than LLM but never silent — this is a genuine
  // per-message AI failure, so flag it for the bubble's retry affordance.
  console.warn(`[Conversation] Body-rewrite LLM failed for ${email.id} — using heuristic slice`);
  return { body: cleanExtractedBody(sliceBodyHeuristic(rawBody)), partial: true, failed: true };
}

/**
 * Re-extract a single message — used by the per-message refresh button.
 * Forces a fresh LLM call.
 */
export async function reExtractSingleMessage(
  _messageId: string,
  email: EmailRecord,
): Promise<{ body: string; failed: boolean }> {
  const { body, failed } = await extractEmailContent(email);
  return { body, failed };
}

// ========== Main Extraction Logic ==========

/**
 * Module-level in-flight dedup, keyed by threadId. Three independent
 * callers can race the same thread (useEmailDetail's effects, the
 * store's autoExtractRecentConversations, the background batch
 * listener) — without this each fires its own round of LLM calls and
 * the cache writes race. Non-force callers JOIN the pending promise;
 * a forceRefresh waits for the pending run to settle first, then runs
 * fresh (so its cache write lands last).
 */
const inFlightExtractions = new Map<string, Promise<ConversationResult>>();

/**
 * Extract conversation messages from a thread.
 * Uses AI to parse quoted content and deduplicate.
 * Supports incremental updates (only processes new emails).
 */
export async function extractConversation(
  threadId: string,
  emails: EmailRecord[],
  _currentUserEmail: string,
  options: ExtractConversationOptions = {},
): Promise<ConversationResult> {
  const pending = inFlightExtractions.get(threadId);
  if (pending) {
    if (!options.forceRefresh) {
      // Joiners attach to the pending promise — they get the final
      // result but NOT the in-flight run's onProgress callbacks
      // (acceptable: only the initiating caller drives the UI).
      console.log(`[Conversation] Extraction already in flight for ${threadId} — joining pending run`);
      return pending;
    }
    // Forced refresh: let the in-flight run finish (its cache write
    // would otherwise race ours), then start the fresh run below.
    console.log(`[Conversation] Force refresh for ${threadId} — waiting for in-flight run to settle first`);
    await pending.catch(() => { /* previous run's failure is its caller's concern */ });
  }
  const run = doExtractConversation(threadId, emails, _currentUserEmail, options).finally(() => {
    if (inFlightExtractions.get(threadId) === run) inFlightExtractions.delete(threadId);
  });
  inFlightExtractions.set(threadId, run);
  return run;
}

/**
 * True when a cached extraction should be discarded because its garbled bubbles
 * were extracted from a body the reheal has since repaired (see
 * `cacheHasHealedMojibake`). Parses the cached messages defensively.
 */
function isCacheStaleFromHeal(cached: ConversationCacheRow, bodiedEmails: EmailRecord[]): boolean {
  try {
    const messages = JSON.parse(cached.messages) as ConversationMessage[];
    return cacheHasHealedMojibake(messages, bodiedEmails);
  } catch {
    return false;
  }
}

async function doExtractConversation(
  threadId: string,
  emails: EmailRecord[],
  _currentUserEmail: string,
  options: ExtractConversationOptions = {},
): Promise<ConversationResult> {
  const provider = getDefaultProvider();
  if (!provider) {
    throw new Error('No AI provider configured');
  }

  if (emails.length === 0) {
    return { messages: [], fromCache: false, partial: false };
  }

  // Sort emails chronologically
  const sortedEmails = [...emails].sort((a, b) => a.date - b.date);

  // Guard: bodies arrive asynchronously over IMAP after a thread
  // opens. If extraction fires before bodies land, every email's
  // rawBody is empty, every bubble caches as "no new content", and
  // the cache then claims those emails are "processed" so the user
  // is stuck with 17× "No new content" forever. Filter out emails
  // whose body hasn't arrived yet — only process the ones we
  // actually have content for. Skipped emails stay UNprocessed in
  // the cache, so the next extraction run (after their bodies land)
  // picks them up as incremental.
  const bodiedEmails = sortedEmails.filter(e =>
    ((e.rawBody || '').trim().length > 0) || ((e.cleanBody || '').trim().length > 0),
  );
  if (bodiedEmails.length < sortedEmails.length) {
    const missing = sortedEmails.length - bodiedEmails.length;
    console.log(
      `[Conversation] ${missing}/${sortedEmails.length} email bodies not yet downloaded — extracting only the ${bodiedEmails.length} with content; skipped emails will run on next pass`,
    );
  }
  if (bodiedEmails.length === 0) {
    // Nothing to extract. Don't write the cache (we'd lock the
    // thread into "processed but empty"). Return empty and let the
    // caller re-trigger once at least one body arrives.
    console.warn('[Conversation] Skipping extraction — no email bodies are loaded yet');
    return { messages: [], fromCache: false, partial: true };
  }

  // Check cache (skip when forceRefresh — user clicked the refresh
  // icon and explicitly wants a fresh run).
  if (options.forceRefresh) {
    const { messages, partial } = await processFullThread(bodiedEmails, options.onProgress);
    const allProcessedIds = bodiedEmails.map(e => e.id);
    // Same as the normal save path below: if any thread emails were
    // skipped for missing bodies, keep the partial marker so the
    // missing-body indicator survives a manual refresh.
    const wasIncomplete = bodiedEmails.length < sortedEmails.length;
    await saveConversationCache(threadId, messages, allProcessedIds, provider.name, partial || wasIncomplete);
    return { messages, fromCache: false, partial: partial || wasIncomplete };
  }
  try {
    // T2: when the caller already fetched the cache row (useEmailDetail
    // reads it for the warm-open shortcut), reuse it instead of a
    // second identical IPC round-trip. cachedHint.row === null means
    // "caller read it: confirmed miss/stale" — go straight to
    // extraction below.
    let cachedRow: ConversationCacheRow | null;
    if (options.cachedHint) {
      cachedRow = options.cachedHint.row;
    } else {
      const cacheResult = await window.electronAPI.ai.getConversation(threadId);
      cachedRow = cacheResult.success && cacheResult.data ? cacheResult.data : null;
    }
    // Drop a cache whose garbled bubbles were extracted from a body the reheal has
    // since repaired — otherwise the ID-keyed cache serves stale mojibake forever.
    if (cachedRow && isCacheStaleFromHeal(cachedRow, bodiedEmails)) {
      console.log('[Conversation] Cached extraction has mojibake but the source body is now clean — re-extracting from the repaired body');
      cachedRow = null;
    }
    if (cachedRow) {
      const cached = cachedRow;

      // Invalidate cache from older extraction versions
      const cachedVersion = cached.modelUsed?.includes('|v') ? parseInt(cached.modelUsed.split('|v')[1]) : 0;
      if (cachedVersion < EXTRACTION_VERSION) {
        console.log(`[Conversation] Cache version ${cachedVersion} < ${EXTRACTION_VERSION}, re-extracting`);
      } else {

      const cachedProcessedIds: string[] = JSON.parse(cached.processedEmailIds || '[]');
      // Only consider emails whose bodies are loaded for the
      // incremental decision — unbodied ones are deliberately
      // skipped (see bodiedEmails filter above) so they remain
      // unprocessed and get picked up on a later run.
      const currentEmailIds = bodiedEmails.map(e => e.id);

      // Check if all current emails are already processed
      const newEmailIds = currentEmailIds.filter(id => !cachedProcessedIds.includes(id));

      if (newEmailIds.length === 0) {
        // STRICT mode: every cached email is processed. Just return the
        // cached bubbles (whatever we have). No auto-retry on partial —
        // that just burns LLM calls on emails that already failed once.
        // The user has the amber refresh icon to retry manually.
        const cachedMessages: ConversationMessage[] = JSON.parse(cached.messages);
        // Reconcile the cache against the current thread so a real email that
        // was dropped in an OLD cached extraction reappears on reopen — no full
        // re-extraction needed (the backfill is deterministic, no LLM).
        const reconciled = backfillMissingEmails(cachedMessages, bodiedEmails);
        const wasPartial =
          (cached.modelUsed?.includes('|partial') || false) ||
          reconciled.length !== cachedMessages.length;
        return { messages: reconciled, fromCache: true, partial: wasPartial };
      }

      // Incremental update — process only new emails
      if (cachedProcessedIds.length > 0) {
        const cachedMessages: ConversationMessage[] = JSON.parse(cached.messages);
        const newEmails = bodiedEmails.filter(e => newEmailIds.includes(e.id));
        // T3: announce the run with what's already known (the cached
        // bubbles), then forward each per-email completion merged
        // into the cached set — same merge as the final result below,
        // so progressive snapshots and the final list are identical
        // in shape and order.
        const { onProgress } = options;
        onProgress?.({
          messages: [...cachedMessages].sort((a, b) => a.date - b.date),
          done: 0,
          total: newEmails.length,
        });
        const { messages: incrementalMessages, partial: incPartial } = await processNewEmails(
          newEmails,
          onProgress
            ? (u) => onProgress({
                messages: mergeIncrementalMessages(cachedMessages, u.messages),
                done: u.done,
                total: u.total,
                status: u.status,
              })
            : undefined,
        );
        const allMessages = mergeIncrementalMessages(cachedMessages, incrementalMessages);

        // Save updated cache — preserve previous partial marker if it was set
        const wasPartial = cached.modelUsed?.includes('|partial') || false;
        const allProcessedIds = [...cachedProcessedIds, ...newEmailIds];
        const mergedPartial = wasPartial || incPartial;
        await saveConversationCache(threadId, allMessages, allProcessedIds, provider.name, mergedPartial);

        return { messages: allMessages, fromCache: false, partial: mergedPartial };
      }
    } // end version check else
    }
  } catch (err) {
    console.warn('[Conversation] Cache lookup failed, doing full extraction:', err);
  }

  // Full extraction
  const { messages, partial } = await processFullThread(bodiedEmails, options.onProgress);

  // Save to cache — only bodied emails count as "processed". The
  // unbodied ones stay out of processedEmailIds so they trigger
  // incremental extraction when their bodies arrive.
  const allProcessedIds = bodiedEmails.map(e => e.id);
  // If any thread emails were skipped due to missing bodies, mark
  // the result partial so the UI reflects "not everything processed
  // yet".
  const wasIncomplete = bodiedEmails.length < sortedEmails.length;
  await saveConversationCache(threadId, messages, allProcessedIds, provider.name, partial || wasIncomplete);

  return { messages, fromCache: false, partial: partial || wasIncomplete };
}

interface FullThreadResult {
  messages: ConversationMessage[];
  partial: boolean; // true if a Phase 2 per-email LLM call fell back to DOM cleaning
}

/**
 * Tokenize HTML/text/markdown into a set of >=4-char lowercase
 * alphanumeric tokens. Used to compare AI output against source to
 * detect hallucinated or rewritten content.
 *
 * Important: we deliberately do NOT strip HTML tags before tokenizing.
 * Stripping `<a href="https://example.com">click</a>` would lose the
 * URL ("https", "example") from the source set, while markdown's
 * `[click](https://example.com)` keeps them — the AI's body would
 * then look like it contains words not in the source and trip the
 * grounding guard. By tokenizing the raw input, attribute values
 * (href, src, etc.) contribute their own words to the source set,
 * matching how the markdown form decomposes.
 *
 * The cost is HTML structural words ("href", "class", "style",
 * "width") leak into the source set. They're harmless: they bloat
 * source.size but never match anything in a normal markdown body, so
 * the overlap fraction (candidate ∩ source / candidate.size) is
 * unaffected.
 */
// Note: tokenOverlap / CONTENT_INTEGRITY_THRESHOLD removed in v20.
// The marker-based pipeline doesn't rewrite bodies, so the
// "did the LLM hallucinate content?" grounding check is no longer
// needed. The slicing operation is byte-deterministic on the
// original HTML.

/**
 * Minimum signature length (visible chars) for a prefix match to count
 * as a duplicate. Two short husks ("Hi", "Thanks") from the same sender
 * are almost certainly DIFFERENT messages, so we only prefix-merge when
 * the shorter signature is at least this long. Exact-equal signatures
 * dedup at any length (identical text is identical).
 */
const DEDUP_MIN_PREFIX_CHARS = 40;
const DEDUP_SIGNATURE_CHARS = 200;

/**
 * Normalized content signature for cross-bubble dedup: lowercase the
 * visible text (HTML tags stripped, entities loosely decoded,
 * whitespace collapsed) and take the first ~200 chars. Two messages
 * with the same signature are the same message regardless of which
 * email quoted it or what timestamp the attribution carried.
 */
function contentSignature(body: string): string {
  return (body || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .slice(0, DEDUP_SIGNATURE_CHARS);
}

/**
 * Rank a message for "which duplicate to KEEP" — higher wins:
 *   2 — bound to a REAL email id (not 'extracted-…'): stable id, exact
 *       date, survives backfill/re-extract by-id lookups.
 *   1 — has a RELIABLE date (non-synthetic, non-zero): sorts correctly.
 *   0 — everything else (synthetic/unknown date, extracted id).
 */
function dedupKeepRank(m: ConversationMessage): number {
  if (!m.id.startsWith('extracted-')) return 2;
  if (m.date !== 0 && !m.dateApprox) return 1;
  return 0;
}

/**
 * Content-signature cross-bubble dedup. The (sender, near-date) dedup
 * elsewhere in this file catches the common case, but MISSES repeats
 * where the date heuristic can't help: a message quoted in two emails
 * with DIFFERENT attribution timestamps, or a Phase-1 bubble carrying a
 * synthetic (dateApprox) date that's excluded from date-matching by
 * design. Here we collapse those: two messages are duplicates when they
 * share a `fromAddress` (lowercased) AND their content signatures are
 * equal, OR one signature is a prefix of the other and the shorter is
 * at least DEDUP_MIN_PREFIX_CHARS long (the length guard stops two
 * genuinely different short messages from the same sender — "ok",
 * "thanks" — from collapsing).
 *
 * When a duplicate group is found we KEEP the highest-ranked member
 * (real-id > reliable-date > first) and drop the rest. This runs IN
 * ADDITION to the (sender,date) dedup, never replaces it, and never
 * merges two different messages (the ≥40-char content-prefix guard).
 * Order is preserved (kept member stays at its earliest position);
 * callers re-sort by date afterwards. All fields on the kept message
 * (sourceEmailId, isExtracted, dateApprox) are untouched.
 */
function dedupByContentSignature(messages: ConversationMessage[]): ConversationMessage[] {
  if (messages.length < 2) return messages;
  type Entry = { msg: ConversationMessage; sig: string; idx: number };
  // Group candidate entries by sender. Empty-signature messages can
  // never prefix-match meaningfully (a "" prefix of everything would
  // collapse all empties), so they bypass dedup and are kept as-is.
  const bySender = new Map<string, Entry[]>();
  const keep = new Array<boolean>(messages.length).fill(true);
  messages.forEach((msg, idx) => {
    const sig = contentSignature(msg.body);
    if (!sig) return; // keep; never a dedup participant
    const from = msg.fromAddress.toLowerCase();
    const list = bySender.get(from);
    if (list) list.push({ msg, sig, idx });
    else bySender.set(from, [{ msg, sig, idx }]);
  });

  let removed = 0;
  for (const entries of bySender.values()) {
    if (entries.length < 2) continue;
    // Greedy clustering: for each not-yet-clustered entry, gather all
    // later entries that duplicate it, then keep the best of the group.
    const consumed = new Array<boolean>(entries.length).fill(false);
    for (let i = 0; i < entries.length; i++) {
      if (consumed[i]) continue;
      const group = [entries[i]];
      for (let j = i + 1; j < entries.length; j++) {
        if (consumed[j]) continue;
        const a = entries[i].sig;
        const b = entries[j].sig;
        const dup =
          a === b ||
          (a.length >= DEDUP_MIN_PREFIX_CHARS && b.startsWith(a)) ||
          (b.length >= DEDUP_MIN_PREFIX_CHARS && a.startsWith(b));
        if (dup) { group.push(entries[j]); consumed[j] = true; }
      }
      if (group.length < 2) continue;
      // Pick the winner: highest keep-rank, ties broken by earliest
      // position (stable original order).
      let best = group[0];
      for (const g of group) {
        if (dedupKeepRank(g.msg) > dedupKeepRank(best.msg)) best = g;
        else if (dedupKeepRank(g.msg) === dedupKeepRank(best.msg) && g.idx < best.idx) best = g;
      }
      // Only ever DROP extracted/quoted copies — never a real-email
      // bubble (id not starting with 'extracted-'). Two genuinely
      // separate real emails with identical short bodies ("ok",
      // "thanks") share a signature but are distinct messages the user
      // received; collapsing them would lose a real bubble. This dedup
      // exists to remove the SAME message quoted across emails (the
      // extracted copies), which is exactly what carries an
      // 'extracted-' id.
      for (const g of group) {
        if (g.idx !== best.idx && g.msg.id.startsWith('extracted-')) {
          keep[g.idx] = false;
          removed++;
        }
      }
    }
  }

  if (removed === 0) return messages;
  console.log(`[Conversation] Content-signature dedup: removed ${removed} duplicate bubble(s)`);
  return messages.filter((_, idx) => keep[idx]);
}

/**
 * Main extraction pipeline for a thread. Replaces the old
 * processFullThread + runPhase2OnRemaining + processNewEmails trio.
 *
 * Strategy:
 *   1. The OLDEST email gets classified by static signals
 *      (classifyCompressedThread). If it's a "compressed thread"
 *      (looped-in late, single email carries the whole prior chain),
 *      run Phase 1 LLM split. Otherwise: cleanHtmlForAI, one bubble.
 *      No LLM call for that case — there's nothing to extract from a
 *      thread-starting email.
 *   2. EVERY OTHER email goes through marker-based extraction
 *      (extractEmailContent): LLM identifies cut-points, we slice
 *      the HTML deterministically, preserving formatting byte-for-byte
 *      before the cut.
 *
 * Returns { messages, partial }. Partial=true means at least one
 * email fell back to heuristic regex slicing (LLM unreachable).
 */
/**
 * Safety net: guarantee every bodied thread email is represented by a bubble.
 * Standard view always shows every email, but the AI extraction/split/dedup
 * logic can occasionally drop one (over-eager cross-source or content-signature
 * dedup, or a failed split) — which made a real email vanish from chat view
 * while still visible in standard view. Any email with no bubble at all (neither
 * as a bubble's id nor as a bubble's source) is backfilled with the
 * deterministic heuristic slice, flagged extractionFailed so the user can retry
 * AI on just that message. Drafts are skipped (they aren't conversation bubbles).
 * Returns the same array reference when nothing was missing.
 */
function backfillMissingEmails(
  messages: ConversationMessage[],
  emails: EmailRecord[],
): ConversationMessage[] {
  const represented = new Set<string>();
  for (const m of messages) {
    represented.add(m.id);
    represented.add(m.sourceEmailId);
  }
  const missing = emails.filter(
    (e) =>
      !represented.has(e.id) &&
      !!(e.rawBody || e.cleanBody) &&
      !(e.tags || '').includes('|draft|'),
  );
  if (missing.length === 0) return messages;
  const backfilled: ConversationMessage[] = missing.map((e) => {
    console.warn(`[Conversation] Email ${e.id} had no bubble after extraction — backfilling into chat view`);
    return {
      id: e.id,
      fromAddress: e.fromAddress,
      fromName: e.fromName,
      toAddress: e.toAddress || '',
      date: e.date,
      body: cleanExtractedBody(sliceBodyHeuristic(e.rawBody || e.cleanBody || '')),
      isExtracted: true,
      sourceEmailId: e.id,
      extractionFailed: true,
    };
  });
  return [...messages, ...backfilled].sort((a, b) => a.date - b.date);
}

async function processThread(
  sortedEmails: EmailRecord[],
  onProgress?: ConversationProgressCallback,
): Promise<FullThreadResult> {
  const allMessages: ConversationMessage[] = [];
  const handledIds = new Set<string>();
  let partial = false;

  // T3 progress plumbing. `total` covers every email in this run;
  // emails handled without their own LLM call (Phase-1 matches, dedup
  // skips) move `done` forward in one jump. `extra` carries the
  // worker pool's not-yet-merged bubbles so snapshots are complete.
  const total = sortedEmails.length;
  let done = 0;
  const emitProgress = (extra: ConversationMessage[] = [], status?: string) => {
    if (!onProgress) return;
    onProgress({
      messages: [...allMessages, ...extra].sort((a, b) => a.date - b.date),
      done: Math.min(done, total),
      total,
      status,
    });
  };
  // Status sink for the oldest-email LLM calls (the pool below wires
  // its own through extractEmailsPooled).
  const oldestStatus = onProgress ? (s: string) => emitProgress([], s) : undefined;
  emitProgress(); // extraction starts: done=0, nothing assembled yet

  const oldest = sortedEmails[0];
  if (oldest) {
    if (classifyCompressedThread(oldest)) {
      // Looped-in late: oldest email contains the whole prior
      // conversation as embedded forward/quote. Phase 1 split.
      let split: Awaited<ReturnType<typeof aiSplitFirstEmail>> = null;
      try {
        split = await aiSplitFirstEmail(
          oldest,
          oldestStatus,
          sortedEmails.map(e => ({ address: e.fromAddress, name: e.fromName })),
        );
      } catch (err) {
        console.warn(`[Conversation] Phase 1 LLM call failed for ${oldest.id}:`, err);
      }
      if (split && split.messages.length > 0) {
        // Salvaged-from-truncation splits may be missing trailing
        // messages — don't let the cache claim completeness.
        if (split.truncated) partial = true;
        // Pass A — intra-split dedup + bind each part to a real
        // thread email by (sender, near-date). dateApprox (synthetic)
        // dates are treated exactly like date-unknown here: they
        // never dedup-match and never bind (X5).
        const candidates: { msg: SplitMessage; matched?: EmailRecord }[] = [];
        for (const msg of split.messages) {
          const fromAddrLc = (msg.fromAddress || '').toLowerCase();
          const msgDate = msg.date || 0;
          const reliableDate = msgDate !== 0 && !msg.dateApprox;
          // Intra-split dedup: if the LLM/DOM-walk returned the same
          // person at the same time twice (rare but happens with
          // deeply-quoted forwards that loop back), skip the dup.
          // Unknown/synthetic dates never match — keep the message.
          const already = reliableDate && candidates.some(c =>
            (c.msg.date || 0) !== 0 && !c.msg.dateApprox &&
            (c.msg.fromAddress || '').toLowerCase() === fromAddrLc &&
            Math.abs((c.msg.date || 0) - msgDate) < 60,
          );
          if (already) continue;
          // Bind to a real thread email by (sender, near-date).
          // Attribution dates lack timezone → use the wide
          // extracted-vs-real tolerance. An unknown or SYNTHETIC
          // date binds to nothing — never treat it as a wildcard.
          const matchedEmail = !reliableDate ? undefined : sortedEmails.find(e =>
            e.fromAddress.toLowerCase() === fromAddrLc &&
            Math.abs(e.date - msgDate) < EXTRACTED_MATCH_TOLERANCE_S
          );
          candidates.push({ msg, matched: matchedEmail });
        }
        // Pass B — X6: when several parts bind to the SAME real email
        // (one email = its own new content + the history it quotes,
        // all from the same sender minutes apart), ONLY the newest
        // part (last in oldest-first order) keeps the real id; the
        // history parts get synthetic 'extracted-' ids. Duplicate ids
        // broke React keys and the re-extract by-id lookup.
        const lastPartForEmail = new Map<string, number>();
        candidates.forEach((c, i) => {
          if (c.matched) lastPartForEmail.set(c.matched.id, i);
        });
        candidates.forEach((c, i) => {
          const ownsRealId = !!c.matched && lastPartForEmail.get(c.matched.id) === i;
          allMessages.push({
            id: ownsRealId ? c.matched!.id : `extracted-${oldest.id.slice(-8)}-${allMessages.length}`,
            fromAddress: c.msg.fromAddress,
            fromName: c.msg.fromName,
            toAddress: c.msg.toAddress || c.matched?.toAddress || '',
            // The part representing the email's own content snaps to
            // the exact email date (attribution parses round to the
            // minute); other parts keep their parsed/synthetic date.
            date: ownsRealId ? c.matched!.date : (c.msg.date || 0),
            ...(c.msg.dateApprox && !ownsRealId ? { dateApprox: true } : {}),
            body: c.msg.body,
            isExtracted: true,
            sourceEmailId: c.matched?.id || oldest.id,
          });
          if (c.matched) handledIds.add(c.matched.id);
        });
        handledIds.add(oldest.id);
        console.log(`[Conversation] Phase 1: compressed thread → split ${oldest.id} into ${split.messages.length} message(s)`);
      } else {
        partial = true;
        console.warn(`[Conversation] Phase 1 produced no messages for ${oldest.id} — marking partial`);
      }
    } else {
      // Regular original email. Show the raw body (preserves
      // branded chrome, inline styles, layout shells) BUT still run
      // signature trim — the user wants signatures cut everywhere,
      // including the first email of a thread.
      //
      // extractEmailContent asks the LLM for signature/quote/
      // disclaimer markers. For an original (no quoted history) the
      // quotedHistoryStart will be empty; only signatureStart fires.
      // The slicer cuts the signature block off the bottom of the
      // raw body, keeping all the formatting above intact.
      const { body, partial: emailPartial, failed: emailFailed } = await extractEmailContent(oldest, oldestStatus);
      if (emailPartial) partial = true;
      allMessages.push({
        id: oldest.id,
        fromAddress: oldest.fromAddress,
        fromName: oldest.fromName,
        toAddress: oldest.toAddress || '',
        date: oldest.date,
        body,
        isExtracted: true,
        sourceEmailId: oldest.id,
        ...(emailFailed ? { extractionFailed: true } : {}),
      });
      handledIds.add(oldest.id);
    }
  }

  // Oldest (and any Phase-1-matched emails) are accounted for.
  done = handledIds.size;
  emitProgress();

  // Every other email → marker-based extraction, run through a small
  // worker pool (extractEmailsPooled, concurrency 3) instead of one
  // serial await per email. The dedup decisions are computed in a
  // pre-pass: a bubble's (fromAddress, date) come from the email
  // record — never from the LLM output — so the skip set for email N
  // depends only on Phase-1 bubbles plus earlier accepted emails,
  // all known up front. This is what makes parallel extraction safe
  // while preserving the old serial loop's semantics exactly.
  const pendingEmails: EmailRecord[] = [];
  // X5: synthetic (dateApprox) dates are sorting-only — they must
  // never dedup-match a real email, so they're excluded here exactly
  // like a 0 (unknown) date would be.
  const seen = allMessages
    .filter(m => !m.dateApprox && m.date !== 0)
    .map(m => ({ from: m.fromAddress.toLowerCase(), date: m.date }));
  for (const email of sortedEmails) {
    if (handledIds.has(email.id)) continue;
    // Cross-source dedup with NEAR-date tolerance. Phase 1 split
    // dates often round to the minute (parsed from "On May 11 at
    // 5:14 PM") while real-email dates are second-precise — exact
    // match misses, and we end up with the same message appearing
    // twice (once from the actual email row, once from a quoted
    // chain that another email embedded).
    const fromLc = email.fromAddress.toLowerCase();
    const dup = seen.some(m => m.from === fromLc && Math.abs(m.date - email.date) < 60);
    handledIds.add(email.id);
    if (dup) continue;
    pendingEmails.push(email);
    seen.push({ from: fromLc, date: email.date });
  }
  // Dedup skips count as handled too.
  done = total - pendingEmails.length;

  const { messages: pooled, partial: poolPartial } = await extractEmailsPooled(pendingEmails, {
    useCircuitBreaker: true,
    onUpdate: onProgress
      ? (u) => {
          done = (total - pendingEmails.length) + u.done;
          emitProgress(u.messages, u.status);
        }
      : undefined,
  });
  if (poolPartial) partial = true;
  allMessages.push(...pooled);

  // Final content-signature dedup. The (sender,date) pre-pass above
  // already dropped near-date repeats; this catches the ones the date
  // heuristic can't — the SAME message quoted in several emails with
  // different attribution timestamps, or a Phase-1 bubble whose
  // synthetic date is excluded from date-matching by design. Runs on
  // the fully-assembled set, before the final sort so order is stable.
  const deduped = dedupByContentSignature(allMessages);
  // Never let a real email silently vanish from chat view (see helper).
  const reconciled = backfillMissingEmails(deduped, sortedEmails);
  if (reconciled.length !== deduped.length) partial = true;
  reconciled.sort((a, b) => a.date - b.date);
  return { messages: reconciled, partial };
}

// Phase-2 worker-pool width. 3 keeps the LLM gateway comfortably under
// per-client burst limits while cutting a long thread's serial
// extraction latency roughly 3×.
const EXTRACTION_CONCURRENCY = 3;

/**
 * Run extractEmailContent over `emails` through a small worker pool.
 *
 * Results come back in INPUT order regardless of completion order —
 * assembled by index. `onUpdate` fires after each completion (done
 * counts completions, not positions) and on AI-layer status events
 * (rate-limit waits / retries), each time with the bubbles completed
 * so far in input order.
 *
 * Circuit breaker (full-thread path only — the incremental path never
 * had one): if 3 CONSECUTIVE extractions fall back to the heuristic
 * (LLM unreachable / gateway timing out) — counted in completion
 * order, reset by any success — stop launching new LLM calls and give
 * every not-yet-started email the deterministic heuristic slice,
 * marking the run partial, exactly like the serial loop did. Calls
 * already in flight when the breaker trips are left to finish.
 * Avoids hammering a dead gateway with N more doomed requests when we
 * already know it's down.
 */
async function extractEmailsPooled(
  emails: EmailRecord[],
  opts: {
    useCircuitBreaker: boolean;
    onUpdate?: (u: { messages: ConversationMessage[]; done: number; status?: string }) => void;
  },
): Promise<{ messages: ConversationMessage[]; partial: boolean }> {
  const results: (ConversationMessage | undefined)[] = new Array(emails.length);
  let partial = false;
  let consecutiveFallbacks = 0;
  let llmDown = false;
  let nextIndex = 0;
  let completed = 0;

  const toMessage = (email: EmailRecord, body: string, failed: boolean): ConversationMessage => ({
    id: email.id,
    fromAddress: email.fromAddress,
    fromName: email.fromName,
    toAddress: email.toAddress || '',
    date: email.date,
    body,
    isExtracted: true,
    sourceEmailId: email.id,
    ...(failed ? { extractionFailed: true } : {}),
  });
  const snapshot = () => results.filter((m): m is ConversationMessage => m !== undefined);
  const emit = (status?: string) =>
    opts.onUpdate?.({ messages: snapshot(), done: completed, status });
  const onStatus = opts.onUpdate ? (s: string) => emit(s) : undefined;

  const worker = async () => {
    // Single-threaded JS: the read-and-increment of nextIndex has no
    // await between check and claim, so two workers can't grab the
    // same index.
    while (nextIndex < emails.length) {
      const i = nextIndex++;
      const email = emails[i];
      let emailBody: string;
      let emailPartial: boolean;
      let emailFailed: boolean;
      if (llmDown) {
        // Gateway looks dead — skip the LLM call entirely, just use
        // the heuristic slice (same X1/X2/X3 cleanup as every other
        // bubble body). Bubble shows up; cache marked partial. Flagged
        // failed so each skipped message offers a per-message retry.
        emailBody = cleanExtractedBody(sliceBodyHeuristic(email.rawBody || email.cleanBody || ''));
        emailPartial = true;
        emailFailed = true;
      } else {
        const res = await extractEmailContent(email, onStatus);
        emailBody = res.body;
        emailPartial = res.partial;
        emailFailed = res.failed;
        if (opts.useCircuitBreaker) {
          if (emailPartial) {
            consecutiveFallbacks++;
            if (consecutiveFallbacks >= 3 && !llmDown) {
              console.warn('[Conversation] 3 consecutive LLM fallbacks — circuit-breaker tripped, using heuristic for remaining emails');
              llmDown = true;
            }
          } else {
            consecutiveFallbacks = 0;
          }
        }
      }
      if (emailPartial) partial = true;
      results[i] = toMessage(email, emailBody, emailFailed);
      completed++;
      emit();
    }
  };

  const width = Math.min(EXTRACTION_CONCURRENCY, emails.length);
  if (width > 0) {
    await Promise.all(Array.from({ length: width }, () => worker()));
  }
  return { messages: snapshot(), partial };
}

/** Compat alias — `extractConversation` still calls processFullThread. */
const processFullThread = processThread;

/**
 * Send the first email's body to the LLM with a simple "split into
 * messages" prompt. Returns the parsed message array, or null on
 * failure. No hallucination guards — trust the LLM's output verbatim.
 *
 * The body is cleaned lightly: images stripped, links flattened to
 * their text, CSS / class / id / tracking-attribute noise removed.
 * Quoted/forwarded structure is PRESERVED so the LLM can see it.
 */
// Quote-history container selectors shared by the body-shrink utilities
// below. Match ANY blockquote — Outlook outputs plain
// <blockquote style="..."> with no class or type, so the gmail_quote /
// type="cite" selectors miss them entirely and the shrink used to leave
// 137KB Outlook bodies un-shrunk. Plus the known Gmail / Outlook /
// Mozilla container classes (defensive — catches threads that mix
// providers).
const QUOTE_CONTAINER_SELECTOR = [
  'blockquote',
  'div.gmail_quote_container',
  'div.gmail_quote',
  'div.OutlookMessageHeader',
  'div#OLK_SRC_BODY_SECTION',
  'div#mail-editor-reference-message-container',
  'div.moz-cite-prefix',
  // New-Outlook / OWA reply scaffolding. The reply-header block is
  // <div id="divRplyFwdMsg"> ("From: … Sent: … To: …") and the empty
  // <div id="appendonsend"></div> marks where the composer split new
  // content from quoted history. When such a body is itself quoted
  // inside ANOTHER email, Outlook sanitizes the ids to an `x_` prefix
  // (x_divRplyFwdMsg, x_appendonsend) — match both. Attribute-prefix
  // selectors (^=) catch any numeric suffixes Outlook appends.
  '[id^="divRplyFwdMsg"]',
  '[id^="x_divRplyFwdMsg"]',
  'div#appendonsend',
  '[id^="appendonsend"]',
  '[id^="x_appendonsend"]',
].join(', ');

/**
 * Phase-2 input trim: drop quote containers NESTED inside another
 * quote container ("history of history"), keeping each first-level
 * quote intact.
 *
 * Why this is safe for the Phase-2 contract: the v25 pipeline is a
 * REWRITE — the LLM returns the cleaned HTML itself (see
 * aiExtractCleanedBody), so there are no marker offsets referencing
 * positions in the original body that trimming could invalidate. The
 * model still needs to SEE the boundary between new content and the
 * quoted tail (the "On X wrote:" attribution + the first-level quote
 * container) to know where the sender's content ends — both survive.
 * Inline-reply content the sender wrote INSIDE the first-level quote
 * survives too; only level-2+ containers go, and those are by
 * definition quoted history the prompt instructs the model to DROP.
 * The grounding check is also unaffected (it compares output against
 * the untrimmed rawBody).
 *
 * Returns the input string untouched when nothing nested was found —
 * avoids a needless DOMParser round-trip of the body (which would lose
 * <body>-level attrs prepareHtmlForMarkerLLM deliberately preserves).
 */
function trimDeepQuotedTail(html: string): string {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  const all = Array.from(doc.body.querySelectorAll(QUOTE_CONTAINER_SELECTOR));
  let removed = 0;
  for (const el of all) {
    // Skip nodes already detached with a removed ancestor.
    if (!doc.body.contains(el)) continue;
    let cur = el.parentElement;
    while (cur && cur !== doc.body) {
      if (cur.matches(QUOTE_CONTAINER_SELECTOR)) {
        el.remove();
        removed++;
        break;
      }
      cur = cur.parentElement;
    }
  }
  if (removed === 0) return html;
  const out = doc.body.innerHTML;
  console.log(`[Conversation] Phase 2: dropped ${removed} nested quote container(s), ${html.length}→${out.length} chars`);
  return out;
}

// Matches an Outlook header block's leading text — "From: … Sent: …"
// or "From: … Subject: …" — used to confirm a bare <hr> actually
// precedes a quoted-reply header (and isn't a decorative rule inside
// the sender's own content).
const OUTLOOK_HEADER_TEXT_RE = /^\s*from\s*:[\s\S]{0,400}?(sent|subject)\s*:/i;
// Cheap pre-gate so quote-free bodies skip the DOMParser round-trip
// entirely (same optimization trimDeepQuotedTail relies on). Either an
// Outlook reply marker id (optionally x_-prefixed when nested) or any
// <hr> is enough to be worth parsing.
const OUTLOOK_TAIL_HINT_RE = /id=["']?(x_)?(appendonsend|divRplyFwdMsg)|<hr\b/i;

/**
 * Phase-2 input trim for NEW-Outlook / OWA replies. The desktop/web
 * Outlook composer does NOT wrap quoted history in a <blockquote> or
 * a gmail_quote-style container — it emits the new content, then an
 * empty `<div id="appendonsend"></div>` boundary, an `<hr>`, a
 * `<div id="divRplyFwdMsg">From: … Sent: … To: …</div>` header, and
 * then the quoted body as FOLLOWING SIBLINGS of that header (not its
 * children). So the existing container-based trimmers
 * (trimDeepQuotedTail / shrinkByDroppingDeepestQuotes) see nothing to
 * drop and the whole quoted chain bloats the LLM input until the hard
 * 30K slice cuts the email and marks it `partial`.
 *
 * This finds the FIRST boundary marker in document order:
 *   1. an element matching #appendonsend / [id^="appendonsend"] /
 *      [id^="x_appendonsend"], OR
 *   2. an element matching #divRplyFwdMsg / [id^="divRplyFwdMsg"] /
 *      [id^="x_divRplyFwdMsg"], OR
 *   3. an <hr> whose next ELEMENT sibling (skipping whitespace text)
 *      begins with an Outlook header ("From: …" then "Sent:"/"Subject:").
 * From that boundary it removes the node AND every following sibling,
 * then walks up to each ancestor and removes ITS following siblings
 * too, until it reaches <body>. Net effect: everything visually below
 * the boundary — the entire quoted tail — is dropped, regardless of how
 * the quoted body is nested relative to the boundary.
 *
 * Why this is safe for the Phase-2 contract (same reasoning as
 * trimDeepQuotedTail): Phase 2 is a REWRITE — the LLM returns the
 * cleaned HTML itself, so there are NO marker offsets into the original
 * body that trimming could invalidate. The model's whole job here is to
 * keep only the sender's NEW content and drop quoted history; cutting
 * at the boundary just hands it a body that already excludes the tail.
 * Grounding still compares the LLM output against the UNTRIMMED rawBody
 * (aiExtractCleanedBody holds rawBody separately), so a legitimate
 * substring can never be flagged as hallucination because we trimmed it.
 *
 * NOT used in Phase 1 — Phase 1 KEEPS quoted history and splits it into
 * bubbles, so it must never see this cut.
 *
 * Returns the input untouched when no boundary is found (and skips the
 * DOMParser entirely when the cheap hint regex doesn't fire).
 */
function stripOutlookReplyTail(html: string): string {
  if (!html) return html;
  // Cheap bail: no Outlook reply markers and no <hr> at all → nothing
  // this function can act on. Avoids a DOMParser round-trip on the
  // common (Gmail / plain) body shapes.
  if (!OUTLOOK_TAIL_HINT_RE.test(html)) return html;

  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  const body = doc.body;
  if (!body) return html;

  // Walk the whole subtree in document order and pick the FIRST node
  // that qualifies as a boundary. The id-marker check is direct; the
  // <hr> check requires the next element sibling to look like an
  // Outlook header so we don't cut at a decorative horizontal rule the
  // sender put inside their own message.
  const ID_BOUNDARY =
    '#appendonsend, [id^="appendonsend"], [id^="x_appendonsend"], ' +
    '#divRplyFwdMsg, [id^="divRplyFwdMsg"], [id^="x_divRplyFwdMsg"]';

  // Gather visible text from the nodes that follow `el` (its later
  // siblings, in order), skipping pure-whitespace, up to ~400 chars.
  // Covers both shapes Outlook emits after the <hr>: a wrapping
  // <div id="divRplyFwdMsg"> element, or a bare "From: …" text run.
  const followingText = (el: Element): string => {
    const parts: string[] = [];
    let n: ChildNode | null = el.nextSibling;
    while (n && parts.join('').length < 400) {
      const t = n.textContent || '';
      if (t.trim() !== '') parts.push(t);
      n = n.nextSibling;
    }
    return parts.join(' ');
  };

  let boundary: Element | null = null;
  // TreeWalker gives strict document order across the whole subtree.
  const walker = doc.createTreeWalker(body, 0x1 /* SHOW_ELEMENT */);
  let cur: Node | null = walker.currentNode === body ? walker.nextNode() : walker.currentNode;
  while (cur) {
    const el = cur as Element;
    if (el.matches(ID_BOUNDARY)) { boundary = el; break; }
    // A bare <hr> is only a boundary when an Outlook header
    // ("From: … Sent:"/"Subject:") immediately follows it — otherwise
    // it's a decorative rule inside the sender's own content.
    if (el.tagName === 'HR' && OUTLOOK_HEADER_TEXT_RE.test(followingText(el))) {
      boundary = el; break;
    }
    cur = walker.nextNode();
  }

  if (!boundary) return html;

  // Remove the boundary node and everything visually after it. Starting
  // at the boundary, drop the boundary itself plus all its following
  // siblings; then climb to each ancestor and drop only ITS following
  // siblings (the ancestor is KEPT — it holds the sender's new content
  // ABOVE the boundary). Repeat up to <body>. This handles both the
  // flat case (boundary + quoted divs are body-level siblings) and the
  // nested case (boundary sits inside a wrapper whose later siblings
  // hold the quoted body).
  const dropFollowing = (node: ChildNode) => {
    // Snapshot first — the live sibling chain shifts as we remove.
    const toRemove: ChildNode[] = [];
    let sib: ChildNode | null = node.nextSibling;
    while (sib) { toRemove.push(sib); sib = sib.nextSibling; }
    for (const s of toRemove) s.remove();
  };
  const node: ChildNode | null = boundary;
  // First step removes the boundary's following siblings AND the
  // boundary node itself.
  dropFollowing(node);
  const firstParent: Node | null = node.parentNode;
  node.remove();
  // Then climb: each ancestor keeps itself, loses only what follows it.
  let ancestor: ChildNode | null =
    firstParent && firstParent !== body ? (firstParent as ChildNode) : null;
  while (ancestor && ancestor !== body) {
    const parent: Node | null = ancestor.parentNode;
    dropFollowing(ancestor);
    ancestor = parent && parent !== body ? (parent as ChildNode) : null;
  }

  const out = body.innerHTML;
  console.log(`[Conversation] Phase 2: stripped Outlook reply tail at <${boundary.tagName.toLowerCase()}${boundary.id ? ` id="${boundary.id}"` : ''}>, ${html.length}→${out.length} chars`);
  return out;
}

/**
 * Shrink an HTML body to fit a character budget by dropping the
 * deepest nested quote containers first. Used by Phase 1 when an
 * oldest-email body is so long it would exceed the LLM context, and
 * by Phase 2 as the quote-aware step before any blind truncation.
 *
 * Strategy: find every quote container (QUOTE_CONTAINER_SELECTOR),
 * sort by DOM depth descending, remove the deepest one, re-measure.
 * Repeat until either:
 *   • innerHTML ≤ maxChars (return shrunken body), or
 *   • no more quote containers left (return whatever's left — caller
 *     may decide to bail out and use Phase 2 instead).
 *
 * Why deepest-first: the oldest embedded messages carry the least
 * information for an in-progress thread. Dropping them keeps the
 * top-level new content + the immediately preceding reply intact.
 */
function shrinkByDroppingDeepestQuotes(html: string, maxChars: number): string {
  if (html.length <= maxChars) return html;
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  const querySelector = QUOTE_CONTAINER_SELECTOR;

  function depthOf(el: Element): number {
    let d = 0;
    let cur: Element | null = el.parentElement;
    while (cur && cur !== doc.body) { d++; cur = cur.parentElement; }
    return d;
  }

  let pass = 0;
  while (doc.body.innerHTML.length > maxChars && pass < 50) {
    const quotes = Array.from(doc.body.querySelectorAll(querySelector));
    if (quotes.length === 0) break;
    // Sort deepest first.
    quotes.sort((a, b) => depthOf(b) - depthOf(a));
    quotes[0].remove();
    pass++;
  }
  return doc.body.innerHTML;
}

export type SplitMessage = {
  fromAddress: string;
  fromName: string | null;
  toAddress: string;
  date: number;
  /** See ConversationMessage.dateApprox — synthetic, sorting-only date. */
  dateApprox?: boolean;
  body: string;
};

// ========== Split-body post-processing (X1 attribution / X2 unwrap / X3 signatures) ==========

/**
 * Parsed "On <date>, <name> <email> wrote:" attribution header.
 * `from` is '' when no address could be recovered (the caller may
 * resolve it against the thread's sender roster by name).
 */
interface ParsedAttribution {
  from: string;
  name: string | null;
  date: number;
}

/**
 * Recover the sender address from an attribution line.
 *
 * Three sources, in order:
 *   1. The visible text ("… Name <addr@host> wrote:" — Gmail encodes
 *      the brackets as &lt;/&gt; so the address survives in text).
 *   2. The element's raw HTML (mailto: hrefs).
 *   3. The Sarv-webmail MANGLED form: the composer emits
 *      `Name <pkh@<a href="https://sarv.com">sarv.com</a>> wrote:`
 *      with an UNESCAPED `<pkh@` — the HTML parser eats it as a bogus
 *      tag name, so textContent loses the local part entirely
 *      ("Pooja Khatri sarv.com> wrote:"). The serialized HTML still
 *      carries the bogus tag, so we stitch the address back together
 *      from the tag name + the domain link's text.
 */
function extractEmailFromAttribution(text: string, rawHtml: string): string {
  const tm = text.match(/([\w.+-]+@[\w-]+\.[\w.-]+)/);
  if (tm) return tm[1].toLowerCase().replace(/[.,;]+$/, '');
  const hm = rawHtml.match(/(?:mailto:)?([\w.+-]+@[\w-]+\.[\w.-]+)/i);
  if (hm) return hm[1].toLowerCase().replace(/[.,;]+$/, '');
  const mm = rawHtml.match(/<([\w.+-]+)@<a\b[^>]*>(?:\s|<[^>]*>)*([\w-]+(?:\.[\w-]+)+)/i);
  if (mm) return `${mm[1]}@${mm[2]}`.toLowerCase();
  return '';
}

/**
 * Parse an "On <date>, <name> <email> wrote:" attribution into
 * { from, name, date }. Unlike the old inline version this NEVER
 * requires the email to be present (mangled Sarv attributions lose
 * it — see extractEmailFromAttribution) and parses the date with
 * explicit format patterns instead of comma-position guessing.
 *
 * `requireWrote: false` additionally accepts attribution lines whose
 * trailing "wrote:" was destroyed by the tag-mangling — callers must
 * only use it for elements that are POSITIVELY attribution-shaped
 * (e.g. class="gmail_attr").
 *
 * Returns null when no attribution marker is found at all.
 */
function parseAttribution(
  text: string,
  rawHtml = '',
  opts: { requireWrote?: boolean } = {},
): ParsedAttribution | null {
  const norm = (text || '').replace(/\s+/g, ' ').trim();
  if (!norm) return null;
  let block: string | null = null;
  const m = norm.match(/\bOn\s+(.{4,300}?)\s*\bwrote\s*:/i);
  if (m) {
    block = m[1];
  } else if (opts.requireWrote === false) {
    const m2 = norm.match(/^On\s+(.{4,300})$/i);
    if (m2) block = m2[1];
  }
  if (block === null) return null;

  const from = extractEmailFromAttribution(block, rawHtml);

  // Date — explicit patterns for the formats seen in the wild:
  //   "Wed, Jun 10, 2026 at 5:11 PM"  (Gmail/Apple, weekday optional)
  //   "11 May 2025 at 17:14"          (European)
  //   "2026-06-12T16:57"              (ISO-ish)
  let date = 0;
  const dm =
    block.match(/\b((?:[A-Za-z]{3,9},?\s+)?[A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4}(?:\s+at)?\s+\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AP]\.?M\.?)?)/i) ||
    block.match(/\b(\d{1,2}\s+[A-Za-z]{3,9}\.?,?\s+\d{4}(?:\s+at)?\s+\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AP]\.?M\.?)?)/i) ||
    block.match(/\b(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?)/);
  if (dm) date = parseHumanDateToEpochSec(dm[1]) ?? 0;
  if (date === 0) {
    // The explicit patterns above only catch textual-month formats; feed the
    // whole attribution block to chrono (day-first) to also catch numeric
    // "07/08/2026"-style dates and anything else the patterns miss.
    date = parseHumanDateToEpochSec(block) ?? 0;
  }

  // Name — text between the date and the email (or whatever is left
  // of the block once date/emails/domains are stripped).
  let name: string | null = null;
  const emailIdx = from ? block.toLowerCase().indexOf(from) : -1;
  if (emailIdx > 0) {
    let nm = block.slice(0, emailIdx).replace(/[<>]/g, '').trim().replace(/^[,\s]+|[,\s]+$/g, '');
    if (dm && nm.startsWith(dm[1])) nm = nm.slice(dm[1].length).replace(/^[,\s]+/, '');
    if (nm.length >= 2 && nm.length <= 80) name = nm;
  }
  if (!name) {
    let rest = dm ? block.replace(dm[1], ' ') : block;
    rest = rest
      .replace(/[\w.+-]+@[\w.-]+/g, ' ')          // emails out
      .replace(/\b[\w-]+(?:\.[\w-]+)+\b/g, ' ')   // bare domains out ("sarv.com>")
      .replace(/\bwrote\b/gi, ' ')
      .replace(/[<>,:]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (rest.length >= 2 && rest.length <= 80) name = rest;
  }

  return { from, name, date };
}

/**
 * Leading-attribution regexes for the DEFENSIVE body cleanup
 * (cleanExtractedBody) — built from the formats parseAttribution
 * understands. Two variants:
 *   • wrote-terminal: the element's whole text is "On … wrote:".
 *   • am/pm (no "wrote:"): mangled Sarv attributions lose the
 *     trailing "> wrote:" along with the eaten address tag. To avoid
 *     false-positives on real sentences ("On Monday we will meet")
 *     this variant additionally requires a 4-digit year AND a time,
 *     and is only applied to elements that are positively
 *     attribution-shaped (.gmail_attr / followed by a quote container).
 */
const ATTRIBUTION_WROTE_TERMINAL_RE = /^On\s.{4,300}?\bwrote\s*:?\s*$/is;
const ATTRIBUTION_AMPM_RE = /^On\s(?=.{0,200}\b(?:19|20)\d{2}\b)(?=.{0,200}\d{1,2}:\d{2}).{4,260}\b(?:am|pm)\b.{0,120}$/is;

/** Quote containers cleanExtractedBody unwraps when they wrap the whole body. */
const UNWRAP_QUOTE_SELECTOR = [
  'blockquote',
  'div.gmail_quote',
  'div.gmail_quote_container',
  'div#OLK_SRC_BODY_SECTION',
  'div#mail-editor-reference-message-container',
].join(', ');

/**
 * Final cleanup applied to EVERY extracted bubble body (Phase-1 split
 * parts from both the DOM and LLM paths, Phase-2 cleaned bodies, and
 * heuristic fallback slices):
 *
 *   X1 — strip a LEADING "On <date>, <name> wrote:" attribution
 *        header that leaked into the body.
 *   X2 — unwrap <blockquote>/.gmail_quote containers that wrap the
 *        ENTIRE content (recursively), so the bubble shows plain
 *        content instead of a nested quote box.
 *   X3 — strip signature blocks: explicit small selectors unguarded;
 *        id/class*="signature" wrappers only when text < 500 chars
 *        (same guard as ai-service's stripSignaturesSimple); plus
 *        plain-text "--" delimiter + short trailing contact block.
 *
 * Content images are preserved — only images travelling inside an
 * identified signature container / "--" tail are removed with it.
 */
export function cleanExtractedBody(html: string): string {
  if (!html || !html.trim()) return html || '';
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(html, 'text/html');
  } catch {
    return html;
  }
  const body = doc.body;
  if (!body) return html;

  const isIgnorableNode = (n: Node): boolean => {
    if (n.nodeType === 3) return !(n.textContent || '').replace(/\u00a0/g, ' ').trim();
    if (n.nodeType !== 1) return true; // comments, PIs…
    const el = n as Element;
    const tag = el.tagName;
    if (tag === 'BR' || tag === 'HR') return true;
    if ((el.textContent || '').replace(/\u00a0/g, ' ').trim()) return false;
    return !el.querySelector('img, table, iframe');
  };
  const meaningfulChildren = (el: Element): Node[] =>
    Array.from(el.childNodes).filter(n => !isIgnorableNode(n));

  const isQuoteContainer = (el: Element): boolean => {
    try { return el.matches(UNWRAP_QUOTE_SELECTOR); } catch { return false; }
  };
  const containsQuoteStructure = (el: Element): boolean =>
    !!el.querySelector('blockquote, .gmail_quote, .gmail_quote_container');

  // ── X1 + X2 interleaved to a fixpoint ──
  // Typical LLM-leaked shape: <div class="gmail_quote"><div class=
  // "gmail_attr">On … wrote:</div><blockquote>CONTENT</blockquote></div>
  // needs: unwrap gmail_quote → strip gmail_attr → unwrap blockquote.
  for (let pass = 0; pass < 8; pass++) {
    let changed = false;

    // X1: leading attribution element. Walk the chain of first
    // meaningful children (the attribution may sit nested inside
    // styled wrappers) — small elements only, so a wrapper holding
    // real content can never be misread as an attribution.
    let cur: Node | undefined = meaningfulChildren(body)[0];
    while (cur && cur.nodeType === 1) {
      const el = cur as Element;
      const text = (el.textContent || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
      if (text.length > 0 && text.length <= 350) {
        let isAttrClass = false;
        try { isAttrClass = el.matches('.gmail_attr, .moz-cite-prefix'); } catch { /* skip */ }
        const next = el.nextElementSibling;
        const beforeQuote = !!next && (isQuoteContainer(next) || containsQuoteStructure(next));
        const wroteHit = ATTRIBUTION_WROTE_TERMINAL_RE.test(text);
        const ampmHit = (isAttrClass || beforeQuote) && ATTRIBUTION_AMPM_RE.test(text);
        if (wroteHit || ampmHit) {
          el.remove();
          changed = true;
          break;
        }
      }
      cur = meaningfulChildren(el)[0];
    }

    // X2: body (or the current level) wholly wrapped in a quote
    // container — unwrap it. Also unwrap a single generic div/span
    // wrapper when quote structure hides inside it, so a nested
    // <div><blockquote>…</blockquote></div> still unwraps.
    const kids = meaningfulChildren(body);
    if (kids.length === 1 && kids[0].nodeType === 1) {
      const only = kids[0] as Element;
      const generic = (only.tagName === 'DIV' || only.tagName === 'SPAN') && containsQuoteStructure(only);
      if (isQuoteContainer(only) || generic) {
        while (only.firstChild) body.insertBefore(only.firstChild, only);
        only.remove();
        changed = true;
      }
    }

    if (!changed) break;
  }

  // ── X3a: signature containers (guarded selector strip — local
  // equivalent of ai-service's stripSignaturesSimple) ──
  for (const selector of SIGNATURE_DOM_SELECTORS) {
    try { body.querySelectorAll(selector).forEach(el => el.remove()); } catch { /* skip */ }
  }
  for (const selector of SIGNATURE_MAYBE_SELECTORS) {
    try {
      body.querySelectorAll(selector).forEach(el => {
        if ((el.textContent || '').trim().length < 500) el.remove();
      });
    } catch { /* skip */ }
  }
  try {
    // .gmail_signature_prefix is Gmail's "-- " marker span — it rides
    // OUTSIDE the .gmail_signature container, so the selector pass
    // above leaves it behind.
    body.querySelectorAll('.gmail_extra, .gmail_signature_prefix, div.moz-signature, table.moz-signature, div#ms-outlook-mobile-signature')
      .forEach(el => el.remove());
  } catch { /* skip */ }

  // ── X3c: trailing legal/confidentiality footer ──
  // Corporate footers ("This E-mail message is private and
  // confidential … delete the message …") often run 600+ chars, which
  // keeps the "--" tail rule below from firing. Remove a TRAILING
  // element that is wholly a disclaimer: it must (a) sit at the
  // trailing edge (last meaningful node, descending through wrappers),
  // (b) START with boilerplate phrasing, and (c) contain ≥2 distinct
  // disclaimer signals — a content paragraph that merely mentions
  // "confidential" can't match, and a wrapper holding real content +
  // the footer fails (b) so we descend into it instead.
  const DISCLAIMER_SIGNALS: RegExp[] = [
    /\bconfidential(?:ity)?\b/i,
    /intended (?:recipient|solely)/i,
    /hereby notified/i,
    /disseminat(?:e|ion)/i,
    /delete (?:the|this) (?:message|e-?mail)/i,
    /\bprivileged\b/i,
    /\bdisclaimer\b/i,
    /no liability|accepts? no (?:liability|responsibility)/i,
    /views (?:expressed|of the author)/i,
    /\bvirus(?:es)?\b/i,
  ];
  const isDisclaimerBlock = (text: string): boolean => {
    if (text.length < 120) return false;
    if (!/^(?:this (?:e-?mail|email|message|communication)|disclaimer|email disclaimer|confidentiality notice|notice:|the (?:information|contents?) (?:of|contained|in))/i.test(text)) return false;
    let hits = 0;
    for (const re of DISCLAIMER_SIGNALS) if (re.test(text)) hits++;
    return hits >= 2;
  };
  const tryRemoveTrailingDisclaimer = (): boolean => {
    let cur: Element | null = body;
    for (let depth = 0; depth < 12 && cur; depth++) {
      const mk = meaningfulChildren(cur);
      if (mk.length === 0) return false;
      const last = mk[mk.length - 1];
      if (last.nodeType !== 1) return false;
      const el = last as Element;
      const text = (el.textContent || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
      if (isDisclaimerBlock(text)) {
        el.remove();
        return true;
      }
      cur = el;
    }
    return false;
  };
  for (let guard = 0; guard < 4 && tryRemoveTrailingDisclaimer(); guard++) { /* repeat — stacked footers */ }

  // ── X3b: plain-text "--" signature delimiter ──
  // A text node that IS the delimiter ("--", optionally "---"),
  // preceded by real content (≥ 20 chars) and followed by a SHORT
  // tail (< 600 chars — name/title/phone lines, logos). Remove the
  // delimiter and everything after it.
  try {
    const walker = doc.createTreeWalker(body, 4 /* NodeFilter.SHOW_TEXT */);
    const textNodes: Text[] = [];
    let tn: Node | null;
    while ((tn = walker.nextNode())) textNodes.push(tn as Text);
    const lenOf = (t: Text) => (t.textContent || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim().length;
    const total = textNodes.reduce((s, t) => s + lenOf(t), 0);
    let before = 0;
    for (const t of textNodes) {
      const trimmed = (t.textContent || '').replace(/\u00a0/g, ' ').trim();
      const isDelim = /^-{2,3}$/.test(trimmed);
      if (isDelim) {
        const after = total - before - trimmed.length;
        if (before >= 20 && after < 600) {
          // Remove every following sibling at each ancestor level,
          // then the delimiter node itself.
          let curN: Node | null = t;
          while (curN && curN !== body) {
            let sib: Node | null = curN.nextSibling;
            while (sib) {
              const nxt: Node | null = sib.nextSibling;
              sib.parentNode?.removeChild(sib);
              sib = nxt;
            }
            curN = curN.parentNode;
          }
          t.parentNode?.removeChild(t);
          break;
        }
      }
      before += lenOf(t);
    }
  } catch { /* defensive — keep body as-is */ }

  // Drop leading/trailing <br>/empty-element runs left by the removals.
  const kids = () => Array.from(body.childNodes);
  let k = kids();
  while (k.length && isIgnorableNode(k[0]) && !(k[0].nodeType === 3 && (k[0].textContent || '').trim())) {
    body.removeChild(k[0]);
    k = kids();
  }
  while (k.length && isIgnorableNode(k[k.length - 1])) {
    body.removeChild(k[k.length - 1]);
    k = kids();
  }

  return body.innerHTML.trim();
}

/**
 * X5 — assign synthetic dates to split parts whose attribution date
 * was unparseable (date === 0). `msgs` MUST be oldest-first. Each
 * 0-dated part gets anchored just BEFORE the next reliably-dated part
 * (or the source email when none follows): anchor − 60s per step,
 * preserving order. Marked dateApprox so no dedup predicate ever
 * matches on the synthetic value.
 */
function assignSyntheticDates(msgs: SplitMessage[], sourceDate: number): void {
  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i].date !== 0) continue;
    let anchor = sourceDate;
    let steps = msgs.length - i;
    for (let j = i + 1; j < msgs.length; j++) {
      if (msgs[j].date > 0 && !msgs[j].dateApprox) {
        anchor = msgs[j].date;
        steps = j - i;
        break;
      }
    }
    msgs[i].date = Math.max(1, anchor - 60 * steps);
    msgs[i].dateApprox = true;
  }
}

/**
 * Shared post-processing for Phase-1 split results (DOM and LLM
 * paths): clean every body (X1/X2/X3), drop parts that became empty
 * chrome, assign synthetic dates (X5), sort oldest-first.
 * `msgs` must arrive oldest-first.
 */
function finalizeSplitMessages(msgs: SplitMessage[], sourceDate: number): SplitMessage[] {
  const cleaned: SplitMessage[] = [];
  for (const m of msgs) {
    const body = cleanExtractedBody(m.body);
    const text = body.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/gi, ' ').trim();
    if (!text && !/<(img|table)\b/i.test(body)) continue; // signature/chrome-only part
    cleaned.push({ ...m, body });
  }
  assignSyntheticDates(cleaned, sourceDate);
  cleaned.sort((a, b) => a.date - b.date);
  return cleaned;
}

/**
 * X4 grounding sanity check for the LLM split path: if a split part's
 * visible text is tiny (< 40 chars) while the blockquote region it
 * came from holds substantially more, the model dropped the middle of
 * the message (restatement loss) — substitute the RAW region
 * (attribution-stripped, then cleanExtractedBody for quote-unwrap +
 * signature strip) instead of caching a husk.
 *
 * Region mapping uses the linear blockquote nesting chain (deepest =
 * oldest message). Only applied when the chain length matches the
 * split exactly (N parts ↔ N−1 nested blockquotes) — anything else is
 * ambiguous and left alone.
 */
function rescueHuskSplitBodies(msgs: SplitMessage[], rawBody: string): void {
  try {
    const doc = new DOMParser().parseFromString(rawBody, 'text/html');
    const chain: Element[] = [];
    let bq: Element | null = doc.body.querySelector('blockquote');
    while (bq) {
      chain.push(bq);
      bq = bq.querySelector('blockquote');
    }
    if (chain.length === 0 || msgs.length !== chain.length + 1) return;
    for (let i = 0; i < msgs.length; i++) {
      const text = msgs[i].body.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim();
      if (text.length >= 40) continue;
      const chainIdx = chain.length - 1 - i; // oldest part ↔ deepest blockquote
      if (chainIdx < 0) continue;            // newest part lives outside the chain
      const region = chain[chainIdx].cloneNode(true) as Element;
      // Drop the deeper history + its attribution from the region —
      // they belong to other parts.
      region.querySelectorAll('blockquote').forEach(el => el.remove());
      region.querySelectorAll('.gmail_attr, .moz-cite-prefix').forEach(el => {
        const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (t.length <= 350 && /^On\s/i.test(t)) el.remove();
      });
      const regionText = (region.textContent || '').replace(/\s+/g, ' ').trim();
      if (regionText.length < 200) continue; // region small too — husk may be legit
      const newBody = cleanExtractedBody(region.innerHTML);
      const newText = newBody.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim();
      if (newText.length >= 40 && newText.length > text.length) {
        console.warn(
          `[Conversation] Phase 1: split part ${i} was a husk (${text.length} chars) while its source region held ${regionText.length} — substituting raw region`,
        );
        msgs[i] = { ...msgs[i], body: newBody };
      }
    }
  } catch { /* defensive — leave split as-is */ }
}

/**
 * Deterministic DOM-based split of a compressed thread, no LLM.
 *
 * Walks the body looking for nested `<blockquote class="gmail_quote">`
 * (Gmail-style) or quote attribution lines like "On <date>, <name>
 * <email> wrote:" / "From: ... Sent:" header blocks. For each boundary
 * it produces one message: the visible text BEFORE the boundary is the
 * current sender's content; the quote content recurses to find deeper
 * messages.
 *
 * Returns at least 2 messages on success (caller treats <2 as failure
 * and falls back to LLM split or a single-bubble extraction).
 *
 * Why deterministic: small models (Sarv Mati Flash) struggle to
 * reliably detect nested quote boundaries in HTML. DOM walking is
 * exact for Gmail/Outlook outputs which dominate the real-world data.
 */
function domSplitFirstEmail(
  rawBody: string,
  sender: { address: string; name: string | null; date: number },
  roster: { address: string; name: string | null }[] = [],
): SplitMessage[] {
  const parser = new DOMParser();
  const doc = parser.parseFromString(rawBody, 'text/html');
  const messages: SplitMessage[] = [];

  // Resolve an attribution with a missing/eaten address against the
  // thread's sender roster by display name ("Jane Doe" →
  // jane.doe@sarv.com). The mangled Sarv attribution loses the local part
  // (see extractEmailFromAttribution) so name is all we have.
  const resolveRoster = (attr: ParsedAttribution): ParsedAttribution => {
    if (attr.from) return attr;
    if (attr.name) {
      const nameLc = attr.name.toLowerCase();
      const hit = roster.find(r => {
        const rn = (r.name || '').toLowerCase().trim();
        return rn.length >= 2 && (nameLc.includes(rn) || rn.includes(nameLc));
      });
      if (hit) return { ...attr, from: hit.address.toLowerCase() };
    }
    return attr;
  };

  type WalkSender = { address: string; name: string | null; date: number };
  type WalkState = { acc: Node[]; pending: ParsedAttribution | null; sender: WalkSender };

  const serializeNode = (n: Node): string => {
    if (n.nodeType === 1) return (n as Element).outerHTML;
    if (n.nodeType === 3) {
      return (n.textContent || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    }
    return '';
  };

  const flush = (state: WalkState) => {
    if (state.acc.length === 0) return;
    const bodyHtml = state.acc.map(serializeNode).join('');
    state.acc.length = 0;
    // Drop empty/whitespace-only chunks (keep image/table-only content).
    const textish = bodyHtml.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();
    if (!textish && !/<(img|table)\b/i.test(bodyHtml)) return;
    messages.push({
      fromAddress: state.sender.address,
      fromName: state.sender.name,
      toAddress: '',
      date: state.sender.date,
      body: bodyHtml,
    });
  };

  // Attribution test — SMALL elements only (≤ 350 text chars), so a
  // wrapper div whose textContent merely CONTAINS "On … wrote:" deep
  // inside can never be misread as an attribution and dropped (that
  // would lose every message nested under it). Generic elements must
  // END with "wrote:"; .gmail_attr/.moz-cite-prefix elements may have
  // lost their "wrote:" to the Sarv tag-mangling, so for those the
  // marker requirement is relaxed (text must still start "On …").
  const tryAttribution = (el: Element): ParsedAttribution | null => {
    const text = (el.textContent || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
    if (!text || text.length > 350) return null;
    let isAttrClass = false;
    try { isAttrClass = el.matches('.gmail_attr, .moz-cite-prefix'); } catch { /* skip */ }
    if (!isAttrClass && !/\bwrote\s*:\s*$/i.test(text)) return null;
    if (isAttrClass && !/^On\s/i.test(text)) return null;
    const parsed = parseAttribution(text, el.outerHTML, { requireWrote: !isAttrClass });
    if (!parsed) return null;
    return resolveRoster(parsed);
  };

  // Transparent quote wrappers: Gmail's <div class="gmail_quote
  // [gmail_quote_container]"> holds [attribution, blockquote] as
  // children; Sarv webmail additionally wraps the WHOLE email in
  // nested styled <div>s. Descend into these (shared accumulator —
  // children are processed as if they sat at the current level)
  // instead of swallowing them wholesale, which is what used to hide
  // every boundary from the splitter and force the LLM path (where
  // shrinkByDroppingDeepestQuotes could then drop the quoted email's
  // actual content — the Thread-A "Dear Advik, + signature" husk).
  const isTransparentWrapper = (el: Element): boolean => {
    const tag = el.tagName;
    if (tag !== 'DIV' && tag !== 'SPAN') return false;
    const cls = el.getAttribute('class') || '';
    if (/\bgmail_quote(?:_container)?\b/.test(cls)) return true;
    try {
      return !!el.querySelector('.gmail_quote, .gmail_attr, blockquote[type="cite"]');
    } catch {
      return false;
    }
  };

  const walkLevel = (container: Element, state: WalkState) => {
    for (const child of Array.from(container.childNodes)) {
      if (child.nodeType === 3) {
        // Bare text node (Sarv/Gmail put salutations directly inside
        // styled wrappers — the old element-only walk dropped them).
        if ((child.textContent || '').replace(/\u00a0/g, ' ').trim()) state.acc.push(child);
        continue;
      }
      if (child.nodeType !== 1) continue;
      const el = child as Element;
      if (el.tagName === 'BLOCKQUOTE') {
        // Boundary: everything accumulated so far belongs to the
        // current sender; the blockquote's content is the next
        // (earlier) message, attributed by the pending header.
        flush(state);
        const attr = state.pending;
        state.pending = null;
        const nextSender: WalkSender = attr
          ? { address: attr.from || 'unknown@unknown', name: attr.name, date: attr.date }
          : { address: 'unknown@unknown', name: null, date: 0 };
        const sub: WalkState = { acc: [], pending: null, sender: nextSender };
        walkLevel(el, sub);
        flush(sub);
        continue;
      }
      const attr = tryAttribution(el);
      if (attr) {
        // X1: the attribution header is a boundary marker, never
        // content — do NOT accumulate it.
        state.pending = attr;
        continue;
      }
      if (isTransparentWrapper(el)) {
        walkLevel(el, state);
        continue;
      }
      state.acc.push(el);
    }
  };

  const top: WalkState = {
    acc: [],
    pending: null,
    sender: { address: sender.address.toLowerCase(), name: sender.name, date: sender.date },
  };
  walkLevel(doc.body, top);
  flush(top);

  // Merge pieces of the SAME message (same sender + same date) — a
  // trailing signature/footer after the quote container flushes as a
  // second top-sender piece; gluing it back keeps "one bubble per
  // message" true. Never merge unknown-sender pieces: two different
  // unparsed-attribution messages would collapse into one.
  const merged: SplitMessage[] = [];
  const byKey = new Map<string, SplitMessage>();
  for (const m of messages) {
    const key = m.fromAddress && m.fromAddress !== 'unknown@unknown' ? `${m.fromAddress}|${m.date}` : null;
    const prev = key ? byKey.get(key) : undefined;
    if (prev) {
      prev.body += m.body;
    } else {
      const copy = { ...m };
      merged.push(copy);
      if (key) byKey.set(key, copy);
    }
  }

  // Walk order is newest-first (top content flushes before the
  // recursion into its quote). Reverse to the pipeline's oldest-first
  // contract — deliberately NOT a date sort here: unparsed (date-0)
  // attributions would jump to the front and lose their true position.
  // finalizeSplitMessages assigns synthetic dates from this order,
  // then date-sorts.
  merged.reverse();
  return merged;
}

export async function aiSplitFirstEmail(
  email: EmailRecord,
  onStatus?: (s: string) => void,
  /**
   * Known thread participants for resolving attribution lines whose
   * address got eaten by the Sarv tag-mangling (name → address).
   * Optional; pass `threadEmails.map(e => ({ address: e.fromAddress,
   * name: e.fromName }))` when available.
   */
  roster: { address: string; name: string | null }[] = [],
): Promise<{
  messages: SplitMessage[];
  /**
   * True when the LLM response had to be salvaged from a truncated
   * output — trailing messages may be missing, so callers should mark
   * their result partial rather than caching it as complete.
   */
  truncated: boolean;
} | null> {
  const rawBody = email.rawBody || email.cleanBody || '';
  if (!rawBody.trim()) return null;

  // Pass 1: deterministic DOM split. Reliable for Gmail-style nested
  // gmail_quote bodies (the most common shape in the wild). If it
  // finds ≥2 messages we trust it — no LLM call needed.
  const domSplit = domSplitFirstEmail(rawBody, {
    address: email.fromAddress,
    name: email.fromName,
    date: email.date,
  }, roster);
  if (domSplit.length >= 2) {
    const finalized = finalizeSplitMessages(domSplit, email.date);
    if (finalized.length >= 2) {
      console.log(`[Conversation] Phase 1 (DOM): split ${email.id} into ${finalized.length} message(s) without LLM`);
      return { messages: finalized, truncated: false };
    }
    // Cleanup collapsed the split (signature/chrome-only parts) —
    // fall through to the LLM pass below.
  }

  // Pass 2: LLM split. Used when DOM walk produced only one message
  // (no recognizable gmail_quote / attribution boundaries) but
  // hasQuotedHistory said something quote-shaped is in there.
  const provider = getDefaultProvider();
  if (!provider) {
    const finalized = finalizeSplitMessages(domSplit, email.date);
    return finalized.length > 0 ? { messages: finalized, truncated: false } : null;
  }
  // Light HTML cleanup that PRESERVES signature/quote DOM containers
  // (gmail_quote, OutlookMessageHeader, moz-cite-prefix, etc.) so the
  // LLM can use them as cues to find message boundaries when splitting
  // a compressed thread. Strips only noise: <head>/<style>/<script>,
  // MSO conditionals, comments, base64 image payloads.
  //
  // Previously this used cleanHtmlForAI(), which strips signature DOM
  // selectors before the LLM ever sees them — removing the very cues
  // Phase 1 needs to detect "From: ... Sent:" blocks and quoted
  // attribution lines. Same fix as the marker LLM path.
  const bodyForAI = prepareHtmlForMarkerLLM(rawBody);
  if (bodyForAI.replace(/<[^>]*>/g, '').trim().length < 100) return null;

  const systemPrompt = `Split this email into individual messages. Input is HTML. Output JSON only: {"messages":[...]}, oldest first.

Each entry: {"from_address": "alice@x.com", "from_name": "Alice" or null, "to_address": "...", "date": "the date/time EXACTLY as written in that message's header, verbatim — copy it character-for-character, do NOT reformat, reorder day/month, or convert to ISO; empty string if none", "body": "<html string>"}.

Rules:
- The user-prompt's From/Date is the LAST entry (newest, on top).
- Each "On X wrote:" / "From: ... Sent:" / "Forwarded message" / "Original Message" marker (or each <blockquote class="gmail_quote"> / plain Outlook <blockquote> / Outlook reply-quote <div>) = one earlier message.
- N markers → N+1 entries.
- from_address is plain "name@domain" — no markdown brackets, no display name.
- body is the sender's VERBATIM HTML for that message — preserve every tag and every attribute (class, id, style, data-*, href, src, alt, colspan, rowspan, etc.) BYTE-FOR-BYTE. The ONLY attribute kind to drop is on* event handlers (onclick, onerror, etc.) for security. The renderer normalizes typography (font-family, font-size, spacing) at display time — DO NOT try to clean styles, classes, or formatting noise.
- body must be COMPLETE: copy EVERY paragraph, list item and table row belonging to that message, from its boundary marker down to the next boundary. Never summarize, never shorten, never skip the middle of a message — a salutation alone is NOT a valid body.
- Do NOT include the "On <date>, <name> wrote:" attribution header (or "From:/Sent:/To:" header lines) in any body — those are boundary markers, not message content.
- Do NOT wrap a body in <blockquote> or quote-container <div>s (gmail_quote etc.) — emit the message's inner content only.
- Do NOT convert to markdown. Do NOT paraphrase. Do NOT fix typos. Drop only the boundary-marker lines and the trailing signature block.
- Content <img> tags must be preserved with their original src (sarv-image: refs, https, data:, cid:) and placed in the body of the message they belong to. Don't invent new ones, don't drop existing ones.
- The output must be valid JSON: escape " as \\" inside string values. HTML tags themselves (<p>, <a href="...">) are fine inside JSON strings.
- Output starts with { and ends with }. No prose, no fences.`;

  // Hard cap on input: 16K tokens (≈ 56K chars at 3.5 chars/token).
  // Model context is 32K total, so capping input here leaves at least
  // 16K for output — long Phase 1 splits with N=10+ messages need
  // that room.
  //
  // For very long bodies (deeply-nested quote chains, VAPT-style
  // threads with 12+ levels of history), we shrink progressively:
  //   1. Try the original body.
  //   2. If too big: drop the DEEPEST blockquote.gmail_quote /
  //      signature containers — preserves the top-level new content
  //      and the closest historical replies while sacrificing the
  //      oldest, lowest-information messages.
  //   3. Repeat until it fits or no more blockquotes left.
  //   4. If still too big after all blockquotes are gone, return
  //      null. Caller (processThread) falls through to Phase 2 for
  //      this email — no split, just clean the visible content.
  // Conservative token estimator. HTML with many class/style attrs
  // tokenizes at ~2.5-3 chars/token (not 3.5 as for plain English).
  // Using 2.5 and a tighter input cap so we never overshoot the
  // 32K model context even with adversarial HTML.
  const MODEL_CONTEXT = 32768;
  const INPUT_TOKEN_CAP = 13000;     // hard cap (was 16384 — slop pushed us over)
  const SAFETY_MARGIN = 1000;        // generous — leaves room for tokenizer variance
  const CHARS_PER_TOKEN = 2.5;
  const headerOverhead = systemPrompt.length + 400;
  const maxBodyChars = Math.floor(INPUT_TOKEN_CAP * CHARS_PER_TOKEN - headerOverhead);
  let finalBody = bodyForAI;
  if (finalBody.length > maxBodyChars) {
    finalBody = shrinkByDroppingDeepestQuotes(finalBody, maxBodyChars);
    if (finalBody.length > maxBodyChars) {
      console.warn(`[Conversation] Phase 1: body ${bodyForAI.length} chars even after dropping nested quotes — skipping split, falling through to Phase 2`);
      return null;
    }
    console.log(`[Conversation] Phase 1: shrunk body ${bodyForAI.length}→${finalBody.length} chars by dropping nested quotes`);
  }
  const inputTokens = Math.ceil((headerOverhead + finalBody.length) / CHARS_PER_TOKEN);
  let responseBudget = Math.min(16384, MODEL_CONTEXT - inputTokens - SAFETY_MARGIN);
  if (responseBudget < 512) responseBudget = 512;

  const userPrompt = `From: ${email.fromName ? `${email.fromName} <${email.fromAddress}>` : email.fromAddress}
To: ${email.toAddress || ''}
Date: ${new Date(email.date * 1000).toISOString()}

${finalBody}`;

  let response: string;
  try {
    response = await makeAICompletion({
      systemPrompt,
      userPrompt,
      maxTokens: responseBudget,
      responseFormat: 'json_object',
      onStatus,
    });
  } catch (err) {
    console.warn('[Conversation] Phase 1 makeAICompletion threw:', err);
    return null;
  }
  if (!response) {
    console.warn('[Conversation] Phase 1 LLM returned empty response');
    return null;
  }

  const parsed = parseJsonResponse(response);
  // Read synchronously after the parse — no await in between.
  const wasTruncated = lastParseRepairedTruncation;
  let arr: any[] | null = null;
  if (Array.isArray(parsed)) arr = parsed;
  else if (parsed && Array.isArray(parsed.messages)) arr = parsed.messages;

  if (!arr) {
    console.warn(
      `[Conversation] Phase 1 LLM response missing "messages" array. ` +
      `Parsed type=${typeof parsed} keys=${parsed && typeof parsed === 'object' ? Object.keys(parsed).join(',') : 'n/a'}. ` +
      `Raw head: ${response.slice(0, 300)}`,
    );
    return null;
  }

  const result: SplitMessage[] = arr.map(m => {
    const dateRaw = m?.date || '';
    // Day-first parse (chrono en.GB), anchored to the source email's date so a
    // numeric "07/08" reads as 7 Aug, not the US July 8.
    const dateSec = parseHumanDateToEpochSec(dateRaw, new Date(email.date * 1000));
    return {
      fromAddress: String(m?.from_address || '').toLowerCase().trim(),
      fromName: m?.from_name ? String(m.from_name) : null,
      toAddress: String(m?.to_address || ''),
      date: dateSec ?? 0,
      // Unescape any double-escaped JSON (literal \" and \n that
      // some models emit instead of real chars). Same fixup as
      // Phase 2 — Outlook .infosys.com / similar HTML bodies tend
      // to provoke this from certain providers.
      body: unescapeDoubleEscapedLLMBody(String(m?.body || '')),
    };
  }).filter(m => m.fromAddress && m.body);

  console.log(
    `[Conversation] Phase 1 LLM returned ${arr.length} entries, ${result.length} kept after filter ` +
    `(needed both from_address AND body). Senders: ${result.map(r => r.fromAddress).join(', ')}`,
  );
  // X1/X2/X3 cleanup FIRST (a husk often hides under a 3KB signature
  // block — only the cleaned text reveals it), then the X4 grounding
  // sanity check: rescue split parts whose cleaned body is a husk
  // (salutation only) while the source region they map to held
  // substantially more text — restatement loss by the model. The
  // rescue reads the ORIGINAL rawBody (not the shrunk LLM input) so
  // content dropped by shrinkByDroppingDeepestQuotes is recoverable.
  const cleanedParts: SplitMessage[] = result.map(m => ({ ...m, body: cleanExtractedBody(m.body) }));
  rescueHuskSplitBodies(cleanedParts, rawBody);
  // Drop empty-chrome parts + X5 synthetic dates + oldest-first sort.
  const finalized = finalizeSplitMessages(cleanedParts, email.date);
  return { messages: finalized, truncated: wasTruncated };
}

/**
 * Incremental extractor: process emails that are NOT in the cache
 * yet. Same per-email pipeline as processThread (now via the shared
 * worker pool), but skips the oldest-email classification (newcomer
 * emails are by definition not the oldest in the thread) and has no
 * circuit breaker — matching the previous serial behavior.
 *
 * `onProgress` here reports the INCREMENTAL messages only (newEmails
 * arrive chronologically sorted, so the snapshot is too) — the caller
 * (doExtractConversation) merges them with the cached bubbles before
 * forwarding to its own onProgress.
 */
async function processNewEmails(
  newEmails: EmailRecord[],
  onProgress?: ConversationProgressCallback,
): Promise<{ messages: ConversationMessage[]; partial: boolean }> {
  return extractEmailsPooled(newEmails, {
    useCircuitBreaker: false,
    onUpdate: onProgress
      ? (u) => onProgress({ messages: u.messages, done: u.done, total: newEmails.length, status: u.status })
      : undefined,
  });
}

/**
 * Merge incremental bubbles into the cached ones. IMAP backfill can
 * deliver an email whose content Phase 1 already produced as an
 * EXTRACTED bubble (synthetic 'extracted-' id) — REPLACE that bubble
 * with the real email's bubble (real email wins: exact date, stable
 * id). Never dedup two real emails: rapid-fire sends from the same
 * sender are distinct. Returns a NEW sorted array, inputs untouched —
 * the T3 progress snapshots and the final merge share this helper.
 */
function mergeIncrementalMessages(
  cachedMessages: ConversationMessage[],
  incrementalMessages: ConversationMessage[],
): ConversationMessage[] {
  const mergedMessages = [...cachedMessages];
  for (const inc of incrementalMessages) {
    const incFromLc = inc.fromAddress.toLowerCase();
    const dupIdx = mergedMessages.findIndex(
      m => m.id.startsWith('extracted-') &&
        m.fromAddress.toLowerCase() === incFromLc &&
        m.date !== 0 &&
        // X5: a synthetic (dateApprox) date is sorting-only — it must
        // never date-match a backfilled real email (false dedup would
        // overwrite a legitimately distinct history bubble).
        !m.dateApprox &&
        Math.abs(m.date - inc.date) < EXTRACTED_MATCH_TOLERANCE_S,
    );
    if (dupIdx !== -1) mergedMessages[dupIdx] = inc;
    else mergedMessages.push(inc);
  }
  // Same content-signature dedup processThread applies to the full
  // build — here it collapses an incremental bubble whose content
  // matches a cached one the (extracted-id, near-date) check above
  // missed (synthetic date, or a different quoted timestamp). Keeps
  // the real-id / reliable-date winner; never merges distinct messages.
  const deduped = dedupByContentSignature(mergedMessages);
  return deduped.sort((a, b) => a.date - b.date);
}

/**
 * Walk a JSON string and escape any literal control characters (newline,
 * tab, carriage return, etc.) found INSIDE string values. Outside string
 * values, leaves whitespace alone (it's structurally legal there).
 *
 * Why: LLMs frequently emit `{"body":"<pre><code>{\n  ...\n}</code></pre>"}`
 * where `\"` quote-escaping is correct but raw `\n` newlines never get
 * escaped. Strict JSON.parse rejects unescaped 0x00–0x1F inside strings.
 */
function escapeUnescapedControlCharsInJsonStrings(json: string): string {
  // Valid JSON escapes inside a string: \" \\ \/ \b \f \n \r \t
  // and \uXXXX (where XXXX = exactly 4 hex digits). LLMs frequently
  // emit malformed escapes when serializing HTML:
  //   • `</span\>`   — `\>` is not a valid escape
  //   • `<u\u></u>`  — `\u` is unicode-escape-looking but the next
  //     4 chars are `></u` (not all hex), so JSON.parse rejects it
  // For both we drop the offending backslash so the next char
  // (or for `\u`, the `u` itself) becomes literal.
  const SIMPLE_ESCAPE = new Set(['"', '\\', '/', 'b', 'f', 'n', 'r', 't']);
  const isHex = (c: string | undefined) => !!c && /^[0-9a-fA-F]$/.test(c);

  let out = '';
  let inString = false;
  for (let i = 0; i < json.length; i++) {
    const ch = json[i];
    if (ch === '\\' && inString) {
      const next = json[i + 1];
      if (next !== undefined && SIMPLE_ESCAPE.has(next)) {
        out += ch + next;
        i++;
      } else if (next === 'u') {
        // Need exactly 4 hex digits to be a valid unicode escape.
        if (
          isHex(json[i + 2]) && isHex(json[i + 3]) &&
          isHex(json[i + 4]) && isHex(json[i + 5])
        ) {
          out += ch + next + json[i + 2] + json[i + 3] + json[i + 4] + json[i + 5];
          i += 5;
        }
        // Else: malformed \u — drop the backslash, fall through so
        // the next loop iteration emits `u` as a literal.
      }
      // Else: invalid escape (`\>`, `\<`, etc.) — drop the backslash.
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      out += ch;
      continue;
    }
    if (inString) {
      const code = ch.charCodeAt(0);
      if (ch === '\n') out += '\\n';
      else if (ch === '\r') out += '\\r';
      else if (ch === '\t') out += '\\t';
      else if (ch === '\b') out += '\\b';
      else if (ch === '\f') out += '\\f';
      else if (code < 0x20) out += '\\u' + code.toString(16).padStart(4, '0');
      else out += ch;
    } else {
      out += ch;
    }
  }
  return out;
}

/**
 * Detect and undo LLM "double-escaped" HTML bodies.
 *
 * Some models pre-escape the JSON characters inside their HTML output
 * before they wrap the whole thing in JSON — so when JSON.parse runs,
 * the body string still contains literal backslash-n and backslash-quote
 * characters instead of real newlines and quotes. That renders as
 * visible "\n" and broken `<div class=\"foo\">` in the iframe.
 *
 * Heuristic: real HTML never contains `\"` inside attribute values
 * (browsers use raw `"`), and never contains `\n` as a 2-char literal
 * (browsers use a real newline). If we see either, run JSON-style
 * unescape once more to recover the intended characters.
 */
function unescapeDoubleEscapedLLMBody(body: string): string {
  if (!body) return body;
  // Cheap signature check — only run the fix if we see the telltale
  // signs. Avoids touching legitimately backslash-bearing content like
  // <pre><code>printf("\n");</code></pre>.
  const hasLiteralBackslashQuoteInAttr = /=\\["']/.test(body);
  const hasLiteralBackslashNAfterTag = /(>|;)\\n</.test(body);
  if (!hasLiteralBackslashQuoteInAttr && !hasLiteralBackslashNAfterTag) {
    return body;
  }
  // Replace the common JSON escape sequences in ONE left-to-right pass so
  // `\\` is consumed atomically. Sequential global replaces handled `\\`
  // last, so the second backslash of `C:\\note` paired with the following
  // `n` as a fake `\n` and the path rendered as "C:\<newline>ote".
  const ESCAPE_MAP: Record<string, string> = { '"': '"', n: '\n', r: '\r', t: '\t', '\\': '\\' };
  const out = body.replace(/\\(["nrt\\])/g, (_m, c: string) => ESCAPE_MAP[c]);
  console.warn('[Conversation] Detected LLM double-escaped body — unescaped \\" and \\n to real chars');
  return out;
}

/**
 * True when the MOST RECENT parseJsonResponse call had to salvage a
 * truncated response via tryRepairTruncatedJson — i.e. the model hit
 * its output cap and we kept a valid prefix. Callers read this
 * SYNCHRONOUSLY right after parseJsonResponse returns (no await in
 * between) and mark their result partial so it isn't cached as
 * complete. The next parse call overwrites the flag.
 */
let lastParseRepairedTruncation = false;

function parseJsonResponse(response: string): any {
  lastParseRepairedTruncation = false;
  if (!response || !response.trim()) {
    console.error('[Conversation] Empty response from LLM');
    return null;
  }

  // Strip <think>/<thinking>/<reasoning>/<thought> blocks BEFORE every
  // parse attempt below. We send chat_template_kwargs: {enable_thinking:
  // false} on the request, but some vLLM-hosted models still leak a
  // thinking block (kwarg not respected, or non-vLLM backend). Without
  // this, the "starts with <" branch wraps the thinking text as
  // { body: '<think>...' } and saves the model's internal monologue
  // into the conversation cache.
  const cleaned = cleanLLMJsonResponse(response);

  // Helper: attempt parse, then attempt parse after escaping unescaped
  // control chars inside string values. The LLM commonly emits
  // {"body":"<pre>...\n  \"key\":\n...</pre>"} where the body field
  // contains a code block with raw newlines — strict JSON requires
  // \n, \r, \t, etc. This catches that case without changing anything
  // that's already valid JSON.
  const parseOrSanitize = (s: string): any => {
    try {
      return JSON.parse(s);
    } catch {
      const sanitized = escapeUnescapedControlCharsInJsonStrings(s);
      if (sanitized !== s) {
        try {
          return JSON.parse(sanitized);
        } catch {
          // fall through to caller's other strategies
        }
      }
      throw new Error('parse failed');
    }
  };

  try {
    return parseOrSanitize(cleaned);
  } catch {
    // Try to extract JSON from markdown code fences
    const jsonMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      try {
        return parseOrSanitize(jsonMatch[1].trim());
      } catch {
        // fall through
      }
    }
    // Try to find JSON object in the response
    const objectMatch = cleaned.match(/\{[\s\S]*\}/);
    if (objectMatch) {
      try {
        return parseOrSanitize(objectMatch[0]);
      } catch {
        // fall through
      }
    }
    // Try to repair truncated JSON (LLM output cut off mid-value)
    const repaired = tryRepairTruncatedJson(cleaned);
    if (repaired) {
      // Salvaged a valid prefix of a cut-off response — flag it so
      // the caller marks its result partial instead of caching the
      // half-email as complete.
      lastParseRepairedTruncation = true;
      return repaired;
    }

    // Last resort: if the response looks like HTML/text content (not JSON at all),
    // the LLM may have returned the body directly without JSON wrapping.
    // This branch operates on `cleaned` so leftover thinking text never
    // gets saved as the conversation body.
    const trimmed = cleaned.trim();
    if (trimmed && (trimmed.startsWith('<') || (!trimmed.startsWith('{') && !trimmed.startsWith('[')))) {
      // Dump the FULL raw + cleaned response so you can see exactly what
      // the model returned (and how cleanLLMJsonResponse mangled it, if
      // at all). Console.log instead of warn so it survives default
      // log-level filters that hide warn but show log.
      console.warn('[Conversation] LLM returned non-JSON response, wrapping as body');
      console.log(
        '[Conversation] Raw response (length=' + response.length + '):\n' + response,
      );
      if (cleaned !== response) {
        console.log(
          '[Conversation] After cleanLLMJsonResponse (length=' + cleaned.length + '):\n' + cleaned,
        );
      } else {
        console.log('[Conversation] cleanLLMJsonResponse made no changes (no thinking tags / fences detected)');
      }
      return { body: trimmed };
    }

    // Final dead-end: full dump (raw + cleaned) for diagnosis. Truncation
    // here would hide the exact malformation that caused the failure.
    console.error('[Conversation] Could not parse JSON from response.');
    console.log(
      '[Conversation] Raw response (length=' + response.length + '):\n' + response,
    );
    if (cleaned !== response) {
      console.log(
        '[Conversation] After cleanLLMJsonResponse (length=' + cleaned.length + '):\n' + cleaned,
      );
    }
    return null;
  }
}

function tryRepairTruncatedJson(response: string): any {
  // Find the start of a JSON object
  const start = response.search(/[[{]/);
  if (start === -1) return null;

  const json = response.substring(start);

  // Dumb close-and-trim, brute-force up to 200 chars. Catches the
  // common "model truncated mid-string, just close it" case for
  // Phase 2's {"body":"..."} shape.
  for (let trim = 0; trim < Math.min(json.length, 200); trim++) {
    const trimmed = json.substring(0, json.length - trim);
    for (const closer of ['"', '"}', '"}]', '"}}', '"}]}']) {
      try {
        const result = JSON.parse(trimmed + closer);
        console.log('[Conversation] Repaired truncated JSON by trimming', trim, 'chars + closing with', closer);
        return result;
      } catch {
        // try next
      }
    }
  }
  return null;
}

// ========== Background Extraction Listener ==========

let backgroundListenerActive = false;
let processingExtraction = false;

type ExtractThreadRef = { id: string; messageCount: number };

// FIX C (MED-4): batches arriving while a batch is in flight used to be
// dropped, silently killing P1's targeted single-thread extraction when it
// collided with the 45s scheduler's in-flight batch. Instead we QUEUE the
// colliding batch (de-duped by threadId against what's queued or in flight)
// and drain it when the current batch finishes — preserving the single-flight
// guarantee (still only one batch processed at a time) without losing the work.
// Bounded so a burst of dispatches can't grow it without limit.
const pendingBatchThreads = new Map<string, ExtractThreadRef>();
let inFlightThreadIds = new Set<string>();
const MAX_PENDING_BATCH_THREADS = 500;

function enqueuePendingBatch(threads: ExtractThreadRef[]): void {
  for (const thread of threads) {
    if (!thread?.id) continue;
    if (inFlightThreadIds.has(thread.id)) continue; // being processed right now
    if (pendingBatchThreads.has(thread.id)) continue; // already queued
    if (pendingBatchThreads.size >= MAX_PENDING_BATCH_THREADS) break;
    pendingBatchThreads.set(thread.id, thread);
  }
}

// Per-session background-extraction attempt counter, keyed by threadId.
// A thread that can't reach completion (LLM failures, dedup/skips leaving
// fewer bubbles than emails, a malformed body) used to be re-queued by the
// 45s scheduler EVERY tick forever — pegging CPU and re-running heavy HTML
// regexes on large Outlook threads (a beachball source). After
// MAX_BG_EXTRACTION_ATTEMPTS we stop reprocessing it this session; a new
// email on the thread (message_count grows) still re-qualifies it via the
// DB predicate, and an app restart clears the counter.
const bgExtractionAttempts = new Map<string, number>();
const MAX_BG_EXTRACTION_ATTEMPTS = 3;
// Cap the counter map. Completed threads delete their entry, but given-up
// (hit-max) and perpetually-partial threads keep theirs for the session — so
// on a large mailbox the map would grow one small entry per distinct thread
// ever processed. Evict oldest (Map preserves insertion order) beyond the cap;
// worst case an evicted thread gets reprocessed up to MAX times again, which
// is rare at this size and bounded.
const MAX_BG_EXTRACTION_ENTRIES = 5000;

// Starvation guard for threads that never complete because their bodies never
// arrive (an email whose body-fetch permanently fails, or thread emails that
// aren't syncing) or extraction keeps yielding nothing. Such a thread stays
// `chat_email_count < message_count` forever, so the main-process scheduler keeps
// re-selecting it into the top-5 batch every 45s and NO other pending thread ever
// gets a turn. We count consecutive passes that make no body progress and, past a
// generous budget, PARK the thread (persist a dequeue) so the scheduler moves on.
// Body progress (bodiedCount grows) resets the counter, so a slow-but-advancing
// body stream is never parked; a restart clears the map and new mail re-qualifies.
const bgNoProgressPasses = new Map<string, { passes: number; lastBodied: number }>();
const MAX_NO_PROGRESS_PASSES = 12; // ~9 min at the 45s scheduler cadence

/**
 * Record a no-progress pass for a stuck thread. Returns true when it has now
 * exceeded the budget and should be parked. Progress (a higher `bodiedCount` than
 * last seen) resets the counter and returns false.
 */
function noteNoProgressPass(threadId: string, bodiedCount: number): boolean {
  const prev = bgNoProgressPasses.get(threadId);
  if (prev && bodiedCount <= prev.lastBodied) {
    const passes = prev.passes + 1;
    bgNoProgressPasses.set(threadId, { passes, lastBodied: bodiedCount });
    if (bgNoProgressPasses.size > MAX_BG_EXTRACTION_ENTRIES) {
      const oldest = bgNoProgressPasses.keys().next().value;
      if (oldest !== undefined) bgNoProgressPasses.delete(oldest);
    }
    return passes >= MAX_NO_PROGRESS_PASSES;
  }
  bgNoProgressPasses.set(threadId, { passes: 0, lastBodied: bodiedCount });
  return false;
}

/**
 * Extract one batch of threads, one at a time. Kept single-flight by the
 * caller (processingExtraction); this only owns the per-thread loop.
 */
async function processThreadBatch(threads: ExtractThreadRef[]): Promise<void> {
  console.log(`[ConversationBg] Processing ${threads.length} threads`);

  for (const thread of threads) {
    try {
      // Give-up guard: don't reprocess a thread the LLM has already FAILED on
      // MAX times this session — that infinite 45s re-queue is the CPU-pegging
      // beachball loop. (FIX B: only genuine AI failures count toward this
      // limit now, so benign await-bodies / dedup passes never trip it.) PARK it
      // (persist a dequeue) so the main-process scheduler also stops re-selecting
      // it — otherwise a given-up thread still holds a top-5 batch slot forever
      // and starves the rest. A new email (message_count grows) or an app restart
      // (this Map clears) re-qualifies it.
      if ((bgExtractionAttempts.get(thread.id) || 0) >= MAX_BG_EXTRACTION_ATTEMPTS) {
        try { await window.electronAPI.ai.updateThreadExtraction(thread.id, thread.messageCount); } catch { /* best effort */ }
        continue;
      }

      // Fetch thread emails via IPC
      const threadResult = await window.electronAPI.emails.getThread(thread.id);
      if (!threadResult.success || !threadResult.data || threadResult.data.length < 2) {
        continue;
      }

      const emails = threadResult.data;
      // Body coverage for THIS thread's locally-present emails. Drives both the
      // extraction bookkeeping below and the no-progress starvation guard.
      const bodiedCount = emails.filter(e =>
        ((e.rawBody || '').trim().length > 0) || ((e.cleanBody || '').trim().length > 0),
      ).length;
      const allBodied = bodiedCount === emails.length;

      // Run extraction (uses cache internally for incremental updates)
      const userEmail = emails[0]?.toAddress || '';
      const result = await extractConversation(thread.id, emails, userEmail);

      // Did the LLM actually SUCCEED on every message? A message whose AI
      // cleanup failed (transient gateway/LLM issue) comes back
      // `extractionFailed` — bodies present is NOT the same as extraction
      // succeeded.
      const anyFailed = result.messages.some((m) => m.extractionFailed);
      const fullyExtracted = allBodied && !anyFailed;

      // Starvation guard: a pass that neither completes nor is an AI failure is an
      // "awaiting bodies / nothing extracted" pass. Legitimate while bodies stream
      // in, but if it makes NO body progress for too many consecutive passes the
      // missing bodies aren't coming — PARK the thread so it stops re-queuing and
      // starving others. (AI failures have their own 3-attempt give-up guard
      // above, so they're excluded here.) Body progress resets the counter.
      if (!fullyExtracted && !anyFailed && noteNoProgressPass(thread.id, bodiedCount)) {
        try { await window.electronAPI.ai.updateThreadExtraction(thread.id, thread.messageCount); } catch { /* best effort */ }
        bgNoProgressPasses.delete(thread.id);
        console.log(`[ConversationBg] Thread ${thread.id} stuck (bodied ${bodiedCount}/${emails.length}) — parking so it stops re-queuing`);
        continue;
      }

      // Not parking yet: if extraction produced NOTHING (bodies not synced yet),
      // leave the thread pending — updating metadata here would permanently
      // dequeue it with zero bubbles cached. Benign await-bodies pass: must NOT
      // count as an extraction attempt (FIX B).
      if (result.partial && result.messages.length === 0) {
        console.log(`[ConversationBg] Thread ${thread.id} had no extractable bodies yet — leaving pending`);
        continue;
      }

      // Mark thread as extracted. Re-queue (store the partial bodied count,
      // which stays < message_count) ONLY while some email's body is still
      // downloading — that's the legitimate "come back when bodies arrive"
      // case. Once EVERY fetched email is bodied, the thread is as extracted
      // as it will get: store the full email count so it dequeues. Otherwise
      // dedup/skips/partial results (fewer bubbles than emails) would keep it
      // < message_count and re-queue it every tick forever — the beachball loop.
      // FIX B (MED-3): only a genuine LLM failure counts toward the give-up
      // limit. await-bodies / no-op / benign-dedup passes (which store
      // bodiedCount < message_count and stay pending) must NOT burn an attempt,
      // or a large thread whose bodies stream in slowly would exhaust its 3
      // attempts in ~2 min and be blocked for the rest of the session.
      if (anyFailed) {
        bgExtractionAttempts.set(thread.id, (bgExtractionAttempts.get(thread.id) || 0) + 1);
        if (bgExtractionAttempts.size > MAX_BG_EXTRACTION_ENTRIES) {
          const oldest = bgExtractionAttempts.keys().next().value;
          if (oldest !== undefined) bgExtractionAttempts.delete(oldest);
        }
      }

      // `fullyExtracted` (computed above) dequeues the thread — see the pending
      // query's `chat_email_count < message_count`. getThread() excludes
      // Trash/Spam copies, so we store message_count (not emails.length) so
      // trash-copy threads still dequeue.
      // FIX A (MED-1): on failure, keep chat_email_count strictly BELOW
      // message_count so a later poll re-processes the thread once AI recovers —
      // regardless of trash copies. A fully-synced thread with no Trash/Spam
      // copies has bodiedCount == message_count, so storing bodiedCount (the old
      // behavior) would DEQUEUE it and the failed message would never
      // auto-retry. Clamp below message_count instead. (The in-session
      // MAX_BG_EXTRACTION_ATTEMPTS guard still prevents a hot loop.)
      const countToStore = fullyExtracted
        ? Math.max(emails.length, thread.messageCount)
        : anyFailed
          ? Math.max(0, Math.min(bodiedCount, thread.messageCount) - 1)
          : bodiedCount;
      await window.electronAPI.ai.updateThreadExtraction(thread.id, countToStore);
      if (fullyExtracted) {
        bgExtractionAttempts.delete(thread.id); // completed — reset both guards
        bgNoProgressPasses.delete(thread.id);
      }
      console.log(`[ConversationBg] Extracted thread ${thread.id} (${bodiedCount}/${emails.length} emails${fullyExtracted ? ', complete' : anyFailed ? ', some AI-failed — will retry' : ', awaiting bodies'})`);
    } catch (error) {
      // Don't update metadata on error — scheduler will retry next tick
      console.error(`[ConversationBg] Failed to extract thread ${thread.id}:`, error);
    }
  }
}

/**
 * Initialize the background extraction listener.
 * Listens for batch extraction requests from the main process scheduler
 * and processes threads one at a time in the renderer.
 */
export function initializeBackgroundExtractionListener(): void {
  if (backgroundListenerActive) return;
  // Guard electronAPI (preload bridge) — an unguarded `.ai` threw "Cannot read
  // properties of undefined (reading 'ai')" (SARV-INBOX-S). Skip WITHOUT marking
  // active so a later call can wire it up once the bridge is ready.
  if (!window.electronAPI?.ai?.onExtractionBatch) return;
  backgroundListenerActive = true;

  window.electronAPI.ai.onExtractionBatch(async (data) => {
    const provider = getDefaultProvider();
    if (!provider) return;

    if (!isConversationModeEnabled()) return;

    if (!Array.isArray(data?.threads)) return;

    // FIX C (MED-4): don't drop a batch that collides with an in-flight one
    // (e.g. P1's targeted single-thread batch) — queue it de-duped and let the
    // running batch drain it when it finishes, so the work isn't lost.
    if (processingExtraction) {
      enqueuePendingBatch(data.threads);
      return;
    }

    processingExtraction = true;
    // try/finally so a throw anywhere in the loop scaffolding can't leave
    // processingExtraction stuck true — that would silently kill background
    // extraction for the rest of the session.
    try {
      let batch: ExtractThreadRef[] = data.threads;
      while (batch.length > 0) {
        inFlightThreadIds = new Set(batch.map((t) => t.id));
        await processThreadBatch(batch);
        // Drain any batches that were queued (via enqueuePendingBatch) while
        // this one was in flight. Still single-flight — we process them here,
        // in this same run, one batch at a time. A batch queued after this
        // drain (once the queue is empty and we exit) is picked up by the next
        // dispatch, which likewise drains the queue.
        batch = Array.from(pendingBatchThreads.values());
        pendingBatchThreads.clear();
      }
    } finally {
      inFlightThreadIds = new Set();
      processingExtraction = false;
    }
  });

  console.log('[ConversationBg] Background extraction listener initialized');
}

/**
 * Remove the background extraction listener (cleanup)
 */
export function removeBackgroundExtractionListener(): void {
  if (!backgroundListenerActive) return;
  window.electronAPI?.ai?.removeExtractionBatchListener?.();
  backgroundListenerActive = false;
}

export async function saveConversationCache(
  threadId: string,
  messages: ConversationMessage[],
  processedEmailIds: string[],
  modelUsed: string,
  partial = false
): Promise<void> {
  try {
    const marker = `${modelUsed}|v${EXTRACTION_VERSION}${partial ? '|partial' : ''}`;
    await window.electronAPI.ai.saveConversation({
      threadId,
      messages: JSON.stringify(messages),
      emailCount: processedEmailIds.length,
      processedEmailIds: JSON.stringify(processedEmailIds),
      processedAt: Math.floor(Date.now() / 1000),
      modelUsed: marker,
    });
  } catch (err) {
    console.error('[Conversation] Failed to save cache:', err);
  }
}
