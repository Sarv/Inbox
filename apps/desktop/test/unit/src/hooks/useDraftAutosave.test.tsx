// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { act, render } from '../../../helpers/render';

// What breaks if this suite goes red: closing the compose box stops producing a
// draft (or produces a stale one, or a duplicate). The user closes, opens
// Drafts, and the message is missing or is missing what they typed last.

vi.mock('../../../../src/store/email-store', () => ({
  useEmailStore: () => ({ imapConfig: { username: 'me@x.com' } }),
}));

const { decideCloseAction, useDraftAutosave } = await import('../../../../src/hooks/useDraftAutosave');

type Opts = Parameters<typeof useDraftAutosave>[0];
type Api = ReturnType<typeof useDraftAutosave>;

const base: Opts = { to: 'a@x.com', subject: 'Hi', body: '', htmlBody: '' };

function Probe({ opts, onApi }: { opts: Opts; onApi?: (api: Api) => void }) {
  const api = useDraftAutosave(opts);
  onApi?.(api);
  return null;
}

let save: ReturnType<typeof vi.fn>;
let del: ReturnType<typeof vi.fn>;
let nextId: number;

beforeEach(() => {
  nextId = 0;
  save = vi.fn(async () => ({ success: true, messageId: `<m${++nextId}@x>` }));
  del = vi.fn(async () => ({ success: true }));
  (window as any).electronAPI = { drafts: { save, delete: del } };
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });

describe('useDraftAutosave — closing the compose box', () => {
  // Breaks: the core promise — close with content and a draft exists.
  it('saves on close', async () => {
    const view = render(<Probe opts={{ ...base, body: 'hello', htmlBody: '<p>hello</p>' }} />);
    view.unmount();
    await flush();
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0][0]).toMatchObject({ body: 'hello', accountEmail: 'me@x.com' });
  });

  // Breaks: an empty new compose left an empty draft behind every time.
  it('does not save an empty compose', async () => {
    const view = render(<Probe opts={{ ...base, to: '', subject: '' }} />);
    view.unmount();
    await flush();
    expect(save).not.toHaveBeenCalled();
  });

  // Breaks: THE delay bug — closing while an autosave uploaded was skipped, so
  // everything typed after that autosave began was lost.
  it('closing during an in-flight save waits, then saves the latest content', async () => {
    let release!: () => void;
    save.mockImplementationOnce(() => new Promise(resolve => {
      release = () => resolve({ success: true, messageId: '<first@x>' });
    }));
    vi.useFakeTimers();
    const view = render(<Probe opts={{ ...base, body: 'first', htmlBody: '<p>first</p>' }} />);
    // The 10s debounce fires and the autosave starts uploading.
    act(() => { vi.advanceTimersByTime(10_000); });
    vi.useRealTimers();
    expect(save).toHaveBeenCalledTimes(1);

    // The user keeps typing, then closes before the upload returns.
    view.rerender(<Probe opts={{ ...base, body: 'second', htmlBody: '<p>second</p>' }} />);
    view.unmount();
    await flush();
    expect(save).toHaveBeenCalledTimes(1);

    release();
    await flush();
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1][0]).toMatchObject({ body: 'second' });
    // …and the first upload's draft is superseded, not left as a duplicate.
    expect(del).toHaveBeenCalledWith({ messageId: '<first@x>', accountId: undefined });
  });

  // Breaks: an opened, untouched draft re-saved on every close, minting a new
  // message-id each time (the "immortal draft" churn).
  it('does not re-save an opened draft closed unedited', async () => {
    const view = render(<Probe opts={{ ...base, body: 'old', htmlBody: '<p>old</p>', initialDraftMessageId: '<old@x>' }} />);
    view.unmount();
    await flush();
    expect(save).not.toHaveBeenCalled();
  });

  // Breaks: Undo-send reopens content newer than the last autosave; closing it
  // unedited skipped the save and the newest text never reached Drafts.
  it('saves an unsaved restore on close and replaces the draft it came from', async () => {
    const view = render(<Probe opts={{
      ...base, body: 'restored', htmlBody: '<p>restored</p>',
      initialDraftMessageId: '<old@x>', initialDraftUnsaved: true, accountId: 'acct-1',
    }} />);
    view.unmount();
    await flush();
    expect(save).toHaveBeenCalledTimes(1);
    expect(del).toHaveBeenCalledWith({ messageId: '<old@x>', accountId: 'acct-1' });
  });

  // Breaks: discarding and then closing resurrected the discarded draft.
  it('does not save after discard', async () => {
    let api: Api | undefined;
    const view = render(<Probe opts={{ ...base, body: 'bye', htmlBody: '<p>bye</p>' }} onApi={a => { api = a; }} />);
    act(() => { api!.markDiscarded(); });
    view.unmount();
    await flush();
    expect(save).not.toHaveBeenCalled();
  });
});

