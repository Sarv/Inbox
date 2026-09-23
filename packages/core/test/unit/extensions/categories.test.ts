import { describe, expect, it } from 'vitest';

import {
  DEFAULT_EXTENSION_CATEGORY,
  EXTENSION_CATEGORIES,
  isExtensionCategory,
  normalizeExtensionCategory,
} from '../../../src/extensions/categories';

/**
 * The catalogue's shelf vocabulary.
 *
 * What breaks if this file goes red: browsing. Authors type this field by hand
 * in their own manifests, so without folding, `Productivity`, `productivity`
 * and `productivity ` are three shelves with one extension each and the filter
 * groups nothing. The other half is the safety property — a category is a
 * browsing aid and must never be able to reject an extension, so every input,
 * including a hostile one, has to come back as a known shelf.
 */

describe('normalizeExtensionCategory', () => {
  it('keeps a value that is already a known shelf', () => {
    for (const category of EXTENSION_CATEGORIES) {
      expect(normalizeExtensionCategory(category)).toBe(category);
    }
  });

  // Regression: the same word typed four ways is one shelf, not four.
  it.each([
    ['capitalised', 'Productivity', 'productivity'],
    ['padded', '  productivity  ', 'productivity'],
    ['spaced', 'artificial intelligence', 'ai'],
    ['underscored', 'artificial_intelligence', 'ai'],
  ])('folds a %s value', (_label, raw, expected) => {
    expect(normalizeExtensionCategory(raw)).toBe(expected);
  });

  // Spelling and plurals are differences nobody should have to think about.
  it.each([
    ['organization', 'organisation'],
    ['tool', 'tools'],
    ['utility', 'tools'],
    ['privacy', 'security'],
    ['automation', 'productivity'],
  ])('folds %s onto %s', (raw, expected) => {
    expect(normalizeExtensionCategory(raw)).toBe(expected);
  });

  // Regression: the whole point of a closed list. An author inventing a shelf
  // must not be able to add a filter button nobody else can reach.
  it('files an unknown word under the default shelf', () => {
    expect(normalizeExtensionCategory('flarblewidgets')).toBe(DEFAULT_EXTENSION_CATEGORY);
  });

  // A malformed or hostile manifest must cost the extension its shelf, never
  // its listing — so nothing here may throw.
  it.each([
    ['missing', undefined],
    ['null', null],
    ['empty', ''],
    ['whitespace', '   '],
    ['a number', 7],
    ['an object', { category: 'office' }],
    ['an array', ['office']],
  ])('falls back to the default for %s', (_label, raw) => {
    expect(normalizeExtensionCategory(raw)).toBe(DEFAULT_EXTENSION_CATEGORY);
  });
});

describe('isExtensionCategory', () => {
  it('accepts a known shelf and rejects anything else', () => {
    expect(isExtensionCategory('security')).toBe(true);
    expect(isExtensionCategory('Security')).toBe(false);
    expect(isExtensionCategory(undefined)).toBe(false);
  });
});
