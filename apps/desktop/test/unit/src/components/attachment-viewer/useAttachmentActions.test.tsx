// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  attachmentKey,
  useAttachmentActions,
  type AttachmentActions,
} from '../../../../../src/components/attachment-viewer/useAttachmentActions';
import { act, render } from '../../../../helpers/render';

/**
 * The one implementation of "what happens when you touch an attachment".
 *
 * It replaced three near-copies (EmailCard, ThreadList, ThreadChatView), one of
 * which silently dropped the failure handling — a failed save looked exactly
 * like a successful one. These tests pin the behaviour the copies disagreed on.
 */

const downloadAttachment = vi.fn();
const previewAttachment = vi.fn();

/** Exposes the hook's API to the test without a component wrapper per case. */
let actions: AttachmentActions;
function Probe() {
  actions = useAttachmentActions();
  return (
    <div
      data-busy={String(actions.isBusy('email-1', 'report.pdf'))}
      data-busy-other={String(actions.isBusy('email-2', 'report.pdf'))}
    />
  );
}

const spyOnConsoleError = () => vi.spyOn(console, 'error').mockImplementation(() => {});

let mounted: ReturnType<typeof render>;
let errorSpy: ReturnType<typeof spyOnConsoleError>;

beforeEach(() => {
  downloadAttachment.mockReset().mockResolvedValue({ success: true });
  previewAttachment.mockReset().mockResolvedValue({ success: true });
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    emails: { downloadAttachment, previewAttachment },
  };
  errorSpy = spyOnConsoleError();
  mounted = render(<Probe />);
});

afterEach(() => {
  mounted.unmount();
  vi.restoreAllMocks();
});

const probe = () => mounted.find('[data-busy]')!;

/** Start a hook action inside act(), so React flushes the busy-state update.
 *  Returns the still-pending promise so a test can assert mid-flight. */
function start<T>(action: () => Promise<T>): Promise<T> {
  let pending!: Promise<T>;
  act(() => {
    pending = action();
  });
  return pending;
}

/** Start an action and wait for it to finish. */
const run = async <T,>(action: () => Promise<T>): Promise<T> => {
  const pending = start(action);
  let result!: T;
  await act(async () => {
    result = await pending;
  });
  return result;
};

describe('in-flight keying', () => {
  // Breaks: two messages in one thread carrying the same attachment name share a
  // spinner — saving one makes the other look like it is working too. The key is
  // emailId AND filename for exactly this reason.
  it('keys the busy state per email and filename', async () => {
    let release: (value: unknown) => void = () => {};
    downloadAttachment.mockReturnValue(new Promise((resolve) => (release = resolve)));

    const pending = start(() => actions.saveCopy({ emailId: 'email-1', filename: 'report.pdf' }));

    expect(probe().dataset.busy).toBe('true');
    expect(probe().dataset.busyOther).toBe('false');

    release({ success: true });
    await act(async () => {
      await pending;
    });
    expect(probe().dataset.busy).toBe('false');
  });

  // Breaks: a failing save leaves the chip spinning forever, so the user cannot
  // retry it.
  it('clears the busy state when the call throws', async () => {
    downloadAttachment.mockRejectedValue(new Error('IPC gone'));

    await run(() => actions.saveCopy({ emailId: 'email-1', filename: 'report.pdf' }));

    expect(probe().dataset.busy).toBe('false');
    expect(errorSpy).toHaveBeenCalled();
  });

  it('composes the key from both parts', () => {
    expect(attachmentKey('email-1', 'report.pdf')).toBe('email-1:report.pdf');
    expect(attachmentKey('email-1', 'a')).not.toBe(attachmentKey('email-2', 'a'));
  });
});

describe('error reporting', () => {
  // Breaks: a cancelled save dialog is logged as an error. It isn't one — the
  // user changed their mind — and logging it is what trained everyone to ignore
  // the real failures next to it.
  it('does not report a cancelled save as an error', async () => {
    downloadAttachment.mockResolvedValue({ success: false, error: 'Save cancelled' });

    await run(() => actions.saveCopy({ emailId: 'email-1', filename: 'report.pdf' }));

    expect(errorSpy).not.toHaveBeenCalled();
  });

  // Breaks: the ThreadChatView regression — a genuine failure (not connected,
  // file too large, wrong account) shows nothing at all.
  it('reports a genuine failure', async () => {
    downloadAttachment.mockResolvedValue({ success: false, error: 'Not connected to IMAP' });

    await run(() => actions.saveCopy({ emailId: 'email-1', filename: 'report.pdf' }));

    expect(errorSpy.mock.calls[0].join(' ')).toContain('Not connected to IMAP');
  });
});

describe('routing', () => {
  // Breaks: save and open-in-system-app are two different IPC calls; crossing
  // them means "Save a copy" launches the file instead, which is the one thing
  // the allow-list exists to keep deliberate.
  it('sends save to downloadAttachment and open to previewAttachment', async () => {
    await run(() =>
      actions.saveCopy({ emailId: 'email-1', filename: 'report.pdf', accountId: 'acct-2' }),
    );
    await run(() => actions.openInSystemApp({ emailId: 'email-1', filename: 'report.pdf' }));

    expect(downloadAttachment).toHaveBeenCalledWith('email-1', 'report.pdf', 'acct-2');
    expect(previewAttachment).toHaveBeenCalledWith('email-1', 'report.pdf', undefined);
  });

  // Breaks: each save opens a NATIVE modal dialog. Firing them in parallel
  // stacks dialogs on top of each other (or drops all but one).
  it('saves all attachments one at a time', async () => {
    const order: string[] = [];
    let resolveFirst: (value: unknown) => void = () => {};
    downloadAttachment.mockImplementation((_id: string, name: string) => {
      order.push(name);
      return name === 'a.pdf'
        ? new Promise((resolve) => (resolveFirst = resolve))
        : Promise.resolve({ success: true });
    });

    const all = start(() => actions.saveAll('email-1', ['a.pdf', 'b.pdf'], 'acct-2'));
    expect(order).toEqual(['a.pdf']); // b.pdf has NOT started

    resolveFirst({ success: true });
    await act(async () => {
      await all;
    });
    expect(order).toEqual(['a.pdf', 'b.pdf']);
    expect(downloadAttachment).toHaveBeenLastCalledWith('email-1', 'b.pdf', 'acct-2');
  });
});
