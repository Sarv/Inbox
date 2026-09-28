import { describe, expect, it } from 'vitest';

import { replyRecipients } from '../../../../src/utils/reply-recipients';

// Who a reply is addressed to. Wrong here and a reply goes to the wrong
// people — or, replying to our own sent message (the follow-up "Follow up"
// button), straight back to ourselves.

const ME = 'me@example.com';
const incoming = { fromAddress: 'alice@example.com', toAddress: 'Me <me@example.com>, bob@example.com', ccAddress: 'carol@example.com' };
const sent = { fromAddress: 'Me@Example.com', toAddress: 'Alice <alice@example.com>, me@example.com', ccAddress: 'carol@example.com, ME@example.com' };

describe('replyRecipients', () => {
  // Plain reply answers the sender only.
  it('replies to the sender of someone else\'s message', () => {
    expect(replyRecipients(incoming, 'reply', ME)).toEqual({ to: 'alice@example.com', cc: '' });
  });

  // Reply All keeps everyone else, minus us and the sender (already in To).
  it('reply-all copies everyone but us and the sender', () => {
    expect(replyRecipients(incoming, 'replyAll', ME)).toEqual({ to: 'alice@example.com', cc: 'bob@example.com, carol@example.com' });
  });

  // Our own message: back to the people we wrote to, never to ourselves.
  it('replies to our own message\'s recipients, case-insensitively', () => {
    expect(replyRecipients(sent, 'reply', ME)).toEqual({ to: 'alice@example.com', cc: '' });
    expect(replyRecipients(sent, 'replyAll', ME)).toEqual({ to: 'alice@example.com', cc: 'carol@example.com' });
  });

  // Unknown own address (not configured yet): behave as before, answer the sender.
  it('answers the sender when our address is unknown', () => {
    expect(replyRecipients({ fromAddress: 'alice@example.com' }, 'replyAll', '')).toEqual({ to: 'alice@example.com', cc: '' });
  });
});
