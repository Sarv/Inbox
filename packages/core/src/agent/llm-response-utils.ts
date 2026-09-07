// Shared helpers for sanitising raw LLM responses before we try to JSON.parse
// them. Consolidated here so every caller strips the same set of noise —
// thinking-model reasoning tags, markdown fences, and surrounding prose.

/**
 * Strip chain-of-thought blocks from LLM responses. Thinking models
 * (DeepSeek R1, o-series and similar) emit their reasoning inline as
 *   <think>…</think>  (DeepSeek R1)
 *   <thinking>…</thinking>
 *   <reasoning>…</reasoning>
 *   <thought>…</thought>
 * before the actual answer. JSON.parse chokes on those prefixes, so the
 * categorization/drafting/planning code paths silently returned empty
 * results for any model that emits inline reasoning. Removing them here
 * lets the rest of the parser see clean JSON.
 *
 * Stripping is anchored to the PREFIX of the response (everything before
 * the payload's first '{' or '['):
 *   • Closed blocks are stripped only when they lead the response — a
 *     closed pair INSIDE a JSON string value is payload, not reasoning.
 *   • A dangling opener (model never closed the tag) drops the dangling
 *     prefix but keeps any JSON that follows instead of truncating to EOF.
 * Content after the JSON start is never touched.
 */
