/**
 * The prompt that splits a thread's first email into the messages it quotes.
 *
 * The rules are the proven split prompt (the one the old Phase 1 used, scored
 * on real looped-in threads), with one protocol added: the body arrives cut
 * into numbered REGIONS at the quote boundaries the chat-view library found
 * (see regions.ts), and every message the model returns names the region its
 * text came from. That is what lets the answer be checked region by region
 * (validate.ts) — a message the model invented, paraphrased or placed in the
 * wrong region is caught against the exact text of that region — and what
 * lets a long history be sent in several chunks instead of being shrunk.
 *
 * Two variants. When the chunk holds region 0 (the sender's own text), the
 * user prompt's From/Date IS the newest message and comes last. When it does
 * not (a later chunk of a long history), that rule would make the model
 * invent a newest message for the sender, so it is left out and the model is
 * told the excerpt is history only.
 */
import type { RegionChunk } from './regions';

/** The model context the budgets below are sized for. */
export const MODEL_CONTEXT_TOKENS = 32_768;
/** Hard cap on the input, prompt included. */
export const INPUT_TOKEN_CAP = 13_000;
/** Room left for tokenizer variance. */
export const SAFETY_MARGIN_TOKENS = 1_000;
/**
 * Conservative characters per token for HTML with class/style attributes
 * (~2.5-3; plain English is ~3.5). Underestimating it overshoots the context.
 */
export const CHARS_PER_TOKEN = 2.5;
/** Ceiling on the response budget. */
export const MAX_RESPONSE_TOKENS = 16_384;
/** Floor on the response budget — below it no split fits. */
export const MIN_RESPONSE_TOKENS = 512;
/** The From/To/Date header and the variant's framing lines. */
export const HEADER_OVERHEAD_CHARS = 400;
/** Most chunks one first email is sent in; regions past them keep Standard's rendering. */
export const MAX_CHUNKS = 4;

/** The line that opens region `k` in the user prompt. */
export function regionMarker(index: number): string {
  return `[[REGION ${index}]]`;
}

/** Characters a region costs in the prompt beyond its HTML: its marker line and spacing. */
export function regionOverheadChars(index: number): number {
  return regionMarker(index).length + 2;
}

const SHARED_RULES = `- Each "On X wrote:" / "From: ... Sent:" / "Forwarded message" / "Original Message" marker (or each <blockquote class="gmail_quote"> / plain Outlook <blockquote> / Outlook reply-quote <div>) = one earlier message.
- from_address is plain "name@domain" — no markdown brackets, no display name.
- body is the sender's VERBATIM HTML for that message — preserve every tag and every attribute (class, id, style, data-*, href, src, alt, colspan, rowspan, etc.) BYTE-FOR-BYTE. The ONLY attribute kind to drop is on* event handlers (onclick, onerror, etc.) for security. The renderer normalizes typography (font-family, font-size, spacing) at display time — DO NOT try to clean styles, classes, or formatting noise.
- body must be COMPLETE: copy EVERY paragraph, list item and table row belonging to that message, from its boundary marker down to the next boundary. Never summarize, never shorten, never skip the middle of a message — a salutation alone is NOT a valid body.
- Do NOT include the "On <date>, <name> wrote:" attribution header (or "From:/Sent:/To:" header lines) in any body — those are boundary markers, not message content.
- Do NOT wrap a body in <blockquote> or quote-container <div>s (gmail_quote etc.) — emit the message's inner content only.
- Do NOT convert to markdown. Do NOT paraphrase. Do NOT fix typos. Drop only the boundary-marker lines and the trailing signature block.
- Content <img> tags must be preserved with their original src (sarv-image: refs, https, data:, cid:) and placed in the body of the message they belong to. Don't invent new ones, don't drop existing ones.
- The output must be valid JSON: escape " as \\" inside string values. HTML tags themselves (<p>, <a href="...">) are fine inside JSON strings.
- Output starts with { and ends with }. No prose, no fences.`;

const ENTRY_SHAPE = `Each entry: {"region": k, "from_address": "alice@x.com", "from_name": "Alice" or null, "to_address": "...", "date": "the date/time EXACTLY as written in that message's header, verbatim — copy it character-for-character, do NOT reformat, reorder day/month, or convert to ISO; empty string if none", "body": "<html string>"}.`;

