// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ComposeEmail } from '../../../../src/components/ComposeEmail';
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
});
afterEach(cleanup);

describe('the shared composer sending account', () => {
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
