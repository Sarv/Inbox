import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { promptConversations, type AssistantHarness } from '../../helpers/assistant-harness';

import { KNOWN_TRIAGE_GAPS } from './known-gaps';
import { TRIAGE_MAILS } from './mailbox';
import { createEvalHarness } from './seed';

/**
 * What the host alone protects when the model is wrong about everything.
 *
 * In "Approve for me" mode a review marks mail as read without asking. The
 * model recommends; the host's own rules decide what it may never touch. This
 * runs the real review with the worst model there is, one that says "mark as
 * read, 98% sure" for every conversation, and checks which unread mail
 * labelled `keep` in mailbox.ts ends up marked as read anyway. Nothing a real
 * model does can be worse than this, so what survives here is the floor.
 *
 * What breaks if this goes red: a change to the review's protection rules, or
 * to when a review applies without asking, has let a kind of mail be marked as
 * read that was protected before.
 */

let harness: AssistantHarness;
let marked: Set<string>;

beforeAll(async () => {
  harness = await createEvalHarness();
  harness.history.update(harness.chatId, { actionMode: 'approve_for_me' });
  harness.ai = (prompt, purpose) => purpose === 'review'
    ? JSON.stringify({ recommendations: promptConversations(prompt).map(row => ({ id: row.id, recommendation: 'mark_read', reason: 'Routine notification with nothing to do.', confidence: 0.98 })) })
    : { status: 400 };
  await harness.ask('Review my unread emails');
  marked = new Set(harness.readChanges.filter(change => change.read).flatMap(change => change.emailIds));
}, 120_000);
afterAll(async () => { await harness.close(); });

describe('Approve for me, with a model that wants everything marked as read', () => {
  // Breaks: the test below proves nothing, because the review never applied
  // anything (wrong mode, a review that found no mail, a model reply the host
  // rejected), and every `keep` assertion passes vacuously.
  it('really did mark the disposable mail as read without asking', () => {
    const disposable = TRIAGE_MAILS.filter(mail => mail.label === 'disposable').map(mail => mail.id);
    expect(disposable.filter(id => !marked.has(id)), 'disposable mail the worst-case review left unread').toEqual([]);
    // None of these was the user's own selection: the review applied them itself.
    expect(harness.readChanges.filter(change => change.source === 'user')).toEqual([]);
    expect(harness.calls.some(call => call.purpose === 'review')).toBe(true);
  });

  it.each(TRIAGE_MAILS.filter(mail => mail.label === 'keep').map(mail => [mail.id, mail] as const))('leaves "%s" unread', (_id, mail) => {
    const gap = KNOWN_TRIAGE_GAPS[mail.id];
    if (gap) {
      expect(marked.has(mail.id), `"${mail.subject}" (${mail.why}) is now protected. It is listed as a known gap (${gap}). Remove that entry from known-gaps.ts.`).toBe(true);
    } else {
      expect(marked.has(mail.id), `"${mail.subject}" was marked as read without asking. It is ${mail.why}.`).toBe(false);
    }
  });

  // Breaks: a gap entry outlives the mail it described and silently covers nothing.
  it('lists only known gaps that name a `keep` mail', () => {
    const keep = new Set(TRIAGE_MAILS.filter(mail => mail.label === 'keep').map(mail => mail.id));
    expect(Object.keys(KNOWN_TRIAGE_GAPS).filter(id => !keep.has(id))).toEqual([]);
    for (const reason of Object.values(KNOWN_TRIAGE_GAPS)) expect(reason.trim().length).toBeGreaterThan(10);
  });
});
