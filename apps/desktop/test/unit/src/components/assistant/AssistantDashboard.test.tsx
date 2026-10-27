// @vitest-environment happy-dom
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AssistantDashboard } from '../../../../../src/components/assistant/AssistantDashboard';
import type { InboxAssistantDashboard, InboxAssistantResult, InboxAssistantSource } from '../../../../../src/types/inbox-assistant';
import { act, cleanup, fire, render, settle } from '../../../../helpers/render';

type Props = ComponentProps<typeof AssistantDashboard>;
type DashboardResult = InboxAssistantResult<InboxAssistantDashboard>;

const source: InboxAssistantSource = {
  id: 'S1', kind: 'message', accountId: 'secondary', accountEmail: 'sales@example.test',
  emailId: 'shared-email-id', threadId: 'shared-thread-id', subject: 'Quotation needs approval',
  from: 'customer@example.test', to: ['sales@example.test'], date: 1_790_000_000,
  folder: 'Archive', sent: false, excerpt: 'Please confirm the updated quotation.',
};
const meeting = {
  eventId: 'recurring-meeting', occurrenceId: 'recurring-meeting@1790003600000',
  startMs: 1_790_003_600_000, endMs: 1_790_007_200_000, title: 'Quotation review',
  calendarName: 'Local work', allDay: false,
};

function snapshot(changes: Partial<InboxAssistantDashboard> = {}): InboxAssistantDashboard {
  return {
    generatedAt: 1_790_000_000_000,
    accounts: [{ id: 'primary', email: 'owner@example.test', status: 'ready' }, { id: 'secondary', email: 'sales@example.test', status: 'ready' }],
    counts: { unreadConversations: 8, uncategorizedUnreadConversations: 2, needsReplyConversations: 1 },
    needsReply: { total: 1, items: [source], truncated: false },
    followUps: { total: 1, items: [{ id: 'due-follow-up', accountId: source.accountId, subject: source.subject, to: 'customer@example.test', dueAt: 1_789_999_000_000, source }], truncated: false },
    meetings: { timeZone: 'Asia/Kolkata', scope: 'local-only', status: 'ready', items: [meeting] },
    warnings: [],
    ...changes,
  };
}

const dashboard = vi.fn<(request: { accountIds: string[] }) => Promise<DashboardResult>>();
const ask = vi.fn();
const applyReview = vi.fn();
const chat = vi.fn();
const createChat = vi.fn();
const resolveSource = vi.fn();

function props(changes: Partial<Props> = {}): Props {
  return {
    accountIds: ['primary', 'secondary'], chats: [], onChoosePrompt: vi.fn(),
    onOpenConversation: vi.fn(), onNewConversation: vi.fn(), ...changes,
  };
}

function button(view: ReturnType<typeof render>, label: string): HTMLElement | null {
  return view.byLabel(label) ?? view.all('button').find(element => element.textContent?.includes(label)) ?? null;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  dashboard.mockReset();
  dashboard.mockResolvedValue({ success: true, data: snapshot() });
  Object.assign(window, { electronAPI: { inboxAssistant: { dashboard, ask, applyReview, chat, createChat, source: resolveSource } } });
});
afterEach(cleanup);

