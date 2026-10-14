import type { ViewFilter } from '@sarvinbox/core';

import type { SearchQuery } from '../services/ai-service';

/** Category tabs retain the inbox quick-filter without becoming a text search. */
export function categoryViewQuery(category: string, folderId: string | null, filter: ViewFilter | null): SearchQuery | null {
  if (!filter) return null;
  return {
    aiCategory: category,
    ...(folderId ? { folderId } : {}),
    ...(filter.isUnread !== undefined ? { isUnread: filter.isUnread } : {}),
    // These ViewFilter fields narrow only when true; search also accepts false
    // as an inverse predicate, so do not pass the inactive values through.
    ...(filter.isFlagged ? { isFlagged: true } : {}),
    ...(filter.hasAttachments ? { hasAttachments: true } : {}),
    ...(filter.noCategory ? { noCategory: true } : {}),
  };
}

export function pageCategoryView(query: SearchQuery, limit: number, offset: number) {
  const pagedQuery = { ...query, limit, offset };
  return window.electronAPI.ai.search(pagedQuery);
}

/** The filtered paginator total must use the same predicate as its page query. */
export async function countCategoryView(query: SearchQuery): Promise<number> {
  try {
    const result = await window.electronAPI.ai.searchCount(query);
    return result?.success && typeof result.data === 'number' ? result.data : 0;
  } catch {
    return 0;
  }
}
