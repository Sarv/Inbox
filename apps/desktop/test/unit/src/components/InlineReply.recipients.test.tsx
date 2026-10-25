// @vitest-environment happy-dom
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ autosave: vi.fn(), send: vi.fn() }));
vi.mock('../../../../src/store/email-store', async () => {
  const { create } = await import('zustand');
  return { useEmailStore: create(() => ({ accounts: [], activeAccountId: null, viewAccountId: null,
    selectedVirtualFolder: null, imapConfig: null, sendEmail: h.send })) };
});
vi.mock('../../../../src/hooks/useDraftAutosave', () => ({ useDraftAutosave: (value: unknown) => {
  h.autosave(value);
  return { markDiscarded: vi.fn(), closeAction: vi.fn() };
} }));
vi.mock('../../../../src/hooks/useCloseComposePrompt', () => ({ useCloseComposePrompt: () => ({ requestClose: vi.fn(), isAsking: () => false, closePromptDialog: null }) }));
vi.mock('../../../../src/hooks/usePgpCompose', () => ({ usePgpCompose: () => ({ state: { encrypt: false } }) }));
vi.mock('../../../../src/services/ai-service', () => ({ getDefaultProvider: () => undefined }));
vi.mock('../../../../src/components/RichTextEditor', () => ({ RichTextEditor: () => null }));
vi.mock('../../../../src/components/ComposeToolbar', () => ({ ComposeToolbar: () => null }));
vi.mock('../../../../src/components/SmtpNotConfiguredBanner', () => ({ SmtpNotConfiguredBanner: () => null }));
vi.mock('../../../../src/components/FromAccountBar', () => ({ FromAccountBar: () => null }));
vi.mock('../../../../src/components/PolishModal', () => ({ PolishModal: () => null }));
vi.mock('../../../../src/components/SandboxedEmailBody', () => ({ SandboxedEmailBody: () => null }));
vi.mock('../../../../src/components/SelectionPolishMenu', () => ({ SELECTION_MENU_WIDTH: 200, SelectionPolishMenu: () => null }));
vi.mock('../../../../src/components/EmailInput', () => ({ EmailInput: ({ value, onChange, placeholder }: { value: string; onChange: (value: string) => void; placeholder: string }) =>
  <input value={value} placeholder={placeholder} onInput={event => onChange(event.currentTarget.value)} /> }));

import { InlineReply } from '../../../../src/components/InlineReply';
import { useEmailStore } from '../../../../src/store/email-store';
import type { StoredAccount } from '../../../../src/store/types';
import type { ReplySource } from '../../../../src/utils/reply-source';
import { act, cleanup, fire, render, typeInto } from '../../../helpers/render';

const home = { id: 'home', email: 'active@home.test', identities: ['active@home.test', 'alias@home.test'] } as StoredAccount;
const work = { id: 'work', email: 'owner@work.test', identities: ['owner@work.test', 'sales@work.test'] } as StoredAccount;
const incoming: ReplySource = { id: 'incoming', accountId: 'work', messageId: '<incoming@test>', threadId: 'thread',
  subject: 'Requested quote', fromAddress: 'client@example.test', fromName: 'Client',
  toAddress: 'owner@work.test, sales@work.test, active@home.test', ccAddress: 'teammate@example.test, CLIENT@example.test',
  date: 100, cleanBody: 'Please send the quote.', rawBody: '<p>Please send the quote.</p>' };
const props = { replyToEmail: incoming, mode: 'replyAll' as const, onClose: vi.fn(), onModeChange: vi.fn() };
const recipients = () => h.autosave.mock.lastCall?.[0] as { to: string; cc: string; subject: string };

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  useEmailStore.setState({ accounts: [home, work], activeAccountId: 'home', viewAccountId: null,
    imapConfig: { username: home.email }, selectedVirtualFolder: null });
});
afterEach(cleanup);

describe('InlineReply recipient ownership', () => {
  it('uses the secondary source account and its identities while retaining another account as a recipient', () => {
    render(<InlineReply {...props} />);
    expect(recipients()).toMatchObject({ to: 'client@example.test', cc: 'active@home.test, teammate@example.test', subject: 'Re: Requested quote' });
    expect(h.send).not.toHaveBeenCalled();
  });

  it('recalculates for an explicit mode change, including replies to an own send-as alias', () => {
    const sent = { ...incoming, fromAddress: 'SALES@work.test', toAddress: 'owner@work.test, client@example.test', ccAddress: 'sales@work.test, other@example.test' };
    const view = render(<InlineReply {...props} replyToEmail={sent} mode="reply" />);
    expect(recipients()).toMatchObject({ to: 'client@example.test', cc: '' });
    view.rerender(<InlineReply {...props} replyToEmail={sent} mode="replyAll" />);
    expect(recipients()).toMatchObject({ to: 'client@example.test', cc: 'other@example.test' });
  });

  it('preserves edited To/Cc when IMAP settings and account metadata refresh', () => {
    const view = render(<InlineReply {...props} />);
    fire(view.all('button').find(button => button.textContent?.startsWith('Cc:'))!, 'click');
    typeInto(view.find('input[placeholder="Recipients"]'), 'chosen@example.test');
    typeInto(view.find('input[placeholder="Cc recipients"]'), 'reviewer@example.test');
    act(() => { useEmailStore.setState({ imapConfig: { username: 'changed-login@provider.test' },
      accounts: [home, { ...work, identities: [...work.identities!, 'new-alias@work.test'] }] }); });
    view.rerender(<InlineReply {...props} replyToEmail={{ ...incoming, rawBody: '<p>Downloaded original</p>' }} />);
    expect(recipients()).toMatchObject({ to: 'chosen@example.test', cc: 'reviewer@example.test', subject: 'Re: Requested quote' });
  });

  it('preserves restored recipients and subject through Strict Mode and account updates', () => {
    const draft = { to: 'saved@example.test', cc: 'saved-cc@example.test', subject: 'Saved subject', htmlContent: '<p>Saved draft.</p>', attachments: [] };
    render(<StrictMode><InlineReply {...props} draft={draft} /></StrictMode>);
    act(() => { useEmailStore.setState({ imapConfig: { username: 'another-login@test' }, accounts: [home, { ...work }] }); });
    expect(recipients()).toMatchObject({ to: draft.to, cc: draft.cc, subject: draft.subject });
    expect(h.send).not.toHaveBeenCalled();
  });

  it('updates recipients for a different message from the same sender', () => {
    const view = render(<InlineReply {...props} />);
    view.rerender(<InlineReply {...props} replyToEmail={{ ...incoming, id: 'next', toAddress: 'owner@work.test, next@example.test', ccAddress: null, subject: 'Next request' }} />);
    expect(recipients()).toMatchObject({ to: 'client@example.test', cc: 'next@example.test', subject: 'Re: Next request' });
  });

  it('uses the legacy username only without a named source owner', () => {
    useEmailStore.setState({ accounts: [], activeAccountId: null, imapConfig: { username: 'legacy@example.test' } });
    const legacy = { ...incoming, accountId: undefined, toAddress: 'legacy@example.test, external@example.test', ccAddress: null };
    const view = render(<InlineReply {...props} replyToEmail={legacy} />);
    expect(recipients()).toMatchObject({ to: 'client@example.test', cc: 'external@example.test' });
    view.rerender(<InlineReply {...props} replyToEmail={{ ...legacy, accountId: 'unavailable-owner' }} />);
    expect(recipients()).toMatchObject({ to: 'client@example.test', cc: 'legacy@example.test, external@example.test' });
  });
});
