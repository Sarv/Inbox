import type { EmailRecord } from '@sarvinbox/core';

import type { InboxAssistantReviewDateFilter } from '../../src/types/inbox-assistant-actions';

const MAX_AGE_DAYS = 36_500;

export interface InboxAssistantReviewDateRequest {
  question: string;
  dateFilter?: InboxAssistantReviewDateFilter;
  invalid?: true;
}

/** Recognize one age clause only; the router must still validate all remaining text. */
export function parseInboxAssistantReviewDate(question: string, nowMs: number): InboxAssistantReviewDateRequest {
  const markers = [...question.matchAll(/\b(?:older|more)\s+(?:than|then)\s*/giu)];
  if (!markers.length) return { question };
  if (markers.length !== 1 || !Number.isFinite(nowMs)) return { question, invalid: true };
  const marker = markers[0]!;
  const age = /^(\d{1,5})\s*days?\b/iu.exec(question.slice(marker.index + marker[0].length));
  if (!age) return { question, invalid: true };
  const olderThanDays = Number(age[1]);
  const before = Math.floor(nowMs / 1000) - olderThanDays * 86_400;
  const dateFilter = { olderThanDays, before };
  if (!validInboxAssistantReviewDateFilter(dateFilter)) return { question, invalid: true };
  const start = marker.index;
  const end = start + marker[0].length + age[0].length;
  // A second sentence such as the observed "mark olf email more then 115 days
  // READ" narrows this low-value review. It never creates an all-old-mail rule.
  const commandStart = /\bmark\s+(?:(?:all|my|the)\s+)?(?:old|olf)\s+(?:unread\s+)?(?:emails?|mail|messages?|conversations?|threads?)\s+$/iu.exec(question.slice(0, start));
  const commandEnd = /^(?:\s+as)?\s+read\b[.!?]*/iu.exec(question.slice(end));
  if (!(commandStart && commandEnd) && /\b(?:keep|leave|retain|preserve|protect)\b/iu.test(question.slice(0, start))) return { question, invalid: true };
  const removalStart = commandStart && commandEnd ? commandStart.index : start;
  const removalEnd = commandStart && commandEnd ? end + commandEnd[0].length : end;
  const prefix = question.slice(0, removalStart);
  // Negation anywhere in the selection clause can reverse the age predicate.
  // A separate mark-old sentence may follow negative keep-only preferences.
  const selectionPrefix = commandStart && commandEnd ? prefix.split(/[.!?;]/u).at(-1)! : prefix;
  if (/\b(?:not|no|never|except|excluding|without|don['’]t)\b/iu.test(selectionPrefix)) return { question, invalid: true };
  const remainder = `${commandStart && commandEnd ? prefix.replace(/[.;!?]\s*$/u, '') : prefix} ${question.slice(removalEnd)}`.trim();
  return { question: remainder, dateFilter };
}

export function validInboxAssistantReviewDateFilter(value: unknown): value is InboxAssistantReviewDateFilter {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const filter = value as InboxAssistantReviewDateFilter;
  return Object.keys(filter).sort().join() === 'before,olderThanDays'
    && Number.isSafeInteger(filter.olderThanDays) && filter.olderThanDays >= 1 && filter.olderThanDays <= MAX_AGE_DAYS
    && Number.isSafeInteger(filter.before) && filter.before > 0 && filter.before <= 8_640_000_000_000;
}

export function matchesInboxAssistantReviewDate(email: Pick<EmailRecord, 'date'>, filter?: InboxAssistantReviewDateFilter): boolean {
  return !filter || (Number.isSafeInteger(email.date) && email.date > 0 && email.date < filter.before);
}

export function inboxAssistantReviewDateLabel(filter: InboxAssistantReviewDateFilter): string {
  return `older than ${filter.olderThanDays} days`;
}
