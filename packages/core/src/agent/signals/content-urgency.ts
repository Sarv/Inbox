/**
 * Signal 5: Content Urgency
 *
 * Regex-based deadline/question/urgency detection.
 * No LLM call — fast and free. LLM only used when other signals > 40 AND regex is ambiguous.
 */

import type { ContentUrgencySignal } from './types';

const DEADLINE_PATTERNS = [
  /\b(by|before|due|deadline)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|today|tonight|eod|end of day|end of week|cob|close of business)\b/i,
  /\b(by|before|due|deadline)\s+\d{1,2}(\/|-)\d{1,2}/i,
  /\b(by|before|due)\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+\d{1,2}/i,
  /\bdeadline\b/i,
  /\boverdue\b/i,
  /\bexpir(es?|ing|ed)\b/i,
];

const URGENCY_PATTERNS = [
  /\b(urgent|asap|immediately|right away|time.?sensitive|critical|emergency)\b/i,
  /\b(as soon as possible|at your earliest|at the earliest)\b/i,
  /\b(action required|action needed|immediate action)\b/i,
  /\b(please respond|please reply|awaiting your|waiting for your)\b/i,
];

const QUESTION_PATTERNS = [
  /\?\s*$/m, // Line ending with ?
  /\b(can you|could you|would you|will you|do you|are you|have you|did you)\b.*\?/i,
  /\b(what|when|where|how|why|which)\b.*\?/i,
  /\b(please (let me know|confirm|advise|share|update|send))\b/i,
];

const APPROVAL_PATTERNS = [
  /\b(please (approve|sign|review and approve|confirm|authorize))\b/i,
  /\b(need(s)?\s+(your\s+)?(approval|sign.?off|confirmation|authorization|go.?ahead))\b/i,
  /\b(pending (your|approval|review))\b/i,
  /\b(awaiting (your\s+)?(approval|sign|confirmation))\b/i,
];

const FINANCIAL_PATTERNS = [
  /\b(invoice|payment|amount due|billing|receipt|refund|transaction)\b/i,
  /\$\s?\d+/,
  /\b(₹|€|£)\s?\d+/,
  /\b\d+\s*(USD|INR|EUR|GBP)\b/i,
];

export function computeContentUrgency(
  subject: string,
  body: string,
  userName: string,
): ContentUrgencySignal {
  const text = `${subject}\n${body}`.replace(/<[^>]+>/g, ''); // Strip HTML
  const textLower = text.toLowerCase();

  const hasDeadline = DEADLINE_PATTERNS.some(p => p.test(text));
  const hasUrgencyMarkers = URGENCY_PATTERNS.some(p => p.test(text));
  const hasDirectQuestion = QUESTION_PATTERNS.some(p => p.test(text));
  const hasApprovalRequest = APPROVAL_PATTERNS.some(p => p.test(text));
  const hasFinancialContent = FINANCIAL_PATTERNS.some(p => p.test(text));

  // User name mentioned in body (not just headers)
  const userNameMentioned = userName.length >= 2 &&
    userName.toLowerCase().split(/\s+/).some(part =>
      part.length >= 2 && textLower.includes(part.toLowerCase())
    );

  // Score computation
  let value = 0;
  const reasons: string[] = [];

  if (hasDeadline) { value += 0.35; reasons.push('deadline detected'); }
  if (hasUrgencyMarkers) { value += 0.25; reasons.push('urgency markers'); }
  if (hasDirectQuestion) { value += 0.15; reasons.push('question for user'); }
  if (hasApprovalRequest) { value += 0.30; reasons.push('approval needed'); }
  if (hasFinancialContent) { value += 0.15; reasons.push('financial content'); }
  if (userNameMentioned) { value += 0.10; reasons.push('user mentioned by name'); }

  value = Math.min(1, value);

  // Confidence: regex is pattern-based, not perfect
  const confidence = reasons.length > 0 ? 0.65 : 0.3;

  return {
    value,
    confidence,
    reasoning: reasons.length > 0 ? reasons.join(', ') : 'No urgency signals detected',
    hasDeadline,
    hasDirectQuestion,
    hasUrgencyMarkers,
    hasApprovalRequest,
    hasFinancialContent,
    userNameMentioned,
  };
}
