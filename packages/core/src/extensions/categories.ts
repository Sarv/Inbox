/**
 * The shelf an extension sits on.
 *
 * Authors write this in their manifest, so it arrives as whatever they typed —
 * `Productivity`, `productivity`, `tool`, `Organization`. Left alone that turns
 * a browsable catalogue into a pile of near-identical labels that no filter can
 * usefully group, so every value is folded onto a known shelf here and anything
 * unrecognised lands on `other` rather than inventing a new one.
 *
 * Deliberately a short, closed list. A vocabulary an author can extend by
 * typing is not a vocabulary, and a filter with forty buttons is not a filter.
 */

/** Every shelf a published extension can sit on. */
export const EXTENSION_CATEGORIES = [
  'productivity',
  'security',
  'organisation',
  'communication',
  'office',
  'ai',
  'tools',
  'other',
] as const;

export type ExtensionCategory = (typeof EXTENSION_CATEGORIES)[number];

/** Where unrecognised and missing values land. */
export const DEFAULT_EXTENSION_CATEGORY: ExtensionCategory = 'other';

/**
 * Spellings folded onto a shelf.
 *
 * Mostly the differences nobody should have to think about: American vs British
 * spelling, and singular vs plural. The rest are the words people reach for
 * that mean an existing shelf — an author who writes `privacy` means `security`
 * and should not be filed under `other` for it.
 */
const ALIASES: Record<string, ExtensionCategory> = {
  organization: 'organisation',
  organize: 'organisation',
  organise: 'organisation',
  filing: 'organisation',
  tool: 'tools',
  utility: 'tools',
  utilities: 'tools',
  privacy: 'security',
  safety: 'security',
  workflow: 'productivity',
  automation: 'productivity',
  business: 'office',
  work: 'office',
  documents: 'office',
  chat: 'communication',
  messaging: 'communication',
  social: 'communication',
  'artificial-intelligence': 'ai',
  llm: 'ai',
  misc: 'other',
  miscellaneous: 'other',
};

/**
 * Fold whatever the manifest said onto a known shelf.
 *
 * Never throws and never rejects the extension: a category is a browsing aid,
 * and a typo in one is not a reason to hide an extension from the catalogue.
 */
export function normalizeExtensionCategory(raw: unknown): ExtensionCategory {
  if (typeof raw !== 'string') return DEFAULT_EXTENSION_CATEGORY;

  const cleaned = raw.trim().toLowerCase().replace(/[\s_]+/g, '-');
  if (!cleaned) return DEFAULT_EXTENSION_CATEGORY;

  if ((EXTENSION_CATEGORIES as readonly string[]).includes(cleaned)) {
    return cleaned as ExtensionCategory;
  }
  return ALIASES[cleaned] ?? DEFAULT_EXTENSION_CATEGORY;
}

/** True when the value is already one of the known shelves. */
export function isExtensionCategory(value: unknown): value is ExtensionCategory {
  return typeof value === 'string' && (EXTENSION_CATEGORIES as readonly string[]).includes(value);
}
