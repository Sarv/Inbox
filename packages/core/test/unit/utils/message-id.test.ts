import { describe, expect, it } from 'vitest';

import { messageIdKey } from '../../../src/utils/message-id';

// What breaks if this file fails: every Message-ID→UID lookup in the app misses.
// `fetchMessageIdToUidMap` builds its map with this function and the Sent dedupe
// and the Drafts server-delete look up with it, so a change on one side only
// looks like "the message isn't on the server" — a duplicate Sent copy, and a
// discarded draft that comes back on the next sync.
describe('messageIdKey', () => {
  // Breaks: `<id@host>` from a stored row never matches the bare id the map is
  // keyed by, which is the whole reason the key form exists.
  it('strips angle brackets from either form', () => {
    expect(messageIdKey('<abc@host>')).toBe('abc@host');
    expect(messageIdKey('abc@host')).toBe('abc@host');
  });

  // Breaks: servers echo Message-IDs with their own casing, so a case-sensitive
  // key misses a message that is right there.
  it('lower-cases and trims', () => {
    expect(messageIdKey('  <ABC@Host.COM>  ')).toBe('abc@host.com');
  });

  // Breaks: a row saved offline has no Message-ID yet; throwing here takes the
  // whole delete or dedupe down instead of simply finding nothing.
  it('answers empty for a missing id', () => {
    expect(messageIdKey('')).toBe('');
    expect(messageIdKey(null)).toBe('');
    expect(messageIdKey(undefined)).toBe('');
  });

  // Breaks: the same id in two forms produces two keys, so a map keyed by one
  // can never be read with the other.
  it('collapses every form of the same id onto one key', () => {
    const forms = ['<a@b>', 'a@b', ' A@B ', '<A@b> '];
    expect(new Set(forms.map(messageIdKey)).size).toBe(1);
  });
});
