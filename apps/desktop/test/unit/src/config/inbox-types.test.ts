import { describe, it, expect } from 'vitest';

import type { SectionFilter } from '../../../../src/config/inbox-types';
import { DEFAULT_SECTIONS, SECTION_FILTER_LABELS, SETTINGS_KEY } from '../../../../src/config/inbox-types';

describe('DEFAULT_SECTIONS', () => {
  // These are the section layouts a user gets when they pick an inbox type in
  // Settings. Two invariants make or break the sectioned inbox:
  //   1. every layout ENDS with everything_else, or mail silently disappears
  //      from the list (nothing sweeps up the unmatched threads);
  //   2. section ids are unique inside a layout, because sectionData is keyed by
  //      id — a collision makes two sections overwrite each other's page.
  it('covers every non-default inbox type', () => {
    expect(Object.keys(DEFAULT_SECTIONS).sort()).toEqual(['important_first', 'priority_first', 'unread_first']);
  });

  it('ends every layout with everything_else so no thread can go unrendered', () => {
    for (const sections of Object.values(DEFAULT_SECTIONS)) {
      expect(sections.at(-1)?.filter).toBe('everything_else');
    }
  });

  it('keeps section ids unique within each layout (sectionData is keyed by id)', () => {
    for (const sections of Object.values(DEFAULT_SECTIONS)) {
      expect(new Set(sections.map((s) => s.id)).size).toBe(sections.length);
    }
  });

  it('leaves every default section uncapped (maxItems 0 = show all)', () => {
    for (const sections of Object.values(DEFAULT_SECTIONS)) {
      for (const s of sections) expect(s.maxItems).toBe(0);
    }
  });

  it('lays out priority_first as important+unread, then starred, then the rest', () => {
    expect(DEFAULT_SECTIONS.priority_first.map((s) => s.filter)).toEqual([
      'important_unread',
      'starred',
      'everything_else',
    ]);
    // Only the middle (starred) section hides when empty — an empty "Starred"
    // heading above the main list is pure noise.
    expect(DEFAULT_SECTIONS.priority_first.map((s) => s.hideWhenEmpty)).toEqual([false, true, false]);
  });

  it('lays out the important_first / unread_first pairs', () => {
    expect(DEFAULT_SECTIONS.important_first.map((s) => s.filter)).toEqual(['important', 'everything_else']);
    expect(DEFAULT_SECTIONS.unread_first.map((s) => s.filter)).toEqual(['unread', 'everything_else']);
  });

  it('uses only filters that have a display label', () => {
    // assignThreadsToSections reads SECTION_FILTER_LABELS[filter] verbatim, so a
    // filter without an entry renders an "undefined" section heading.
    for (const sections of Object.values(DEFAULT_SECTIONS)) {
      for (const s of sections) expect(SECTION_FILTER_LABELS[s.filter]).toBeTruthy();
    }
  });
});

describe('SECTION_FILTER_LABELS', () => {
  it('labels every SectionFilter variant exactly once', () => {
    const filters: SectionFilter[] = ['important_unread', 'important', 'unread', 'starred', 'everything_else', 'none'];
    expect(Object.keys(SECTION_FILTER_LABELS).sort()).toEqual([...filters].sort());
    expect(new Set(Object.values(SECTION_FILTER_LABELS)).size).toBe(filters.length);
  });
});

describe('SETTINGS_KEY', () => {
  it('is the one localStorage key every settings reader uses', () => {
    // helpers.ts (getEmailsPerPage / getRemoteImageMode / …) and signatures.ts
    // hardcode this same literal; a rename here silently orphans the user's
    // saved settings.
    expect(SETTINGS_KEY).toBe('sarvinbox-settings');
  });
});
