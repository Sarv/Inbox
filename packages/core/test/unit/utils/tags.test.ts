import { describe, it, expect } from 'vitest';

import {
  FLAG_TAG_NAMES,
  addTag,
  buildTags,
  hasTag,
  imapFlagsToTags,
  parseTags,
  removeTag,
  tagsToImapFlags,
} from '../../../src/utils/tags';

// The `|a|b|c|` encoding is not cosmetic: every folder/flag/category query is a
// SQL `instr(tags, '|tag|')`. So the ONLY thing that keeps those queries correct
// is that every tag is surrounded by pipes at all times — a string that ever
// loses a delimiter (or gains a bare `|`) silently changes what the DB matches.
// These tests pin that encoding contract.

describe('buildTags / parseTags', () => {
  // Every tag must be pipe-delimited on BOTH sides or `instr(tags,'|tag|')` misses it.
  it('wraps and separates every tag with pipes', () => {
    expect(buildTags(['INBOX', 'read', 'starred'])).toBe('|INBOX|read|starred|');
    expect(buildTags(['read'])).toBe('|read|');
  });

  // The empty state is the sentinel `||`, never '' — a bare '' would make
  // `hasTag` cheap-but-correct and `addTag` still work, but the DB column is
  // NOT NULL and rows are compared against '||' elsewhere.
  it('encodes "no tags" as the || sentinel, and decodes it back to []', () => {
    expect(buildTags([])).toBe('||');
    expect(parseTags('||')).toEqual([]);
  });

  it('parses an encoded string back to the exact tag list (round-trip)', () => {
    const list = ['INBOX', 'read', '[Gmail]/All Mail', 'needs_response'];
    expect(parseTags(buildTags(list))).toEqual(list);
  });

  // Legacy/garbage input must not produce phantom empty tags — `''` would encode
  // back as `||` and match every `instr` probe.
  it('never yields empty-string tags from empty, missing or double-piped input', () => {
    expect(parseTags('')).toEqual([]);
    expect(parseTags(undefined as unknown as string)).toEqual([]);
    expect(parseTags('|||read|||')).toEqual(['read']);
    expect(parseTags('|read|')).toEqual(['read']);
  });
});

describe('hasTag', () => {
  it('finds a tag anywhere in the string', () => {
    expect(hasTag('|INBOX|read|starred|', 'INBOX')).toBe(true);
    expect(hasTag('|INBOX|read|starred|', 'read')).toBe(true);
    expect(hasTag('|INBOX|read|starred|', 'starred')).toBe(true);
  });

  // THE substring trap: `read` must never match inside `unread`, and `star`
  // must never match inside `starred`. This is the whole reason for the pipes.
  it('does NOT false-match a tag that is a substring of another tag', () => {
    expect(hasTag('|unread|', 'read')).toBe(false);
    expect(hasTag('|starred|', 'star')).toBe(false);
    expect(hasTag('|important|', 'import')).toBe(false);
    expect(hasTag('|INBOX/Sub|', 'INBOX')).toBe(false);
    // ...but the real tag still matches when both are present.
    expect(hasTag('|unread|read|', 'read')).toBe(true);
  });

  it('is false for the empty sentinel and for missing/undefined input', () => {
    expect(hasTag('||', 'read')).toBe(false);
    expect(hasTag('', 'read')).toBe(false);
    expect(hasTag(undefined as unknown as string, 'read')).toBe(false);
  });

  // Folder paths are stored as tags verbatim, so spaces/slashes/brackets must work.
  it('matches folder-path tags containing spaces, slashes and brackets', () => {
    expect(hasTag('|INBOX|[Gmail]/All Mail|', '[Gmail]/All Mail')).toBe(true);
  });
});

describe('addTag', () => {
  it('appends a tag and keeps the encoding well-formed', () => {
    expect(addTag('|INBOX|', 'read')).toBe('|INBOX|read|');
  });

  // addTag runs on every flag change; a non-idempotent version would grow the
  // column without bound and break `removeTag` (which drops ALL copies at once).
  it('is idempotent — re-adding an existing tag returns the string unchanged', () => {
    expect(addTag('|INBOX|read|', 'read')).toBe('|INBOX|read|');
    expect(addTag(addTag('|INBOX|', 'read'), 'read')).toBe(addTag('|INBOX|', 'read'));
  });

  it('promotes empty / sentinel / missing input to a valid single-tag string', () => {
    expect(addTag('', 'read')).toBe('|read|');
    expect(addTag('||', 'read')).toBe('|read|');
    expect(hasTag(addTag('||', 'read'), 'read')).toBe(true);
  });

  // `read` already present must not block adding `unread` (substring safety on
  // the WRITE side, not just the read side).
  it('still adds a tag whose name is a substring of an existing tag', () => {
    expect(addTag('|unread|', 'read')).toBe('|unread|read|');
  });
});

