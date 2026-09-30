// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Only General is exercised; every other tab is its own suite's business and
// pulls in half the app.
const stub = vi.hoisted(() => () => null);
vi.mock('../../../../../src/components/settings/AccountsTab', () => ({ AccountsTab: stub }));
vi.mock('../../../../../src/components/settings/AdvancedTab', () => ({ AdvancedTab: stub }));
vi.mock('../../../../../src/components/settings/AppearanceTab', () => ({ AppearanceTab: stub }));
vi.mock('../../../../../src/components/settings/FiltersTab', () => ({ FiltersTab: stub }));
vi.mock('../../../../../src/components/settings/FoldersTab', () => ({ FoldersTab: stub }));
vi.mock('../../../../../src/components/settings/InboxTab', () => ({ InboxTab: stub }));
vi.mock('../../../../../src/components/settings/KeyboardShortcutsTab', () => ({ KeyboardShortcutsTab: stub }));
vi.mock('../../../../../src/components/settings/SignatureSettings', () => ({ SignatureSettings: stub }));
const store = vi.hoisted(() => ({ reloadInboxSettings: vi.fn() }));
vi.mock('../../../../../src/store/email-store', () => ({ useEmailStore: { getState: () => store } }));

import { Settings } from '../../../../../src/components/settings/Settings';
import { getRemoteImageMode, notifyRemoteImageModeChanged, saveRemoteImageMode } from '../../../../../src/utils/remote-images';
import { cleanup, fire, render, type Mounted } from '../../../../helpers/render';

/**
 * The Settings screen's Save.
 *
 * What breaks if this file goes red: Save writes the screen's WHOLE working
 * copy, loaded when the screen opened. The remote-image mode is chosen on
 * Security → Remote images and saved at once; if Save wrote its copy back, a
 * reader who chose "Block" there and then changed anything here would be
 * silently put back on the old mode — tracking pixels loading for mail they
 * blocked. Same for the blocklist section (Security → Blocklists).
 */

const SETTINGS_KEY = 'sarvinbox-settings';
let mounted: Mounted;

const stored = () => JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null');
const mountSettings = () => { mounted = render(<Settings initialTab="general" />); };
/** Change a setting the General tab owns, then press Save. */
const editAndSave = () => {
  const perFolder = mounted.all('select').find((el) => [...(el as HTMLSelectElement).options].some((o) => o.textContent === '100 (Fast)')) as HTMLSelectElement;
  perFolder.value = '250';
  fire(perFolder, 'change');
  fire(mounted.all('button').find((b) => b.textContent?.includes('Save Changes')) ?? null, 'click');
};

beforeEach(() => {
  localStorage.clear();
  store.reloadInboxSettings.mockClear();
});

/** Seed the settings blob, and say so: the parsed remote-image mode is kept in
 *  memory and re-read only when told the blob changed (app-settings-sync's
 *  write mirror does in the app). */
const seed = (settings: Record<string, unknown>) => {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  notifyRemoteImageModeChanged();
};
afterEach(() => cleanup());

describe('Settings → Save', () => {
  // Breaks if Save reverts a mode chosen on the Security page while this
  // screen was open (its copy was loaded before the choice).
  it('keeps a remote-image mode chosen elsewhere after the screen opened', () => {
    seed({ remoteImageMode: 'always', maxEmailsPerFolder: 1000 });
    mountSettings();
    expect(saveRemoteImageMode('block')).toBe(true); // Security → Remote images

    editAndSave();

    expect(stored().maxEmailsPerFolder).toBe(250); // the screen's own edit lands
    expect(stored().remoteImageMode).toBe('block');
    expect(getRemoteImageMode()).toBe('block');
    expect(store.reloadInboxSettings).toHaveBeenCalledTimes(1);
  });

  // Breaks if Save puts a reader who switched trusted senders OFF (categorized
  // mail only — the value added with the independent switches) back on the
  // screen's copy: trusted senders' pixels would quietly load again.
  it('keeps "categorized mail only", chosen after the screen opened', () => {
    seed({ remoteImageMode: 'safe' });
    mountSettings();
    expect(saveRemoteImageMode('categorized')).toBe(true);

    editAndSave();

    expect(stored().remoteImageMode).toBe('categorized');
    expect(getRemoteImageMode()).toBe('categorized');
  });

  // Breaks if Save writes the screen's DEFAULT mode ('safe') for a reader whose
  // choice is still the legacy boolean — resetting "always block" to the
  // default (trusted senders and categorized mail) just because they changed
  // an unrelated setting.
  it('does not invent a mode for a reader whose choice is still the legacy boolean', () => {
    seed({ autoLoadRemoteImages: false });
    mountSettings();

    editAndSave();

    expect('remoteImageMode' in stored()).toBe(false);
    expect(stored().autoLoadRemoteImages).toBe(false);
    expect(getRemoteImageMode()).toBe('block');
  });

  // Breaks if Save reverts the blocklist section the Security → Blocklists tab
  // wrote while this screen was open.
  it('keeps the blocklist section as the Blocklists tab last wrote it', () => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ reputation: { enabled: true, provider: 'local', chosen: true } }));
    mountSettings();
    const current = stored();
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...current, reputation: { enabled: false, provider: 'local', chosen: true } }));

    editAndSave();

    expect(stored().reputation).toEqual({ enabled: false, provider: 'local', chosen: true });
  });

  // Breaks the Gravatar default for a profile with no stored value: the
  // screen's Save must record it as on (the default), never off.
  it('saves Gravatar as on when the stored settings had no value for it', () => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ signatures: [] }));
    mountSettings();

    editAndSave();

    expect(stored().contactGravatar).toBe(true);
  });

  // Breaks if a reader's explicit Gravatar "off" is turned on by an unrelated Save.
  it('keeps an explicit Gravatar "off" through an unrelated Save', () => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ contactGravatar: false }));
    mountSettings();

    editAndSave();

    expect(stored().contactGravatar).toBe(false);
  });
});
