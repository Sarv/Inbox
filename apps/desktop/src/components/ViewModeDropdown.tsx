import { LayoutGrid, Columns, Rows } from 'lucide-react';

import { useEmailStore } from '../store/email-store';

interface ViewModeDropdownProps {
  showDropdown: boolean;
  setShowDropdown: (show: boolean) => void;
  buttonClassName?: string;
}

export function ViewModeDropdown({ showDropdown, setShowDropdown, buttonClassName }: ViewModeDropdownProps) {
  const { viewMode, setViewMode } = useEmailStore();

  const getViewModeIcon = () => {
    switch (viewMode) {
      case 'no-split':
        return <LayoutGrid className="h-4 w-4" />;
      case 'vertical':
        return <Columns className="h-4 w-4" />;
      case 'horizontal':
        return <Rows className="h-4 w-4" />;
      default:
        return <Columns className="h-4 w-4" />;
    }
  };

  return (
    <div className="relative">
      <button
        onClick={() => setShowDropdown(!showDropdown)}
        className={buttonClassName || "p-2 hover:bg-accent rounded-md"}
        title="View mode"
      >
        {getViewModeIcon()}
      </button>

      {showDropdown && (
        <div
          className="absolute right-0 top-10 z-50 bg-popover border border-border rounded-lg shadow-lg py-1 w-44"
          onMouseLeave={() => setShowDropdown(false)}
        >
          <button
            onClick={() => { setViewMode('no-split'); setShowDropdown(false); }}
            className={`w-full px-3 py-2 text-left hover:bg-accent flex items-center gap-2 ${viewMode === 'no-split' ? 'bg-accent' : ''}`}
          >
            <LayoutGrid className="h-4 w-4" />
            <span className="text-sm">No split</span>
          </button>
          <button
            onClick={() => { setViewMode('vertical'); setShowDropdown(false); }}
            className={`w-full px-3 py-2 text-left hover:bg-accent flex items-center gap-2 ${viewMode === 'vertical' ? 'bg-accent' : ''}`}
          >
            <Columns className="h-4 w-4" />
            <span className="text-sm">Vertical split</span>
          </button>
          <button
            onClick={() => { setViewMode('horizontal'); setShowDropdown(false); }}
            className={`w-full px-3 py-2 text-left hover:bg-accent flex items-center gap-2 ${viewMode === 'horizontal' ? 'bg-accent' : ''}`}
          >
            <Rows className="h-4 w-4" />
            <span className="text-sm">Horizontal split</span>
          </button>
        </div>
      )}
    </div>
  );
}
