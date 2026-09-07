/**
 * Response parser — turns the LLM's JSON string into a validated
 * ContactEnrichment blob. Tolerates common LLM mistakes (wrapping JSON
 * in markdown fences, trailing commas, null-vs-missing inconsistencies)
 * so the caller can just trust the return value.
 */

import type { ContactEnrichment } from '../types/models';

export class EnrichmentParseError extends Error {
  constructor(message: string, readonly raw: string) {
    super(message);
    this.name = 'EnrichmentParseError';
  }
}

/**
 * Strip chain-of-thought tags, markdown code fences, and isolate the
 * first JSON object. LLMs routinely return ```json ... ``` even when
 * told not to; thinking models (DeepSeek R1 and similar) also prepend
 * <think>…</think> blocks. Boundary-slicing between '{' and '}' is
 * also kept as a final defense against any leading prose.
 */
function isolateJsonObject(raw: string): string {
  let s = raw.trim();
  // Strip <think>/<thinking>/<reasoning>/<thought> blocks first so we
  // don't mis-count braces inside reasoning text.
  s = s.replace(/<think>[\s\S]*?<\/think>\s*/gi, '');
  s = s.replace(/<thinking>[\s\S]*?<\/thinking>\s*/gi, '');
  s = s.replace(/<reasoning>[\s\S]*?<\/reasoning>\s*/gi, '');
  s = s.replace(/<thought>[\s\S]*?<\/thought>\s*/gi, '');
  // Also strip an UNCLOSED reasoning tag: a truncated (maxTokens-capped)
  // thinking model can emit "<think> …" with no closing tag, leaving its
  // reasoning — full of braces — in the string. Without this, the brace
  // scan below counts braces inside the reasoning and corrupts the JSON.
  s = s.replace(/<(?:think|thinking|reasoning|thought)\b[^>]*>[\s\S]*$/i, '');
  // Strip fences
  if (s.startsWith('```')) {
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  }
  // Brace-match from the first '{' to its balanced close, ignoring braces
  // inside strings — far more robust than first-'{'…last-'}', which slices
  // across stray braces left in leading/trailing prose or reasoning text.
  const balanced = extractBalancedObject(s);
  if (balanced) return balanced;
  // Fallback: naive first-'{'…last-'}' slice (kept as a last defense).
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first < 0 || last <= first) return s;
  return s.slice(first, last + 1);
}

/**
 * Return the first brace-balanced `{…}` substring, or null if none. Tracks
 * string state (and escapes) so braces inside JSON string values don't throw
 * off the depth count.
 */
function extractBalancedObject(s: string): string | null {
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

function asStr(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

function asUrl(v: unknown): string | null {
  const s = asStr(v);
  if (!s) return null;
  // Accept bare domain or full URL; normalize to include protocol.
  if (/^https?:\/\//i.test(s)) return s;
  if (/^[a-z0-9.-]+\.[a-z]{2,}(\/.*)?$/i.test(s)) return `https://${s}`;
  return s;
}

function asOtherSocials(v: unknown): Array<{ platform: string; url: string }> {
  if (!Array.isArray(v)) return [];
  const out: Array<{ platform: string; url: string }> = [];
  for (const item of v) {
    if (!item || typeof item !== 'object') continue;
    const platform = asStr((item as any).platform);
    const url = asUrl((item as any).url);
    if (platform && url) out.push({ platform, url });
  }
  return out;
}

// Never throw out of the parser — a single unparseable LLM response must
// not crash the enrichment run. On any failure (empty, invalid JSON, non-
// object) we return null and let the caller record it as a soft failure.
export function parseEnrichmentResponse(raw: string): ContactEnrichment | null {
  if (!raw || !raw.trim()) return null;
  const body = isolateJsonObject(raw);
  let data: any;
  try {
    data = JSON.parse(body);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;

  return {
    fullName: asStr(data.fullName),
    designation: asStr(data.designation),
    department: asStr(data.department),
    companyName: asStr(data.companyName),
    companyDomain: asStr(data.companyDomain)?.toLowerCase() || null,
    companyWebsite: asUrl(data.companyWebsite),
    companyAddress: asStr(data.companyAddress),
    linkedinUrl: asUrl(data.linkedinUrl),
    twitterUrl: asUrl(data.twitterUrl),
    githubUrl: asUrl(data.githubUrl),
    personalPhone: asStr(data.personalPhone),
    companyPhone: asStr(data.companyPhone),
    whatsappNumber: asStr(data.whatsappNumber),
    personalEmail: asStr(data.personalEmail)?.toLowerCase() || null,
    location: asStr(data.location),
    pronouns: asStr(data.pronouns),
    otherSocials: asOtherSocials(data.otherSocials),
    notes: asStr(data.notes),
  };
}
