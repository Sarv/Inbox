import { describe, expect, it } from 'vitest';

import { automaticCategorizationDeferred, existingCategoryClassification, independentImportance, providerCategorySelection, parseCategorySelection } from '../../../src/utils/category-authority';

describe('category authority', () => {
  // Regression: Gmail native tabs/Important no longer own categorization; custom labels and manual choices still do.
  it('only gives Gmail Promotions and custom server labels category authority', () => {
    for (const gmailImportant of [true, false]) {
      const email = { gmailImportant, serverCategories: ['important', 'social', 'updates', 'forums', 'personal'] };
      expect(existingCategoryClassification(email)).toBeNull();
      expect(automaticCategorizationDeferred({ ...email, gmailCategoriesPending: true })).toBe(true);
      expect(existingCategoryClassification({ ...email, serverCategories: ['social', 'promotions', 'finance'] }))
        .toEqual({ source: 'provider', categories: ['promotions', 'finance'] });
      expect(existingCategoryClassification({ ...email, manualCategories: ['social'] }))
        .toEqual({ source: 'user', categories: ['social'] });
    }
    expect(providerCategorySelection(['important', 'forums'], null)).toEqual(['important', 'forums']);
  });
  // Regression: a manual off flag must override both native and AI importance without freezing AI categorization.
  it('separates independent importance from category ownership', () => {
    expect(independentImportance({ gmailImportant: true })).toBe(true);
    expect(independentImportance({ gmailImportant: false })).toBeNull();
    expect(independentImportance({ manualImportant: true })).toBe(true);
    expect(independentImportance({ manualImportant: false, gmailImportant: true })).toBe(false);
    expect(independentImportance({})).toBeNull();
    expect(existingCategoryClassification({ gmailImportant: true })).toBeNull();
  });
  // Regression: provider labels and an explicit user removal must not spend categorization tokens.
  it('uses user selection ahead of server categories, including an empty selection', () => {
    expect(existingCategoryClassification({ serverCategories: ['promotions'] })).toEqual({ source: 'provider', categories: ['promotions'] });
    expect(existingCategoryClassification({ serverCategories: ['important'] })).toEqual({ source: 'provider', categories: ['important'] });
    expect(existingCategoryClassification({ serverCategories: ['promotions'], manualCategories: ['finance'] })).toEqual({ source: 'user', categories: ['finance'] });
    expect(existingCategoryClassification({ serverCategories: ['promotions'], manualCategories: [] })).toEqual({ source: 'user', categories: [] });
  });
  // Regression: ordinary mailbox flags and removed provider classification cannot block AI.
  it('does not classify absent or empty provider metadata', () => {
    expect(existingCategoryClassification({})).toBeNull();
    expect(existingCategoryClassification({ serverCategories: [], manualCategories: null })).toBeNull();
  });
  // Regression: a failed Gmail category lookup must be retried, never treated as empty/unclassified mail.
  it('defers unknown provider categories unless an existing classification already supplies authority', () => {
    expect(automaticCategorizationDeferred({ gmailCategoriesPending: true })).toBe(true);
    expect(automaticCategorizationDeferred({ gmailCategoriesPending: false })).toBe(false);
    expect(automaticCategorizationDeferred({ gmailCategoriesPending: true, serverCategories: ['important'] })).toBe(false);
    expect(automaticCategorizationDeferred({ gmailCategoriesPending: true, manualCategories: [] })).toBe(false);
  });
  // Regression: malformed JSON must not invent a classification or fail mailbox reads.
  it('parses only arrays of strings, retaining explicit empty selection', () => {
    expect(parseCategorySelection('["promotions","promotions"]')).toEqual(['promotions']);
    expect(parseCategorySelection('[]')).toEqual([]);
    expect(parseCategorySelection(['important'])).toEqual(['important']);
    for (const raw of [null, undefined, '{', 'null', '{}', '"important"', '[1,"important"]']) expect(parseCategorySelection(raw)).toBeNull();
  });
});