// Breaks: the close button asks about nothing (an empty compose), or silently
// closes over real work — the "pressed X and the mail is gone" report.
describe('decideCloseAction', () => {
  it('discards without asking when there is nothing to keep', () => {
    expect(decideCloseAction({ hasContent: false, unchangedSinceOpened: false })).toBe('discard');
  });
  it('keeps an opened draft that was not changed, without asking', () => {
    expect(decideCloseAction({ hasContent: true, unchangedSinceOpened: true })).toBe('keep');
  });
  it('asks when there is work', () => {
    expect(decideCloseAction({ hasContent: true, unchangedSinceOpened: false })).toBe('ask');
  });
});

describe('useDraftAutosave — closeAction', () => {
  const actionFor = (opts: Opts, after?: Opts) => {
    let api: Api | undefined;
    const view = render(<Probe opts={opts} onApi={a => { api = a; }} />);
    if (after) view.rerender(<Probe opts={after} onApi={a => { api = a; }} />);
    const action = api!.closeAction();
    view.unmount();
    return action;
  };

  // Breaks: typing a new mail and pressing X would close without the question.
  it('asks for a new compose with content', () => {
    expect(actionFor({ ...base, body: 'hi', htmlBody: '<p>hi</p>' })).toBe('ask');
  });

  // Breaks: opening an empty compose and closing it would nag.
  it('discards an empty compose silently', () => {
    expect(actionFor({ ...base, to: '', subject: '' })).toBe('discard');
  });

  // Breaks: an auto-filled reply (recipient + "Re:" only) would nag on close.
  it('treats an untouched reply as empty', () => {
    expect(actionFor({ ...base, inReplyTo: '<p@x>' })).toBe('discard');
  });

  // Breaks: peeking at a saved draft and closing it would nag, or — worse —
  // a "Discard" answer would delete a draft the user never touched.
  it('keeps an opened draft closed unchanged', () => {
    expect(actionFor({ ...base, body: 'old', htmlBody: '<p>old</p>', initialDraftMessageId: '<d@x>' })).toBe('keep');
  });

  // Breaks: edits to an opened draft would be closed over without the question.
  it('asks once an opened draft is edited', () => {
    const opened = { ...base, body: 'old', htmlBody: '<p>old</p>', initialDraftMessageId: '<d@x>' };
    expect(actionFor(opened, { ...opened, body: 'new', htmlBody: '<p>new</p>' })).toBe('ask');
  });

  // Breaks: an Undo-send restore (content newer than any saved draft) would
  // close silently and lose the newest text.
  it('asks for an unsaved restore even when unedited', () => {
    expect(actionFor({ ...base, body: 'r', htmlBody: '<p>r</p>', initialDraftMessageId: '<d@x>', initialDraftUnsaved: true })).toBe('ask');
  });
});

