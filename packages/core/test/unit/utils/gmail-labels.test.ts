import { describe, expect, it } from 'vitest';

import { categorySlugFromLabel, mapGmailLabels } from '../../../src/utils/gmail-labels';

/**
 * Gmail label mapping. This is what makes a message downloaded via the All Mail
 * superset show up in INBOX, in Starred, and in the user's own labels — the
 * missing half of that optimisation, and the reason a Gmail account could sit at
 * "88 mails" while thousands of messages were already on disk.
 *
 * The dangerous mistakes this pins down:
 *   - treating `\Starred` as a FOLDER (invents a folder named "\Starred" and the
 *     star still never appears),
 *   - dropping a user label like `access`, so visiting it here shows nothing
 *     while Gmail shows plenty,
 *   - turning this app's own `Sarv Inbox/*` mirror labels into user folders,
 *   - inventing a category slug for a label that matches no real category.
 */

describe('mapGmailLabels — system labels', () => {
  // \Inbox is a ROLE, not a path: the actual mailbox path differs per account
  // ([Gmail]/Sent Mail vs Sent), so the caller resolves it.
  it('maps folder-ish system labels to roles', () => {
    const m = mapGmailLabels(['\\Inbox', '\\Sent', '\\Draft', '\\Trash', '\\Junk']);
    expect(m.roles).toEqual(['inbox', 'sent', 'drafts', 'trash', 'spam']);
    expect(m.labels).toEqual([]);
    expect(m.flags).toEqual([]);
  });

  // \Starred is a FLAG in this app's model. Routing it to `labels` would create
  // a bogus "\Starred" folder AND leave the star missing.
  it('maps \\Starred to a flag tag, never to a folder', () => {
    const m = mapGmailLabels(['\\Starred']);
    expect(m.flags).toEqual(['starred']);
    expect(m.labels).toEqual([]);
    expect(m.roles).toEqual([]);
  });

  // BEHAVIOUR CHANGE: \Important used to map to the `important` flag tag. This
  // app's AI is the sole author of that tag, so Gmail's own guess must be
  // dropped — otherwise mail synced while the AI is down still shows an
  // "Important" chip, and disabling the AI never clears the section.
  it('drops \\Important instead of tagging it important', () => {
    const m = mapGmailLabels(['\\Inbox', '\\Starred', '\\Important']);
    expect(m.flags).toEqual(['starred']);
    expect(m.labels).toEqual([]);
    expect(m.categories).toEqual([]);
    expect(m.roles).toEqual(['inbox']);
  });

  // Dropping it must not fall through to the user-label branch: a folder called
  // "\Important" would be worse than the chip we removed.
  it('never turns \\Important into a label or folder, in any casing', () => {
    for (const spelling of ['\\Important', '\\IMPORTANT', '\\important']) {
      const m = mapGmailLabels([spelling]);
      expect(m.flags).toEqual([]);
      expect(m.labels).toEqual([]);
      expect(m.roles).toEqual([]);
    }
  });

  it('treats \\Drafts and \\Spam aliases the same as their canonical forms', () => {
    expect(mapGmailLabels(['\\Drafts']).roles).toEqual(['drafts']);
    expect(mapGmailLabels(['\\Spam']).roles).toEqual(['spam']);
  });

  it('is case-insensitive about system label spelling', () => {
    expect(mapGmailLabels(['\\INBOX', '\\starred']).roles).toEqual(['inbox']);
    expect(mapGmailLabels(['\\INBOX', '\\starred']).flags).toEqual(['starred']);
  });

  // A system label this build has never heard of must be IGNORED, not guessed
  // at: materialising `\SomethingNew` as a folder would put mail somewhere the
  // user can't explain and can't clean up.
  it('drops unknown backslash labels instead of inventing a folder', () => {
    const m = mapGmailLabels(['\\SomethingNew', '\\Inbox']);
    expect(m.roles).toEqual(['inbox']);
    expect(m.labels).toEqual([]);
  });
});

