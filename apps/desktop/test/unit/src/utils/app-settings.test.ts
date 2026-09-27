import { afterEach, describe, expect, it, vi } from 'vitest';

import { defaultSettings } from '../../../../src/components/settings/types';
import { readAppSettings, readUndoSendDelayMs, undoSendDelayMs } from '../../../../src/utils/app-settings';

// What breaks if this suite goes red: every setting read outside React. The
// reader runs on the send path, so a throw here is a mail that never leaves —
// and a wrong undo window is either an Undo button that does nothing or a
// message held after the toast has gone.

const stubStorage = (raw: string | null) => {
  vi.stubGlobal('localStorage', {
    getItem: () => {
      if (raw === 'THROW') throw new Error('SecurityError');
      return raw;
    },
    setItem: () => {},
    removeItem: () => {},
  });
};

afterEach(() => vi.unstubAllGlobals());

describe('readAppSettings', () => {
  it('returns the defaults when nothing is stored', () => {
    stubStorage(null);
    expect(readAppSettings()).toEqual(defaultSettings);
  });

  it('merges the stored values over the defaults', () => {
    stubStorage(JSON.stringify({ undoSendDelay: 30 }));
    const settings = readAppSettings();
    expect(settings.undoSendDelay).toBe(30);
    // Regression: a partial blob must not blank every field it omits.
    expect(settings.emailsPerPage).toBe(defaultSettings.emailsPerPage);
  });

  // Regression: this runs while sending. A parse error must degrade to the
  // defaults, never propagate into the send path.
  it('falls back to the defaults on a corrupt blob', () => {
    stubStorage('{not json');
    expect(readAppSettings()).toEqual(defaultSettings);
  });

  it('falls back to the defaults on a non-object blob', () => {
    stubStorage('"a string"');
    expect(readAppSettings()).toEqual(defaultSettings);
  });

  // A denied/unavailable localStorage (private window, blocked site data)
  // throws on access rather than returning null.
  it('falls back to the defaults when localStorage throws', () => {
    stubStorage('THROW');
    expect(readAppSettings()).toEqual(defaultSettings);
  });
});

describe('undoSendDelayMs', () => {
  it('converts the stored seconds to milliseconds', () => {
    expect(undoSendDelayMs(5)).toBe(5000);
    expect(undoSendDelayMs(30)).toBe(30000);
    // A minute-plus window is a supported choice, not an out-of-range value.
    expect(undoSendDelayMs(60)).toBe(60000);
    expect(undoSendDelayMs(300)).toBe(300000);
  });

  // Regression: NaN reaches setTimeout as "fire now", which transmits the mail
  // before the Undo button has rendered — the one thing the window prevents.
  it('falls back to the default for a non-number', () => {
    for (const bad of [undefined, null, 'ten', NaN, Infinity]) {
      expect(undoSendDelayMs(bad)).toBe(defaultSettings.undoSendDelay * 1000);
    }
  });

  it('clamps out-of-range values into the honoured window', () => {
    expect(undoSendDelayMs(0)).toBe(1000);
    expect(undoSendDelayMs(-10)).toBe(1000);
    expect(undoSendDelayMs(9999)).toBe(300000);
  });

  it('rounds a fractional value to whole seconds', () => {
    expect(undoSendDelayMs(7.4)).toBe(7000);
  });
});

describe('readUndoSendDelayMs', () => {
  // Regression: the whole point of the change. The select in Settings wrote
  // this value and nothing read it — 30 seconds behaved exactly like 5.
  it('reads the configured window from the stored settings', () => {
    stubStorage(JSON.stringify({ undoSendDelay: 20 }));
    expect(readUndoSendDelayMs()).toBe(20000);
  });

  it('uses the default window when nothing is stored', () => {
    stubStorage(null);
    expect(readUndoSendDelayMs()).toBe(defaultSettings.undoSendDelay * 1000);
  });
});
