// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UnscannedWarningRequest } from '../../../../../electron/preload';
import { UnscannedAttachmentWarning } from '../../../../../src/components/antivirus/UnscannedAttachmentWarning';
import { act, cleanup, fire, render, settle, type Mounted } from '../../../../helpers/render';

const request: UnscannedWarningRequest = {
  id: 'warning-work-pdf', accountId: 'work', action: 'view', filename: 'arakiri_A_50186774_/_3.pdf',
};
let onWarning: ((request: UnscannedWarningRequest) => void) | undefined;
let onClosed: ((id: string) => void) | undefined;
let mounted: Mounted;
const offWarning = vi.fn();
const offClosed = vi.fn();
const api = {
  onUnscannedWarning: (callback: typeof onWarning) => { onWarning = callback; return offWarning; },
  onUnscannedWarningClosed: (callback: typeof onClosed) => { onClosed = callback; return offClosed; },
  getPendingUnscannedWarning: vi.fn(async (): Promise<{ success: boolean; data?: UnscannedWarningRequest | null }> => ({ success: true, data: null })),
  respondUnscannedWarning: vi.fn(async () => ({ success: true })),
};
const button = (text: string) => mounted.all('button').find((element) => element.textContent?.replace(/^✓ /, '') === text) as HTMLButtonElement;
const emit = (payload = request) => act(() => onWarning?.(payload));
const close = (id: string) => act(() => onClosed?.(id));
const click = async (text: string) => { fire(button(text), 'click'); await settle(); };

beforeEach(() => {
  api.respondUnscannedWarning.mockReset().mockResolvedValue({ success: true });
  api.getPendingUnscannedWarning.mockReset().mockResolvedValue({ success: true, data: null });
  offWarning.mockClear(); offClosed.mockClear();
  onWarning = undefined; onClosed = undefined;
  (window as unknown as { electronAPI: unknown }).electronAPI = { antivirus: api };
  mounted = render(<UnscannedAttachmentWarning />);
});
afterEach(() => { cleanup(); document.body.innerHTML = ''; });

