// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ComposeEmail } from '../../../../src/components/ComposeEmail';
import type { LocalCalendarAvailability } from '../../../../src/types/local-calendar';
import { act, cleanup, fire, render, settle } from '../../../helpers/render';

const h = vi.hoisted(() => ({
  accounts: [{ id: 'work', email: 'work@example.com' }, { id: 'sales', email: 'sales@example.com' }],
  send: vi.fn(), autosave: vi.fn(), signature: vi.fn(), pgp: vi.fn(), failure: vi.fn(),
}));
vi.mock('../../../../src/store/email-store', () => ({
  useEmailStore: (selector?: (state: unknown) => unknown) => {
    const state = { accounts: h.accounts, activeAccountId: 'work', imapConfig: { username: 'work@example.com' } };
    return selector ? selector(state) : state;
  },
}));
vi.mock('../../../../src/components/useCompose', () => ({
  useCompose: ({ initialDraft }: { initialDraft?: { to?: string; subject?: string; htmlContent?: string } }) => ({
    to: initialDraft?.to ?? 'buyer@example.com', cc: '', bcc: '', pendingTo: [], pendingCc: [], pendingBcc: [],
    subject: initialDraft?.subject ?? 'Proposal', htmlBody: initialDraft?.htmlContent ?? '<p>Please review.</p>', plainBody: 'Please review.',
    attachments: [], sending: false, showCc: false, showBcc: false, showPolishModal: false,
    mergeEmails: (value: string) => value ? value.split(', ') : [], getSignature: h.signature, sendEmail: h.send,
    setTo: vi.fn(), setCc: vi.fn(), setBcc: vi.fn(), setPendingTo: vi.fn(), setPendingCc: vi.fn(), setPendingBcc: vi.fn(),
    setSubject: vi.fn(), setHtmlBody: vi.fn(), setBody: vi.fn(), setAttachments: vi.fn(), setSending: vi.fn(),
    setShowCc: vi.fn(), setShowBcc: vi.fn(), setShowPolishModal: vi.fn(), setPolishMode: vi.fn(),
  }),
}));
vi.mock('../../../../src/hooks/useDraftAutosave', () => ({ useDraftAutosave: (options: unknown) => { h.autosave(options); return { markDiscarded: () => 'draft-message-id', closeAction: vi.fn() }; } }));
vi.mock('../../../../src/hooks/useForwardAttachments', () => ({ useForwardAttachments: () => ({ blocked: false }) }));
vi.mock('../../../../src/hooks/useCloseComposePrompt', () => ({ useCloseComposePrompt: () => ({ requestClose: vi.fn(), isAsking: () => false, closePromptDialog: null }) }));
vi.mock('../../../../src/hooks/usePgpCompose', () => ({ usePgpCompose: (...args: unknown[]) => { h.pgp(...args); return { state: { encrypt: false } }; } }));
vi.mock('../../../../src/services/ai-service', () => ({ getDefaultProvider: () => null }));
vi.mock('../../../../src/utils/attachment-reminder', () => ({ checkAttachmentBeforeSend: async () => true }));
vi.mock('../../../../src/utils/send-failure', () => ({ reportSendFailure: h.failure }));
vi.mock('../../../../src/components/ComposeToolbar', () => ({ ComposeToolbar: ({ onSend }: { onSend: () => void }) => <button onClick={onSend}>Send</button> }));
vi.mock('../../../../src/components/EmailInput', () => ({ EmailInput: () => <div /> }));
vi.mock('../../../../src/components/RichTextEditor', () => ({ RichTextEditor: () => <div />, EMPTY_EDITOR_HTML: '<p></p>' }));
vi.mock('../../../../src/components/ForwardAttachmentStatus', () => ({ ForwardAttachmentStatus: () => null }));
vi.mock('../../../../src/components/SmtpNotConfiguredBanner', () => ({ SmtpNotConfiguredBanner: () => null }));
vi.mock('../../../../src/components/QuotedOriginalPreview', () => ({ QuotedOriginalPreview: () => null }));
vi.mock('../../../../src/components/SandboxedEmailBody', () => ({ SandboxedEmailBody: () => null }));
vi.mock('../../../../src/components/PolishModal', () => ({ PolishModal: () => null }));
vi.mock('../../../../src/components/SelectionPolishMenu', () => ({ SelectionPolishMenu: () => null }));

