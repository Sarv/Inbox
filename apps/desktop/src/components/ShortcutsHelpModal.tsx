import { X } from 'lucide-react';
import { useEffect, useState } from 'react';

import {
  DEFAULT_SHORTCUTS,
  DEFAULT_GOTO_SHORTCUTS,
  prettyKey,
  type ShortcutCategory,
} from '../config/keyboard-shortcuts';

export function ShortcutsHelpModal() {
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    const handleOpen = () => setIsOpen(true);
    document.addEventListener('sarvinbox:shortcuts-help', handleOpen);
    return () => document.removeEventListener('sarvinbox:shortcuts-help', handleOpen);
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setIsOpen(false);
      }
    };
    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [isOpen]);

  if (!isOpen) return null;

  // Group shortcuts by category
  const categories: ShortcutCategory[] = ['Navigation', 'Actions', 'Compose'];
  const grouped = categories.map(cat => ({
    category: cat,
    shortcuts: DEFAULT_SHORTCUTS.filter(s => s.category === cat),
  }));

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-[200]"
      onClick={() => setIsOpen(false)}
    >
      <div
        className="bg-card border border-border rounded-lg shadow-xl w-[600px] max-h-[80vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <h2 className="text-lg font-semibold">Keyboard Shortcuts</h2>
          <button
            onClick={() => setIsOpen(false)}
            className="p-1.5 hover:bg-accent rounded-md transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="overflow-y-auto px-6 py-4 space-y-6">
          {grouped.map(({ category, shortcuts }) => (
            <div key={category}>
              <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-2">
                {category}
              </h3>
              <div className="space-y-1">
                {shortcuts.map(s => (
                  <div
                    key={s.action}
                    className="flex items-center justify-between py-1.5"
                  >
                    <span className="text-sm">{s.description}</span>
                    <div className="flex items-center gap-1">
                      {s.keys.map((key, i) => (
                        <span key={i}>
                          {i > 0 && (
                            <span className="text-xs text-muted-foreground mx-1">or</span>
                          )}
                          <kbd className="inline-flex items-center px-2 py-0.5 text-xs font-mono bg-muted border border-border rounded">
                            {prettyKey(key)}
                          </kbd>
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}

          {/* Compose window shortcuts */}
          <div>
            <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-2">
              Compose Window
            </h3>
            <div className="space-y-1">
              {[
                { keys: ['\u2318/Ctrl', 'Enter'], description: 'Send message', join: '+' },
                { keys: ['\u2318/Ctrl', 'Shift', 'C'], description: 'Add CC recipients', join: '+' },
                { keys: ['\u2318/Ctrl', 'Shift', 'B'], description: 'Add BCC recipients', join: '+' },
                { keys: ['Esc'], description: 'Discard / close compose' },
              ].map((s, idx) => (
                <div key={idx} className="flex items-center justify-between py-1.5">
                  <span className="text-sm">{s.description}</span>
                  <div className="flex items-center">
                    {s.keys.map((key, i) => (
                      <span key={i}>
                        {i > 0 && (
                          <span className="text-xs text-muted-foreground mx-0.5">
                            {s.join || ''}
                          </span>
                        )}
                        <kbd className="inline-flex items-center px-2 py-0.5 text-xs font-mono bg-muted border border-border rounded">
                          {key}
                        </kbd>
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Go-to shortcuts */}
          <div>
            <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-2">
              Go To
            </h3>
            <div className="space-y-1">
              {DEFAULT_GOTO_SHORTCUTS.map(s => (
                <div
                  key={s.target}
                  className="flex items-center justify-between py-1.5"
                >
                  <span className="text-sm">{s.description}</span>
                  <div className="flex items-center gap-1">
                    <kbd className="inline-flex items-center px-2 py-0.5 text-xs font-mono bg-muted border border-border rounded">
                      g
                    </kbd>
                    <span className="text-xs text-muted-foreground">then</span>
                    <kbd className="inline-flex items-center px-2 py-0.5 text-xs font-mono bg-muted border border-border rounded">
                      {s.keys[0]}
                    </kbd>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t border-border text-xs text-muted-foreground">
          Press <kbd className="px-1.5 py-0.5 bg-muted border border-border rounded font-mono">?</kbd> to toggle this dialog
          {' \u00b7 '}
          Customize in Settings &rarr; Keyboard Shortcuts
        </div>
      </div>
    </div>
  );
}
