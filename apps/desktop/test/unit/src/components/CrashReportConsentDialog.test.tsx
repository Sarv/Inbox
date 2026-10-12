// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CrashReportConsentDialog } from '../../../../src/components/CrashReportConsentDialog';
import { useCrashReportChoiceStore } from '../../../../src/services/crash-report-choice';
import { cleanup, fire, render, settle } from '../../../helpers/render';

/**
 * The one-time crash-report question (CASA L-8: off until the user says yes).
 *
 * What breaks if this goes red: the app asks when it should not (every
 * launch, on top of onboarding, after the user answered), never asks (so
 * reporting stays off for everyone, or a legacy install keeps an answer it
 * never gave), records the wrong answer, or turns a dismissal into one.
 */

const diagnostics = { getCrashReports: vi.fn(), setCrashReports: vi.fn() };

beforeEach(() => {
  useCrashReportChoiceStore.setState({ choice: null });
  diagnostics.getCrashReports.mockReset();
  diagnostics.setCrashReports.mockReset();
  diagnostics.setCrashReports.mockResolvedValue({ success: true });
  (window as unknown as { electronAPI: unknown }).electronAPI = { diagnostics };
});

afterEach(() => {
  cleanup();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

const mount = async (answer: unknown, suppressed = false) => {
  diagnostics.getCrashReports.mockResolvedValue(answer);
  const view = render(<CrashReportConsentDialog suppressed={suppressed} />);
  await settle();
  return view;
};

const dialog = () => document.querySelector('[role="dialog"]');
const button = (label: string) =>
  [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === label) ?? null;

describe('CrashReportConsentDialog', () => {
  // Breaks if a user main reports as never asked is not asked.
  it('asks when main reports the question unanswered', async () => {
    await mount({ success: true, data: 'unasked' });
    expect(dialog()).not.toBeNull();
    expect(dialog()?.textContent).toContain('Send crash reports to Sarv?');
  });

  // Breaks if the dialog asks again after an answer, or on a guess.
  it.each([
    ['a yes', { success: true, data: 'yes' }],
    ['a no', { success: true, data: 'no' }],
    ['a failed read', { success: false, error: 'boom' }],
    ['the old boolean reply', { success: true, data: true }],
  ])('stays hidden after %s', async (_label, answer) => {
    await mount(answer);
    expect(dialog()).toBeNull();
  });

  // Breaks if it lands on top of onboarding — a new user meets it after
  // setup, when onboarding stops showing.
  it('waits while onboarding is on screen', async () => {
    const view = await mount({ success: true, data: 'unasked' }, true);
    expect(dialog()).toBeNull();
    view.rerender(<CrashReportConsentDialog suppressed={false} />);
    await settle();
    expect(dialog()).not.toBeNull();
  });

  // Breaks if a button records the opposite answer, or the dialog stays up
  // after main saved it.
  it.each([
    ['Send crash reports', true],
    ['Don’t send', false],
  ])('“%s” records %s in main and closes', async (label, enabled) => {
    await mount({ success: true, data: 'unasked' });
    fire(button(label), 'click');
    await settle();
    expect(diagnostics.setCrashReports).toHaveBeenCalledTimes(1);
    expect(diagnostics.setCrashReports).toHaveBeenCalledWith(enabled);
    expect(dialog()).toBeNull();
  });

  // Breaks if closing counts as an answer: Escape or a click outside must
  // record nothing, so the question comes back next launch and nothing is
  // sent meanwhile.
  it('records nothing when closed by Escape or a click outside', async () => {
    await mount({ success: true, data: 'unasked' });
    fire(document.body, 'keydown', { key: 'Escape' });
    await settle();
    expect(dialog()).toBeNull();
    cleanup();

    await mount({ success: true, data: 'unasked' });
    fire(dialog(), 'click');
    await settle();
    expect(dialog()).toBeNull();

    expect(diagnostics.setCrashReports).not.toHaveBeenCalled();
    expect(useCrashReportChoiceStore.getState().choice).toBe('unasked');
  });

  // Breaks if a click inside the panel (on its text) dismisses it.
  it('stays open for a click inside the panel', async () => {
    await mount({ success: true, data: 'unasked' });
    fire(document.getElementById('crash-consent-body'), 'click');
    await settle();
    expect(dialog()).not.toBeNull();
  });

  // Breaks if the mail list's keyboard shortcuts act underneath the dialog.
  it('keeps keystrokes from reaching the app underneath while open', async () => {
    const underneath = vi.fn();
    document.addEventListener('keydown', underneath);
    try {
      await mount({ success: true, data: 'unasked' });
      fire(document.body, 'keydown', { key: 'j' });
      expect(underneath).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener('keydown', underneath);
    }
  });

  // Breaks if Enter could consent: focus starts on the heading, not on a
  // button.
  it('pre-focuses neither answer', async () => {
    await mount({ success: true, data: 'unasked' });
    expect(document.activeElement?.id).toBe('crash-consent-title');
  });

  // Breaks if a failed save closes the dialog as if answered.
  it('stays open and says so when the answer could not be saved', async () => {
    diagnostics.setCrashReports.mockResolvedValue({ success: false, error: 'EACCES' });
    await mount({ success: true, data: 'unasked' });
    fire(button('Send crash reports'), 'click');
    await settle();
    expect(dialog()).not.toBeNull();
    expect(dialog()?.textContent).toContain('Your answer could not be saved.');
    expect((button('Send crash reports') as HTMLButtonElement).disabled).toBe(false);
  });

  // Breaks if the wording stops saying what is sent, that no memory dump
  // is, or where to change it.
  it('says what a report carries, what it never does, and where to change it', async () => {
    await mount({ success: true, data: 'unasked' });
    const text = dialog()?.textContent ?? '';
    expect(text).toContain('the error, the app version, your operating system and language');
    // Adversarial review: the activity trail and server name travel too, so
    // the consent text says so. Breaks if consent is asked on a partial list.
    expect(text).toContain('your mail server’s name, and a trail of recent app activity such as sync steps and folder names');
    expect(text).toContain('Email addresses are removed, and so are passwords and tokens wherever the app recognises them');
    expect(text).toContain('a copy of the app’s memory');
    expect(text).toContain('Settings → General');
  });
});