describe('mapGmailLabels — user labels', () => {
  // The whole point: a label called `access` must list the same mail here as it
  // does in Gmail.
  it('keeps a plain user label verbatim', () => {
    expect(mapGmailLabels(['access']).labels).toEqual(['access']);
  });

  it('preserves nesting and spaces in user labels', () => {
    expect(mapGmailLabels(['Work/Clients', 'Big Client 2026']).labels)
      .toEqual(['Work/Clients', 'Big Client 2026']);
  });

  // Gmail sends a label containing spaces or specials quoted, with embedded
  // quotes and backslashes escaped. Storing the quotes would make the tag never
  // match the folder path.
  it('unquotes and unescapes a quoted label', () => {
    expect(mapGmailLabels(['"Work/Clients"']).labels).toEqual(['Work/Clients']);
    expect(mapGmailLabels(['"He said \\"hi\\""']).labels).toEqual(['He said "hi"']);
    expect(mapGmailLabels(['"back\\\\slash"']).labels).toEqual(['back\\slash']);
  });

  it('ignores blank and whitespace-only labels', () => {
    expect(mapGmailLabels(['', '   ', '""']).labels).toEqual([]);
  });

  it('de-duplicates repeated labels, roles and flags', () => {
    const m = mapGmailLabels(['access', 'access', '\\Inbox', '\\Inbox', '\\Starred', '\\Starred']);
    expect(m.labels).toEqual(['access']);
    expect(m.roles).toEqual(['inbox']);
    expect(m.flags).toEqual(['starred']);
  });

  it('returns empty results for null/undefined/empty input', () => {
    for (const input of [null, undefined, []] as const) {
      expect(mapGmailLabels(input)).toEqual({ roles: [], labels: [], flags: [], categories: [] });
    }
  });
});

describe('mapGmailLabels — this app\'s own category mirror', () => {
  const known = [
    { slug: 'promotions', name: 'Promotions' },
    { slug: 'needs_response', name: 'Needs Response' },
    { slug: 'invoice', name: 'Invoices' },
  ];

  // Recovering these is what restores category chips for old mail WITHOUT paying
  // an LLM to re-classify thousands of messages.
  it('recovers a category slug from a mirror label', () => {
    const m = mapGmailLabels(['Sarv Inbox/Promotions', '\\Inbox'], { knownCategories: known });
    expect(m.categories).toEqual(['promotions']);
    expect(m.roles).toEqual(['inbox']);
    expect(m.labels).toEqual([]);          // never the user's label
  });

  // The mirror leaf is the category's DISPLAY NAME, so "Needs Response" has to
  // resolve to the `needs_response` slug, not to `needs response`.
  it('resolves a multi-word display name to its slug', () => {
    expect(mapGmailLabels(['Sarv Inbox/Needs Response'], { knownCategories: known }).categories)
      .toEqual(['needs_response']);
  });

  // A name that differs from its slug (Invoices → invoice) must map by NAME.
  it('matches by display name even when it differs from the slug', () => {
    expect(mapGmailLabels(['Sarv Inbox/Invoices'], { knownCategories: known }).categories)
      .toEqual(['invoice']);
  });

  // A stale mirror label for a category the user deleted must NOT become a
  // category (it no longer exists) and must NOT become a user folder (it was
  // never theirs) — it is simply dropped.
  it('drops an unresolvable mirror label instead of inventing a category or a folder', () => {
    const m = mapGmailLabels(['Sarv Inbox/Deleted Category'], { knownCategories: known });
    expect(m.categories).toEqual([]);
    expect(m.labels).toEqual([]);
  });

  // Without definitions to check against, fall back to the transform so the
  // caller still gets something usable.
  it('falls back to a slug transform when no categories are supplied', () => {
    expect(mapGmailLabels(['Sarv Inbox/Needs Response']).categories).toEqual(['needs_response']);
  });

  // A user label that merely STARTS with the parent word is theirs, not ours.
  it('does not claim a user label that only starts with the parent name', () => {
    const m = mapGmailLabels(['Sarv Inbox Archive', 'Sarv Inboxen'], { knownCategories: known });
    expect(m.labels).toEqual(['Sarv Inbox Archive', 'Sarv Inboxen']);
    expect(m.categories).toEqual([]);
  });

  it('honours a custom category parent', () => {
    const m = mapGmailLabels(['Custom/Promotions'], { categoryParent: 'Custom', knownCategories: known });
    expect(m.categories).toEqual(['promotions']);
  });
});

describe('categorySlugFromLabel', () => {
  it('returns null for anything outside the mirror namespace', () => {
    expect(categorySlugFromLabel('access')).toBeNull();
    expect(categorySlugFromLabel('Sarv Inbox')).toBeNull();       // parent itself
    expect(categorySlugFromLabel('Sarv Inbox/')).toBeNull();      // empty leaf
  });

  // Non-Gmail servers nest with '.' — the delimiter must not be hard-coded.
  it('accepts any single delimiter after the parent', () => {
    expect(categorySlugFromLabel('Sarv Inbox.Promotions')).toBe('promotions');
    expect(categorySlugFromLabel('Sarv Inbox/Promotions')).toBe('promotions');
  });
});
