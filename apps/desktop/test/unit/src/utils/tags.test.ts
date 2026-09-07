import { describe, it, expect } from 'vitest';

import { addTag, buildTags, hasTag, parseTags, removeTag } from '../../../../src/utils/tags';

// Tags are the app's single storage format for folders + flags + AI categories
// (`|INBOX|read|starred|`). Every list query, badge and optimistic update does
// substring matching on this string, so the delimiter invariant — ALWAYS a
// leading and trailing pipe — is what makes `includes('|read|')` correct.

describe('buildTags', () => {
  it('wraps the list in pipes on both ends', () => {
    expect(buildTags(['INBOX', 'read'])).toBe('|INBOX|read|');
    expect(buildTags(['INBOX'])).toBe('|INBOX|');
  });

  it('represents "no tags" as || so hasTag still works on it', () => {
    // '' would break the delimiter invariant; '||' keeps every includes() check
    // safely false rather than accidentally matching.
    expect(buildTags([])).toBe('||');
    expect(hasTag(buildTags([]), 'read')).toBe(false);
  });
});

describe('parseTags', () => {
  it('round-trips a built string', () => {
    expect(parseTags(buildTags(['INBOX', 'read', 'starred']))).toEqual(['INBOX', 'read', 'starred']);
  });

  it('treats the empty markers as no tags', () => {
    expect(parseTags('||')).toEqual([]);
    expect(parseTags('')).toEqual([]);
    expect(parseTags(null as unknown as string)).toEqual([]);
  });

  it('drops empty segments from a doubled delimiter', () => {
    expect(parseTags('|INBOX||read|')).toEqual(['INBOX', 'read']);
  });

  it('preserves tags containing spaces and slashes (real folder paths)', () => {
    expect(parseTags('|[Gmail]/Sent Mail|Junk Email|')).toEqual(['[Gmail]/Sent Mail', 'Junk Email']);
  });
});

describe('hasTag', () => {
  it('matches only a whole delimited tag, never a substring', () => {
    // The reason tags are pipe-WRAPPED: 'read' must not match 'unread'/'already'.
    expect(hasTag('|INBOX|read|', 'read')).toBe(true);
    expect(hasTag('|INBOX|unread-ish|', 'read')).toBe(false);
    expect(hasTag('|Junk Email|', 'Junk')).toBe(false);
  });

  it('is safe on null/undefined/empty tags', () => {
    expect(hasTag(null, 'read')).toBe(false);
    expect(hasTag(undefined, 'read')).toBe(false);
    expect(hasTag('', 'read')).toBe(false);
  });

  it('is case-sensitive (folder tags carry the server\'s exact casing)', () => {
    expect(hasTag('|INBOX|', 'inbox')).toBe(false);
  });
});

describe('addTag', () => {
  it('appends a new tag, keeping the delimiters intact', () => {
    expect(addTag('|INBOX|', 'read')).toBe('|INBOX|read|');
  });

  it('is idempotent — re-adding returns the string UNCHANGED (identity preserved)', () => {
    // Optimistic updates call this on every click; a re-add must not reorder or
    // rebuild the string, or React sees a changed row for no reason.
    const tags = '|INBOX|read|';
    expect(addTag(tags, 'read')).toBe(tags);
  });

  it('promotes the empty marker to a real single-tag string', () => {
    expect(addTag('||', 'starred')).toBe('|starred|');
    expect(addTag('', 'starred')).toBe('|starred|');
  });
});

describe('removeTag', () => {
  it('removes just that tag and leaves the others in order', () => {
    expect(removeTag('|INBOX|read|starred|', 'read')).toBe('|INBOX|starred|');
  });

  it('collapses to the empty marker when the last tag goes', () => {
    expect(removeTag('|read|', 'read')).toBe('||');
  });

  it('is a no-op for a tag that is not present', () => {
    expect(removeTag('|INBOX|', 'read')).toBe('|INBOX|');
    expect(removeTag('||', 'read')).toBe('||');
  });

  it('removes every occurrence if a malformed string duplicated one', () => {
    expect(removeTag('|read|INBOX|read|', 'read')).toBe('|INBOX|');
  });

  it('round-trips with addTag', () => {
    expect(removeTag(addTag('|INBOX|', 'starred'), 'starred')).toBe('|INBOX|');
  });
});
