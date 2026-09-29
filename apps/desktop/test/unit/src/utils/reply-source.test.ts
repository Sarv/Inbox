import { describe, expect, it } from 'vitest';

import { toReplySource } from '../../../../src/utils/reply-source';

// What breaks if this suite goes red: an inline reply that does not thread
// (no Message-ID), drafts into the wrong account, or — for encrypted mail —
// no longer defaults to encrypted, because a call site dropped the field.
const row = {
  id: 'e1', messageId: '<m1@x.org>', threadId: 't1', accountId: 'acc-2', subject: 'Plans',
  fromAddress: 'a@x.org', fromName: 'A', toAddress: 'me@x.org', ccAddress: null, date: 1_700_000_000,
  cleanBody: 'hi', rawBody: '<p>hi</p>', pgpStatus: 'encrypted' as const,
};

describe('toReplySource', () => {
  // Breaks: threading, send-as and the encrypted-reply default, all at once.
  it('carries the threading, account and OpenPGP fields through', () => {
    expect(toReplySource(row)).toMatchObject({ messageId: '<m1@x.org>', threadId: 't1', accountId: 'acc-2', pgpStatus: 'encrypted' });
  });

  // Breaks: a null subject / To renders as "Re: null", and a null id reaches In-Reply-To.
  it('turns missing subject, To and ids into empty strings or undefined', () => {
    const source = toReplySource({ ...row, subject: null, toAddress: null, messageId: null, threadId: null });
    expect(source).toMatchObject({ subject: '', toAddress: '' });
    expect(source.messageId).toBeUndefined();
    expect(source.threadId).toBeUndefined();
  });
});
