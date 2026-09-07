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
