// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../../src/store/email-store', async () => {
  const { create } = await import('zustand');
  return { useEmailStore: create(() => ({ selectedEmailId: null, threadEmails: [], threadAccountId: null, loadingThread: false, viewAccountId: null, activeAccountId: 'primary', pendingThreadEmailIds: [], clearSelectedEmail: vi.fn(), openThread: vi.fn() })) };
});
const reader = vi.hoisted(() => ({ render: vi.fn() }));
vi.mock('../../../../../src/components/extensions/MailDetailWithPanels', () => ({
  MailDetailWithPanels: (props: { threadOnly?: boolean; onBack?: () => void }) => {
    reader.render(props);
    return <div aria-label="Shared full mail reader"><button onClick={props.onBack}>Shared reader Back</button></div>;
  },
}));

import { AssistantSourcePane } from '../../../../../src/components/assistant/AssistantSourcePane';
import { useEmailStore } from '../../../../../src/store/email-store';
import type { InboxAssistantSource } from '../../../../../src/types/inbox-assistant';
import { emailRecord } from '../../../../helpers/email-fixtures';
import { act, cleanup, fire, render, settle } from '../../../../helpers/render';

const source: InboxAssistantSource = { id: 'S1', kind: 'attachment', accountId: 'secondary', accountEmail: 'sales@example.test', emailId: 'shared-id', threadId: 'same-thread', subject: 'TCS quote', from: 'sales@example.test', to: ['tcs@example.test'], date: 1_700_000_000, folder: 'Sent', sent: true, filename: 'quote.pdf', excerpt: '' };
const resolveSource = vi.fn(async () => ({ success: true, data: { emailId: source.emailId, threadId: source.threadId, filename: source.filename } }));

beforeEach(() => {
  vi.clearAllMocks();
  resolveSource.mockImplementation(async () => ({ success: true, data: { emailId: source.emailId, threadId: source.threadId, filename: source.filename } }));
  useEmailStore.setState({ selectedEmailId: null, threadEmails: [], threadAccountId: null, viewAccountId: null, activeAccountId: 'primary', loadingThread: false,
    clearSelectedEmail: vi.fn(() => { useEmailStore.setState({ selectedEmailId: null, threadEmails: [] }); }),
    openThread: vi.fn((emailId, _threadId, accountId) => { useEmailStore.setState({ selectedEmailId: emailId, viewAccountId: accountId, loadingThread: true }); }),
  });
  Object.assign(window, { electronAPI: { inboxAssistant: { source: resolveSource } } });
});
afterEach(cleanup);

async function finishLoad(accountId = source.accountId, emailId = source.emailId, threadId = source.threadId!) {
  await act(async () => { useEmailStore.setState({ loadingThread: false, threadAccountId: accountId, threadEmails: [emailRecord({ id: emailId, threadId, accountId, subject: 'Owned quotation' })] }); });
  await settle();
}

