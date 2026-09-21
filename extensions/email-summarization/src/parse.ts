/**
 * Reading the model's answer without trusting it.
 *
 * A completion is a string. It is asked for bare JSON and usually gives it, but
 * "usually" is the whole problem: it also arrives wrapped in ```json fences,
 * with a sentence of preamble, with a number where an array was asked for, or
 * with a 40,000-character "summary" because something went wrong upstream. All
 * of it lands in the UI, so all of it is validated and capped here rather than
 * where it is rendered.
 *
 * Nothing in this module throws. A shape that cannot be read is `null`, which
 * the caller reports as "no summary" — the honest answer.
 */

import type { EmailSummaryResult, ThreadSummaryResult } from '@sarvinbox/core/extension-sdk';

/** Longest summary paragraph kept. */
export const MAX_SUMMARY_CHARS = 1_500;

/** Longest single bullet kept. */
export const MAX_POINT_CHARS = 300;

/** Most bullets kept in any one list. */
export const MAX_POINTS = 8;

/** Used when the model omits a confidence or gives an unusable one. */
export const DEFAULT_CONFIDENCE = 0.5;

/**
 * The first balanced `{...}` run in a string.
 *
 * Brace matching rather than a regex: a regex either stops at the first `}`
 * (truncating any nested object) or runs to the last one in the string
 * (swallowing a second object and any trailing prose). String literals are
 * tracked so a brace inside `"a } b"` does not end the scan.
 */
export function extractJsonObject(raw: string): string | null {
  const start = raw.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < raw.length; index += 1) {
    const character = raw[index];

    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }

    if (character === '"') inString = true;
    else if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) return raw.slice(start, index + 1);
    }
  }

  return null;
}

/** Parse a completion into a plain object, or `null` if it holds no usable one. */
export function parseCompletion(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'string') return null;
  const json = extractJsonObject(raw);
  if (!json) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function cleanText(value: unknown, limit: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  return trimmed.length > limit ? `${trimmed.slice(0, limit).trimEnd()}...` : trimmed;
}

/**
 * A list of short strings.
 *
 * Non-strings are dropped rather than coerced: `String(["a"])` is `"a"` and
 * `String({})` is `"[object Object]"`, both of which look like content in the
 * UI and are not.
 */
export function cleanStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const items: string[] = [];
  for (const entry of value) {
    const text = cleanText(entry, MAX_POINT_CHARS);
    if (text) items.push(text);
    if (items.length >= MAX_POINTS) break;
  }
  return items;
}

/** A confidence in 0..1, falling back rather than propagating a NaN. */
export function cleanConfidence(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_CONFIDENCE;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/** A single-message summary, or `null` if the model gave nothing usable. */
export function parseEmailSummary(raw: unknown): EmailSummaryResult | null {
  const parsed = parseCompletion(raw);
  if (!parsed) return null;

  const summary = cleanText(parsed.summary, MAX_SUMMARY_CHARS);
  // A result with no summary text is not a degraded result, it is no result:
  // every surface that shows one shows the paragraph.
  if (!summary) return null;

  const actionItems = cleanStringList(parsed.action_items);
  return {
    summary,
    key_points: cleanStringList(parsed.key_points),
    ...(actionItems.length > 0 ? { action_items: actionItems } : {}),
    confidence: cleanConfidence(parsed.confidence),
  };
}

/**
 * A thread summary, or `null`.
 *
 * `participants` falls back to the list the caller derived from the messages
 * themselves. The senders are a fact we already hold; asking the model for them
 * is convenience, and it is the field it most often gets wrong.
 */
export function parseThreadSummary(raw: unknown, knownParticipants: readonly string[] = []): ThreadSummaryResult | null {
  const parsed = parseCompletion(raw);
  if (!parsed) return null;

  const summary = cleanText(parsed.summary, MAX_SUMMARY_CHARS);
  if (!summary) return null;

  const modelParticipants = cleanStringList(parsed.participants);
  const actionItems = cleanStringList(parsed.action_items);

  return {
    summary,
    key_points: cleanStringList(parsed.key_points),
    participants: modelParticipants.length > 0 ? modelParticipants : [...knownParticipants].slice(0, MAX_POINTS),
    ...(actionItems.length > 0 ? { action_items: actionItems } : {}),
    confidence: cleanConfidence(parsed.confidence),
  };
}
