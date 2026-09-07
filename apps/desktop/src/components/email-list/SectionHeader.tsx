import { ChevronRight, ChevronDown, MoreVertical, Check } from 'lucide-react';

import { Tooltip } from '../Tooltip';

import type { SectionHeaderProps } from './types';

const SHOW_UP_TO_OPTIONS = [5, 10, 25, 50];
const DEFAULT_MAX = 25;

export function SectionHeader({
  sectionId,
  label,
  count,
  totalInSection,
  folderTotal = 0,
  isEverythingElse = false,
  isCollapsed,
  showMenu,
  onToggleCollapse,
  onSetSectionMenuId,
  dbTotal,
  page = 0,
  pageSize = 0,
  maxItems = 0,
  hideWhenEmpty = false,
  onOpenFullPage,
  onSetMaxItems,
  onToggleHideWhenEmpty,
  onManageSettings,
}: SectionHeaderProps) {
  const effectiveTotal = dbTotal !== undefined ? dbTotal : totalInSection;
  const displayTotal = isEverythingElse && folderTotal > effectiveTotal && dbTotal === undefined
    ? folderTotal
    : effectiveTotal;
  const start = count > 0 ? page * pageSize + 1 : 0;
  const end = page * pageSize + count;
  const currentMax = maxItems && maxItems > 0 ? maxItems : DEFAULT_MAX;

  const closeMenu = () => onSetSectionMenuId(null);

  return (
    // Raise this header (and its dropdown) above sibling sticky headers while the
    // menu is open — otherwise the next section's sticky header (also z-10, later
    // in the DOM) clips/overlaps the dropdown.
    <div className={`px-3 py-2 bg-muted border-b border-border sticky top-0 ${showMenu ? 'z-40' : 'z-10'}`}>
      <div className="flex items-center gap-2">
        {/* Collapse toggle */}
        <button onClick={() => onToggleCollapse(sectionId)} className="p-0.5 hover:bg-accent rounded">
          {isCollapsed
            ? <ChevronRight className="h-4 w-4 text-muted-foreground" />
            : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
        </button>

        {/* Label */}
        <span className="text-sm font-medium text-foreground">{label}</span>

        <div className="ml-auto flex items-center gap-1">
          {/* Clickable count → open this section full-page (Gmail) */}
          <button
            onClick={onOpenFullPage}
            disabled={!onOpenFullPage || count === 0}
            className={`text-xs tabular-nums px-1.5 py-0.5 rounded ${onOpenFullPage && count > 0 ? 'hover:bg-accent text-foreground cursor-pointer' : 'text-muted-foreground cursor-default'}`}
          >
            {count > 0 ? `${start.toLocaleString()}–${end.toLocaleString()} of ${displayTotal.toLocaleString()}` : '0'}
          </button>

          {/* Three-dot menu (Gmail: Show more / Show up to / Hide when empty / Manage) */}
          <div className="relative">
            <Tooltip content="More" delayMs={40}>
              <button
                onClick={() => onSetSectionMenuId(showMenu ? null : sectionId)}
                className="p-1 hover:bg-accent rounded"
                aria-label="Section options"
              >
                <MoreVertical className="h-4 w-4 text-muted-foreground" />
              </button>
            </Tooltip>
            {showMenu && (
              <div
                className="absolute right-0 top-8 z-50 bg-popover border border-border rounded-lg shadow-lg py-1 w-52 text-sm"
                onMouseLeave={closeMenu}
              >
                {onOpenFullPage && (
                  <button
                    onClick={() => { onOpenFullPage(); closeMenu(); }}
                    className="w-full px-3 py-2 text-left hover:bg-accent font-medium"
                  >
                    Show more messages
                  </button>
                )}
                {onSetMaxItems && (
                  <>
                    <div className="border-t border-border my-1" />
                    <div className="px-3 pt-1 pb-0.5 text-xs text-muted-foreground">Show up to</div>
                    {SHOW_UP_TO_OPTIONS.map((n) => (
                      <button
                        key={n}
                        onClick={() => { onSetMaxItems(n); closeMenu(); }}
                        className="w-full px-3 py-1.5 text-left hover:bg-accent flex items-center gap-2"
                      >
                        <Check className={`h-3.5 w-3.5 ${currentMax === n ? 'opacity-100' : 'opacity-0'}`} />
                        {n} items
                      </button>
                    ))}
                  </>
                )}
                {onToggleHideWhenEmpty && (
                  <>
                    <div className="border-t border-border my-1" />
                    <button
                      onClick={() => { onToggleHideWhenEmpty(); closeMenu(); }}
                      className="w-full px-3 py-2 text-left hover:bg-accent flex items-center gap-2"
                    >
                      <Check className={`h-3.5 w-3.5 ${hideWhenEmpty ? 'opacity-100' : 'opacity-0'}`} />
                      Hide section when empty
                    </button>
                  </>
                )}
                {onManageSettings && (
                  <>
                    <div className="border-t border-border my-1" />
                    <button
                      onClick={() => { onManageSettings(); closeMenu(); }}
                      className="w-full px-3 py-2 text-left hover:bg-accent"
                    >
                      Manage Inbox settings
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
