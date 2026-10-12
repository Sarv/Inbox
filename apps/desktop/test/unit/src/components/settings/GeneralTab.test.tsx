// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GeneralTab } from '../../../../../src/components/settings/GeneralTab';
import { defaultSettings, type AppSettings } from '../../../../../src/components/settings/types';
import { useCrashReportChoiceStore } from '../../../../../src/services/crash-report-choice';
import { cleanup, render, settle, toggle, type Mounted } from '../../../../helpers/render';

// The signature editor is its own suite's business, and a heavy one.
vi.mock('../../../../../src/components/settings/SignatureSettings', () => ({ SignatureSettings: () => null }));

/**
 * Settings → General.
 *
 * What breaks if this file goes red: two privacy-relevant switches. The
 * remote-image mode moved to Security → Remote images; a second copy left here
 * would be written back by this screen's Save over the reader's choice there.
 * And "Contact photos from Gravatar" must show what main actually does:
 * off when nothing is stored, on only after the reader opted in.
 */

let mounted: Mounted;
afterEach(() => cleanup());

const mount = (settings: Partial<AppSettings> | Record<string, unknown>) => {
  const updateSetting = vi.fn();
  mounted = render(<GeneralTab settings={settings as AppSettings} updateSetting={updateSetting} />);
  return updateSetting;
};

/** The checkbox inside the label whose visible text is `text`. */
const checkboxLabelled = (text: string) =>
  (mounted.all('label').find((l) => l.textContent?.trim() === text)?.querySelector('input[type="checkbox"]') ?? null) as HTMLInputElement | null;
const gravatar = () => checkboxLabelled('Contact photos from Gravatar');

describe('GeneralTab', () => {
  // Breaks if the remote-image mode is shown (and so saved) here again: the
  // Settings screen's copy is stale the moment Security changes it.
  it('no longer offers the remote-image mode', () => {
    mount(defaultSettings);
    const text = mounted.container.textContent ?? '';
    expect(text).not.toContain('Remote images');
    expect(text).not.toContain('Categorized only');
    const radioLabels = mounted.all('label').filter((l) => l.querySelector('input[type="radio"]')).map((l) => l.textContent?.trim());
    expect(radioLabels).not.toContain('Block');
    expect(radioLabels).not.toContain('Always load');
  });
});

describe('GeneralTab → Contact photos from Gravatar', () => {
  // Breaks if a fresh install sends contact-address hashes without opt-in.
  it('is unticked on a fresh install', () => {
    mount(defaultSettings);
    expect(gravatar()?.checked).toBe(false);
  });

  // Breaks if a missing or malformed Gravatar choice is treated as consent.
  it('is unticked when the stored settings carry no value, or a non-boolean one', () => {
    const { contactGravatar: _omitted, ...withoutGravatar } = defaultSettings;
    mount(withoutGravatar);
    expect(gravatar()?.checked).toBe(false);
    cleanup();

    mount({ ...defaultSettings, contactGravatar: 'yes' as unknown as boolean });
    expect(gravatar()?.checked).toBe(false);
  });

  // Breaks if a reader's explicit "off" is shown as on (or turned on).
  it('stays unticked when the reader turned it off, and ticked when they turned it on', () => {
    mount({ ...defaultSettings, contactGravatar: false });
    expect(gravatar()?.checked).toBe(false);
    cleanup();

    mount({ ...defaultSettings, contactGravatar: true });
    expect(gravatar()?.checked).toBe(true);
  });

  // Breaks if a deliberate opt-in or opt-out is not saved as a boolean.
  it('records an explicit choice either way', () => {
    const on = mount({ ...defaultSettings, contactGravatar: true });
    toggle(gravatar());
    expect(on).toHaveBeenCalledWith('contactGravatar', false);
    cleanup();

    const off = mount({ ...defaultSettings, contactGravatar: false });
    toggle(gravatar());
    expect(off).toHaveBeenCalledWith('contactGravatar', true);
  });

  // Breaks if the explanation suggests probing occurs without consent, or
  // oversells the hash: Gravatar can match it back to the address.
  it('explains that it is opt-in, and what it sends', () => {
    mount(defaultSettings);
    const text = mounted.container.textContent ?? '';
    expect(text).toContain('Contact photos from Gravatar are off until you turn them on');
    expect(text).toContain('a hash of each contact’s address, which Gravatar can match to the address');
    expect(text).not.toContain('on unless you turn them off');
    expect(text).not.toContain('never the address itself');
  });

  // Breaks if the logo/favicon boxes stop reading the same rule as main:
  // on unless explicitly false.
  it('reads the logo and favicon switches with the same rule', () => {
    mount({ ...defaultSettings, senderLogos: false, senderFavicons: 'x' as unknown as boolean });
    expect(checkboxLabelled('Brand logos and verified tick (BIMI)')?.checked).toBe(false);
    expect(checkboxLabelled('Domain favicons')?.checked).toBe(true);
  });

  // Breaks if the logo/favicon boxes record their choice under the wrong
  // setting (main would never be told to stop the lookup).
  it('records the logo and favicon choices under their own settings', () => {
    const update = mount(defaultSettings);
    toggle(checkboxLabelled('Brand logos and verified tick (BIMI)'));
    toggle(checkboxLabelled('Domain favicons'));
    expect(update).toHaveBeenCalledWith('senderLogos', false);
    expect(update).toHaveBeenCalledWith('senderFavicons', false);
  });
});

