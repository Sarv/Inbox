import { describe, expect, it } from 'vitest';

import { categorySelectionChanges } from '../../../../src/components/category-selection';

// Regression: staged selections must preserve independent Important and only write the user's changed categories.
describe('explicit category selection', () => {
  it('marks Important without removing Promotions or custom categories', () => {
    expect(categorySelectionChanges(new Set(['promotions', 'custom']), new Set(['promotions', 'custom', 'important'])))
      .toEqual([{ slug: 'important', on: true }]);
  });
  it('removes only the unchecked category', () => {
    expect(categorySelectionChanges(new Set(['promotions', 'important']), new Set(['important'])))
      .toEqual([{ slug: 'promotions', on: false }]);
  });
  it('leaves unchanged selections alone and handles several explicit changes', () => {
    expect(categorySelectionChanges(new Set(['important']), new Set(['important']))).toEqual([]);
    expect(categorySelectionChanges(new Set(['promotions', 'important']), new Set(['updates', 'important'])))
      .toEqual([{ slug: 'promotions', on: false }, { slug: 'updates', on: true }]);
  });
});
