import { Search, SlidersHorizontal } from 'lucide-react';

import { QUICK_SEARCH_SUGGESTIONS } from '../config/search-suggestions';

import { AdvancedSearchPanel } from './AdvancedSearchPanel';

interface SearchBarProps {
  placeholder: string;
  localSearchQuery: string;
  setLocalSearchQuery: (q: string) => void;
  onSearch: (e: React.FormEvent) => void;
  onClear: () => void;
  showClearButton: boolean;
  searchFocused: boolean;
  setSearchFocused: (focused: boolean) => void;
  showAdvancedSearch: boolean;
  setShowAdvancedSearch: (show: boolean) => void;
  getSearchContext: () => any;
  search: (query: string, context?: any) => void;
  viewMode: string;
  initialQuery: string;
  trailing?: React.ReactNode;
  below?: React.ReactNode;
  searchSuggestions?: string[];
}

export function SearchBar({
  placeholder,
  localSearchQuery,
  setLocalSearchQuery,
  onSearch,
  onClear,
  showClearButton,
  searchFocused,
  setSearchFocused,
  showAdvancedSearch,
  setShowAdvancedSearch,
  getSearchContext,
  search,
  viewMode,
  initialQuery,
  trailing,
  below,
  searchSuggestions,
}: SearchBarProps) {
  return (
    <div className={`${viewMode === 'no-split' ? 'px-4 py-3' : 'p-4'} border-b border-border overflow-visible`}>
      <div className="flex items-center gap-2 overflow-visible">
        <div className="relative flex-1 overflow-visible">
          <form onSubmit={onSearch} className="relative flex items-center">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <input
              type="text"
              placeholder={placeholder}
              value={localSearchQuery}
              onChange={(e) => setLocalSearchQuery(e.target.value)}
              onFocus={() => setSearchFocused(true)}
              onBlur={() => setTimeout(() => setSearchFocused(false), 200)}
              className="w-full pl-10 pr-20 py-2 bg-background border border-input rounded-full focus:outline-none focus:ring-2 focus:ring-ring text-sm"
            />
            {showClearButton && (
              <button
                type="button"
                onClick={onClear}
                className="absolute right-12 top-1/2 transform -translate-y-1/2 text-muted-foreground hover:text-foreground text-xs"
              >
                Clear
              </button>
            )}
            <button
              type="button"
              onClick={() => setShowAdvancedSearch(!showAdvancedSearch)}
              className={`absolute right-2 top-1/2 transform -translate-y-1/2 p-1.5 rounded-full transition-colors ${
                showAdvancedSearch ? 'bg-primary/10 text-primary' : 'hover:bg-accent text-muted-foreground hover:text-foreground'
              }`}
              title="Advanced search"
            >
              <SlidersHorizontal className="h-4 w-4" />
            </button>
          </form>

          {searchFocused && !showAdvancedSearch && !localSearchQuery && (
            <div className="absolute left-0 right-0 top-full mt-1 bg-popover border border-border rounded-lg shadow-lg z-40 p-2">
              <div className="text-xs text-muted-foreground px-2 py-1">Quick filters</div>
              <div className="flex flex-wrap gap-1.5 p-1">
                {QUICK_SEARCH_SUGGESTIONS.map((suggestion) => {
                  const Icon = suggestion.icon;
                  return (
                    <button
                      key={suggestion.query}
                      onClick={() => {
                        setLocalSearchQuery(suggestion.query);
                        search(suggestion.query, getSearchContext());
                        setSearchFocused(false);
                      }}
                      className="flex items-center gap-1.5 px-2.5 py-1.5 bg-muted/50 hover:bg-muted rounded-full text-sm transition-colors"
                    >
                      <Icon className="h-3.5 w-3.5 text-muted-foreground" />
                      {suggestion.label}
                    </button>
                  );
                })}
              </div>
              <div className="border-t border-border mt-2 pt-2 px-2">
                <div className="text-xs text-muted-foreground">
                  Try: <span className="font-mono bg-muted px-1 rounded">from:john</span>{' '}
                  <span className="font-mono bg-muted px-1 rounded">subject:meeting</span>{' '}
                  <span className="font-mono bg-muted px-1 rounded">is:unread</span>
                </div>
              </div>
            </div>
          )}

          <AdvancedSearchPanel
            isOpen={showAdvancedSearch}
            onClose={() => setShowAdvancedSearch(false)}
            onSearch={(query, skipAI) => {
              setLocalSearchQuery(query);
              if (query.trim()) {
                search(query, { ...getSearchContext(), skipAI });
              }
            }}
            initialQuery={initialQuery}
          />
        </div>

        {trailing}
      </div>
      {searchSuggestions && searchSuggestions.length > 0 && localSearchQuery && (
        <div className="flex flex-wrap gap-1.5 mt-2">
          {searchSuggestions.map((term) => (
            <button
              key={term}
              onClick={() => {
                const newQuery = localSearchQuery.trim() + ' ' + term;
                setLocalSearchQuery(newQuery);
                search(newQuery, getSearchContext());
              }}
              className="px-2.5 py-1 bg-muted/60 hover:bg-muted rounded-full text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              {term}
            </button>
          ))}
        </div>
      )}
      {below}
    </div>
  );
}