describe('read-only assistant dashboard', () => {
  it('loads only the exact deduplicated selected-account scope', async () => {
    const view = render(<AssistantDashboard {...props({ accountIds: ['primary', 'primary', 'secondary'] })} />);
    await settle();
    expect(dashboard).toHaveBeenCalledExactlyOnceWith({ accountIds: ['primary', 'secondary'] });
    expect(view.container.textContent).toContain('Today in your inbox');
    expect(ask).not.toHaveBeenCalled();
    expect(applyReview).not.toHaveBeenCalled();
    view.rerender(<AssistantDashboard {...props({ accountIds: ['secondary', 'primary', 'secondary'] })} />);
    await settle();
    expect(dashboard).toHaveBeenCalledOnce();
  });

  it('distinguishes actual zero conversations from unavailable counts', async () => {
    dashboard.mockResolvedValueOnce({ success: true, data: snapshot({ counts: { unreadConversations: 0, uncategorizedUnreadConversations: 0, needsReplyConversations: 0 }, needsReply: { total: 0, items: [], truncated: false } }) });
    const view = render(<AssistantDashboard {...props()} />);
    await settle();
    expect(view.byLabel('Unread conversations: 0')).not.toBeNull();
    expect(view.byLabel('Uncategorized unread conversations: 0')).not.toBeNull();
    expect(view.byLabel('Saved needs-reply conversations: 0')).not.toBeNull();
    dashboard.mockResolvedValueOnce({ success: true, data: snapshot({ counts: { unreadConversations: null, uncategorizedUnreadConversations: null, needsReplyConversations: null }, needsReply: { total: null, items: [], truncated: false } }) });
    fire(button(view, 'Refresh overview'), 'click');
    await settle();
    expect(view.byLabel('Unread conversations: Unavailable')).not.toBeNull();
    expect(view.byLabel('Uncategorized unread conversations: Unavailable')).not.toBeNull();
    expect(view.byLabel('Saved needs-reply conversations: Unavailable')).not.toBeNull();
    expect(view.byLabel('Unread conversations: 0')).toBeNull();
  });

  it('does not interpret an empty account selection as all accounts', async () => {
    const common = props();
    const view = render(<AssistantDashboard {...common} accountIds={[]} />);
    await settle();
    expect(dashboard).not.toHaveBeenCalled();
    view.rerender(<AssistantDashboard {...common} />);
    await settle();
    expect(view.byLabel('Unread conversations: 8')).not.toBeNull();
    view.rerender(<AssistantDashboard {...common} accountIds={[]} />);
    await settle();
    expect(dashboard).toHaveBeenCalledOnce();
    expect(view.byLabel('Unread conversations: 8')).toBeNull();
  });

  it('keeps a missing dashboard API readable and offers a retry', async () => {
    Object.assign(window, { electronAPI: { inboxAssistant: {} } });
    const view = render(<AssistantDashboard {...props()} />);
    await settle();
    expect(view.container.textContent).toMatch(/unavailable/i);
    expect(button(view, 'Refresh overview')).not.toBeNull();
    Object.assign(window, { electronAPI: { inboxAssistant: { dashboard } } });
    fire(button(view, 'Refresh overview'), 'click');
    await settle();
    expect(dashboard).toHaveBeenCalledExactlyOnceWith({ accountIds: ['primary', 'secondary'] });
    expect(view.byLabel('Unread conversations: 8')).not.toBeNull();
  });

  it('shows a failed snapshot error and retries without invoking AI', async () => {
    dashboard.mockResolvedValueOnce({ success: false, error: 'Local overview cannot be read.' });
    const view = render(<AssistantDashboard {...props()} />);
    await settle();
    expect(view.container.textContent).toContain('Local overview cannot be read.');
    fire(button(view, 'Refresh overview'), 'click');
    await settle();
    expect(dashboard).toHaveBeenCalledTimes(2);
    expect(view.byLabel('Unread conversations: 8')).not.toBeNull();
    expect(ask).not.toHaveBeenCalled();
    expect(applyReview).not.toHaveBeenCalled();
  });

  it('handles an IPC rejection as a readable overview error', async () => {
    dashboard.mockRejectedValueOnce(new Error('Local connection interrupted.'));
    const view = render(<AssistantDashboard {...props()} />);
    await settle();
    expect(view.find('[role="alert"]')?.textContent).toContain('Local connection interrupted.');
    expect(view.byLabel('Unread conversations: 0')).toBeNull();
    expect(button(view, 'Refresh overview')?.hasAttribute('disabled')).toBe(false);
  });

  it('discards a late response after the account scope changes', async () => {
    const old = deferred<DashboardResult>();
    dashboard.mockImplementationOnce(() => old.promise);
    dashboard.mockResolvedValueOnce({ success: true, data: snapshot({ accounts: [{ id: 'secondary', email: 'sales@example.test', status: 'ready' }], counts: { unreadConversations: 3, uncategorizedUnreadConversations: 1, needsReplyConversations: 1 } }) });
    const common = props({ accountIds: ['primary'] });
    const view = render(<AssistantDashboard {...common} />);
    view.rerender(<AssistantDashboard {...common} accountIds={['secondary']} />);
    await settle();
    expect(dashboard.mock.calls).toEqual([[{ accountIds: ['primary'] }], [{ accountIds: ['secondary'] }]]);
    expect(view.byLabel('Unread conversations: 3')).not.toBeNull();
    await act(async () => { old.resolve({ success: true, data: snapshot({ counts: { unreadConversations: 987, uncategorizedUnreadConversations: 986, needsReplyConversations: 985 }, warnings: ['Obsolete primary account result'] }) }); });
    expect(view.byLabel('Unread conversations: 3')).not.toBeNull();
    expect(view.byLabel('Unread conversations: 987')).toBeNull();
    expect(view.container.textContent).not.toContain('Obsolete primary account result');
  });

  it('does no work while hidden and suppresses an in-flight response after hiding', async () => {
    const pending = deferred<DashboardResult>();
    dashboard.mockImplementationOnce(() => pending.promise);
    const common = props({ visible: false });
    const view = render(<AssistantDashboard {...common} />);
    await settle();
    expect(dashboard).not.toHaveBeenCalled();
    view.rerender(<AssistantDashboard {...common} visible />);
    await settle();
    expect(dashboard).toHaveBeenCalledOnce();
    view.rerender(<AssistantDashboard {...common} visible={false} />);
    await act(async () => { pending.resolve({ success: true, data: snapshot({ warnings: ['Snapshot completed after hiding'] }) }); });
    expect(view.container.textContent).not.toContain('Snapshot completed after hiding');
    expect(view.byLabel('Unread conversations: 8')).toBeNull();
    expect(dashboard).toHaveBeenCalledOnce();
  });

  it('opens sources with their exact owning account and email identifiers', async () => {
    const onNavigateToSource = vi.fn();
    const view = render(<AssistantDashboard {...props({ onNavigateToSource })} />);
    await settle();
    fire(view.byLabel(`Open email: ${source.subject} (${source.accountEmail})`), 'click');
    expect(onNavigateToSource).toHaveBeenCalledExactlyOnceWith(source);
    expect(resolveSource).not.toHaveBeenCalled();
    expect(ask).not.toHaveBeenCalled();
    expect(applyReview).not.toHaveBeenCalled();
  });

  it('defaults reply rows to Reply all while keeping Open email a separate reading action', async () => {
    const onNavigateToSource = vi.fn();
    const onReplyToSource = vi.fn();
    const view = render(<AssistantDashboard {...props({ onNavigateToSource, onReplyToSource })} />);
    await settle();
    const reply = view.byLabel(`Reply all: ${source.subject} (${source.accountEmail})`);
    const open = view.byLabel(`Open email: ${source.subject} (${source.accountEmail})`);
    expect(reply?.tagName).toBe('BUTTON');
    expect(reply?.getAttribute('type')).toBe('button');
    expect(reply?.contains(open)).toBe(false);
    act(() => reply?.focus());
    expect(document.activeElement).toBe(reply);
    fire(reply, 'click');
    expect(onReplyToSource).toHaveBeenCalledExactlyOnceWith(source);
    expect(onNavigateToSource).not.toHaveBeenCalled();
    fire(open, 'click');
    expect(onNavigateToSource).toHaveBeenCalledExactlyOnceWith(source);
    expect(onReplyToSource).toHaveBeenCalledOnce();
    expect(ask).not.toHaveBeenCalled();
    expect(applyReview).not.toHaveBeenCalled();
    expect(resolveSource).not.toHaveBeenCalled();
  });

  it('falls back to reading when Reply all is not wired and disables unavailable source actions', async () => {
    const onNavigateToSource = vi.fn();
    const common = props({ onNavigateToSource });
    const view = render(<AssistantDashboard {...common} />);
    await settle();
    fire(view.byLabel(`Reply all: ${source.subject} (${source.accountEmail})`), 'click');
    expect(onNavigateToSource).toHaveBeenCalledExactlyOnceWith(source);
    view.rerender(<AssistantDashboard {...common} onNavigateToSource={undefined} />);
    expect(view.byLabel(`Reply all: ${source.subject} (${source.accountEmail})`)?.hasAttribute('disabled')).toBe(true);
    expect(view.byLabel(`Open email: ${source.subject} (${source.accountEmail})`)?.hasAttribute('disabled')).toBe(true);
    expect(dashboard).toHaveBeenCalledOnce();
  });

  it('keeps full long subjects available while showing a compact reply row', async () => {
    const longSubject = `Revised quotation ${'LongSubject'.repeat(50)}`;
    const longFrom = `A Customer With A Long Name <${'customer'.repeat(30)}@example.test>`;
    const onReplyToSource = vi.fn();
    const longSource = { ...source, subject: longSubject, from: longFrom };
    dashboard.mockResolvedValueOnce({ success: true, data: snapshot({ needsReply: { total: 1, items: [longSource], truncated: false } }) });
    const view = render(<AssistantDashboard {...props({ compact: true, onReplyToSource })} />);
    await settle();
    const subject = view.all('[title]').find(element => element.getAttribute('title') === longSubject);
    expect(subject?.textContent).toBe(longSubject);
    expect(view.all('[title]').some(element => element.getAttribute('title') === longFrom)).toBe(true);
    fire(view.byLabel(`Reply all: ${longSubject} (${source.accountEmail})`), 'click');
    expect(onReplyToSource).toHaveBeenCalledExactlyOnceWith(longSource);
  });

  it('focuses the reply worklist from its count without starting a search', async () => {
    const onChoosePrompt = vi.fn();
    const view = render(<AssistantDashboard {...props({ onChoosePrompt })} />);
    await settle();
    fire(view.byLabel('Saved needs-reply conversations: 1'), 'click');
    expect(document.activeElement?.textContent).toMatch(/^Needs your reply/);
    expect(onChoosePrompt).not.toHaveBeenCalled();
    expect(ask).not.toHaveBeenCalled();
  });

  it('opens the exact local calendar occurrence in milliseconds', async () => {
    const onOpenCalendarEvent = vi.fn();
    const view = render(<AssistantDashboard {...props({ onOpenCalendarEvent })} />);
    await settle();
    fire(view.byLabel(`Open calendar event: ${meeting.title}`), 'click');
    expect(onOpenCalendarEvent).toHaveBeenCalledExactlyOnceWith({ eventId: meeting.eventId, startMs: meeting.startMs, occurrenceId: meeting.occurrenceId });
    expect(view.container.textContent).toMatch(/local calendar/i);
  });

  it('quick actions fill the composer through callbacks without asking or applying anything', async () => {
    const onChoosePrompt = vi.fn();
    const onNewConversation = vi.fn();
    const view = render(<AssistantDashboard {...props({ onChoosePrompt, onNewConversation })} />);
    await settle();
    for (const label of ['Review unread', 'Check uncategorized', 'Find what needs a reply', 'Find quotations', 'Find meeting invitations']) fire(button(view, label), 'click');
    expect(onChoosePrompt.mock.calls).toEqual([
      ['Review my unread emails and mark low-value conversations as read.'],
      ['Review my uncategorized unread emails.'],
      ['Which recent customer emails need a response?'],
      ['Find the latest quotation I sent and any revisions.'],
      ['Find meeting invitations received today.'],
    ]);
    fire(button(view, 'New conversation'), 'click');
    expect(onNewConversation).toHaveBeenCalledOnce();
    expect(ask).not.toHaveBeenCalled();
    expect(applyReview).not.toHaveBeenCalled();
    expect(createChat).not.toHaveBeenCalled();
  });

  it('keeps task actions directly available without a menu and prepares only the selected request', async () => {
    const onChoosePrompt = vi.fn();
    const view = render(<AssistantDashboard {...props({ onChoosePrompt })} />);
    await settle();
    const tasks = view.byLabel('Guided inbox tasks');
    const quotations = button(view, 'Find quotations');
    expect(tasks?.contains(quotations)).toBe(true);
    expect(quotations?.closest('details')).toBeNull();
    act(() => quotations?.focus());
    expect(document.activeElement).toBe(quotations);
    fire(quotations, 'click');
    expect(onChoosePrompt).toHaveBeenCalledExactlyOnceWith('Find the latest quotation I sent and any revisions.');
    expect(ask).not.toHaveBeenCalled();
  });

  it('renders recent conversation metadata and opens its id without loading chat contents', async () => {
    const onOpenConversation = vi.fn();
    const view = render(<AssistantDashboard {...props({ onOpenConversation, chats: [{ id: 'chat-two', title: 'Quotation discussion', createdAt: 1_789_000_000_000, updatedAt: 1_790_000_000_000, exchangeCount: 4 }] })} />);
    await settle();
    const recent = view.all('button').find(element => element.textContent?.includes('Quotation discussion'));
    fire(recent ?? null, 'click');
    expect(onOpenConversation).toHaveBeenCalledExactlyOnceWith('chat-two');
    expect(chat).not.toHaveBeenCalled();
    expect(ask).not.toHaveBeenCalled();
    expect(view.container.textContent).toContain('4 saved answers');
  });

  it('shows partial coverage and bounded-list warnings and renders external text safely', async () => {
    const untrusted = '<img src=x onerror=send()> <script>send()</script>';
    dashboard.mockResolvedValueOnce({ success: true, data: snapshot({
      accounts: [{ id: 'primary', email: 'owner@example.test', status: 'ready' }, { id: 'secondary', email: 'sales@example.test', status: 'unavailable', error: 'Account database unavailable' }],
      needsReply: { total: 200, items: [{ ...source, subject: untrusted }], truncated: true },
      followUps: { total: 150, items: [{ id: 'due', accountId: 'primary', subject: untrusted, dueAt: 1_789_999_000_000 }], truncated: true },
      meetings: { timeZone: 'Asia/Kolkata', scope: 'local-only', status: 'unavailable', items: [] },
      warnings: [`Coverage warning: ${untrusted}`],
    }) });
    const view = render(<AssistantDashboard {...props()} />);
    await settle();
    expect(view.container.textContent).toContain('sales@example.test');
    expect(view.container.textContent).toContain('Account database unavailable');
    expect(view.container.textContent).toContain(`Coverage warning: ${untrusted}`);
    expect(view.container.textContent).toContain(untrusted);
    expect(view.byLabel('Needs your reply')?.textContent).toMatch(/showing|limited|truncated|first/i);
    expect(view.byLabel('Follow-ups due')?.textContent).toMatch(/showing|limited|truncated|first/i);
    expect(view.container.textContent).toMatch(/calendar.*unavailable|unavailable.*calendar/i);
    expect(view.find('img')).toBeNull();
    expect(view.find('script')).toBeNull();
    expect(view.find('[onerror]')).toBeNull();
  });
});
