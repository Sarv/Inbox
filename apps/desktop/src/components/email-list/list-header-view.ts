// Which listing the top bar is heading — pure, so the naming is tested without
// rendering a list. Kept out of ListHeader.tsx to keep the business logic
// separate from the framework code.

import type { ClassifiableFolder } from '../../config/folder-mapping';
import { folderDisplayName, VIRTUAL_FOLDERS } from '../../config/folder-mapping';

/** What the list is showing, in the order the views override one another. */
export interface ListHeaderView {
  /** `viewingSectionLabel` — set while drilled into a section's full page. */
  sectionLabel?: string | null;
  searching?: boolean;
  /** `viewingAICategory` slug, e.g. "needs-response". */
  aiCategory?: string | null;
  snoozed?: boolean;
  /** `selectedVirtualFolder` id, e.g. "virtual-all". */
  virtualFolder?: string | null;
  folder?: (ClassifiableFolder & { name: string }) | null;
}

/** Title-case a category slug: "needs-response" -> "Needs Response". */
const categoryLabel = (slug: string): string =>
  slug.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

/**
 * The title the bar shows for a view, or null when the view has no list of its
 * own to head (the sectioned inbox, where each section carries its own pager).
 *
 * Pure and exported so the naming is tested without rendering the list: a view
 * that falls through to "" is a bar with a pager and no idea what it is paging.
 */
export function listHeaderTitle(view: ListHeaderView): string | null {
  if (view.sectionLabel) return view.sectionLabel;
  if (view.searching) return 'Search results';
  if (view.aiCategory) return categoryLabel(view.aiCategory);
  if (view.snoozed) return 'Snoozed';
  if (view.virtualFolder === 'virtual-unified') return 'All Inboxes';
  if (view.virtualFolder) {
    return VIRTUAL_FOLDERS.find((f) => f.id === view.virtualFolder)?.name ?? null;
  }
  return view.folder ? folderDisplayName(view.folder) : null;
}