beforeEach(() => {
  vi.clearAllMocks();
  h.accounts = [{ id: 'work', email: 'work@example.com' }, { id: 'sales', email: 'sales@example.com' }];
  h.signature.mockReturnValue(''); h.send.mockResolvedValue(undefined);
  (window as unknown as { electronAPI: unknown }).electronAPI = {};
});
afterEach(cleanup);

describe('the shared composer sending account', () => {
  const startMs = Date.parse('2026-10-22T09:00:00Z');
  const proposal: LocalCalendarAvailability = { startMs, endMs: startMs + 3_600_000, checkedAt: startMs - 86_400_000, timeZone: 'UTC', durationMinutes: 30,
    calendarIds: ['local'], calendarNames: ['Private calendar'], scope: 'local-only', status: 'ready',
    slots: [{ startMs, endMs: startMs + 1_800_000, label: 'Please review.' }] };

  it('retains meeting evidence in autosave and the Undo draft after rechecking the actual time', async () => {
    const availability = vi.fn(async () => ({ success: true, data: proposal }));
    (window as unknown as { electronAPI: unknown }).electronAPI = { calendar: { availability } };
    const view = render(<ComposeEmail mode="new" draft={{ accountId: 'sales', to: 'buyer@example.com', calendarAvailability: proposal }} onClose={vi.fn()} />);
    expect(h.autosave).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'sales', calendarAvailability: proposal }));
    fire(view.all('button').find(button => button.textContent === 'Send') ?? null, 'click');
    await settle();
    expect(availability).toHaveBeenCalledExactlyOnceWith({ startMs, endMs: proposal.slots[0].endMs, durationMinutes: 30, timeZone: 'UTC', limit: 1 });
    expect(h.send).toHaveBeenCalledWith(expect.objectContaining({ draft: expect.objectContaining({ calendarAvailability: proposal, accountId: 'sales' }) }));
  });

  it('keeps a reopened meeting draft open when its retained time has become busy', async () => {
    const onClose = vi.fn();
    const availability = vi.fn(async () => ({ success: true, data: { ...proposal, slots: [] } }));
    (window as unknown as { electronAPI: unknown }).electronAPI = { calendar: { availability } };
    const view = render(<ComposeEmail mode="new" draft={{ accountId: 'sales', to: 'buyer@example.com', calendarAvailability: proposal }} onClose={onClose} />);
    fire(view.all('button').find(button => button.textContent === 'Send') ?? null, 'click');
    await settle();
    expect(h.send).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(h.failure).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('no longer available') }));
  });

  it('opens an assistant draft under its chosen account and sends through that account only after Send', async () => {
    const view = render(<ComposeEmail mode="new" draft={{ accountId: 'sales', to: 'buyer@example.com', subject: 'Proposal', htmlContent: '<p>Please review.</p>' }} onClose={vi.fn()} />);
    expect(view.container.textContent).toContain('sales@example.com');
    expect(h.autosave).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'sales' }));
    expect(h.signature).toHaveBeenCalledWith('new', 'sales');
    expect(h.pgp).toHaveBeenCalledWith('sales@example.com', ['buyer@example.com'], false);
    expect(h.send).not.toHaveBeenCalled();
    fire(view.all('button').find(button => button.textContent === 'Send') ?? null, 'click');
    await settle();
    expect(h.send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ accountId: 'sales', to: ['buyer@example.com'], draftCleanup: expect.objectContaining({ accountId: 'sales' }) }));
  });

  it('keeps normal new mail on the active account', async () => {
    const view = render(<ComposeEmail mode="new" onClose={vi.fn()} />);
    fire(view.all('button').find(button => button.textContent === 'Send') ?? null, 'click');
    await settle();
    expect(h.send).toHaveBeenCalledWith(expect.objectContaining({ accountId: undefined }));
    expect(h.pgp).toHaveBeenCalledWith('work@example.com', ['buyer@example.com'], false);
  });

  it('does not send from the active mailbox when the draft account was removed', async () => {
    h.accounts = h.accounts.filter(account => account.id !== 'sales');
    const view = render(<ComposeEmail mode="new" draft={{ accountId: 'sales', to: 'buyer@example.com' }} onClose={vi.fn()} />);
    await act(async () => fire(view.all('button').find(button => button.textContent === 'Send') ?? null, 'click'));
    expect(h.send).not.toHaveBeenCalled();
    expect(h.failure).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('sending account is no longer connected') }));
  });
});