export function stripThinkingTags(raw: string): string {
  if (!raw) return '';
  let out = raw;

  // Strip complete <tag>…</tag> blocks anchored at the start (handles the
  // common "think block(s), then JSON" shape, even when the reasoning
  // itself contains braces).
  const leadingClosed = /^\s*<(think|thinking|reasoning|thought)>[\s\S]*?<\/\1>\s*/i;
  while (leadingClosed.test(out)) {
    out = out.replace(leadingClosed, '');
  }

  // Opener still in the prefix before the payload's first '{' or '[' —
  // dangling (or prose-wrapped) reasoning. Keep the JSON, drop the prefix;
  // with no JSON at all, fall back to dropping from the opener to EOF.
  const jsonStart = out.search(/[[{]/);
  const head = jsonStart === -1 ? out : out.slice(0, jsonStart);
  const openerIdx = head.search(/<(?:think|thinking|reasoning|thought)>/i);
  if (openerIdx !== -1) {
    out = jsonStart === -1 ? out.slice(0, openerIdx) : out.slice(jsonStart);
  }

  return out.trim();
}

/**
 * Strip a leading ``` or ```json fence and the trailing ```. Covers the
 * common "LLM wrapped JSON in markdown even though the prompt said not to"
 * case.
 */
export function stripMarkdownFences(raw: string): string {
  let s = raw.trim();
  if (s.startsWith('```json')) s = s.slice(7);
  else if (s.startsWith('```')) s = s.slice(3);
  if (s.endsWith('```')) s = s.slice(0, -3);
  return s.trim();
}

/**
 * Walk a JSON-shaped string and escape any literal control characters
 * (newline, tab, carriage return, etc.) that appear INSIDE string
 * values. JSON spec requires those to be escaped as \n / \t / \r;
 * LLMs frequently emit them raw, especially inside long `reasoning`
 * fields that contain quoted dialogue or pasted code. The result:
 * `JSON.parse` throws "Unterminated string" or "Expected ',' or '}'"
 * mid-response, and the entire batch gets discarded.
 *
 * Outside string values (structural whitespace), control chars are
 * left alone.
 */
export function escapeUnescapedControlCharsInJsonStrings(json: string): string {
  let out = '';
  let inString = false;
  let escapedNext = false;
  for (let i = 0; i < json.length; i++) {
    const ch = json[i];
    if (escapedNext) {
      out += ch;
      escapedNext = false;
      continue;
    }
    if (ch === '\\' && inString) {
      out += ch;
      escapedNext = true;
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
 * Try `JSON.parse` and on failure retry once with the control-char
 * sanitiser applied. Catches the common LLM mistake of emitting raw
 * newlines inside `reasoning` strings — the entire batch gets
 * discarded otherwise.
 *
 * Returns `null` on hard failure. Caller decides whether to log the
 * raw response, salvage what it can, or fall back to a default.
 */
export function tryParseLLMJson<T = any>(json: string): T | null {
  try {
    return JSON.parse(json) as T;
  } catch {
    const sanitised = escapeUnescapedControlCharsInJsonStrings(json);
    if (sanitised === json) return null;
    try {
      return JSON.parse(sanitised) as T;
    } catch {
      return null;
    }
  }
}

export interface SalvageDiagnostics {
  /** Total chars of input we walked. */
  inputLength: number;
  /** `{` openings we saw at top-level (objects we attempted to extract). */
  objectsAttempted: number;
  /** Of those, how many had a matching `}` (no truncation). */
  objectsClosed: number;
  /** Of the closed ones, how many parsed successfully via tryParseLLMJson. */
  objectsParsed: number;
  /** True if the walker hit end-of-input mid-object — likely truncation. */
  truncatedMidObject: boolean;
  /** True if the walker hit `]` cleanly (response ended properly). */
  reachedArrayEnd: boolean;
}

/**
 * Walk a JSON-array-shaped string and yield each top-level object
 * individually, parsing each with `tryParseLLMJson`. Survives several
 * failure modes that kill `JSON.parse` on the whole array:
 *
 *   • Truncation — last incomplete object gets dropped, rest survive.
 *   • Per-object malformation (unescaped quote inside one reasoning
 *     string) — that one object skipped, neighbours fine.
 *   • Trailing prose after the array — ignored.
 *   • Leading prose before the array — `[` finds the start.
 *
 * Use this AFTER `tryParseLLMJson` fails on the whole array but you
 * still want to recover whatever objects you can.
 *
 * Returns the (possibly-empty) list of successfully-parsed objects.
 */
export function salvageJsonArray<T = any>(raw: string): T[] {
  return salvageJsonArrayWithDiagnostics<T>(raw).items;
}

/**
 * Same as `salvageJsonArray` but also returns walker stats so callers
 * can see WHY salvage produced fewer objects than expected (truncation
 * vs. malformation vs. the LLM just emitted fewer entries).
 */
export function salvageJsonArrayWithDiagnostics<T = any>(raw: string): { items: T[]; diagnostics: SalvageDiagnostics } {
  const diagnostics: SalvageDiagnostics = {
    inputLength: raw.length,
    objectsAttempted: 0,
    objectsClosed: 0,
    objectsParsed: 0,
    truncatedMidObject: false,
    reachedArrayEnd: false,
  };
  const start = raw.indexOf('[');
  if (start < 0) return { items: [], diagnostics };
  const out: T[] = [];
  let i = start + 1;
  // Walk top-level: collect each `{...}` object, respecting nested
  // braces and quoted strings so we don't split mid-value.
  while (i < raw.length) {
    // Skip whitespace + commas between objects
    while (i < raw.length && /[\s,]/.test(raw[i])) i++;
    if (i >= raw.length) break;
    if (raw[i] === ']') {
      diagnostics.reachedArrayEnd = true;
      break;
    }
    if (raw[i] !== '{') {
      // Unexpected char — bail rather than loop forever
      break;
    }
    diagnostics.objectsAttempted++;
    // Find the matching closing brace, tracking string boundaries.
    const objStart = i;
    let depth = 0;
    let inString = false;
    let escapedNext = false;
    let objEnd = -1;
    for (let j = i; j < raw.length; j++) {
      const ch = raw[j];
      if (escapedNext) { escapedNext = false; continue; }
      if (ch === '\\' && inString) { escapedNext = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) { objEnd = j; break; }
      }
    }
    if (objEnd < 0) {
      // Truncated mid-object — give up; we kept everything before this.
      diagnostics.truncatedMidObject = true;
      break;
    }
    diagnostics.objectsClosed++;
    const slice = raw.substring(objStart, objEnd + 1);
    const parsed = tryParseLLMJson<T>(slice);
    if (parsed !== null) {
      out.push(parsed);
      diagnostics.objectsParsed++;
    }
    // else: object had unescaped quote / other malformation — skip it.
    i = objEnd + 1;
  }
  return { items: out, diagnostics };
}

/**
 * Numeric fields LLMs sometimes emit as garbage that breaks JSON.parse for the
 * WHOLE response. Observed: `"confidence": 0. nine` (the model spelled the
 * decimal), which is a syntax error INSIDE every object, so even per-object
 * salvage failed and the entire categorization batch was discarded ("No usable
 * JSON"). These are soft/secondary fields, so repairing a malformed value to
 * `null` is safe — the object then parses and the consumer applies its own
 * default (e.g. categorization maps a non-number confidence to 0.5).
 */
const REPAIRABLE_NUMERIC_KEYS = ['confidence', 'score', 'priority_score'];
const VALID_JSON_NUMBER = /^-?(\d+(\.\d+)?|\.\d+)([eE][+-]?\d+)?$/;

/**
 * Rewrite a malformed numeric value for a known numeric key to `null` so the
 * surrounding JSON still parses. Only touches a key in object-key position
 * (preceded by `{` or `,`) so a stray `"confidence":` inside a reasoning string
 * is left alone, and only when the value ISN'T already a valid JSON number.
 */
export function repairMalformedNumericFields(raw: string): string {
  let out = raw;
  for (const key of REPAIRABLE_NUMERIC_KEYS) {
    const re = new RegExp(`([{,]\\s*"${key}"\\s*:\\s*)([^,}\\]\\n]+)`, 'g');
    out = out.replace(re, (full, prefix, value) => {
      const v = String(value).trim();
      if (VALID_JSON_NUMBER.test(v)) return full;   // already a valid number — leave it
      if (v.startsWith('"')) return full;           // a STRING value (e.g. "a, b") — not a malformed number; don't touch
      return `${prefix}null`;                       // genuine garbage (e.g. 0. nine) → null so the object parses
    });
  }
  return out;
}

/**
 * Full sanitise: thinking tags → markdown fences → malformed-number repair →
 * trim. Use this immediately before JSON.parse anywhere that might see output
 * from a thinking model.
 */
export function cleanLLMJsonResponse(raw: string): string {
  return repairMalformedNumericFields(stripMarkdownFences(stripThinkingTags(raw)));
}

/**
 * Extract the first BALANCED `[ ... ]` array from a string, ignoring everything
 * around it — reasoning prose, plain-text analysis, or model markers. Reasoning
 * models like gpt-oss emit an analysis channel that isn't a <think> tag, so it
 * survives the tag stripper and buries the JSON array; per-object salvage can
 * then latch onto a brace in the reasoning instead of the real array. This
 * pulls out the actual array as a unit. String-aware so brackets inside
 * "reasoning" values don't throw off the depth count. Returns null if there is
 * no balanced array.
 */
export function extractBalancedJsonArray(s: string): string | null {
  const start = s.indexOf('[');
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '[') depth++;
    else if (c === ']') { depth--; if (depth === 0) return s.slice(start, i + 1); }
  }
  return null;
}
