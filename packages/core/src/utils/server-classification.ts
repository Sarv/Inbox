import { GMAIL_CLASSIFICATION_CATEGORY_SLUGS, mapGmailLabels, matchKnownCategory, type KnownCategory } from './gmail-labels';
import { detectProvider } from './provider';

/** Explicit server importance keywords; stars (\\Flagged) are a separate state. */
export function isServerImportant(flags: readonly string[] | null | undefined, labels?: readonly string[] | null): boolean {
  return [...(flags ?? []), ...(labels ?? [])].some((value) =>
    ['important', '$important', '\\important'].includes(String(value).trim().toLowerCase()));
}

export interface ServerClassificationInput {
  flags?: readonly string[] | null;
  labels?: readonly string[] | null;
  categories?: readonly string[] | null;
  folderPath?: string;
  providerHost?: string;
  knownCategories?: readonly KnownCategory[];
}

/** Recover provider categories before AI, preserving importance as an independent flag. */
export function mapServerClassification(input: ServerClassificationInput): {
  important: boolean; categories: string[]; hasClassification: boolean;
} {
  const mapped = mapGmailLabels(input.labels, { knownCategories: input.knownCategories });
  const gmail = input.labels !== undefined || input.categories !== undefined || detectProvider(input.providerHost ?? '') === 'gmail';
  const ignoredNativeCategories = new Set(['social', 'updates', 'forums', 'personal', 'primary']);
  const allowedCategory = (slug: string): boolean => slug !== 'important' && (!gmail || !ignoredNativeCategories.has(slug));
  // Read-only native discovery is Promotions-only; ordinary Sarv/custom category mappings remain intact.
  const nativeCategories = (input.categories ?? []).filter((slug) => (GMAIL_CLASSIFICATION_CATEGORY_SLUGS as readonly string[]).includes(slug));
  const categories = new Set([...mapped.categories, ...nativeCategories].filter(allowedCategory));
  const important = isServerImportant(input.flags) || mapped.flags.includes('important');
  for (const raw of input.flags ?? []) {
    // Only a known category is a classification. Arbitrary custom keywords,
    // read/unread, and stars never suppress AI on otherwise unclassified mail.
    if (String(raw).startsWith('\\')) continue;
    const value = String(raw).replace(/^[$]/, '');
    const slug = matchKnownCategory(value, input.knownCategories);
    if (slug && allowedCategory(slug)) categories.add(slug);
  }
  if (input.folderPath && !['inbox', 'sent', 'sent mail', 'sent items', 'drafts', 'draft', 'trash', 'deleted items', 'deleted', 'junk', 'spam', 'archive', 'archives', 'all mail', 'starred', 'flagged', 'important'].includes(input.folderPath.toLowerCase())) {
    // Exact folder names match the provider's displayed categories; do not match
    // arbitrary nested leaves (e.g. Work/Promotions) to a global category.
    const slug = matchKnownCategory(input.folderPath, input.knownCategories);
    if (slug && allowedCategory(slug)) categories.add(slug);
  }
  return { important, categories: [...categories], hasClassification: important || categories.size > 0 };
}
