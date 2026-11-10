import { describe, expect, it } from 'vitest';

import { computeThreadDynamics } from '../../../src/agent/signals/thread-dynamics';
import type { ThreadStats } from '../../../src/agent/signals/types';

// Thread dynamics decides whether the user owns, takes part in, or is merely
// copied on a conversation, and whether their name is in the body — a priority
// signal computed for every email, on a body a stranger wrote.

const stats = (over: Partial<ThreadStats>): ThreadStats => ({
  participantCount: 3,
  userMessageCount: 0,
  totalMessages: 3,
  userStarted: false,
  lastActivityAt: Math.floor(Date.now() / 1000),
  ...over,
});

describe('computeThreadDynamics — name mention', () => {
  // Breaks: a name inside markup ("<b>Ann</b>") is missed, or a tag attribute
  // counts as a mention.
  it('finds the user name in the text of an HTML body, not in its tags', () => {
    expect(computeThreadDynamics(null, '<p>Thanks <b>Ann</b>!</p>', 'Ann Lee', false).role).toBe('mentioned');
    expect(computeThreadDynamics(null, '<a title="ann">link</a>', 'Ann Lee', false).role).toBe('single');
  });

  // Breaks: a body of unclosed `<` stalls priority scoring. The strip was
  // `/<[^>]+>/g`, quadratic (CodeQL js/polynomial-redos): 200 K `<` took about
  // 14 s, so this test timed out under it.
  it('scores a body of 200 K unclosed "<" at once', () => {
    expect(computeThreadDynamics(null, `${'<'.repeat(200_000)}ann`, 'Ann', false).role).toBe('mentioned');
    expect(computeThreadDynamics(stats({}), '<'.repeat(200_000), 'Ann', false).role).toBe('late_addition');
  });
});

describe('computeThreadDynamics — roles', () => {
  // Breaks: a thread the user was added to without replying stops being told
  // apart from one where they are named (the branch whose `!userStarted` test
  // CodeQL js/trivial-conditional flagged as always true — it is, the
  // initiator branch above already took every userStarted thread).
  it('tells a late addition from a mention when the user has not replied', () => {
    expect(computeThreadDynamics(stats({}), 'status update', 'Ann', false)).toMatchObject({ role: 'late_addition', value: 0.25 });
    expect(computeThreadDynamics(stats({}), 'Ann, can you check?', 'Ann', false)).toMatchObject({ role: 'mentioned', value: 0.6 });
  });

  // Breaks: a thread the user started is scored as anything but theirs.
  it('makes the user the initiator of a thread they started, even before replying', () => {
    expect(computeThreadDynamics(stats({ userStarted: true }), 'x', 'Ann', false).role).toBe('initiator');
  });
});
