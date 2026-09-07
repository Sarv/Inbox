import { describe, it, expect } from 'vitest';

import { isExpectedMessage } from '../../../src/imap/message-processor';

const msg = (messageId: string | undefined) =>
  ({ envelope: { messageId } }) as any;

describe('isExpectedMessage', () => {
  it('accepts the message we asked for', () => {
    expect(isExpectedMessage(msg('<a@sarv.com>'), '<a@sarv.com>')).toBe(true);
  });

  it('REJECTS a different message — the wrong-mailbox UID collision', () => {
    // What actually happened: a body fetch for UID 56 resolved in a mailbox that
    // had been re-selected underneath it, and a newsletter's body was written
    // onto an unrelated work email.
    expect(isExpectedMessage(msg('<newsletter@snyk.io>'), '<ops@sarv.com>')).toBe(false);
  });

  it('does not block a body when the SERVER omits the message-id', () => {
    expect(isExpectedMessage(msg(undefined), '<a@sarv.com>')).toBe(true);
    expect(isExpectedMessage(msg(''), '<a@sarv.com>')).toBe(true);
  });

  it('does not block a body when WE have no stored message-id', () => {
    expect(isExpectedMessage(msg('<a@sarv.com>'), null)).toBe(true);
    expect(isExpectedMessage(msg('<a@sarv.com>'), undefined)).toBe(true);
    expect(isExpectedMessage(msg('<a@sarv.com>'), '')).toBe(true);
  });

  it('tolerates a missing envelope', () => {
    expect(isExpectedMessage({ envelope: undefined } as any, '<a@sarv.com>')).toBe(true);
  });
});
