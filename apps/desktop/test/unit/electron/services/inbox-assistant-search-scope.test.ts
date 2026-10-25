import { describe, expect, it } from 'vitest';

import { INBOX_ASSISTANT_FOLLOWUP_SEPARATOR } from '../../../../electron/services/inbox-assistant-context';
import { matchesInboxAssistantTerm, meaningfulInboxAssistantTerms, resolveInboxAssistantSearchScope } from '../../../../electron/services/inbox-assistant-search-scope';

describe('Inbox Agent host-derived search constraints', () => {
  it('interprets today in the selected local timezone even when UTC is the previous date', () => {
    const scope = resolveInboxAssistantSearchScope('is any meetings invite today', { nowMs: Date.parse('2026-10-22T19:00:00Z'), timeZone: 'Asia/Kolkata' });
    expect(scope.filters).toEqual({ after: '2026-10-23', before: '2026-10-24' });
    expect(scope.timeWindow).toMatchObject({ dateFrom: Date.parse('2026-10-22T18:30:00Z') / 1000, dateTo: Date.parse('2026-10-23T18:30:00Z') / 1000 - 1, timeZone: 'Asia/Kolkata' });
    expect(scope.timeWindow?.label).toContain('message dates');
    expect(scope.topicTerms).toEqual(['meeting']);
    expect(scope.queryTerms).not.toEqual(expect.arrayContaining(['any', 'today']));
    expect(scope.meetingIntent).toBe(true);
    expect(scope.invitationIntent).toBe(true);
  });

  it.each([
    ['2026-03-08T15:00:00Z', '2026-03-08T05:00:00Z', '2026-03-09T04:00:00Z', 23],
    ['2026-11-01T15:00:00Z', '2026-11-01T04:00:00Z', '2026-11-02T05:00:00Z', 25],
  ])('uses real local-day boundaries across DST at %s', (now, start, end, hours) => {
    const window = resolveInboxAssistantSearchScope('meeting invitations today', { nowMs: Date.parse(now), timeZone: 'America/New_York' }).timeWindow!;
    expect(window.dateFrom).toBe(Date.parse(start) / 1000);
    expect(window.dateTo).toBe(Date.parse(end) / 1000 - 1);
    expect(window.dateTo + 1 - window.dateFrom).toBe(hours * 3600);
  });

  it('keeps a named company and the meeting family as independently required groups', () => {
    const scope = resolveInboxAssistantSearchScope('any TCS meeting invitations today?', { today: '2026-10-23', timeZone: 'UTC' });
    const matches = (value: string) => scope.topicGroups.every(group => group.some(term => matchesInboxAssistantTerm(value, term)));
    expect(matches('TCS Meeting Confirmation')).toBe(true);
    expect(matches('TCS invitation')).toBe(true);
    expect(matches('TCS pricing escalation')).toBe(false);
    expect(matches('Other company Meeting Confirmation')).toBe(false);
    expect(matchesInboxAssistantTerm('PostCSS', 'TCS')).toBe(false);
    expect(matchesInboxAssistantTerm('EPFO3.0', 'EPFO')).toBe(true);
  });

  it.each([
    'Are there any meeting invites in my inbox today?',
    'What meeting invites arrived today?',
    'Create a summary of meeting invitations received today',
    'Create a list of meetings mentioned in email',
  ])('does not require research/mailbox grammar to appear in invitation content: %s', question => {
    const scope = resolveInboxAssistantSearchScope(question, { today: '2026-10-23', timeZone: 'UTC' });
    expect(scope.topicTerms).toEqual(['meeting']);
    expect(scope.topicGroups).toHaveLength(1);
    expect(scope.topicGroups.every(group => group.some(term => matchesInboxAssistantTerm('Meeting Confirmation | Sarv <> Vembu', term)))).toBe(true);
  });

  it('retains real company and sender anchors while ignoring arrival and mailbox grammar', () => {
    const scope = resolveInboxAssistantSearchScope('What TCS meeting invitations arrived from Prakash in my inbox today?', { today: '2026-10-23', timeZone: 'UTC' });
    expect(scope.topicTerms).toEqual(['TCS', 'Prakash', 'meeting']);
    expect(scope.topicGroups.slice(0, 2)).toEqual([['TCS'], ['Prakash']]);
    expect(scope.queryTerms).toEqual(expect.arrayContaining(['TCS', 'Prakash']));
    expect(scope.queryTerms).not.toEqual(expect.arrayContaining(['arrived', 'inbox']));
  });

  it('never interprets functional words as topics, or negated/ambiguous dates as today only', () => {
    expect(meaningfulInboxAssistantTerms(['any', 'today', 'show me', 'TCS', 'Meeting Confirmation'])).toEqual(['TCS', 'Meeting Confirmation']);
    expect(resolveInboxAssistantSearchScope('meetings not today', { timeZone: 'UTC' }).timeWindow).toBeUndefined();
    expect(resolveInboxAssistantSearchScope('meetings today or tomorrow', { timeZone: 'UTC' }).timeWindow).toBeUndefined();
    expect(resolveInboxAssistantSearchScope('meetings since yesterday', { timeZone: 'UTC' }).timeWindow).toBeUndefined();
    expect(resolveInboxAssistantSearchScope('meetings last week and today', { timeZone: 'UTC' }).timeWindow).toBeUndefined();
    expect(resolveInboxAssistantSearchScope('do I have new meeting invitations today', { timeZone: 'UTC' }).topicTerms).toEqual(['meeting']);
    expect(resolveInboxAssistantSearchScope('meetings today', { timeZone: 'UTC' }).invitationIntent).toBeUndefined();
  });

  it('resolves last week as a local Monday range and does not inherit an old relative date', () => {
    const scope = resolveInboxAssistantSearchScope(`meeting invitations last week${INBOX_ASSISTANT_FOLLOWUP_SEPARATOR}TCS quote today`, { today: '2026-10-23', timeZone: 'Asia/Kolkata' });
    expect(scope.filters).toEqual({ after: '2026-10-12', before: '2026-10-19' });
    expect(scope.topicTerms).toEqual(['meeting']);
  });
});
