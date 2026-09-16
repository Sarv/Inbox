import { jsonrepair } from 'jsonrepair';

// Shared helpers for handling raw LLM text output in the renderer.
//
// These live under apps/desktop/src/utils (a renderer-local leaf module)
// rather than @sarvinbox/core because the core barrel re-exports
// imapflow/nodemailer, which drag Node's `events` module into the Vite
// renderer bundle and fail with "Dynamic require of 'events' is not
// supported". Keeping them here lets both ai-service and
// conversation-service import the single source of truth without pulling
// core into the renderer.

/**
 * Normalize a raw LLM response into a bare JSON string ready for
 * JSON.parse. Strips model "thinking" blocks and a surrounding markdown
 * code fence.
 *
 * This is the superset of every prior inline copy:
 * - conversation-service's local `cleanLLMJsonResponse` (thinking-block
 *   removal + fence stripping) — behavior-identical.
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
  const unclosed = out.search(/<(?:think|thinking|reasoning|thought)>/i);
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
 * recovery, never a new failure mode. The thrown message carries a bounded head
 * of the response, because "Unexpected token 'T'" without the text tells you
 * nothing about a model that answered in prose.
 *
 * @param raw the model's response, fences and thinking blocks included
 * @throws when the response cannot be parsed even after repair
 */
export function parseLLMJson<T = unknown>(raw: string): T {
  const cleaned = cleanLLMJsonResponse(raw);
  if (!cleaned) throw new Error('LLM returned an empty response');
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
    throw new Error(
      'LLM answered in prose, not JSON. '
      + `Response began: ${JSON.stringify(cleaned.slice(0, 160))}`,
    );
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
      repairError = (err as Error).message;
    }
  }
  throw new Error(
    `LLM response was not JSON even after repair (${repairError}). `
    + `Response began: ${JSON.stringify(cleaned.slice(0, 160))}`,
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
