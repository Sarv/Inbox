import {
  cleanLLMJsonResponse,
  extractBalancedJsonArray,
  salvageJsonArrayWithDiagnostics,
  tryParseLLMJson,
  type SalvageDiagnostics,
} from './llm-response-utils';

/**
 * How an AI provider's answer that should be a JSON array was read, and what
 * came out. The categorizers (core `validateCategorizationResponse` and the
 * desktop `AICategorizationService`) both parse this way and log their own lines
 * from the outcome.
 *
 * - `whole`: the cleaned answer parsed as JSON. `value` may still not be an
 *   array; the caller decides what a bare object means.
 * - `salvaged`: the whole parse failed and some objects of the array were
 *   parsed one by one.
 * - `bracket`: nothing was salvaged, but the first balanced `[...]` in the answer
 *   parsed as a unit (an array buried in reasoning prose).
 * - `none`: nothing usable.
 *
 * `summary` describes the salvage walk in counts only. It is what a log line
 * may say about an unusable answer: the answer itself is the model's reading
 * of the user's mail and never goes to the log.
 */
export type LLMJsonArrayParse =
  | { how: 'whole'; value: unknown }
  | { how: 'salvaged' | 'bracket'; value: unknown[]; diagnostics: SalvageDiagnostics; summary: string }
  | { how: 'none'; value: null; diagnostics: SalvageDiagnostics; summary: string };

/** The salvage walk's counts as one log-safe fragment: numbers and booleans, no text. */
export function salvageDiagnosticsSummary(diagnostics: SalvageDiagnostics): string {
  return (
    `inputLen=${diagnostics.inputLength} ` +
    `attempted=${diagnostics.objectsAttempted} ` +
    `closed=${diagnostics.objectsClosed} ` +
    `parsed=${diagnostics.objectsParsed} ` +
    `truncated=${diagnostics.truncatedMidObject} ` +
    `reachedEnd=${diagnostics.reachedArrayEnd}`
  );
}

/**
 * Read an AI answer that should be a JSON array, in three passes:
 *   1. `JSON.parse` of the cleaned answer (thinking tags and fences stripped,
 *      raw control characters in strings escaped on a retry).
 *   2. Per-object salvage, which survives truncation, one bad object and
 *      trailing prose.
 *   3. The first balanced `[...]`, for an array buried in reasoning prose that
 *      the tag stripper and the salvage both missed.
 */
export function parseLLMJsonArray(raw: string): LLMJsonArrayParse {
  const clean = cleanLLMJsonResponse(raw);
  const whole = tryParseLLMJson<unknown>(clean);
  if (whole !== null) return { how: 'whole', value: whole };

  const { items, diagnostics } = salvageJsonArrayWithDiagnostics<unknown>(clean);
  const summary = salvageDiagnosticsSummary(diagnostics);
  if (items.length > 0) return { how: 'salvaged', value: items, diagnostics, summary };

  const array = extractBalancedJsonArray(clean);
  const retry = array && array !== clean ? tryParseLLMJson<unknown>(array) : null;
  if (Array.isArray(retry)) return { how: 'bracket', value: retry, diagnostics, summary };
  return { how: 'none', value: null, diagnostics, summary };
}
