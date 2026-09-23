import { describe, expect, it } from 'vitest';

import { threadHeaderLabel } from '../../../../../src/components/email-detail/thread-header-label';
import { collapseDuplicateMessages } from '../../../../../src/utils/duplicate-messages';

import { ELEVEN_AM, email, TEN_AM } from './email-fixture';

/**
 * The participant + count line above an opened conversation.
 *
 * What breaks if this file goes red: the opened thread starts counting the CARDS
 * it drew instead of the messages the conversation holds. Duplicate copies are
 * folded behind one card (render-only), so a thread the list row labelled "(3)"
 * headed itself "(2)" — reported from the field, and indistinguishable from mail
 * that silently failed to sync.
 */
describe('threadHeaderLabel', () => {
  // The reported bug, end to end: the same two pure pieces the detail pane
  // composes. Two of the three rows are the SAME message (one Message-ID, synced
  // under two accounts), so ONE card is folded away — and the header must still
  // say 3, the number the list row shows. The shared `messageId` is what makes
  // them one message; without it they are two mails and nothing folds.
  it('counts folded duplicate copies, so the header matches the list row', () => {
    const body = '<p>Your OTP code is 831503.</p>';
    const sameMessage = '<one-and-the-same@acme.example>';
    const thread = [
      email({ id: 'first', date: TEN_AM, rawBody: '<p>A request was received.</p>' }),
      email({ id: 'copy-a', date: ELEVEN_AM, uid: 2, rawBody: body, messageId: sameMessage }),
      email({ id: 'copy-b', date: ELEVEN_AM + 60, uid: 3, rawBody: body, messageId: sameMessage }),
    ];

    const visible = collapseDuplicateMessages(thread).map((group) => group.email);

    // The fold really happened — otherwise this test would pass for the wrong reason.
    expect(visible).toHaveLength(2);
    expect(threadHeaderLabel(visible, thread.length)).toBe('Alice Chen (3)');
  });

  // A thread with nothing folded must be unaffected: the total and the visible
  // count are the same number, and the label names both ends of the conversation.
  it('names the first and last participant of an ordinary thread', () => {
    const thread = [
      email({ id: 'a', date: TEN_AM }),
      email({ id: 'b', date: ELEVEN_AM, fromName: 'Bob Lin', fromAddress: 'bob@acme.example' }),
      email({ id: 'c', date: ELEVEN_AM + 60, fromName: 'Dana Ray', fromAddress: 'dana@acme.example' }),
    ];

    expect(threadHeaderLabel(thread, thread.length)).toBe('Alice Chen .. Dana Ray (3)');
  });

  // Ends are taken by DATE, not by array order: the store hands the detail pane
  // its thread newest-first in some paths, and a label read off the raw order
  // would name the last participant first.
  it('orders the participants by date, whatever order it is handed', () => {
    const newestFirst = [
      email({ id: 'c', date: ELEVEN_AM + 60, fromName: 'Dana Ray', fromAddress: 'dana@acme.example' }),
      email({ id: 'a', date: TEN_AM }),
    ];

    expect(threadHeaderLabel(newestFirst, 2)).toBe('Alice Chen .. Dana Ray (2)');
  });

  // Sorting must not reorder the caller's array — it is the same array the cards
  // render from, and a mutated copy would shuffle the conversation on screen.
  it('does not mutate the array it is given', () => {
    const newestFirst = [
      email({ id: 'c', date: ELEVEN_AM, fromName: 'Dana Ray', fromAddress: 'dana@acme.example' }),
      email({ id: 'a', date: TEN_AM }),
    ];

    threadHeaderLabel(newestFirst, 2);

    expect(newestFirst.map((e) => e.id)).toEqual(['c', 'a']);
  });

  // One participant is not "Alice .. Alice" — the vast majority of threads.
  it('names a single participant once', () => {
    const thread = [email({ id: 'a', date: TEN_AM }), email({ id: 'b', date: ELEVEN_AM })];

    expect(threadHeaderLabel(thread, 2)).toBe('Alice Chen (2)');
  });

  // The header also fronts a SINGLE email whose body embeds a forwarded chain
  // (loop-me-in). There is no message count to show there — one stored message —
  // so the count must not leak into the sentence.
  it('describes a single visible email as a forwarded conversation', () => {
    const forwarded = [email({ id: 'a', date: TEN_AM })];

    expect(threadHeaderLabel(forwarded, 1)).toBe('Alice Chen forwarded a conversation');
  });

  // Machine senders (noreply@…) routinely have no display name; the header must
  // not render an empty gap where the participant belongs.
  it('falls back to the local part when a sender has no display name', () => {
    const thread = [
      email({ id: 'a', date: TEN_AM, fromName: null, fromAddress: 'noreply.practice@expandtesting.com' }),
      email({ id: 'b', date: ELEVEN_AM, fromName: null, fromAddress: 'noreply.practice@expandtesting.com' }),
    ];

    expect(threadHeaderLabel(thread, 2)).toBe('noreply.practice (2)');
  });

  // A row with neither name nor address still has to produce a label rather than
  // throwing inside the render tree.
  it('survives a message with no sender at all', () => {
    const thread = [
      email({ id: 'a', date: TEN_AM, fromName: null, fromAddress: '' }),
      email({ id: 'b', date: ELEVEN_AM, fromName: null, fromAddress: '' }),
    ];

    expect(threadHeaderLabel(thread, 2)).toBe(' (2)');
  });
});