describe('GeneralTab → Send crash reports (CASA L-8)', () => {
  const diagnostics = { getCrashReports: vi.fn(), setCrashReports: vi.fn() };
  const crashBox = () => checkboxLabelled('Send crash reports');

  beforeEach(() => {
    useCrashReportChoiceStore.setState({ choice: null });
    diagnostics.getCrashReports.mockReset();
    diagnostics.setCrashReports.mockReset();
    (window as unknown as { electronAPI: unknown }).electronAPI = { diagnostics };
  });
  afterEach(() => {
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  });

  const mountWith = async (answer: 'yes' | 'no' | 'unasked') => {
    diagnostics.getCrashReports.mockResolvedValue({ success: true, data: answer });
    const update = mount(defaultSettings);
    await settle();
    return update;
  };

  // Breaks if the box shows anything but main's answer — ticked for a user
  // who was never asked (the old default) or unticked after a yes.
  it('shows main’s answer: ticked only for a yes', async () => {
    await mountWith('unasked');
    expect(crashBox()?.checked).toBe(false);
    cleanup();
    await mountWith('no');
    expect(crashBox()?.checked).toBe(false);
    cleanup();
    await mountWith('yes');
    expect(crashBox()?.checked).toBe(true);
  });

  // Breaks if the choice goes into this screen's settings copy again (which
  // Save would write back and the bootstrap used to push over main's answer)
  // instead of straight to main.
  it('records a change in main at once, never in the settings copy', async () => {
    diagnostics.setCrashReports.mockResolvedValue({ success: true });
    const update = await mountWith('unasked');
    toggle(crashBox());
    await settle();
    expect(diagnostics.setCrashReports).toHaveBeenCalledWith(true);
    expect(crashBox()?.checked).toBe(true);
    toggle(crashBox());
    await settle();
    expect(diagnostics.setCrashReports).toHaveBeenLastCalledWith(false);
    expect(crashBox()?.checked).toBe(false);
    expect(update).not.toHaveBeenCalledWith('crashReports', expect.anything());
  });

  // Breaks if a failed save looks saved: the box must stay as main has it,
  // and say why.
  it('stays as it was and says so when main could not save it', async () => {
    diagnostics.setCrashReports.mockResolvedValue({ success: false, error: 'EACCES' });
    await mountWith('no');
    toggle(crashBox());
    await settle();
    expect(crashBox()?.checked).toBe(false);
    expect(mounted.container.textContent).toContain('That preference could not be saved.');
  });

  // Breaks if the explanation goes back to opt-out wording, or stops saying
  // that no memory dump is sent.
  it('explains that it is off until turned on, and what is sent', async () => {
    await mountWith('unasked');
    const text = mounted.container.textContent ?? '';
    expect(text).toContain('Off until you turn it on.');
    expect(text).toContain('Email addresses are removed, and so are passwords and tokens wherever the app recognises them');
    expect(text).toContain('a copy of the app’s memory');
  });
});
