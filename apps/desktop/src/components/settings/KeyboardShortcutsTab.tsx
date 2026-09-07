import { RotateCcw } from 'lucide-react';
import { useState, useEffect, useCallback, useRef } from 'react';

import {
  DEFAULT_SHORTCUTS,
  DEFAULT_GOTO_SHORTCUTS,
  getEffectiveShortcuts,
  getEffectiveGotoShortcuts,
  loadCustomBindings,
  saveCustomBindings,
  clearCustomBindings,
  prettyKey,
  type ShortcutDef,
  type ShortcutAction,
  type ShortcutCategory,
  type GotoShortcutDef,
  type GotoTarget,
} from '../../config/keyboard-shortcuts';

import type { SettingsTabProps } from './types';


const CATEGORIES: ShortcutCategory[] = ['Navigation', 'Actions', 'Compose'];

type EditingTarget =
  | { type: 'shortcut'; action: ShortcutAction; index: number | 'new' }
  | { type: 'goto'; target: GotoTarget; index: number | 'new' }
  | null;

export function KeyboardShortcutsTab({ settings, updateSetting }: SettingsTabProps) {
  const [shortcuts, setShortcuts] = useState<ShortcutDef[]>(getEffectiveShortcuts);
  const [gotoShortcuts, setGotoShortcuts] = useState<GotoShortcutDef[]>(getEffectiveGotoShortcuts);
  const [editing, setEditing] = useState<EditingTarget>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const captureRef = useRef<HTMLDivElement>(null);

  // Reload from storage whenever we're not editing
  useEffect(() => {
    if (!editing) {
      setShortcuts(getEffectiveShortcuts());
      setGotoShortcuts(getEffectiveGotoShortcuts());
    }
  }, [editing]);

  // Focus the capture overlay when editing
  useEffect(() => {
    if (editing) {
      captureRef.current?.focus();
    }
  }, [editing]);

  const persist = useCallback((updatedShortcuts: ShortcutDef[], updatedGoto: GotoShortcutDef[]) => {
    const bindings = loadCustomBindings();

    // Build shortcut overrides (only store what differs from defaults)
    const shortcutOverrides: Record<string, string[]> = {};
    for (const s of updatedShortcuts) {
      const def = DEFAULT_SHORTCUTS.find(d => d.action === s.action);
      if (def && JSON.stringify(def.keys) !== JSON.stringify(s.keys)) {
        shortcutOverrides[s.action] = s.keys;
      }
    }

    // Build goto overrides
    const gotoOverrides: Record<string, string[]> = {};
    for (const g of updatedGoto) {
      const def = DEFAULT_GOTO_SHORTCUTS.find(d => d.target === g.target);
      if (def && JSON.stringify(def.keys) !== JSON.stringify(g.keys)) {
        gotoOverrides[g.target] = g.keys;
      }
    }

    bindings.shortcuts = Object.keys(shortcutOverrides).length > 0 ? shortcutOverrides as any : undefined;
    bindings.goto = Object.keys(gotoOverrides).length > 0 ? gotoOverrides as any : undefined;

    saveCustomBindings(bindings);
  }, []);

  const findConflict = useCallback((key: string, excludeAction?: ShortcutAction, excludeGoto?: GotoTarget): string | null => {
    // Check against all shortcuts
    for (const s of shortcuts) {
      if (s.action === excludeAction) continue;
      if (s.keys.includes(key)) {
        return `"${prettyKey(key)}" is already used by "${s.label}"`;
      }
    }
    // Check goto shortcuts
    for (const g of gotoShortcuts) {
      if (g.target === excludeGoto) continue;
      if (g.keys.includes(key)) {
        return `"${prettyKey(key)}" is already used by Go To "${g.label}"`;
      }
    }
    return null;
  }, [shortcuts, gotoShortcuts]);

  const handleKeyCapture = useCallback((e: React.KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();

    // Ignore modifier-only presses
    if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return;

    const key = e.key;

    if (key === 'Escape') {
      setEditing(null);
      setConflict(null);
      return;
    }

    if (!editing) return;

    if (editing.type === 'shortcut') {
      const conflictMsg = findConflict(key, editing.action);
      if (conflictMsg) {
        setConflict(conflictMsg);
        return;
      }

      setConflict(null);
      const updated = shortcuts.map(s => {
        if (s.action !== editing.action) return s;
        if (editing.index === 'new') {
          return { ...s, keys: [...s.keys, key] };
        }
        const newKeys = [...s.keys];
        newKeys[editing.index] = key;
        return { ...s, keys: newKeys };
      });
      setShortcuts(updated);
      persist(updated, gotoShortcuts);
      setEditing(null);
    } else if (editing.type === 'goto') {
      const conflictMsg = findConflict(key, undefined, editing.target);
      if (conflictMsg) {
        setConflict(conflictMsg);
        return;
      }

      setConflict(null);
      const updated = gotoShortcuts.map(g => {
        if (g.target !== editing.target) return g;
        if (editing.index === 'new') {
          return { ...g, keys: [...g.keys, key] };
        }
        const newKeys = [...g.keys];
        newKeys[editing.index] = key;
        return { ...g, keys: newKeys };
      });
      setGotoShortcuts(updated);
      persist(shortcuts, updated);
      setEditing(null);
    }
  }, [editing, shortcuts, gotoShortcuts, findConflict, persist]);

  const removeGotoKey = (target: GotoTarget, index: number) => {
    const updated = gotoShortcuts.map(g => {
      if (g.target !== target) return g;
      if (g.keys.length <= 1) return g; // Don't remove last key
      const newKeys = g.keys.filter((_, i) => i !== index);
      return { ...g, keys: newKeys };
    });
    setGotoShortcuts(updated);
    persist(shortcuts, updated);
  };

  const removeKey = (action: ShortcutAction, index: number) => {
    const updated = shortcuts.map(s => {
      if (s.action !== action) return s;
      if (s.keys.length <= 1) return s; // Don't remove last key
      const newKeys = s.keys.filter((_, i) => i !== index);
      return { ...s, keys: newKeys };
    });
    setShortcuts(updated);
    persist(updated, gotoShortcuts);
  };

  const resetToDefaults = () => {
    clearCustomBindings();
    setShortcuts([...DEFAULT_SHORTCUTS]);
    setGotoShortcuts([...DEFAULT_GOTO_SHORTCUTS]);
    setEditing(null);
    setConflict(null);
  };

  const shortcutsByCategory = CATEGORIES.map(cat => ({
    category: cat,
    items: shortcuts.filter(s => s.category === cat),
  }));

  return (
    <div className="space-y-6">
      {/* Enable/Disable */}
      <div className="border-b border-border pb-6">
        <h3 className="text-sm font-semibold mb-4 text-muted-foreground uppercase tracking-wider">
          Keyboard Shortcuts
        </h3>
        <div className="flex items-center justify-between py-3">
          <div>
            <div className="font-medium">Enable keyboard shortcuts</div>
            <div className="text-sm text-muted-foreground">
              Use single-key shortcuts like Gmail (j/k to navigate, e to archive, etc.)
            </div>
          </div>
          <div className="flex gap-4">
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="radio"
                checked={settings.keyboardShortcuts}
                onChange={() => updateSetting('keyboardShortcuts', true)}
                className="text-primary"
              />
              <span className="text-sm">On</span>
            </label>
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="radio"
                checked={!settings.keyboardShortcuts}
                onChange={() => updateSetting('keyboardShortcuts', false)}
                className="text-primary"
              />
              <span className="text-sm">Off</span>
            </label>
          </div>
        </div>
      </div>

      {/* Key capture overlay */}
      {editing && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div
            ref={captureRef}
            tabIndex={0}
            onKeyDown={handleKeyCapture}
            onBlur={() => { setEditing(null); setConflict(null); }}
            className="bg-background border border-border rounded-lg p-8 shadow-xl text-center max-w-sm"
          >
            <div className="text-lg font-medium mb-2">Press a key</div>
            <div className="text-sm text-muted-foreground mb-4">
              {editing.type === 'shortcut'
                ? `Assign a key for "${shortcuts.find(s => s.action === editing.action)?.label}"`
                : `Assign a key for Go To "${gotoShortcuts.find(g => g.target === editing.target)?.label}"`}
            </div>
            {conflict && (
              <div className="text-sm text-red-500 mb-3 font-medium">{conflict}</div>
            )}
            <div className="text-xs text-muted-foreground">Press Escape to cancel</div>
          </div>
        </div>
      )}

      {/* Shortcut categories */}
      {shortcutsByCategory.map(({ category, items }) => (
        <div key={category} className="border-b border-border pb-6">
          <h3 className="text-sm font-semibold mb-4 text-muted-foreground uppercase tracking-wider">
            {category}
          </h3>
          <div className="space-y-1">
            {items.map(shortcut => (
              <div key={shortcut.action} className="flex items-center justify-between py-2.5 group">
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-sm">{shortcut.label}</div>
                  <div className="text-xs text-muted-foreground">{shortcut.description}</div>
                </div>
                <div className="flex items-center gap-2 ml-4 shrink-0">
                  <div className="flex items-center gap-1 flex-wrap">
                    {shortcut.keys.map((key, i) => (
                      <span key={`${key}-${i}`} className="inline-flex items-center gap-1">
                        {i > 0 && (
                          <span className="text-xs text-muted-foreground">&</span>
                        )}
                        <kbd className="px-2 py-0.5 bg-muted border border-border rounded text-xs font-mono min-w-[24px] text-center">
                          {prettyKey(key)}
                        </kbd>
                        {shortcut.keys.length > 1 && (
                          <button
                            onClick={() => removeKey(shortcut.action, i)}
                            className="text-muted-foreground hover:text-red-500 text-[10px] leading-none"
                            title="Remove this key"
                          >
                            ×
                          </button>
                        )}
                      </span>
                    ))}
                  </div>
                  <button
                    onClick={() => setEditing({ type: 'shortcut', action: shortcut.action, index: 0 })}
                    className="px-2 py-1 text-xs border border-border rounded hover:bg-muted transition-colors"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => setEditing({ type: 'shortcut', action: shortcut.action, index: 'new' })}
                    className="px-1.5 py-1 text-xs border border-border rounded hover:bg-muted transition-colors"
                    title="Add another key binding"
                  >
                    +
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}

      {/* Go-To shortcuts */}
      <div className="border-b border-border pb-6">
        <h3 className="text-sm font-semibold mb-4 text-muted-foreground uppercase tracking-wider">
          Go To
        </h3>
        <p className="text-xs text-muted-foreground mb-4">
          Each key works as a direct shortcut and also after pressing <kbd className="px-1 py-0.5 bg-muted border border-border rounded text-xs font-mono">g</kbd>
        </p>
        <div className="space-y-1">
          {gotoShortcuts.map(g => (
            <div key={g.target} className="flex items-center justify-between py-2.5 group">
              <div className="flex-1 min-w-0">
                <div className="font-medium text-sm">{g.label}</div>
                <div className="text-xs text-muted-foreground">{g.description}</div>
              </div>
              <div className="flex items-center gap-2 ml-4 shrink-0">
                <div className="flex items-center gap-1 flex-wrap">
                  {g.keys.map((key, i) => (
                    <span key={`${key}-${i}`} className="inline-flex items-center gap-1">
                      {i > 0 && (
                        <span className="text-xs text-muted-foreground">&</span>
                      )}
                      <kbd className="px-2 py-0.5 bg-muted border border-border rounded text-xs font-mono min-w-[24px] text-center">
                        {prettyKey(key)}
                      </kbd>
                      {g.keys.length > 1 && (
                        <button
                          onClick={() => removeGotoKey(g.target, i)}
                          className="text-muted-foreground hover:text-red-500 text-[10px] leading-none"
                          title="Remove this key"
                        >
                          ×
                        </button>
                      )}
                    </span>
                  ))}
                </div>
                <button
                  onClick={() => setEditing({ type: 'goto', target: g.target, index: 0 })}
                  className="px-2 py-1 text-xs border border-border rounded hover:bg-muted transition-colors"
                >
                  Edit
                </button>
                <button
                  onClick={() => setEditing({ type: 'goto', target: g.target, index: 'new' })}
                  className="px-1.5 py-1 text-xs border border-border rounded hover:bg-muted transition-colors"
                  title="Add another key binding"
                >
                  +
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Reset button */}
      <div className="flex justify-center pt-2">
        <button
          onClick={resetToDefaults}
          className="flex items-center gap-2 px-4 py-2 text-sm border border-border rounded-md hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
        >
          <RotateCcw className="h-3.5 w-3.5" />
          Reset to Defaults
        </button>
      </div>
    </div>
  );
}
