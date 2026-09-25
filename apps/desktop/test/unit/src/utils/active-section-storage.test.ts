import { describe, it, expect, afterEach } from 'vitest';

import { APP_SECTIONS } from '../../../../src/components/app-sections';
import {
  ACTIVE_SECTION_KEY,
  persistActiveSection,
  restoreActiveSection,
  DEFAULT_SECTION,
  isAppSection,
  readActiveSection,
  writeActiveSection,
  type SectionStore,
} from '../../../../src/utils/active-section-storage';

/** A sessionStorage stand-in whose reads/writes can be made to fail. */
function fakeStore(seed: Record<string, string> = {}) {
  const data = new Map(Object.entries(seed));
  return {
    data,
    failRead: false,
    failWrite: false,
    getItem(key: string) {
      if (this.failRead) throw new Error('storage denied');
      return data.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      if (this.failWrite) throw new Error('quota exceeded');
      data.set(key, value);
    },
  } satisfies SectionStore & Record<string, unknown>;
}

describe('isAppSection', () => {
  // If this drifts, a section the app really renders is treated as garbage and
  // the user is sent to the inbox anyway — the bug this module exists to fix.
  it('accepts every section the app can render', () => {
    for (const section of APP_SECTIONS) expect(isAppSection(section)).toBe(true);
  });

  // A value written by an older build, or hand-edited, must not reach App's
  // renderContent switch — it falls through to `null` and paints an empty pane.
  it('rejects anything that is not a known section', () => {
    for (const value of ['', 'inbox', 'Mail', 'settings ', 'nope']) {
      expect(isAppSection(value)).toBe(false);
    }
  });

  it('rejects non-strings', () => {
    for (const value of [null, undefined, 42, {}, ['mail']]) {
      expect(isAppSection(value)).toBe(false);
    }
  });
});

describe('readActiveSection', () => {
  // The restore itself: the section recorded before the reload comes back.
  it('returns the stored section', () => {
    const store = fakeStore({ [ACTIVE_SECTION_KEY]: 'settings' });
    expect(readActiveSection(store)).toBe('settings');
  });

  // A cold launch (new session, nothing stored) still opens on the mailbox.
  it('falls back to the mailbox when nothing is stored', () => {
    expect(readActiveSection(fakeStore())).toBe('mail');
    expect(DEFAULT_SECTION).toBe('mail');
  });

  it('falls back to the mailbox for a section this build no longer has', () => {
    expect(readActiveSection(fakeStore({ [ACTIVE_SECTION_KEY]: 'webmail-classic' }))).toBe('mail');
  });

  // This runs inside App's first render, where a throw is a white screen.
  it('falls back to the mailbox when the storage read throws', () => {
    const store = fakeStore({ [ACTIVE_SECTION_KEY]: 'contacts' });
    store.failRead = true;
    expect(readActiveSection(store)).toBe('mail');
  });

  it('falls back to the mailbox with no store at all', () => {
    expect(readActiveSection(null)).toBe('mail');
    expect(readActiveSection(undefined)).toBe('mail');
  });
});

describe('writeActiveSection', () => {
  it('records the section under the shared key', () => {
    const store = fakeStore();
    writeActiveSection(store, 'security');
    expect(store.data.get(ACTIVE_SECTION_KEY)).toBe('security');
  });

  it('overwrites the previous section rather than accumulating', () => {
    const store = fakeStore();
    writeActiveSection(store, 'settings');
    writeActiveSection(store, 'mail');
    expect(store.data.get(ACTIVE_SECTION_KEY)).toBe('mail');
    expect(store.data.size).toBe(1);
  });

  // A denied or full store costs the restore, never the navigation the user
  // just asked for.
  it('swallows a failing write', () => {
    const store = fakeStore();
    store.failWrite = true;
    expect(() => writeActiveSection(store, 'settings')).not.toThrow();
  });

  it('does nothing with no store at all', () => {
    expect(() => writeActiveSection(null, 'settings')).not.toThrow();
    expect(() => writeActiveSection(undefined, 'settings')).not.toThrow();
  });
});

describe('round trip', () => {
  // The contract App depends on: whatever was written is what comes back.
  it('reads back every section it can write', () => {
    const store = fakeStore();
    for (const section of APP_SECTIONS) {
      writeActiveSection(store, section);
      expect(readActiveSection(store)).toBe(section);
    }
  });
});

describe('the bound sessionStorage wrappers', () => {
  const globals = globalThis as Record<string, unknown>;

  afterEach(() => {
    delete globals.sessionStorage;
  });

  // This file runs in the node environment, where `sessionStorage` does not
  // exist at all — the same shape as a build with no DOM. Neither wrapper may
  // throw there, or App cannot render.
  it('falls back to the mailbox where sessionStorage does not exist', () => {
    expect(restoreActiveSection()).toBe('mail');
    expect(() => persistActiveSection('settings')).not.toThrow();
  });

  // A browser set to block site data throws on the property ACCESS itself, not
  // on getItem — so the guard has to sit around the lookup, not only the read.
  it('falls back to the mailbox when reaching sessionStorage throws', () => {
    Object.defineProperty(globals, 'sessionStorage', {
      configurable: true,
      get() {
        throw new Error('site data blocked');
      },
    });
    expect(restoreActiveSection()).toBe('mail');
    expect(() => persistActiveSection('settings')).not.toThrow();
  });

  it('uses sessionStorage when it is available', () => {
    const store = fakeStore();
    Object.defineProperty(globals, 'sessionStorage', { configurable: true, value: store });
    persistActiveSection('agent');
    expect(store.data.get(ACTIVE_SECTION_KEY)).toBe('agent');
    expect(restoreActiveSection()).toBe('agent');
  });
});
