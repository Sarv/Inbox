import { errorDiagnostic } from '@sarvinbox/core/error-diagnostic';
import { jsonrepair, JSONRepairError } from 'jsonrepair';

// Shared helpers for handling raw LLM text output in the renderer.
//
// These live under apps/desktop/src/utils (a renderer-local leaf module)
// rather than @sarvinbox/core because the core barrel re-exports
// imapflow/nodemailer, which drag Node's `events` module into the Vite
// renderer bundle and fail with "Dynamic require of 'events' is not
// supported". Keeping them here lets ai-service and the first-email split
// (services/first-split) import the single source of truth without pulling
// core into the renderer.

// The opening tag of a model "thinking" block, matched case-insensitively.
const THINKING_OPENER = /<(?:think|thinking|reasoning|thought)>/i;

/**
 * Normalize a raw LLM response into a bare JSON string ready for
 * JSON.parse. Strips model "thinking" blocks and a surrounding markdown
 * code fence.
 *
 * This is the superset of every prior inline copy:
 * - the old conversation extractor's local `cleanLLMJsonResponse`
 *   (thinking-block removal + fence stripping) — behavior-identical.
 * - ai-service's inline "strip ```json fence then JSON.parse" blocks,
 *   which only did the fence stripping. Routing them through this helper
 *   additionally removes stray <think>/<thinking>/<reasoning>/<thought>
 *   blocks before parsing — a pure improvement (such blocks would have
 *   made JSON.parse throw), never a regression, since on fence-only /
 *   plain-JSON input the thinking regexes are no-ops.
 */
export const cleanLLMJsonResponse = (raw: string): string => {
  if (!raw) return '';
  let out = raw;
  // Strip complete <tag>…</tag> reasoning blocks across newlines.
  out = out.replace(/<think>[\s\S]*?<\/think>\s*/gi, '');
  out = out.replace(/<thinking>[\s\S]*?<\/thinking>\s*/gi, '');
  out = out.replace(/<reasoning>[\s\S]*?<\/reasoning>\s*/gi, '');
  out = out.replace(/<thought>[\s\S]*?<\/thought>\s*/gi, '');
  // Dangling opener (truncated thinking) — drop everything from it onward.
  const unclosed = out.search(THINKING_OPENER);
  if (unclosed !== -1) out = out.slice(0, unclosed);
  // Strip a leading ```json / ``` fence and trailing ```.
  let s = out.trim();
  if (s.startsWith('```json')) s = s.slice(7);
  else if (s.startsWith('```')) s = s.slice(3);
  if (s.endsWith('```')) s = s.slice(0, -3);
  return s.trim();
};

/**
 * Truncate `str` to `max` chars, appending `suffix` only when the string
 * was actually longer than `max`. The suffix is an explicit parameter
 * because the call sites use deliberately different marker text (e.g.
 * '\n... [truncated]' vs '...[truncated]' vs '\n[...input truncated]');
 * consolidating on a single hardcoded suffix would silently change the
 * text at some sites, so callers keep their exact marker.
 */
export const truncate = (str: string, max: number, suffix: string): string =>
  str.length > max ? str.substring(0, max) + suffix : str;

/**
 * Why `parseLLMJson` gave up, as a machine code a log line can carry:
 * `empty` (nothing left once fences and thinking blocks are gone), `prose` (the
 * model answered in sentences) or `unrepairable` (it began as JSON and the repair
 * pass could not make it parse).
 */
export type LLMJsonFailure = 'empty' | 'prose' | 'unrepairable';

/**
 * The error `parseLLMJson` throws. Its message describes the response's SHAPE
 * (`describeLLMResponseShape`) and never quotes it, and `code` says which way it
 * failed, so a caller that logs it with `errorDiagnostic` still tells "answered
 * in prose" from "emitted broken JSON" without a word of the answer.
 */
export class LLMJsonError extends Error {
  readonly code: LLMJsonFailure;

  constructor(code: LLMJsonFailure, message: string) {
    super(message);
    this.name = 'LLMJsonError';
    this.code = code;
  }
}

/**
 * What a model's response LOOKED like — its size, whether it came fenced or with
 * a thinking block, and what kind of character the answer began with — and not
 * one word of what it said.
 *
 * The answer is built from mail: a signature's HTML, a polished draft, a thread
 * summary, a search query echoed back. This used to go into the thrown message
 * as `Response began: "<first 160 chars>"`, and every caller logs that error, so
 * the head of the answer reached app.log at error level from four features. The
 * shape still separates the failures that matter (prose, a bare fence, a
 * thinking block that ate the budget, a cut-off object) and quotes nothing.
 */
export function describeLLMResponseShape(raw: string): string {
  const cleaned = cleanLLMJsonResponse(raw);
  const parts = [`chars=${raw.length}`];
  if (cleaned.length !== raw.length) parts.push(`cleanedChars=${cleaned.length}`);
  if (raw.trimStart().startsWith('```')) parts.push('fenced');
  if (THINKING_OPENER.test(raw)) parts.push('thinking block');
  parts.push(`began with ${firstCharKind(cleaned)}`);
  return parts.join(', ');
}

/** The kind of character `text` starts with, named without the character itself. */
function firstCharKind(text: string): string {
  const first = text.charAt(0);
  if (!first) return 'nothing';
  if (first === '{') return 'an object';
  if (first === '[') return 'an array';
  if (first === '"') return 'a string';
  if (first === '<') return 'markup';
  if (/\p{L}/u.test(first)) return 'a letter';
  if (/\p{N}/u.test(first)) return 'a digit';
  return 'a symbol';
}

