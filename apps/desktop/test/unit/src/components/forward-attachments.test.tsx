// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ComposeDraft } from '../../../../src/components/useCompose';
import type { EmailStore } from '../../../../src/store/types';
import type { ForwardSource } from '../../../../src/utils/forward-quote';
import { act, cleanup, fire, render, settle, typeInto, type Mounted } from '../../../helpers/render';

// Keep both real composers, useCompose, the shared forward-loading hook, the
// attachment loader, and the toolbar. Only editor/remote-service boundaries are
// replaced: the assertion is the actual payload the composer hands to sendEmail.
const stubs = vi.hoisted(() => ({
  sendEmail: vi.fn<EmailStore['sendEmail']>().mockResolvedValue(undefined),
  getAttachmentBase64: vi.fn(),
  fetchBody: vi.fn(),
  markDiscarded: vi.fn(() => undefined),
  onClose: vi.fn(),
}));

const store = {
  sendEmail: stubs.sendEmail,
  discardDraft: vi.fn(),
  imapConfig: { username: 'active@example.test' },
  activeAccountId: 'active-account',
  viewAccountId: 'original-account',
  selectedVirtualFolder: 'virtual-unified',
  accounts: [
    { id: 'active-account', email: 'active@example.test', name: 'Active' },
    { id: 'original-account', email: 'owner@example.test', name: 'Original' },
  ],
};

vi.mock('../../../../src/store/email-store', () => ({
  useEmailStore: Object.assign(
    (select?: (state: typeof store) => unknown) => select ? select(store) : store,
    { getState: () => store },
  ),
}));
vi.mock('../../../../src/services/ai-service', () => ({ getDefaultProvider: () => null }));
vi.mock('../../../../src/hooks/useDraftAutosave', () => ({
  useDraftAutosave: () => ({ markDiscarded: stubs.markDiscarded, closeAction: vi.fn() }),
}));
vi.mock('../../../../src/hooks/useCloseComposePrompt', () => ({
  useCloseComposePrompt: () => ({ requestClose: vi.fn(), isAsking: () => false, closePromptDialog: null }),
}));
vi.mock('../../../../src/hooks/usePgpCompose', () => ({
  usePgpCompose: () => ({ state: { available: false, encrypt: false, request: undefined } }),
}));
vi.mock('../../../../src/utils/attachment-reminder', () => ({
  checkAttachmentBeforeSend: vi.fn(async () => true),
}));
vi.mock('../../../../src/components/EmailInput', () => ({
  EmailInput: ({ value, onChange, placeholder }: {
    value: string; onChange: (value: string) => void; placeholder: string;
  }) => <input aria-label={placeholder} value={value} onChange={(event) => onChange(event.target.value)} />,
}));
vi.mock('../../../../src/components/RichTextEditor', () => ({
  EMPTY_EDITOR_HTML: '<p></p>',
  RichTextEditor: ({ content, onChange }: {
    content: string; onChange: (html: string, text: string) => void;
  }) => <textarea aria-label="Compose body" value={content} onChange={(event) => {
    onChange(`<p>${event.target.value}</p>`, event.target.value);
  }} />,
}));
vi.mock('../../../../src/components/PolishModal', () => ({ PolishModal: () => null }));
vi.mock('../../../../src/components/QuotedOriginalPreview', () => ({ QuotedOriginalPreview: () => null }));
vi.mock('../../../../src/components/SandboxedEmailBody', () => ({ SandboxedEmailBody: () => null }));
vi.mock('../../../../src/components/SmtpNotConfiguredBanner', () => ({ SmtpNotConfiguredBanner: () => null }));
vi.mock('../../../../src/components/FromAccountBar', () => ({ FromAccountBar: () => null }));
vi.mock('../../../../src/components/SelectionPolishMenu', () => ({
  SELECTION_MENU_WIDTH: 200,
  SelectionPolishMenu: () => null,
}));

const { ComposeEmail } = await import('../../../../src/components/ComposeEmail');
const { InlineForward } = await import('../../../../src/components/InlineForward');