const REGION_RULES = `- The input is cut into regions. Each [[REGION k]] line starts region k. "region" is REQUIRED on every entry: the number k of the region that entry's text is copied from. A message never spans two regions.
- Every region after REGION 0 starts with the boundary marker of the message it holds — read that message's sender and date from it. A region holds one message, unless it contains another boundary marker the cut missed: then one entry per marker.`;

/** The system prompt for a chunk that holds region 0 (the sender's own text). */
const OWN_CHUNK_PROMPT = `Split this email into individual messages. Input is HTML. Output JSON only: {"messages":[...]}, oldest first.

${ENTRY_SHAPE}

Rules:
${REGION_RULES}
- The user-prompt's From/Date is the LAST entry (newest, on top): it is REGION 0, the sender's own text.
- N markers → N+1 entries.
${SHARED_RULES}`;

/** The system prompt for a chunk of quoted history only (no region 0). */
const HISTORY_CHUNK_PROMPT = `Split this excerpt of an email's quoted history into individual messages. Input is HTML. Output JSON only: {"messages":[...]}, oldest first.

${ENTRY_SHAPE}

Rules:
${REGION_RULES}
- This excerpt is QUOTED HISTORY only. None of it is the newest message, and none of it was written by the carrier email's sender unless a boundary marker says so — never invent a message for the carrier's sender.
- N markers → N entries.
${SHARED_RULES}`;

/** The system prompt for a chunk. */
export function systemPromptFor(includesOwnRegion: boolean): string {
  return includesOwnRegion ? OWN_CHUNK_PROMPT : HISTORY_CHUNK_PROMPT;
}

/**
 * How many characters of region HTML one chunk may carry: the input cap, less
 * the longer of the two system prompts and the header. Derived rather than
 * hard-coded so a prompt edit can never push a full chunk over the model's
 * context.
 */
export const CHUNK_BUDGET_CHARS = Math.floor(INPUT_TOKEN_CAP * CHARS_PER_TOKEN)
  - Math.max(OWN_CHUNK_PROMPT.length, HISTORY_CHUNK_PROMPT.length)
  - HEADER_OVERHEAD_CHARS;

/** Who sent the email being split, as the user prompt states it. */
export interface CarrierHeader {
  fromAddress: string;
  fromName?: string | null;
  toAddress?: string | null;
  /** Unix SECONDS; unreadable (0, null) is omitted from the header. */
  date: number | null | undefined;
}

function isoDate(seconds: number | null | undefined): string {
  return typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0
    ? new Date(seconds * 1000).toISOString()
    : '';
}

/** The user prompt for one chunk: the carrier's header, then each region under its marker. */
export function userPromptFor(chunk: RegionChunk, carrier: CarrierHeader): string {
  const from = carrier.fromName ? `${carrier.fromName} <${carrier.fromAddress}>` : carrier.fromAddress;
  const header = chunk.includesOwnRegion
    ? `From: ${from}\nTo: ${carrier.toAddress || ''}\nDate: ${isoDate(carrier.date)}`
    : `Quoted history from an email sent by ${from} on ${isoDate(carrier.date)} (context only — that email's own text is not in this excerpt).`;
  const regions = chunk.regions.map((region) => `${regionMarker(region.index)}\n${region.html}`);
  return `${header}\n\n${regions.join('\n\n')}`;
}

/** The response budget left once the input is counted: `min(16384, 32768 − input − 1000)`, at least 512. */
export function responseBudgetFor(systemPrompt: string, userPrompt: string): number {
  const inputTokens = Math.ceil((systemPrompt.length + userPrompt.length) / CHARS_PER_TOKEN);
  const budget = Math.min(MAX_RESPONSE_TOKENS, MODEL_CONTEXT_TOKENS - inputTokens - SAFETY_MARGIN_TOKENS);
  return Math.max(MIN_RESPONSE_TOKENS, budget);
}

/** One completion request for one chunk. */
export interface SplitPrompt {
  systemPrompt: string;
  userPrompt: string;
  maxTokens: number;
}

export function buildSplitPrompt(chunk: RegionChunk, carrier: CarrierHeader): SplitPrompt {
  const systemPrompt = systemPromptFor(chunk.includesOwnRegion);
  const userPrompt = userPromptFor(chunk, carrier);
  return { systemPrompt, userPrompt, maxTokens: responseBudgetFor(systemPrompt, userPrompt) };
}