// jsonrepair's messages quote the text it stopped at (`Unexpected character "S"`,
// `Invalid unicode character "\u12SE"`), which is the model's answer again. Only
// these kinds and the position are kept; any other wording is named by its class.
const REPAIR_FAILURE_KINDS = [
  'Invalid character',
  'Unexpected character',
  'Unexpected end of json string',
  'Object key expected',
  'Colon expected',
  'Invalid unicode character',
];

/** Why the repair pass failed, without the text it quoted. */
function describeRepairFailure(err: unknown): string {
  if (!(err instanceof JSONRepairError)) return errorDiagnostic(err).name;
  const kind = REPAIR_FAILURE_KINDS.find((known) => err.message.startsWith(known)) ?? 'JSONRepairError';
  return `${kind} at position ${err.position}`;
}

/**
 * Clean a raw LLM response and parse it as JSON, repairing the malformations
 * models routinely produce.
 *
 * Every renderer call site used to do `JSON.parse(cleanLLMJsonResponse(x))`
 * with no repair at all, so any imperfection threw and the whole feature fell
 * back — signature detection, query parsing, thread summaries and text polish
 * all shared the flaw. It only ever got noticed in one of them, because that
 * one logged the failure.
 *
 * What the repair pass buys, measured on 36 real failed responses from one
 * mailbox: quotes escaped going into an HTML attribute but not coming out,
 * escapes JSON does not define (`</div\>`), literal control characters inside
 * strings, trailing junk, and missing closers. It recovered 24 of those 36
 * unaided.
 *
 * Throws on unrecoverable input, exactly as `JSON.parse` does, so the existing
 * try/catch at every call site keeps working unchanged — this is strictly more
 * recovery, never a new failure mode. The thrown `LLMJsonError` says which way
 * it failed (`code`) and what the response looked like
 * (`describeLLMResponseShape`), never what it said: callers log it, and the
 * response is built from mail.
 *
 * @param raw the model's response, fences and thinking blocks included
 * @throws LLMJsonError when the response cannot be parsed even after repair
 */
export function parseLLMJson<T = unknown>(raw: string): T {
  const cleaned = cleanLLMJsonResponse(raw);
  if (!cleaned) throw new LLMJsonError('empty', `LLM returned an empty response (${describeLLMResponseShape(raw)})`);
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    // Not valid JSON as written — hand it to a parser built for model output.
  }
  // A JSON response begins with `{` or `[` once fences and thinking blocks are
  // gone. Anything else is the model answering in prose, and the repair pass
  // must not be let near it: handed "The provided HTML is an extremely large,
  // truncated email template…" jsonrepair SPLITS THE SENTENCE ON ITS COMMAS and
  // returns a valid array of string fragments. That passes every structural
  // check, reaches the caller, and has none of the fields it reads — a
  // fabricated answer where an exception belongs. Three real responses did
  // exactly this.
  if (!/^[{[]/.test(cleaned)) {
    throw new LLMJsonError('prose', `LLM answered in prose, not JSON (${describeLLMResponseShape(raw)})`);
  }

  let repairError = '';
  // Two shapes the repair pass alone gets wrong, both seen in real responses.
  for (const candidate of [cleaned, firstBalancedValue(cleaned)]) {
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(jsonrepair(candidate));
      // A model that answered in prose ("The provided HTML contains no
      // signature block.") is not repairable — but jsonrepair happily QUOTES
      // it and hands back a valid JSON string. Callers then read
      // `parsed.hasSignature` off a string, get undefined, and silently take
      // the "no signature" branch as though the model had said so. Only an
      // object or array is a real parse here; every call site wants one.
      if (parsed && typeof parsed === 'object') return parsed as T;
      repairError = 'model answered in prose, not JSON';
    } catch (err) {
      repairError = describeRepairFailure(err);
    }
  }
  throw new LLMJsonError(
    'unrepairable',
    `LLM response was not JSON even after repair (${repairError}; ${describeLLMResponseShape(raw)})`,
  );
}

/**
 * The complete `{…}` or `[…]` that a response STARTS with, ignoring braces
 * inside strings — i.e. the value with any trailing commentary trimmed off.
 *
 * Models append remarks after the object they were asked for ("…} Hope that
 * helps!"), which the repair pass rejects outright instead of treating as
 * trailing junk. Slicing to the balanced value turns that into an ordinary
 * parse; 8 of 13 real signature-detection failures were exactly this.
 *
 * It must START the response, and that restriction is load-bearing. Scanning
 * for a brace ANYWHERE finds one inside prose: a real response reading "The
 * provided HTML is an extremely large, truncated email template…" yielded a
 * six-element array from some fragment mid-sentence, which is an object, parses
 * cleanly, and has none of the fields the caller reads. That is a silent wrong
 * answer dressed as a recovery — worse than the exception it replaced. Prose
 * with a brace in it is not a JSON response, and must fail.
 */
function firstBalancedValue(text: string): string | null {
  const trimmed = text.trimStart();
  // Anchored: only a response that BEGINS with a JSON value can have mere
  // trailing junk. Leading prose means the model did not answer in JSON.
  if (!/^[{[]/.test(trimmed)) return null;
  text = trimmed;
  const start = 0;
  const open = text[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}
