import { describe, expect, it } from 'vitest';

import { readStateTextClass } from '../../../../../src/components/email-list/read-state-text';

// ---------------------------------------------------------------------------
// Unread vs read text in the mail list.
//
// The field report this guards: in dark mode unread mail was hard to pick out,
// because a READ subject used `text-foreground` — the same colour as an unread
// one — leaving only a semibold weight to tell them apart.
// ---------------------------------------------------------------------------
describe('readStateTextClass', () => {
  // Breaks if unread text loses its weight or full-contrast colour.
  it('renders unread text heavy and full-contrast', () => {
    expect(readStateTextClass(true)).toBe('font-semibold text-foreground');
  });

  // THE REGRESSION: read text must drop to the muted tone, not stay at
  // text-foreground, or colour stops distinguishing read from unread.
  it('renders read text in the muted tone, never full-contrast', () => {
    const readClass = readStateTextClass(false);
    expect(readClass).toBe('text-muted-foreground');
    expect(readClass.split(' ')).not.toContain('text-foreground');
  });
});