const BYTES: Record<string, string> = {
  'Annual report.pdf': 'JVBERi0xLjQK',
  'schedule.txt': 'ZnJpZGF5',
};
const ORIGINAL: ForwardSource = {
  id: 'received-message',
  accountId: 'original-account',
  subject: 'Annual report',
  fromAddress: 'sender@example.test',
  fromName: 'Sender',
  toAddress: 'owner@example.test',
  ccAddress: null,
  date: 1_760_000_000,
  cleanBody: 'Here is the report.',
  rawBody: '<p>Here is the report.</p>',
  hasAttachments: true,
  attachmentNames: '["Annual report.pdf","schedule.txt"]',
};

type Composer = 'popup' | 'inline';
function compose(kind: Composer, source = ORIGINAL, draft?: ComposeDraft) {
  return kind === 'popup'
    ? <ComposeEmail mode="forward" replyToEmail={source} draft={draft} onClose={stubs.onClose} />
    : <InlineForward forwardEmail={source} draft={draft} onClose={stubs.onClose} />;
}
function mount(kind: Composer, source = ORIGINAL, draft?: ComposeDraft) {
  const view = render(compose(kind, source, draft));
  if (!draft) typeInto(view.byLabel('Recipients'), 'recipient@example.test');
  return view;
}
const button = (view: Mounted, text: string) =>
  [...view.container.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent === text) ?? null;
const sendButton = (view: Mounted) => button(view, 'Send');
async function send(view: Mounted) {
  fire(sendButton(view), 'click');
  await settle();
}
function shortcut() {
  fire(document.body, 'keydown', { key: 'Enter', ctrlKey: true });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  stubs.getAttachmentBase64.mockReset().mockImplementation(async (_id: string, filename: string) => ({
    success: true,
    base64: BYTES[filename],
  }));
  stubs.fetchBody.mockReset().mockResolvedValue({
    success: true,
    // Metadata returned through the IPC must never replace the source owner.
    data: { ...ORIGINAL, accountId: 'active-account' },
  });
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: { emails: { getAttachmentBase64: stubs.getAttachmentBase64, fetchBody: stubs.fetchBody } },
  });
});
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, 'electronAPI');
});