describe('removeTag', () => {
  it('removes only the exact tag, preserving the others and the delimiters', () => {
    expect(removeTag('|INBOX|read|starred|', 'read')).toBe('|INBOX|starred|');
  });

  it('collapses back to the || sentinel when the last tag goes', () => {
    expect(removeTag('|read|', 'read')).toBe('||');
    expect(parseTags(removeTag('|read|', 'read'))).toEqual([]);
  });

  it('is a no-op (but still well-formed) for a tag that is not present', () => {
    expect(removeTag('|INBOX|', 'read')).toBe('|INBOX|');
    expect(removeTag('||', 'read')).toBe('||');
    expect(removeTag('', 'read')).toBe('||');
  });

  // Removing `read` must not also strip `unread`.
  it('does not remove a tag that merely contains the removed name', () => {
    expect(removeTag('|unread|read|', 'read')).toBe('|unread|');
    expect(hasTag(removeTag('|unread|read|', 'read'), 'unread')).toBe(true);
  });

  it('round-trips with addTag — add then remove restores the original', () => {
    const start = '|INBOX|read|';
    expect(removeTag(addTag(start, 'starred'), 'starred')).toBe(start);
  });
});

describe('imapFlagsToTags', () => {
  // The server speaks `\Seen`; the DB speaks `read`. A mistranslation here shows
  // up as every message looking unread (or every message looking read).
  it('maps each IMAP system flag to its tag name', () => {
    expect(imapFlagsToTags(['\\Seen'])).toEqual(['read']);
    expect(imapFlagsToTags(['\\Flagged'])).toEqual(['starred']);
    expect(imapFlagsToTags(['\\Answered'])).toEqual(['answered']);
    expect(imapFlagsToTags(['\\Draft'])).toEqual(['draft']);
    expect(imapFlagsToTags(['\\Deleted'])).toEqual(['deleted']);
  });

  it('maps a whole flag set at once, preserving order', () => {
    expect(imapFlagsToTags(['\\Seen', '\\Flagged', '\\Answered'])).toEqual([
      'read',
      'starred',
      'answered',
    ]);
  });

  // Servers advertise their own `\Flags` (e.g. `\Recent`, `\NonJunk`). Keep them
  // as lowercased tags rather than dropping them, so nothing is silently lost.
  it('keeps an unknown backslash flag as a lowercased tag', () => {
    expect(imapFlagsToTags(['\\Recent', '\\NonJunk'])).toEqual(['recent', 'nonjunk']);
    expect(imapFlagsToTags(['\\Seen', '\\SomeCustomFlag'])).toEqual(['read', 'somecustomflag']);
  });

  // Gmail keywords ($Phishing, keyword labels) are NOT `\`-flags — they must not
  // leak into the flag-derived tag set (they'd be mistaken for our own tags).
  it('drops non-backslash keywords entirely', () => {
    expect(imapFlagsToTags(['$Phishing', 'MyLabel'])).toEqual([]);
    expect(imapFlagsToTags(['\\Seen', '$Forwarded'])).toEqual(['read']);
  });

  it('returns [] for an empty flag list', () => {
    expect(imapFlagsToTags([])).toEqual([]);
  });
});

describe('tagsToImapFlags', () => {
  it('maps each tag name back to its IMAP system flag', () => {
    expect(tagsToImapFlags(['read', 'starred', 'answered', 'draft', 'deleted'])).toEqual([
      '\\Seen',
      '\\Flagged',
      '\\Answered',
      '\\Draft',
      '\\Deleted',
    ]);
  });

  // Folder paths and AI categories share the tags column but are NOT server
  // flags — pushing them as flags would make the server reject the STORE.
  it('skips folder-path and category tags', () => {
    expect(tagsToImapFlags(['INBOX', '[Gmail]/All Mail', 'needs_response', 'important'])).toEqual([]);
    expect(tagsToImapFlags(['INBOX', 'read', 'promotions'])).toEqual(['\\Seen']);
  });

  it('returns [] for an empty tag list', () => {
    expect(tagsToImapFlags([])).toEqual([]);
  });

  // Both directions must agree, else a sync round-trip flips flags back and forth.
  it('round-trips flags -> tags -> flags for the full system-flag set', () => {
    const flags = ['\\Seen', '\\Flagged', '\\Answered', '\\Draft', '\\Deleted'];
    expect(tagsToImapFlags(imapFlagsToTags(flags))).toEqual(flags);
  });
});

describe('FLAG_TAG_NAMES', () => {
  // Callers use this list to strip "flag" tags from a tag string before writing
  // folder tags; if it drifts from the mapping table, a flag tag survives where
  // it shouldn't (or a real flag gets clobbered).
  it('lists exactly the tags that map to an IMAP flag', () => {
    expect([...FLAG_TAG_NAMES]).toEqual(['read', 'starred', 'answered', 'draft', 'deleted']);
    for (const name of FLAG_TAG_NAMES) {
      expect(tagsToImapFlags([name])).toHaveLength(1);
    }
  });
});
