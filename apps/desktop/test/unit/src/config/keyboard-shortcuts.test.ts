import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import type { GotoTarget, ShortcutAction } from '../../../../src/config/keyboard-shortcuts';
import {
  DEFAULT_GOTO_SHORTCUTS,
  DEFAULT_SHORTCUTS,
  GOTO_TIMEOUT_MS,
  MOD_KEY,
  SINGLE_KEY_SHORTCUTS,
  clearCustomBindings,
  getEffectiveGotoRecord,
  getEffectiveGotoShortcuts,
  getEffectiveShortcuts,
  getGotoShortcutHint,
  getGotoShortcutHints,
  getShortcutHint,
  getShortcutHints,
  loadCustomBindings,
  prettyKey,
  saveCustomBindings,
} from '../../../../src/config/keyboard-shortcuts';

const KEY = 'sarvinbox-keyboard-shortcuts';

/** The vitest env is 'node', which has no localStorage. */
const installLocalStorage = () => {
  const store = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  };
};

beforeEach(installLocalStorage);
afterEach(() => {
  delete (globalThis as any).localStorage;
});

describe('DEFAULT_SHORTCUTS', () => {
  // Gmail-style single-key shortcuts. The invariants that matter: one def per
  // action (the resolver uses `find`, so a duplicate action is unreachable), and
  // no unshifted key claimed by two actions — that is a silently dead binding.
  it('defines each action exactly once', () => {
    const actions = DEFAULT_SHORTCUTS.map((s) => s.action);
    expect(new Set(actions).size).toBe(actions.length);
  });

  it('gives every def a label, a description, a category and at least one key', () => {
    for (const s of DEFAULT_SHORTCUTS) {
      expect(s.keys.length).toBeGreaterThan(0);
      expect(s.label).toBeTruthy();
      expect(s.description).toBeTruthy();
      expect(['Navigation', 'Actions', 'Compose', 'Go To']).toContain(s.category);
    }
  });

  it('never binds the same key to two actions at the same shift level', () => {
    const seen = new Map<string, ShortcutAction>();
    for (const s of DEFAULT_SHORTCUTS) {
      for (const key of s.keys) {
        const id = `${s.shift ? 'shift+' : ''}${key}`;
        expect(seen.has(id), `${id} bound to both ${seen.get(id)} and ${s.action}`).toBe(false);
        seen.set(id, s.action);
      }
    }
  });

  it('keeps the SINGLE_KEY_SHORTCUTS legacy alias pointing at the same list', () => {
    expect(SINGLE_KEY_SHORTCUTS).toBe(DEFAULT_SHORTCUTS);
  });

  it('pins the destructive/high-traffic bindings users have muscle memory for', () => {
    const of = (action: ShortcutAction) => DEFAULT_SHORTCUTS.find((s) => s.action === action);
    expect(of('ARCHIVE')?.keys).toEqual(['e']);
    expect(of('DELETE')?.keys).toEqual(['d', '#', 'Backspace', 'Delete']);
    expect(of('STAR_TOGGLE')?.keys).toEqual(['s']);
    expect(of('UNDO_DELETE')?.keys).toEqual(['u']);
    // Mark read/unread are SHIFTED, so plain i/u stay free for go-to and undo.
    expect(of('MARK_READ')).toMatchObject({ keys: ['I'], shift: true });
    expect(of('MARK_UNREAD')).toMatchObject({ keys: ['U'], shift: true });
  });
});

