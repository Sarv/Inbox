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

  it('excludes the owning account and its aliases, retaining an unrelated account as an intentional recipient', () => {
    const source = { fromAddress: 'client@example.com', toAddress: 'owner@work.test, alias@work.test, active@home.test', ccAddress: 'ALIAS@work.test, teammate@work.test' };
    expect(replyRecipients(source, 'replyAll', 'owner@work.test', ['owner@work.test', 'alias@work.test'])).toEqual({
      to: 'client@example.com', cc: 'active@home.test, teammate@work.test',
    });
  });

  it('deduplicates the sender and To/Cc case-insensitively without losing the first recipient spelling', () => {
    expect(replyRecipients({ fromAddress: 'Alice <ALICE@example.com>',
      toAddress: 'alice@example.com, Bob <bob@example.com>, BOB@example.com, me@example.com',
      ccAddress: 'BOB@example.com, Carol <carol@example.com>, CAROL@example.com, ALICE@example.com',
    }, 'replyAll', ME)).toEqual({ to: 'ALICE@example.com', cc: 'bob@example.com, carol@example.com' });
  });

  it.each(['reply', 'replyAll'] as const)('follows up an own send-as alias in %s mode', mode => {
    const source = { fromAddress: 'Sales <SALES@work.test>', toAddress: 'client@example.com, owner@work.test, sales@work.test, CLIENT@example.com',
      ccAddress: 'client@example.com, other@example.com, SALES@work.test' };
    expect(replyRecipients(source, mode, 'owner@work.test', ['sales@work.test'])).toEqual({
      to: 'client@example.com', cc: mode === 'replyAll' ? 'other@example.com' : '',
    });
  });

  it.each(['reply', 'replyAll'] as const)('answers external Cc when a self-sent alias message has no external To (%s)', mode => {
    expect(replyRecipients({ fromAddress: 'sales@work.test', toAddress: 'owner@work.test, sales@work.test', ccAddress: 'client@example.com, CLIENT@example.com' },
      mode, 'owner@work.test', ['sales@work.test'])).toEqual({ to: 'client@example.com', cc: '' });
  });

  it('plain reply to an incoming message does not add other recipients', () => {
    expect(replyRecipients(incoming, 'reply', ME, ['alias@example.com'])).toEqual({ to: 'alice@example.com', cc: '' });
  });
});