describe('embedded assistant source mail', () => {
  it('keeps the existing reader mounted during same-thread refresh so an inline draft is preserved', async () => {
    const view = render(<AssistantSourcePane source={source} onClose={vi.fn()} />);
    await settle(); await finishLoad();
    const original = view.byLabel('Shared full mail reader');
    await act(async () => { useEmailStore.setState({ loadingThread: true }); });
    expect(view.byLabel('Shared full mail reader')).toBe(original);
  });

  it('shows a legacy single email whose thread identifier is empty', async () => {
    const legacy = { ...source, threadId: '', filename: undefined };
    resolveSource.mockImplementationOnce(async () => ({ success: true, data: { emailId: legacy.emailId, threadId: legacy.emailId, filename: undefined } }));
    const view = render(<AssistantSourcePane source={legacy} onClose={vi.fn()} />);
    await settle();
    await finishLoad(legacy.accountId, legacy.emailId, '');
    expect(view.byLabel('Shared full mail reader')).not.toBeNull();
  });

  it('opens the exact owning account in the existing full reader with inbox navigation disabled', async () => {
    const view = render(<AssistantSourcePane source={source} onClose={vi.fn()} />);
    await settle();
    expect(useEmailStore.getState().openThread).toHaveBeenCalledWith('shared-id', 'same-thread', 'secondary');
    expect(reader.render).not.toHaveBeenCalled();
    await finishLoad();
    expect(view.byLabel('Shared full mail reader')).not.toBeNull();
    expect(reader.render).toHaveBeenLastCalledWith(expect.objectContaining({ threadOnly: true, onBack: expect.any(Function) }));
    expect(view.container.textContent).toContain('sales@example.test');
  });

  it('clears old rows before loading and refuses a same-ID thread stamped with the wrong account', async () => {
    useEmailStore.setState({ selectedEmailId: source.emailId, threadAccountId: 'primary', threadEmails: [emailRecord({ id: source.emailId, threadId: source.threadId! })] });
    const view = render(<AssistantSourcePane source={source} onClose={vi.fn()} />);
    expect(useEmailStore.getState().threadEmails).toEqual([]);
    await settle();
    await finishLoad('primary');
    expect(view.byLabel('Shared full mail reader')).toBeNull();
    expect(view.container.textContent).toContain('could not be loaded from its original account');
    expect(reader.render).not.toHaveBeenCalled();
  });

  it('ignores late source resolution after another source was selected', async () => {
    let resolveOld!: (value: Awaited<ReturnType<typeof resolveSource>>) => void;
    resolveSource.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }));
    const next = { ...source, accountId: 'third', emailId: 'next-id', filename: 'next.pdf' };
    resolveSource.mockImplementationOnce(async () => ({ success: true, data: { emailId: next.emailId, threadId: 'next-thread', filename: next.filename } }));
    const view = render(<AssistantSourcePane source={source} onClose={vi.fn()} />);
    view.rerender(<AssistantSourcePane source={next} onClose={vi.fn()} />);
    await settle();
    await act(async () => { resolveOld({ success: true, data: { emailId: source.emailId, threadId: source.threadId, filename: source.filename } }); });
    expect(useEmailStore.getState().openThread).toHaveBeenCalledExactlyOnceWith(next.emailId, 'next-thread', next.accountId);
  });

  it('closes through the shared Back action and retains the assistant route', async () => {
    const onClose = vi.fn();
    const view = render(<AssistantSourcePane source={source} onClose={onClose} />);
    await settle(); await finishLoad();
    fire(view.all('button').find(button => button.textContent === 'Shared reader Back')!, 'click');
    expect(onClose).toHaveBeenCalledOnce();
    expect(useEmailStore.getState().selectedEmailId).toBeNull();
  });

  it('uses the original attachment viewer callback with the exact verified owner and filename', async () => {
    const onOpenAttachment = vi.fn();
    const view = render(<AssistantSourcePane source={source} onClose={vi.fn()} onOpenAttachment={onOpenAttachment} />);
    await settle();
    fire(view.all('button').find(button => button.textContent === 'Open quote.pdf')!, 'click');
    expect(onOpenAttachment).toHaveBeenCalledWith({ accountId: 'secondary', emailId: 'shared-id', threadId: 'same-thread', filename: 'quote.pdf' });
  });

  it('does not open a source whose validation finishes after the pane was closed', async () => {
    let resolveLate!: (value: Awaited<ReturnType<typeof resolveSource>>) => void;
    resolveSource.mockImplementationOnce(() => new Promise(resolve => { resolveLate = resolve; }));
    const view = render(<AssistantSourcePane source={source} onClose={vi.fn()} />);
    view.unmount();
    await act(async () => { resolveLate({ success: true, data: { emailId: source.emailId, threadId: source.threadId, filename: source.filename } }); });
    expect(useEmailStore.getState().openThread).not.toHaveBeenCalled();
  });
});