describe('useDraftAutosave — forward drafts', () => {
  const forward: Opts = { to: '', subject: 'Fwd: Hi', subjectPrefilled: true, body: '', htmlBody: '' };

  // Breaks: an untouched forward (only the automatic "Fwd:" subject) would ask
  // on close and leave an empty draft behind.
  it('does not count the prefilled subject as work', () => {
    let api: Api | undefined;
    const view = render(<Probe opts={forward} onApi={a => { api = a; }} />);
    expect(api!.closeAction()).toBe('discard');
    view.unmount();
    expect(save).not.toHaveBeenCalled();
  });

  // Breaks: choosing who to forward to, then closing, would lose the forward.
  it('counts recipients as work', () => {
    let api: Api | undefined;
    const view = render(<Probe opts={{ ...forward, to: 'b@x.com' }} onApi={a => { api = a; }} />);
    expect(api!.closeAction()).toBe('ask');
    view.unmount();
  });

  // Breaks: the draft would hold only the note — reopened from Drafts, the
  // forwarded message is gone.
  it('writes what composeForSave shapes, while change detection reads the editor', async () => {
    const composeForSave = vi.fn((note: { body: string; htmlBody: string }) => ({
      body: `${note.body}\n\n[original]`,
      htmlBody: `${note.htmlBody}<blockquote>original</blockquote>`,
    }));
    const view = render(<Probe opts={{ ...forward, to: 'b@x.com', body: 'FYI', htmlBody: '<p>FYI</p>', composeForSave }} />);
    view.unmount();
    await flush();
    expect(composeForSave).toHaveBeenCalledWith({ body: 'FYI', htmlBody: '<p>FYI</p>' });
    expect(save.mock.calls[0][0]).toMatchObject({
      subject: 'Fwd: Hi',
      body: 'FYI\n\n[original]',
      htmlBody: '<p>FYI</p><blockquote>original</blockquote>',
    });
  });
});

describe('useDraftAutosave — attachments', () => {
  const pdf = { filename: 'invoice.pdf', content: 'JVBERg==', contentType: 'application/pdf', size: 4, type: 'attachment' };
  const withBody: Opts = { ...base, body: 'see attached', htmlBody: '<p>see attached</p>' };

  // Breaks: THE regression — the draft is saved without its files, so it
  // reopens (and is sent) missing them.
  it('saves the attached files with the draft', async () => {
    const view = render(<Probe opts={{ ...withBody, attachments: [pdf] }} />);
    view.unmount();
    await flush();
    expect(save.mock.calls[0][0].attachments).toEqual([
      { filename: 'invoice.pdf', content: 'JVBERg==', contentType: 'application/pdf' },
    ]);
  });

  // Breaks: attaching a file to an opened draft is not an edit, so the close
  // keeps the old draft and the new file is lost.
  it('counts adding a file to an opened draft as an edit', () => {
    let api: Api | undefined;
    const opened: Opts = { ...withBody, initialDraftMessageId: '<d@x>' };
    const view = render(<Probe opts={opened} onApi={a => { api = a; }} />);
    view.rerender(<Probe opts={{ ...opened, attachments: [pdf] }} onApi={a => { api = a; }} />);
    expect(api!.closeAction()).toBe('ask');
    view.unmount();
  });

  // Breaks: reopening a draft with a file and closing it untouched nags — or
  // re-saves it, minting a new copy every time it is looked at.
  it('keeps an opened draft whose files are unchanged', () => {
    let api: Api | undefined;
    const view = render(<Probe opts={{ ...withBody, initialDraftMessageId: '<d@x>', attachments: [pdf] }} onApi={a => { api = a; }} />);
    expect(api!.closeAction()).toBe('keep');
    view.unmount();
  });

  // Breaks: a mail with only an attachment (nothing typed yet) is discarded
  // silently on close — the file the user picked is gone.
  it('counts an attached file as work on its own', () => {
    let api: Api | undefined;
    const view = render(<Probe opts={{ ...base, to: '', subject: '', attachments: [pdf] }} onApi={a => { api = a; }} />);
    expect(api!.closeAction()).toBe('ask');
    view.unmount();
  });

  // Breaks: opening a forward of a mail with attachments and closing it at once
  // asks the question and leaves a draft behind — the files were loaded FOR
  // the user, not chosen by them.
  it('does not count prefilled files as work', () => {
    let api: Api | undefined;
    const forward: Opts = { to: '', subject: 'Fwd: Hi', subjectPrefilled: true, body: '', htmlBody: '', attachments: [pdf], attachmentsPrefilled: true };
    const view = render(<Probe opts={forward} onApi={a => { api = a; }} />);
    expect(api!.closeAction()).toBe('discard');
    view.unmount();
    expect(save).not.toHaveBeenCalled();
  });
});
