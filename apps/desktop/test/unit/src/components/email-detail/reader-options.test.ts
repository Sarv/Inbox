import { describe, expect, it } from 'vitest';

import { readerCurrentUserEmail, readerFolderFlags } from '../../../../../src/components/email-detail/reader-options';

const accounts = [{ id: 'active', email: 'rc@primary.example' }, { id: 'source', email: 'sales@secondary.example' }];

describe('embedded mail reader context', () => {
  it('uses the source account identity for a Sent message addressed to an external customer', () => {
    expect(readerCurrentUserEmail({ threadOnly: true, threadAccountId: 'source', accounts, fallback: 'rc@primary.example' })).toBe('sales@secondary.example');
    expect(readerCurrentUserEmail({ threadAccountId: 'source', accounts, fallback: 'rc@primary.example' })).toBe('rc@primary.example');
  });

  it('shows normal Sent actions even when the background mailbox is Spam or Trash', () => {
    for (const path of ['[Gmail]/Spam', 'Deleted Items']) {
      expect(readerFolderFlags({ threadOnly: true, tags: '|Sent Items|', selectedFolder: { path } })).toEqual({ isInTrash: false, isInSpam: false });
    }
  });

  it('uses the cited message folders after it is moved, preserving ordinary Mail folder behavior', () => {
    expect(readerFolderFlags({ threadOnly: true, tags: '|[Gmail]/Trash|', selectedFolder: { path: 'INBOX' } })).toEqual({ isInTrash: true, isInSpam: false });
    expect(readerFolderFlags({ threadOnly: true, tags: '|Junk Email|', selectedFolder: { path: 'INBOX' } })).toEqual({ isInTrash: false, isInSpam: true });
    expect(readerFolderFlags({ tags: '|Sent|', selectedFolder: { path: 'Deleted Items' } })).toEqual({ isInTrash: true, isInSpam: false });
  });
});
