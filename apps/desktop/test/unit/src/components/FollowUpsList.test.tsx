// @vitest-environment happy-dom
import type { AccountFollowUp } from '@sarvinbox/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The Follow-ups view and the banner above a thread. What breaks: a reminder
// row that opens nothing (or the wrong account's thread), a Dismiss that
// doesn't reach the store, a banner on a thread with no reminder, or a
// "Follow up" that isn't aimed at the message we sent.

const h = vi.hoisted(() => ({
  email: {
    viewMode: 'vertical',
    selectedEmailId: null as string | null,
    activeAccountId: 'acct-a',
    openThread: vi.fn(),
  },
}));

vi.mock('../../../../src/store/email-store', () => ({
  useEmailStore: (select: (state: typeof h.email) => unknown) => select(h.email),
}));

import { FollowUpBanner } from '../../../../src/components/email-detail/FollowUpBanner';
import { FollowUpsList } from '../../../../src/components/FollowUpsList';
import { useFollowUpsStore } from '../../../../src/store/follow-ups-store';
import { fire, render } from '../../../helpers/render';

const followUp = (id: string, over: Partial<AccountFollowUp> = {}): AccountFollowUp => ({
  id,
  accountId: 'acct-a',
  messageId: `<${id}@x>`,
  subject: `Subject ${id}`,
  recipients: 'alice@example.com',
  fromAddress: 'me@example.com',
  sentAt: Math.floor(new Date(2026, 8, 20, 10).getTime() / 1000),
  dueAt: Math.floor(new Date(2026, 8, 23, 10).getTime() / 1000),
  status: 'pending',
  resolvedAt: null,
  emailId: `e-${id}`,
  threadId: `t-${id}`,
  ...over,
});

const dismiss = vi.fn(async () => {});
const refresh = vi.fn(async () => {});

beforeEach(() => {
  h.email.viewMode = 'vertical';
  h.email.selectedEmailId = null;
  h.email.openThread = vi.fn();
  dismiss.mockClear();
  refresh.mockClear();
  useFollowUpsStore.setState({ items: [], loaded: true, dismiss, refresh });
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('FollowUpsList', () => {
  // Empty: say how to create one instead of a blank pane.
  it('explains the bell when there are no reminders, and refreshes on mount', () => {
    const view = render(<FollowUpsList />);
    expect(view.container.textContent).toContain('No follow-ups');
    expect(refresh).toHaveBeenCalled();
    view.unmount();
  });

  // Each row: subject, recipients, state; a click opens its thread in its account.
  it('lists reminders and opens a row\'s thread in its own account', () => {
    useFollowUpsStore.setState({
      items: [followUp('due', { status: 'due', accountId: 'acct-b' }), followUp('later')],
    });
    h.email.selectedEmailId = 'e-later';
    const view = render(<FollowUpsList />);
    const text = view.container.textContent ?? '';
    expect(text).toContain('Subject due');
    expect(text).toContain('To alice@example.com');
    expect(text).toContain('No reply since Sun, Sep 20');
    expect(text).toContain('Reminder Wed, Sep 23, 10:00 AM');
    fire(view.all('button').find((b) => b.textContent?.includes('Subject due')) ?? null, 'click');
    expect(h.email.openThread).toHaveBeenCalledWith('e-due', 't-due', 'acct-b');
    view.unmount();
  });

  // No local copy of the sent message yet: nothing to open, so nothing happens.
  it('does not open a reminder whose message is not stored locally', () => {
    useFollowUpsStore.setState({ items: [followUp('x', { emailId: null, threadId: null, accountId: '', subject: '', recipients: '' })] });
    h.email.viewMode = 'no-split';
    const view = render(<FollowUpsList />);
    expect(view.container.textContent).toContain('(no subject)');
    fire(view.all('button').find((b) => b.textContent?.includes('(no subject)')) ?? null, 'click');
    expect(h.email.openThread).not.toHaveBeenCalled();
    view.unmount();
  });

  it('dismisses a row from its icon button', () => {
    const item = followUp('a');
    useFollowUpsStore.setState({ items: [item] });
    h.email.viewMode = 'horizontal';
    const view = render(<FollowUpsList />);
    fire(view.byLabel('Dismiss reminder'), 'click');
    expect(dismiss).toHaveBeenCalledWith(item);
    view.unmount();
  });
});

describe('FollowUpBanner', () => {
  const sentEmail = { id: 'e-a', messageId: '<a@x>', threadId: 't-a' } as never;

  it('renders nothing for a thread with no open reminder', () => {
    useFollowUpsStore.setState({ items: [followUp('a')] });
    const view = render(<FollowUpBanner threadId="t-other" accountId={null} threadEmails={[]} onFollowUp={vi.fn()} />);
    expect(view.container.textContent).toBe('');
    view.unmount();
  });

  // Due: says since when, and "Follow up" replies to the message we sent.
  it('offers Follow up on a due reminder, aimed at our sent message', () => {
    const onFollowUp = vi.fn();
    useFollowUpsStore.setState({ items: [followUp('a', { status: 'due' })] });
    const view = render(<FollowUpBanner threadId="t-a" accountId={null} threadEmails={[sentEmail]} onFollowUp={onFollowUp} />);
    expect(view.container.textContent).toContain('No reply since Sun, Sep 20');
    fire(view.all('button').find((b) => b.textContent === 'Follow up') ?? null, 'click');
    expect(onFollowUp).toHaveBeenCalledWith(sentEmail);
    fire(view.byLabel('Dismiss reminder'), 'click');
    expect(dismiss).toHaveBeenCalled();
    view.unmount();
  });

  // Waiting: says when, can be cancelled, no Follow up yet.
  it('shows a pending reminder with a cancel and no Follow up', () => {
    useFollowUpsStore.setState({ items: [followUp('a')] });
    const view = render(<FollowUpBanner threadId="t-a" accountId="acct-a" threadEmails={[sentEmail]} onFollowUp={vi.fn()} />);
    expect(view.container.textContent).toContain('Reminder Wed, Sep 23, 10:00 AM');
    expect(view.all('button').some((b) => b.textContent === 'Follow up')).toBe(false);
    expect(view.byLabel('Cancel reminder')).not.toBeNull();
    view.unmount();
  });

  // Our message isn't among the loaded ones: no target, so no Follow up button.
  it('hides Follow up when the sent message is not in the thread', () => {
    useFollowUpsStore.setState({ items: [followUp('a', { status: 'due' })] });
    const view = render(<FollowUpBanner threadId="t-a" accountId={null} threadEmails={[]} onFollowUp={vi.fn()} />);
    expect(view.all('button').some((b) => b.textContent === 'Follow up')).toBe(false);
    view.unmount();
  });
});