describe.each<Composer>(['popup', 'inline'])('%s forward attachments', (kind) => {
  it.each(['known', 'header-only'] as const)('sends original filenames and bytes through the original account (%s metadata)', async (metadata) => {
    const source = metadata === 'header-only' ? { ...ORIGINAL, attachmentNames: null } : ORIGINAL;
    const view = mount(kind, source);
    await settle();
    expect(sendButton(view)?.disabled).toBe(false);
    await send(view);

    if (metadata === 'header-only') {
      expect(stubs.fetchBody).toHaveBeenCalledExactlyOnceWith(ORIGINAL.id, ORIGINAL.accountId);
    } else {
      expect(stubs.fetchBody).not.toHaveBeenCalled();
    }
    expect(stubs.getAttachmentBase64.mock.calls).toEqual([
      [ORIGINAL.id, 'Annual report.pdf', ORIGINAL.accountId],
      [ORIGINAL.id, 'schedule.txt', ORIGINAL.accountId],
    ]);
    expect(stubs.sendEmail).toHaveBeenCalledOnce();
    expect(stubs.sendEmail.mock.calls[0][0]).toMatchObject({
      to: ['recipient@example.test'],
      accountId: 'original-account',
      attachments: [
        { filename: 'Annual report.pdf', content: BYTES['Annual report.pdf'], encoding: 'base64' },
        { filename: 'schedule.txt', content: BYTES['schedule.txt'], encoding: 'base64' },
      ],
    });
  });

  it('blocks the toolbar and keyboard send until original bytes finish loading', async () => {
    const pending = deferred<{ success: boolean; base64: string }>();
    stubs.getAttachmentBase64.mockReturnValue(pending.promise);
    const source = { ...ORIGINAL, attachmentNames: '["Annual report.pdf"]' };
    const view = mount(kind, source);

    expect(view.container.textContent).toContain('Loading forwarded attachments');
    expect(sendButton(view)?.disabled).toBe(true);
    if (kind === 'popup') expect((view.byLabel('Send later') as HTMLButtonElement)?.disabled).toBe(true);
    await send(view);
    shortcut();
    await settle();
    expect(stubs.sendEmail).not.toHaveBeenCalled();
    expect(stubs.onClose).not.toHaveBeenCalled();
    expect(stubs.markDiscarded).not.toHaveBeenCalled();

    await act(async () => { pending.resolve({ success: true, base64: BYTES['Annual report.pdf'] }); });
    expect(sendButton(view)?.disabled).toBe(false);
    shortcut();
    await settle();
    expect(stubs.sendEmail.mock.calls[0][0].attachments).toEqual([
      expect.objectContaining({ filename: 'Annual report.pdf', content: BYTES['Annual report.pdf'] }),
    ]);
  });

  it('blocks a partial attachment failure and retries without sending a partial forward', async () => {
    let failed = false;
    stubs.getAttachmentBase64.mockImplementation(async (_id: string, filename: string) => {
      if (filename === 'schedule.txt' && !failed) {
        failed = true;
        return { success: false, error: 'temporarily unavailable' };
      }
      return { success: true, base64: BYTES[filename] };
    });
    const view = mount(kind);
    await settle();

    expect(view.container.textContent).toContain('Could not load forwarded attachments');
    expect(sendButton(view)?.disabled).toBe(true);
    await send(view);
    shortcut();
    await settle();
    expect(stubs.sendEmail).not.toHaveBeenCalled();
    expect(stubs.onClose).not.toHaveBeenCalled();

    fire(button(view, 'Retry attachments'), 'click');
    await settle();
    expect(sendButton(view)?.disabled).toBe(false);
    await send(view);
    expect(stubs.sendEmail).toHaveBeenCalledOnce();
    expect(stubs.sendEmail.mock.calls[0][0].attachments).toEqual([
      expect.objectContaining({ filename: 'Annual report.pdf', content: BYTES['Annual report.pdf'] }),
      expect.objectContaining({ filename: 'schedule.txt', content: BYTES['schedule.txt'] }),
    ]);
  });

  it('keeps a user-removed file removed after source metadata rerenders', async () => {
    const view = mount(kind);
    await settle();
    const filename = [...view.container.querySelectorAll('span')].find((item) => item.textContent === 'Annual report.pdf');
    fire(filename?.parentElement?.querySelector('button') ?? null, 'click');
    view.rerender(compose(kind, { ...ORIGINAL }));
    await settle();
    expect(stubs.getAttachmentBase64).toHaveBeenCalledTimes(2);
    await send(view);
    expect(stubs.sendEmail.mock.calls[0][0].attachments).toEqual([
      expect.objectContaining({ filename: 'schedule.txt', content: BYTES['schedule.txt'] }),
    ]);
  });

  it.each([true, false])('retains restored draft attachments without loading originals (has files: %s)', async (hasFiles) => {
    const selectedFiles = hasFiles ? [{
      filename: 'my-note.txt', content: 'bXkgbm90ZQ==', encoding: 'base64', size: 7, type: 'attachment',
    }] : [];
    const draft: ComposeDraft = {
      to: 'recipient@example.test',
      subject: 'Fwd: Annual report',
      htmlContent: '<p>Please review.</p>',
      attachments: selectedFiles,
    };
    const view = mount(kind, ORIGINAL, draft);
    await settle();
    expect(stubs.getAttachmentBase64).not.toHaveBeenCalled();
    expect(sendButton(view)?.disabled).toBe(false);
    await send(view);
    expect(stubs.sendEmail.mock.calls[0][0]).toMatchObject({
      accountId: 'original-account',
      attachments: selectedFiles,
    });
    expect(stubs.sendEmail.mock.calls[0][0].attachments).toHaveLength(selectedFiles.length);
  });
});
