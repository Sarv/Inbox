import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  crashReportChoice,
  loadCrashReportChoice,
  saveCrashReportChoice,
  useCrashReportChoiceStore,
} from '../../../../src/services/crash-report-choice';

/**
 * The renderer's view of main's crash-report answer (CASA L-8). What breaks
 * if this goes red: the consent dialog, Settings and the renderer's Sentry
 * gate act on an answer main does not have — a yes the next launch won't
 * honour, a "not yet asked" taken as consent, or a dialog that reopens right
 * after the user answered it.
 */

const diagnostics = { getCrashReports: vi.fn(), setCrashReports: vi.fn() };

beforeEach(() => {
  useCrashReportChoiceStore.setState({ choice: null });
  diagnostics.getCrashReports.mockReset();
  diagnostics.setCrashReports.mockReset();
  vi.stubGlobal('window', { electronAPI: { diagnostics } });
});

afterEach(() => vi.unstubAllGlobals());

describe('loadCrashReportChoice', () => {
  // Breaks if main's answer is not what the renderer shows.
  it.each(['yes', 'no', 'unasked'] as const)('takes main’s answer: %s', async (answer) => {
    diagnostics.getCrashReports.mockResolvedValue({ success: true, data: answer });
    expect(await loadCrashReportChoice()).toBe(answer);
    expect(crashReportChoice()).toBe(answer);
  });

  // Breaks if a failed, malformed or missing reply is guessed into an answer
  // (a guess of yes sends; a guess of unasked opens the dialog).
  it('keeps what it had when the answer cannot be read', async () => {
    diagnostics.getCrashReports.mockResolvedValueOnce({ success: false, error: 'x' });
    expect(await loadCrashReportChoice()).toBeNull();
    diagnostics.getCrashReports.mockResolvedValueOnce({ success: true, data: true }); // the old boolean shape
    expect(await loadCrashReportChoice()).toBeNull();
    diagnostics.getCrashReports.mockResolvedValueOnce({ success: false, data: 'yes' }); // a failure is no answer
    expect(await loadCrashReportChoice()).toBeNull();
    diagnostics.getCrashReports.mockRejectedValueOnce(new Error('ipc gone'));
    expect(await loadCrashReportChoice()).toBeNull();

    useCrashReportChoiceStore.setState({ choice: 'no' });
    diagnostics.getCrashReports.mockResolvedValueOnce({ success: false });
    expect(await loadCrashReportChoice()).toBe('no');
  });

  // Breaks in a window without the preload bridge (or outside a window).
  it('is a no-op without the bridge', async () => {
    vi.stubGlobal('window', {});
    expect(await loadCrashReportChoice()).toBeNull();
    vi.unstubAllGlobals();
    expect(await loadCrashReportChoice()).toBeNull();
  });

  // Breaks if a read that was in flight when the user answered lands after
  // the answer and puts "unasked" back — reopening the consent dialog.
  it('never lets a stale read overwrite a newer answer', async () => {
    let reply!: (v: unknown) => void;
    diagnostics.getCrashReports.mockReturnValue(new Promise((resolve) => { reply = resolve; }));
    diagnostics.setCrashReports.mockResolvedValue({ success: true });

    const reading = loadCrashReportChoice();
    expect(await saveCrashReportChoice(true)).toBe(true);
    reply({ success: true, data: 'unasked' });
    expect(await reading).toBe('yes');
    expect(crashReportChoice()).toBe('yes');
  });
});

describe('saveCrashReportChoice', () => {
  // Breaks if the toggle/dialog records the wrong answer in main.
  it('records yes and no in main, then shows them', async () => {
    diagnostics.setCrashReports.mockResolvedValue({ success: true });
    expect(await saveCrashReportChoice(true)).toBe(true);
    expect(diagnostics.setCrashReports).toHaveBeenLastCalledWith(true);
    expect(crashReportChoice()).toBe('yes');
    expect(await saveCrashReportChoice(false)).toBe(true);
    expect(diagnostics.setCrashReports).toHaveBeenLastCalledWith(false);
    expect(crashReportChoice()).toBe('no');
  });

  // Breaks if the window shows an answer main failed to save — the next
  // launch would do something else than the screen said.
  it('changes nothing when main could not save it', async () => {
    useCrashReportChoiceStore.setState({ choice: 'unasked' });
    diagnostics.setCrashReports.mockResolvedValueOnce({ success: false, error: 'EACCES' });
    expect(await saveCrashReportChoice(true)).toBe(false);
    diagnostics.setCrashReports.mockRejectedValueOnce(new Error('ipc gone'));
    expect(await saveCrashReportChoice(true)).toBe(false);
    vi.stubGlobal('window', {});
    expect(await saveCrashReportChoice(true)).toBe(false);
    expect(crashReportChoice()).toBe('unasked');
  });
});