describe('DEFAULT_GOTO_SHORTCUTS', () => {
  it('defines each target once, with unique keys', () => {
    const targets = DEFAULT_GOTO_SHORTCUTS.map((s) => s.target);
    expect(new Set(targets).size).toBe(targets.length);
    const keys = DEFAULT_GOTO_SHORTCUTS.flatMap((s) => s.keys);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('gives the chord a 1s window to complete', () => {
    // Long enough to type "g" then a letter, short enough that a later lone
    // keypress isn't swallowed as part of the chord.
    expect(GOTO_TIMEOUT_MS).toBe(1000);
  });
});

describe('custom bindings persistence', () => {
  it('returns {} when nothing is stored', () => {
    expect(loadCustomBindings()).toEqual({});
  });

  it('round-trips a saved rebinding', () => {
    saveCustomBindings({ shortcuts: { ARCHIVE: ['y'] }, goto: { inbox: ['h'] } });
    expect(loadCustomBindings()).toEqual({ shortcuts: { ARCHIVE: ['y'] }, goto: { inbox: ['h'] } });
  });

  it('returns {} (never throws) on corrupt stored JSON', () => {
    // A bad blob must not break every keystroke in the app — fall back to defaults.
    localStorage.setItem(KEY, '{not json');
    expect(loadCustomBindings()).toEqual({});
  });

  it('clears back to the defaults', () => {
    saveCustomBindings({ shortcuts: { ARCHIVE: ['y'] } });
    clearCustomBindings();
    expect(loadCustomBindings()).toEqual({});
    expect(getEffectiveShortcuts()).toBe(DEFAULT_SHORTCUTS);
  });
});

describe('getEffectiveShortcuts', () => {
  it('returns the DEFAULTS BY REFERENCE when nothing is customised', () => {
    // Identity matters: a fresh array each call would re-run every consumer's
    // effect/memo on every render.
    expect(getEffectiveShortcuts()).toBe(DEFAULT_SHORTCUTS);
    saveCustomBindings({ goto: { inbox: ['h'] } }); // goto-only override
    expect(getEffectiveShortcuts()).toBe(DEFAULT_SHORTCUTS);
  });

  it('overrides only the customised action\'s keys, keeping its label/category', () => {
    saveCustomBindings({ shortcuts: { ARCHIVE: ['y', 'Y'] } });
    const shortcuts = getEffectiveShortcuts();
    const archive = shortcuts.find((s) => s.action === 'ARCHIVE')!;
    expect(archive.keys).toEqual(['y', 'Y']);
    expect(archive.label).toBe('Archive');
    // Every other def is untouched (same object).
    const idx = DEFAULT_SHORTCUTS.findIndex((s) => s.action === 'DELETE');
    expect(shortcuts[idx]).toBe(DEFAULT_SHORTCUTS[idx]);
  });
});

describe('getEffectiveGotoShortcuts / getEffectiveGotoRecord', () => {
  it('returns the defaults by reference with no goto overrides', () => {
    expect(getEffectiveGotoShortcuts()).toBe(DEFAULT_GOTO_SHORTCUTS);
    saveCustomBindings({ shortcuts: { ARCHIVE: ['y'] } }); // shortcuts-only override
    expect(getEffectiveGotoShortcuts()).toBe(DEFAULT_GOTO_SHORTCUTS);
  });

  it('applies a goto override for that target only', () => {
    saveCustomBindings({ goto: { inbox: ['h'] } });
    const gotos = getEffectiveGotoShortcuts();
    expect(gotos.find((g) => g.target === 'inbox')?.keys).toEqual(['h']);
    expect(gotos.find((g) => g.target === 'sent')?.keys).toEqual(['t']);
  });

  it('flattens to a key → target record covering EVERY bound key', () => {
    saveCustomBindings({ goto: { inbox: ['h', 'i'] } });
    const record = getEffectiveGotoRecord();
    expect(record.h).toBe('inbox');
    expect(record.i).toBe('inbox');
    expect(record.d).toBe('drafts');
    expect(Object.keys(record)).toHaveLength(DEFAULT_GOTO_SHORTCUTS.length + 1);
  });
});

describe('prettyKey', () => {
  it('maps the non-printable keys to their display glyphs', () => {
    expect(prettyKey('ArrowDown')).toBe('↓');
    expect(prettyKey('ArrowUp')).toBe('↑');
    expect(prettyKey('ArrowLeft')).toBe('←');
    expect(prettyKey('ArrowRight')).toBe('→');
    expect(prettyKey('Escape')).toBe('Esc');
    expect(prettyKey(' ')).toBe('Space');
    expect(prettyKey('Backspace')).toBe('⌫');
    expect(prettyKey('Delete')).toBe('Del');
    expect(prettyKey('Tab')).toBe('Tab');
  });

  it('passes a printable key through unchanged, preserving case', () => {
    expect(prettyKey('e')).toBe('e');
    expect(prettyKey('I')).toBe('I');
    expect(prettyKey('#')).toBe('#');
  });
});

describe('getShortcutHints / getShortcutHint', () => {
  // These strings appear on toolbar tooltips and in the help sheet; they must
  // match what the handler actually listens for, including the Shift prefix.
  it('lists every alternate key for the action', () => {
    expect(getShortcutHints('MOVE_DOWN')).toEqual(['j', '↓']);
    expect(getShortcutHints('DELETE')).toEqual(['d', '#', '⌫', 'Del']);
  });

  it('prefixes shifted shortcuts with Shift+', () => {
    expect(getShortcutHints('MARK_READ')).toEqual(['Shift+I']);
    expect(getShortcutHints('FORWARD_POPUP')).toEqual(['Shift+F']);
  });

  it('deduplicates keys that render to the same display string', () => {
    // e.g. a rebinding to ['e','e'] must not print the chip twice.
    saveCustomBindings({ shortcuts: { ARCHIVE: ['e', 'e'] } });
    expect(getShortcutHints('ARCHIVE')).toEqual(['e']);
  });

  it('reflects a custom rebinding', () => {
    saveCustomBindings({ shortcuts: { ARCHIVE: ['y'] } });
    expect(getShortcutHint('ARCHIVE')).toBe('y');
  });

  it('returns nothing for an unknown action rather than throwing', () => {
    expect(getShortcutHints('NOT_AN_ACTION' as ShortcutAction)).toEqual([]);
    expect(getShortcutHint('NOT_AN_ACTION' as ShortcutAction)).toBe('');
  });

  it('getShortcutHint is the first hint only', () => {
    expect(getShortcutHint('MOVE_DOWN')).toBe('j');
  });
});

describe('getGotoShortcutHints / getGotoShortcutHint', () => {
  it('offers both the direct key and the g-chord form', () => {
    expect(getGotoShortcutHints('inbox')).toEqual(['i', 'g then i']);
    expect(getGotoShortcutHint('drafts')).toBe('g then d');
  });

  it('reflects a custom goto rebinding', () => {
    saveCustomBindings({ goto: { inbox: ['h'] } });
    expect(getGotoShortcutHints('inbox')).toEqual(['h', 'g then h']);
    expect(getGotoShortcutHint('inbox')).toBe('g then h');
  });

  it('returns nothing for an unknown target, and an empty chord for the shorthand', () => {
    expect(getGotoShortcutHints('nowhere' as GotoTarget)).toEqual([]);
    expect(getGotoShortcutHint('nowhere' as GotoTarget)).toBe('g then ');
  });
});

describe('MOD_KEY', () => {
  it('resolves to a platform modifier symbol at module load', () => {
    // Read from navigator.platform once, so it must be one of the two values
    // rather than undefined (which would render "undefined+K" in tooltips).
    expect(['⌘', 'Ctrl']).toContain(MOD_KEY);
  });
});
