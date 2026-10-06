import { describe, expect, it } from 'vitest';

import { isSpamProtectedEmail } from '../../../src/utils/spam-protection';

describe('provider Spam protection before AI', () => {
  // Spam already known to the provider/filter needs no categorizer call.
  it.each(['|spam|', '|Spam|', '|Junk|', '|\\Junk|', '|\\Spam|', '|[Gmail]/Spam|', '|[GoogleMail]/Spam|', '|junk email|'])('protects Spam membership %s', (tags) => {
    expect(isSpamProtectedEmail({ tags })).toBe(true);
  });

  // Explicit ham clears local filter classification, but cannot clear provider membership before an unspam move.
  it('honors ham only after provider Spam/Junk membership is removed', () => {
    expect(isSpamProtectedEmail({ tags: '|INBOX|spam|', spamUserVerdict: 'ham' }, 'inbox')).toBe(false);
    expect(isSpamProtectedEmail({ tags: '|Spam|spam|', spamUserVerdict: 'ham' }, 'spam')).toBe(true);
    expect(isSpamProtectedEmail({ tags: '|\\Junk|', spamUserVerdict: 'ham' })).toBe(true);
    expect(isSpamProtectedEmail({ tags: '|INBOX|', spamUserVerdict: 'ham' }, { type: 'inbox' })).toBe(false);
    expect(isSpamProtectedEmail({ spamUserVerdict: 'spam' })).toBe(true);
  });

  // Localized Junk paths need explicit folder metadata rather than English-name guessing.
  it('protects provider metadata roles and both supported SPECIAL-USE forms', () => {
    expect(isSpamProtectedEmail({ spamUserVerdict: 'ham' }, { path: 'Abfall', specialUse: '\\Junk' })).toBe(true);
    expect(isSpamProtectedEmail({}, { path: 'Localized', specialUse: ['\\HasNoChildren', ' \\JUNK '] })).toBe(true);
    expect(isSpamProtectedEmail({}, { path: 'Localized', type: 'junk' })).toBe(true);
    expect(isSpamProtectedEmail({}, { path: 'Junk' })).toBe(true);
    expect(isSpamProtectedEmail({}, { path: 'Spam', specialUse: '\\Sent' })).toBe(false);
    expect(isSpamProtectedEmail({}, { path: 'Spam', type: 'archive' })).toBe(false);
  });

  // A linked localized Junk label still owns Spam even when All Mail is the primary folder and ham is stale.
  it('recognizes exact linked Junk membership without confusing unrelated folder names', () => {
    const folders = [{ path: 'Abfall', specialUse: '\\Junk' }, { path: 'Work/Spam' }, { specialUse: '\\Junk' }];
    expect(isSpamProtectedEmail({ tags: '|[Gmail]/All Mail|Abfall|', spamUserVerdict: 'ham' }, { type: 'archive' }, folders)).toBe(true);
    expect(isSpamProtectedEmail({ tags: '|[Gmail]/All Mail|', spamUserVerdict: 'ham' }, { type: 'archive' }, folders)).toBe(false);
    expect(isSpamProtectedEmail({ tags: '|Work/Spam|' }, null, folders)).toBe(false);
  });

  // Ordinary tags and absent metadata must not suppress categorization of unrelated mail.
  it('keeps ordinary mail eligible with empty/unknown metadata', () => {
    for (const tags of [undefined, null, '', '|INBOX|read|starred|important|', '|Work/Spam|']) {
      expect(isSpamProtectedEmail({ tags }, {}, [])).toBe(false);
    }
  });
});
