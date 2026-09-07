import { Loader2 } from 'lucide-react';

import { getEmailsPerPage } from '../../store/helpers';

import { SectionHeader } from './SectionHeader';
import type { SectionListProps } from './types';

export function SectionList({
  sections,
  collapsedSections,
  expandedSectionIds,
  sectionMenuId,
  hoveredPaginationId,
  displayEmailsCount,
  renderThread,
  onToggleCollapse,
  onToggleExpansion,
  onSetSectionMenuId,
  onSetHoveredPaginationId,
  onLoadMoreSection,
  onOpenSectionFullPage,
  onSetSectionMaxItems,
  onToggleSectionHideWhenEmpty,
  onManageInboxSettings,
  sectionLoadingSet,
  isSyncing,
}: SectionListProps) {
  return (
    <>
      {sections.map((sectionData) => {
        const isCollapsed = collapsedSections.has(sectionData.section.id);
        const isDbBacked = sectionData.total !== undefined && sectionData.total > 0;
        const sectionLoading = sectionLoadingSet?.has(sectionData.section.id) || sectionData.loading || false;
        const filter = sectionData.section.filter;
        // An empty section is either genuinely empty or still resolving. Show a
        // "checking…" spinner while its own query is loading OR a background
        // sync is running, so the user reads it as working, not broken.
        const emptyIsPending = sectionLoading || !!isSyncing;

        return (
          <div key={sectionData.section.id}>
            <SectionHeader
              sectionId={sectionData.section.id}
              label={sectionData.label}
              count={sectionData.threads.length}
              totalInSection={isDbBacked ? (sectionData.total || 0) : sectionData.threads.length}
              folderTotal={displayEmailsCount}
              isEverythingElse={filter === 'everything_else'}
              isCollapsed={isCollapsed}
              isExpanded={expandedSectionIds.has(sectionData.section.id)}
              showMenu={sectionMenuId === sectionData.section.id}
              isHoveredPagination={hoveredPaginationId === sectionData.section.id}
              onToggleCollapse={onToggleCollapse}
              onToggleExpansion={onToggleExpansion}
              onSetSectionMenuId={onSetSectionMenuId}
              onSetHoveredPaginationId={onSetHoveredPaginationId}
              dbTotal={isDbBacked ? sectionData.total : undefined}
              hasMore={isDbBacked ? sectionData.hasMore : false}
              onLoadMore={onLoadMoreSection ? () => onLoadMoreSection(sectionData.section.id) : undefined}
              page={sectionData.page || 0}
              pageSize={getEmailsPerPage()}
              maxItems={sectionData.section.maxItems}
              hideWhenEmpty={sectionData.section.hideWhenEmpty}
              onOpenFullPage={isDbBacked && onOpenSectionFullPage ? () => onOpenSectionFullPage(sectionData.section.id) : undefined}
              onSetMaxItems={onSetSectionMaxItems ? (n) => onSetSectionMaxItems(sectionData.section.id, n) : undefined}
              onToggleHideWhenEmpty={onToggleSectionHideWhenEmpty ? () => onToggleSectionHideWhenEmpty(sectionData.section.id) : undefined}
              onManageSettings={onManageInboxSettings}
              sectionLoading={sectionLoading}
            />
            {!isCollapsed && (
              <>
                {sectionData.threads.length > 0 ? (
                  sectionData.threads.map((thread) => renderThread(thread))
                ) : emptyIsPending ? (
                  <div className="flex items-center gap-2 px-4 py-3 text-sm text-muted-foreground italic">
                    <Loader2 className="h-3 w-3 animate-spin not-italic" />
                    Checking for {sectionData.label.toLowerCase()} emails…
                  </div>
                ) : (
                  <div className="px-4 py-3 text-sm text-muted-foreground italic">
                    No {sectionData.label.toLowerCase()} emails
                  </div>
                )}
                {/* Client-side maxItems indicator (legacy) */}
                {!isDbBacked && sectionData.section.maxItems > 0 &&
                 sectionData.threads.length >= sectionData.section.maxItems && (
                  <div className="px-4 py-2 text-xs text-muted-foreground text-center border-b border-border">
                    Showing {sectionData.section.maxItems} of more
                  </div>
                )}
              </>
            )}
          </div>
        );
      })}
    </>
  );
}

