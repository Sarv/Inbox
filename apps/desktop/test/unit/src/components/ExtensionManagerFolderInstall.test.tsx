// @vitest-environment happy-dom
import { setLogSink } from '@sarvinbox/core/logger';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ExtensionManager } from '../../../../src/components/ExtensionManager';
import { act, cleanup, render, type Mounted } from '../../../helpers/render';

/**
 * Install from folder asks before it installs (CASA audit L-9).
 *
 * What breaks if this file goes red: one click on "Install from folder" goes
 * straight to the folder picker and installs whatever is chosen — no checksum,
 * no permission prompt, every permission its manifest lists granted and the
 * extension switched on — without the user ever being told that an extension
 * runs as full code with the app's access to their files and mail data. The
 * registry path has always had a consent screen; this one had none.
 */

const buildApi = () => ({
  list: vi.fn(async () => ({ success: true, data: [] })),
  getInfo: vi.fn(async () => ({ success: false })),
  enable: vi.fn(async () => ({ success: true })),
  disable: vi.fn(async () => ({ success: true })),
  uninstall: vi.fn(async () => ({ success: true })),
  selectAndInstall: vi.fn(async (): Promise<{ success: boolean; error?: string }> => ({ success: true })),
  browse: vi.fn(async () => ({ success: true, data: { items: [], registries: [] } })),
  registryDetail: vi.fn(async () => ({ success: false })),
  installFromRegistry: vi.fn(async () => ({ success: true })),
});

let api: ReturnType<typeof buildApi>;

const settle = async () => {
  await act(async () => {
    for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();
  });
};

const mount = async (): Promise<Mounted> => {
  const view = render(<ExtensionManager />);
  await settle();
  return view;
};

const click = async (element: HTMLElement | null | undefined) => {
  expect(element).toBeTruthy();
  await act(async () => {
    element!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await settle();
};

const button = (view: Mounted, text: string) =>
  view.all('button').find((node) => node.textContent?.trim() === text);

/** The confirmation dialog the folder install raises (ConfirmDialogView). */
const dialog = (view: Mounted) =>
  view.all('[role="dialog"]').find((node) => node.textContent?.includes('from a folder'));

beforeEach(() => {
  api = buildApi();
  (window as unknown as Record<string, unknown>).electronAPI = { extensions: api };
});

afterEach(() => {
  cleanup();
  setLogSink(null);
  delete (window as unknown as Record<string, unknown>).electronAPI;
});

describe('ExtensionManager install from folder', () => {
  // Regression (L-9): the click went straight to selectAndInstall.
  it('shows the trust notice first and picks nothing until it is confirmed', async () => {
    const view = await mount();
    await click(button(view, 'Install from folder'));

    const text = dialog(view)?.textContent ?? '';
    expect(text).toContain('runs as full code on your computer');
    expect(text).toContain('same access to your files and mail data as Sarv Inbox itself');
    expect(text).toContain('gets every permission its manifest lists');
    expect(api.selectAndInstall).not.toHaveBeenCalled();
  });

  // Regression: declining has to mean nothing happens — no picker, no install,
  // no reload of the list.
  it('installs nothing when the notice is cancelled', async () => {
    const view = await mount();
    const listCalls = api.list.mock.calls.length;
    await click(button(view, 'Install from folder'));
    await click(button(view, 'Cancel'));

    expect(dialog(view)).toBeUndefined();
    expect(api.selectAndInstall).not.toHaveBeenCalled();
    expect(api.list).toHaveBeenCalledTimes(listCalls);
  });

  // Regression: Escape is a refusal too, never a way past the notice.
  it('installs nothing when the notice is dismissed with Escape', async () => {
    const view = await mount();
    await click(button(view, 'Install from folder'));
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await settle();

    expect(dialog(view)).toBeUndefined();
    expect(api.selectAndInstall).not.toHaveBeenCalled();
  });

  // Regression: the confirmation must still lead to the install, exactly once,
  // and the installed list must pick the new extension up.
  it('opens the picker and installs once confirmed, then reloads the list', async () => {
    const view = await mount();
    const listCalls = api.list.mock.calls.length;
    await click(button(view, 'Install from folder'));
    await click(button(view, 'Choose folder'));

    expect(dialog(view)).toBeUndefined();
    expect(api.selectAndInstall).toHaveBeenCalledTimes(1);
    expect(api.list).toHaveBeenCalledTimes(listCalls + 1);
  });

  // Regression: a picker closed without a folder (success: false) is not an
  // install, so the list is left alone.
  it('does not reload the list when no folder was installed', async () => {
    api.selectAndInstall.mockResolvedValueOnce({ success: false, error: 'No folder selected' });
    const view = await mount();
    const listCalls = api.list.mock.calls.length;
    await click(button(view, 'Install from folder'));
    await click(button(view, 'Choose folder'));

    expect(api.selectAndInstall).toHaveBeenCalledTimes(1);
    expect(api.list).toHaveBeenCalledTimes(listCalls);
  });

  // Regression: a failed install is reported through the shared logger (so it
  // reaches app.log structured), not raw console.error, and never escapes as an
  // unhandled rejection from the click handler.
  it('logs a failed install through the shared logger', async () => {
    const sink = vi.fn();
    setLogSink(sink);
    api.selectAndInstall.mockRejectedValueOnce(new Error('IPC gone'));
    const view = await mount();
    await click(button(view, 'Install from folder'));
    await click(button(view, 'Choose folder'));

    const errors = sink.mock.calls.filter(([level, name]) => level === 'error' && name === 'ExtensionManager');
    expect(errors).toHaveLength(1);
    expect(String(errors[0][2])).toContain('Failed to install extension');
  });
});