describe('custom warning before attachment access without scanner setup', () => {
  // Breaks: the warning uses a disk basename, truncating a MIME filename after its slash.
  it('shows the entire filename as text inside an accessible custom popup', () => {
    expect(mounted.find('[role="alertdialog"]')).toBeNull();
    emit();
    const dialog = mounted.find('[role="alertdialog"]');
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    expect(dialog?.getAttribute('aria-labelledby')).toBe('unscanned-warning-title');
    expect(dialog?.getAttribute('aria-describedby')).toBe('unscanned-warning-description');
    expect(dialog?.className).toContain('max-h-[90vh]');
    expect(dialog?.className).toContain('overflow-y-auto');
    expect(dialog?.textContent).toContain('arakiri_A_50186774_/_3.pdf will not be checked for viruses.');
    expect(dialog?.textContent).toContain('Harmful files can put your device and data at risk.');
    expect(button('View anyway')).toBeDefined();
    expect(document.activeElement).toBe(button('Cancel'));
    expect(mounted.find('span.font-medium')?.className).toContain('[overflow-wrap:anywhere]');
    expect(api.respondUnscannedWarning).not.toHaveBeenCalled();
  });

  // Breaks: a filename containing markup becomes executable content in the app dialog.
  it('escapes markup in attachment names without changing their visible text', () => {
    const filename = '<img src=x onerror="bad()">/full.pdf';
    emit({ ...request, filename });
    expect(mounted.container.textContent).toContain(filename);
    expect(mounted.find('img')).toBeNull();
  });

  // Breaks: the user sees "View anyway" for a save, OS open, or calendar import.
  it.each([
    ['open', 'Open anyway', 'Open without antivirus scanning?'],
    ['download', 'Download anyway', 'Download without antivirus scanning?'],
    ['calendar', 'Add anyway', 'Add without antivirus scanning?'],
  ] as const)('labels %s with its requested action', (action, continueLabel, title) => {
    emit({ ...request, action });
    expect(button(continueLabel)).toBeDefined();
    expect(mounted.find('h2')?.textContent).toBe(title);
  });

  // Breaks: merely displaying a missing-setup warning authorizes an attachment operation.
  it('continues only after an explicit View anyway click', async () => {
    emit();
    await click('View anyway');
    expect(api.respondUnscannedWarning).toHaveBeenCalledExactlyOnceWith({
      id: request.id, choice: 'continue', dontShowAgain: false,
    });
    expect(mounted.find('[role="alertdialog"]')).toBeNull();
  });

  // Breaks: dismissing the warning preferences without acceptance disables future warnings.
  it('offers the remember link and sends the selected preference only on Continue', async () => {
    emit();
    const preference = button("Don't show this message again");
    expect(preference.getAttribute('role')).toBe('checkbox');
    expect(preference.getAttribute('aria-checked')).toBe('false');
    expect(mounted.container.textContent).toContain('For this account while antivirus setup is missing.');
    fire(preference, 'click');
    expect(preference.getAttribute('aria-checked')).toBe('true');
    expect(api.respondUnscannedWarning).not.toHaveBeenCalled();
    await click('View anyway');
    expect(api.respondUnscannedWarning).toHaveBeenCalledExactlyOnceWith({
      id: request.id, choice: 'continue', dontShowAgain: true,
    });
  });

  // Breaks: the preference link cannot be unchecked before accepting the warning.
  it('allows the remember choice to be removed before continuing', async () => {
    emit();
    fire(button("Don't show this message again"), 'click');
    fire(button("Don't show this message again"), 'click');
    expect(button("Don't show this message again").getAttribute('aria-checked')).toBe('false');
    await click('View anyway');
    expect(api.respondUnscannedWarning).toHaveBeenCalledWith({ id: request.id, choice: 'continue', dontShowAgain: false });
  });

  // Breaks: cancelling or opening setup saves a bypass preference chosen in the dialog.
  it.each([['Cancel', 'cancel'], ['Set up antivirus', 'setup']] as const)('does not remember the choice on %s', async (label, choice) => {
    emit();
    fire(button("Don't show this message again"), 'click');
    await click(label);
    expect(api.respondUnscannedWarning).toHaveBeenCalledExactlyOnceWith({ id: request.id, choice, dontShowAgain: false });
  });

  // Breaks: Escape accepts the warning or reaches background email actions.
  it('cancels on Escape without triggering background keyboard handlers', async () => {
    const backgroundKey = vi.fn();
    document.addEventListener('keydown', backgroundKey);
    try {
      emit();
      fire(button('Cancel'), 'keydown', { key: 'Escape' });
      await settle();
      expect(api.respondUnscannedWarning).toHaveBeenCalledWith({ id: request.id, choice: 'cancel', dontShowAgain: false });
      expect(backgroundKey).not.toHaveBeenCalled();
    } finally { document.removeEventListener('keydown', backgroundKey); }
  });

  // Breaks: keyboard navigation escapes the popup and activates another mail item.
  it('traps focus and blocks mail shortcuts while leaving focused-button activation intact', () => {
    const backgroundKey = vi.fn();
    document.addEventListener('keydown', backgroundKey);
    try {
      emit();
      const first = button("Don't show this message again");
      const last = button('View anyway');
      first.focus();
      fire(first, 'keydown', { key: 'Tab', shiftKey: true });
      expect(document.activeElement).toBe(last);
      fire(last, 'keydown', { key: 'Tab' });
      expect(document.activeElement).toBe(first);
      button('Cancel').focus();
      fire(button('Cancel'), 'keydown', { key: 'Tab' });
      fire(button('Cancel'), 'keydown', { key: 'Enter' });
      fire(button('Cancel'), 'keydown', { key: 'g' });
      const outsideEvent = new KeyboardEvent('keydown', { key: 'g', bubbles: true, cancelable: true });
      act(() => document.body.dispatchEvent(outsideEvent));
      expect(outsideEvent.defaultPrevented).toBe(true);
      expect(backgroundKey).not.toHaveBeenCalled();
      expect(api.respondUnscannedWarning).not.toHaveBeenCalled();
    } finally { document.removeEventListener('keydown', backgroundKey); }
  });

  // Breaks: earlier document capture handlers close a viewer or submit a form before the warning handles a key.
  it('isolates keyboard events from existing document capture and later window capture handlers', async () => {
    const documentCapture = vi.fn();
    const lateWindowCapture = vi.fn();
    document.addEventListener('keydown', documentCapture, true);
    try {
      emit();
      window.addEventListener('keydown', lateWindowCapture, true);
      const continueButton = button('View anyway');
      const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
      const space = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
      const copy = new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true, cancelable: true });
      act(() => { continueButton.dispatchEvent(enter); continueButton.dispatchEvent(space); continueButton.dispatchEvent(copy); });
      fire(continueButton, 'keydown', { key: 'ArrowRight' });
      expect(enter.defaultPrevented).toBe(false);
      expect(space.defaultPrevented).toBe(false);
      expect(copy.defaultPrevented).toBe(false);
      fire(button('Cancel'), 'keydown', { key: 'Escape' });
      await settle();
      expect(documentCapture).not.toHaveBeenCalled();
      expect(lateWindowCapture).not.toHaveBeenCalled();
      expect(api.respondUnscannedWarning).toHaveBeenCalledWith({ id: request.id, choice: 'cancel', dontShowAgain: false });
    } finally {
      document.removeEventListener('keydown', documentCapture, true);
      window.removeEventListener('keydown', lateWindowCapture, true);
    }
  });

  // Breaks: clicks inside the dialog cancel, or backdrop dismissal continues unscanned access.
  it('cancels only a backdrop click and restores the original focus', async () => {
    const trigger = document.createElement('button');
    document.body.appendChild(trigger); trigger.focus();
    emit();
    fire(mounted.find('[role="alertdialog"]'), 'click');
    expect(api.respondUnscannedWarning).not.toHaveBeenCalled();
    fire(mounted.find('[role="alertdialog"]')?.parentElement ?? null, 'click');
    await settle();
    expect(api.respondUnscannedWarning).toHaveBeenCalledWith({ id: request.id, choice: 'cancel', dontShowAgain: false });
    expect(document.activeElement).toBe(trigger);
  });

  // Breaks: duplicate clicks or Escape during an IPC request submit conflicting answers.
  it('disables controls and submits each warning once while the answer is pending', async () => {
    let resolve!: (value: { success: boolean }) => void;
    api.respondUnscannedWarning.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    emit();
    fire(button('View anyway'), 'click');
    fire(button('View anyway'), 'click');
    fire(button('Cancel'), 'keydown', { key: 'Escape' });
    expect(mounted.all('button').every((element) => (element as HTMLButtonElement).disabled)).toBe(true);
    expect(api.respondUnscannedWarning).toHaveBeenCalledTimes(1);
    await act(async () => resolve({ success: true }));
    expect(mounted.find('[role="alertdialog"]')).toBeNull();
  });

  // Breaks: a failed IPC response is silently treated as consent and removes the warning.
  it.each(['result', 'rejection'] as const)('keeps the warning and supports retry after an IPC %s failure', async (failure) => {
    if (failure === 'result') api.respondUnscannedWarning.mockResolvedValueOnce({ success: false });
    else api.respondUnscannedWarning.mockRejectedValueOnce(new Error('synthetic private path'));
    emit();
    await click('View anyway');
    expect(mounted.find('[role="alert"]')?.textContent).toBe('Could not record your choice. Try again.');
    expect(mounted.container.textContent).not.toContain('synthetic private path');
    expect(button('View anyway').disabled).toBe(false);
    await click('View anyway');
    expect(api.respondUnscannedWarning).toHaveBeenCalledTimes(2);
    expect(mounted.find('[role="alertdialog"]')).toBeNull();
  });

  // Breaks: a queued warning reuses another attachment's answer or remember state.
  it('queues different accounts, ignores duplicate IDs and resets the remember link for each warning', async () => {
    const next: UnscannedWarningRequest = { ...request, id: 'warning-personal', accountId: 'personal', filename: 'personal.pdf' };
    emit(); emit(request); emit(next);
    expect(mounted.all('[role="alertdialog"]')).toHaveLength(1);
    expect(mounted.container.textContent).not.toContain('personal.pdf');
    fire(button("Don't show this message again"), 'click');
    await click('View anyway');
    expect(mounted.container.textContent).toContain('personal.pdf');
    expect(button("Don't show this message again").getAttribute('aria-checked')).toBe('false');
    await click('Cancel');
    expect(api.respondUnscannedWarning).toHaveBeenNthCalledWith(2, { id: next.id, choice: 'cancel', dontShowAgain: false });
    expect(mounted.find('[role="alertdialog"]')).toBeNull();
  });

  // Breaks: host cancellation leaves an expired warning that can authorize a later request.
  it('removes only the exact host-closed ID, including queued and unknown IDs', () => {
    emit(); emit({ ...request, id: 'next', filename: 'next.pdf' });
    close('unknown'); close('next');
    expect(mounted.container.textContent).toContain(request.filename);
    close(request.id);
    expect(mounted.find('[role="alertdialog"]')).toBeNull();
    expect(api.respondUnscannedWarning).not.toHaveBeenCalled();
  });

  // Breaks: a late old answer closes the next account's warning instead of only its own.
  it('ignores late completion of a closed warning when another request is visible', async () => {
    let resolve!: (value: { success: boolean }) => void;
    api.respondUnscannedWarning.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    emit(); fire(button('View anyway'), 'click');
    close(request.id); emit({ ...request, id: 'next', filename: 'next.pdf' });
    await act(async () => resolve({ success: true }));
    expect(mounted.container.textContent).toContain('next.pdf');
    expect(button('View anyway').disabled).toBe(false);
  });

  // Breaks: a closed dialog updates an unmounted component after IPC rejects or fails.
  it.each(['result', 'rejection'] as const)('does not reopen a host-closed dialog after a late %s failure', async (failure) => {
    let resolve!: (value: { success: boolean }) => void;
    let reject!: (reason: Error) => void;
    api.respondUnscannedWarning.mockImplementationOnce(() => new Promise((done, fail) => { resolve = done; reject = fail; }));
    emit(); fire(button('View anyway'), 'click'); close(request.id);
    await act(async () => {
      if (failure === 'result') resolve({ success: false });
      else reject(new Error('late failure'));
    });
    expect(mounted.find('[role="alertdialog"]')).toBeNull();
    expect(mounted.find('[role="alert"]')).toBeNull();
  });

  // Breaks: closing the app keeps unseen warnings and their attachment jobs alive.
  it('unsubscribes and cancels all unanswered warnings when unmounted', () => {
    emit(); emit({ ...request, id: 'queued' });
    mounted.unmount();
    expect(offWarning).toHaveBeenCalledOnce(); expect(offClosed).toHaveBeenCalledOnce();
    expect(api.respondUnscannedWarning).toHaveBeenCalledWith({ id: request.id, choice: 'cancel', dontShowAgain: false });
    expect(api.respondUnscannedWarning).toHaveBeenCalledWith({ id: 'queued', choice: 'cancel', dontShowAgain: false });
  });

  // Breaks: unmount submits a cancellation while the same warning's answer is already being sent.
  it('does not submit another answer on unmount while the first answer is pending', async () => {
    let resolve!: (value: { success: boolean }) => void;
    api.respondUnscannedWarning.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    emit(); fire(button('View anyway'), 'click'); mounted.unmount();
    expect(api.respondUnscannedWarning).toHaveBeenCalledTimes(1);
    await act(async () => resolve({ success: true }));
  });

  // Breaks: running a browser-only renderer without an Electron bridge crashes at startup.
  it('stays hidden when the warning bridge is unavailable', () => {
    mounted.unmount();
    (window as unknown as { electronAPI: unknown }).electronAPI = undefined;
    mounted = render(<UnscannedAttachmentWarning />);
    expect(mounted.find('[role="alertdialog"]')).toBeNull();
  });

  // Breaks: an attachment requested during app startup waits forever because its popup event was missed.
  it('recovers a pending host warning after subscribing without duplicating a received event', async () => {
    mounted.unmount();
    api.getPendingUnscannedWarning.mockResolvedValueOnce({ success: true, data: request });
    mounted = render(<UnscannedAttachmentWarning />);
    emit();
    await settle();
    expect(mounted.all('[role="alertdialog"]')).toHaveLength(1);
    expect(mounted.container.textContent).toContain(request.filename);
    await click('View anyway');
    expect(mounted.find('[role="alertdialog"]')).toBeNull();
  });

  // Breaks: a delayed startup snapshot revives an expired warning over the next attachment's popup.
  it('does not revive a host-closed warning from a late recovery snapshot', async () => {
    let resolve!: (value: { success: boolean; data: UnscannedWarningRequest }) => void;
    mounted.unmount();
    api.getPendingUnscannedWarning.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    mounted = render(<UnscannedAttachmentWarning />);
    emit(); close(request.id);
    emit({ ...request, id: 'fresh-warning', filename: 'fresh.pdf' });
    await act(async () => resolve({ success: true, data: request }));
    expect(mounted.container.textContent).toContain('fresh.pdf');
    await click('Cancel');
    expect(mounted.find('[role="alertdialog"]')).toBeNull();
  });

  // Breaks: a late snapshot adds a popup after the renderer was unmounted.
  it('ignores recovery results after unmount', async () => {
    let resolve!: (value: { success: boolean; data: UnscannedWarningRequest }) => void;
    mounted.unmount();
    api.getPendingUnscannedWarning.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    mounted = render(<UnscannedAttachmentWarning />);
    mounted.unmount();
    await act(async () => resolve({ success: true, data: request }));
    expect(mounted.find('[role="alertdialog"]')).toBeNull();
    expect(api.respondUnscannedWarning).not.toHaveBeenCalled();
  });

  // Breaks: recovery failure prevents later live warning events from being displayed.
  it.each(['result', 'rejection'] as const)('continues receiving events after a recovery %s failure', async (failure) => {
    mounted.unmount();
    if (failure === 'result') api.getPendingUnscannedWarning.mockResolvedValueOnce({ success: false, data: request });
    else api.getPendingUnscannedWarning.mockRejectedValueOnce(new Error('synthetic recovery failure'));
    mounted = render(<UnscannedAttachmentWarning />);
    await settle();
    expect(mounted.find('[role="alertdialog"]')).toBeNull();
    emit();
    expect(mounted.container.textContent).toContain(request.filename);
    close(request.id);
    expect(mounted.find('[role="alertdialog"]')).toBeNull();
  });
});
