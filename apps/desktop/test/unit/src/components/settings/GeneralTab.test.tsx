// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GeneralTab } from '../../../../../src/components/settings/GeneralTab';
import { defaultSettings, type AppSettings } from '../../../../../src/components/settings/types';
import { cleanup, render, toggle, type Mounted } from '../../../../helpers/render';

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
