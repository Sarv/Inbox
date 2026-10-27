// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AssistantReviewCard, type AssistantReviewCardProps } from '../../../../../src/components/assistant/AssistantReviewCard';
import type { InboxAssistantReview, InboxAssistantReviewAutomation, InboxAssistantReviewItem } from '../../../../../src/types/inbox-assistant-actions';
import { act, cleanup, fire, render, toggle } from '../../../../helpers/render';

const NOW = Date.UTC(2026, 9, 15, 10, 0, 0);
function item(id: string, over: Partial<InboxAssistantReviewItem> = {}): InboxAssistantReviewItem {
  return {
    id, accountId: 'work', accountEmail: 'owner@example.test', threadId: `thread-${id}`, emailId: `mail-${id}`,
    subject: `Subject ${id}`, from: 'sender@example.test', date: NOW / 1000,
    unreadCount: 2, messageCount: 3, unreadEmailIds: [`mail-${id}`, `reply-${id}`],
    recommendation: 'mark_read', reason: `Reason for ${id}`, confidence: 0.96,
    protectedReasons: [], bodyUnavailable: false, attachmentsUnknown: false, status: 'pending',
    categories: [], uncategorized: true, ...over,
  };
}

function review(over: Partial<InboxAssistantReview> = {}): InboxAssistantReview {
  return {
    id: 'review-1', kind: 'unread', createdAt: NOW, expiresAt: NOW + 60_000, status: 'ready',
    accounts: [{ id: 'work', email: 'owner@example.test' }, { id: 'other', email: 'other@example.test' }],
    items: [
      item('safe-a'),
      item('safe-b', { accountId: 'other', accountEmail: 'other@example.test', unreadCount: 1, unreadEmailIds: ['mail-safe-b'], confidence: 0.9 }),
      item('protected', { protectedReasons: ['Starred by you'], categories: ['important'], uncategorized: false }),
      item('body-gap', { bodyUnavailable: true }),
      item('attachment-gap', { attachmentsUnknown: true }),
      item('low-confidence', { confidence: 0.89 }),
      item('keep', { recommendation: 'keep_unread', reason: 'A customer is waiting for a reply.' }),
      item('uncertain', { recommendation: 'needs_review', reason: 'The request is ambiguous.' }),
    ],
    coverage: [{ accountId: 'work', email: 'owner@example.test', status: 'reviewed', reviewedThreads: 8, scannedThreads: 8, truncated: false, hasMore: false, warnings: [] }],
    truncated: false, ...over,
  };
}

function automation(over: Partial<InboxAssistantReviewAutomation> = {}): InboxAssistantReviewAutomation {
  return {
    reviewId: 'review-1', status: 'running', batchesReviewed: 2, reviewedConversations: 12,
    markedConversations: 3, markedEmails: 5, queuedEmails: 2, maxBatches: 10, maxAICalls: 20,
    ...over,
  };
}

function mount(value = review(), extra: Partial<AssistantReviewCardProps> = {}) {
  const props: AssistantReviewCardProps = { review: value, busy: false, onApply: vi.fn(), onUndo: vi.fn(), onOpen: vi.fn(), onRefresh: vi.fn(), ...extra };
  return { view: render(<AssistantReviewCard {...props} />), props };
}
function button(view: ReturnType<typeof render>, label: string) {
  return view.all('button').find(value => value.textContent?.trim() === label) ?? null;
}
function checkbox(view: ReturnType<typeof render>, id: string, email = 'owner@example.test') {
  return view.byLabel(`Select conversation: Subject ${id} (${email})`) as HTMLInputElement;
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('Assistant unread review card', () => {
  it('shows a nonempty retained or uncertain group when no mark-read recommendations exist without selecting its mail', () => {
    const value = review({ items: [item('financial', { recommendation: 'keep_unread', protectedReasons: ['Financial report'], manualSelectionAllowed: true })] });
    const { view, props } = mount(value);
    expect(button(view, 'Keep unread 1')?.getAttribute('aria-pressed')).toBe('true');
    expect(view.byLabel('Reviewed conversations')?.textContent).toContain('Subject financial');
    expect(view.container.textContent).toContain('These conversations stay unread.');
    expect(checkbox(view, 'financial').checked).toBe(false);
    expect(view.container.textContent).toContain('0 conversations selected');
    view.rerender(<AssistantReviewCard {...props} review={review({ id: 'only-uncertain', items: [item('uncertain', { recommendation: 'needs_review', manualSelectionAllowed: true })] })} />);
    expect(button(view, 'Needs review 1')?.getAttribute('aria-pressed')).toBe('true');
    expect(checkbox(view, 'uncertain').checked).toBe(false);
    expect(props.onApply).not.toHaveBeenCalled();
    expect(props.onOpen).not.toHaveBeenCalled();
  });

  it('selects a recommendation group without changing mail and preserves selections when inspecting another group', () => {
    const { view, props } = mount(review({ items: [
      item('recommended', { mailActionsAllowed: true }),
      item('keep-a', { recommendation: 'keep_unread', manualSelectionAllowed: true, mailActionsAllowed: true }),
      item('keep-b', { recommendation: 'keep_unread', manualSelectionAllowed: true, mailActionsAllowed: true }),
      item('uncertain', { recommendation: 'needs_review', manualSelectionAllowed: true, mailActionsAllowed: true }),
    ] }));
    expect(checkbox(view, 'recommended').checked).toBe(true);
    fire(button(view, 'Keep unread 2'), 'click');
    expect(checkbox(view, 'keep-a').checked).toBe(false);
    fire(button(view, 'Select this group'), 'click');
    expect(checkbox(view, 'keep-a').checked).toBe(true);
    expect(checkbox(view, 'keep-b').checked).toBe(true);
    expect(view.container.textContent).toContain('3 conversations selected');
    fire(button(view, 'Needs review 1'), 'click');
    expect(checkbox(view, 'uncertain').checked).toBe(false);
    expect(view.container.textContent).toContain('3 in other groups');
    expect(props.onApply).not.toHaveBeenCalled();
    expect(props.onUndo).not.toHaveBeenCalled();
    fire(button(view, 'Clear selection'), 'click');
    fire(button(view, 'Keep unread 2'), 'click');
    expect(checkbox(view, 'keep-a').checked).toBe(false);
    expect(checkbox(view, 'keep-b').checked).toBe(false);
    fire(button(view, 'Mark read 1'), 'click');
    expect(checkbox(view, 'recommended').checked).toBe(false);
  });

  it.each([
    ['archive', 'Archive selected conversations'],
    ['trash', 'Move selected conversations to Trash'],
  ] as const)('submits only explicitly selected conversation tokens for %s without applying read recommendations', (action, label) => {
    const { view, props } = mount(review({ items: [
      item('recommended', { mailActionsAllowed: true }),
      item('keep', { recommendation: 'keep_unread', manualSelectionAllowed: true, mailActionsAllowed: true }),
      item('not-selected', { recommendation: 'keep_unread', manualSelectionAllowed: true, mailActionsAllowed: true }),
    ] }));
    fire(button(view, 'Clear selection'), 'click');
    fire(button(view, 'Keep unread 2'), 'click');
    toggle(checkbox(view, 'keep'));
    expect(props.onApply).not.toHaveBeenCalled();
    expect(view.byLabel(label)).not.toBeNull();
    fire(view.byLabel(label), 'click');
    expect(props.onApply).toHaveBeenCalledExactlyOnceWith(['keep'], true, action);
    expect(props.onUndo).not.toHaveBeenCalled();
  });

  it('keeps archive and Trash disabled until the current snapshot has an eligible selection', () => {
    const { view, props } = mount(review({ items: [
      item('keep', { recommendation: 'keep_unread', manualSelectionAllowed: true, mailActionsAllowed: true }),
    ] }));
    for (const label of ['Archive selected conversations', 'Move selected conversations to Trash']) {
      expect((view.byLabel(label) as HTMLButtonElement).disabled).toBe(true);
      fire(view.byLabel(label), 'click');
    }
    expect(props.onApply).not.toHaveBeenCalled();
  });

  it('does not treat an older read-only review snapshot as permission to archive or delete mail', () => {
    const { view, props } = mount(review({ items: [item('read-only-snapshot')] }));
    expect(checkbox(view, 'read-only-snapshot').checked).toBe(true);
    expect((button(view, 'Mark selected as read') as HTMLButtonElement).disabled).toBe(false);
    for (const label of ['Archive selected conversations', 'Move selected conversations to Trash']) {
      expect((view.byLabel(label) as HTMLButtonElement).disabled).toBe(true);
      fire(view.byLabel(label), 'click');
    }
    expect(props.onApply).not.toHaveBeenCalled();
  });

  it.each(['applied', 'queued', 'failed'] as const)('allows a manually selected %s read receipt to move while preventing a duplicate mark-read action', status => {
    const { view, props } = mount(review({ items: [
      item('read-receipt', { status, appliedAction: 'mark_read', mailActionsAllowed: true }),
    ] }));
    expect(checkbox(view, 'read-receipt').checked).toBe(false);
    expect(checkbox(view, 'read-receipt').disabled).toBe(false);
    toggle(checkbox(view, 'read-receipt'));
    expect(checkbox(view, 'read-receipt').checked).toBe(true);
    expect((button(view, 'Mark selected as read') as HTMLButtonElement).disabled).toBe(true);
    expect((view.byLabel('Archive selected conversations') as HTMLButtonElement).disabled).toBe(false);
    expect((view.byLabel('Move selected conversations to Trash') as HTMLButtonElement).disabled).toBe(false);
    fire(button(view, 'Mark selected as read'), 'click');
    expect(props.onApply).not.toHaveBeenCalled();
    fire(view.byLabel('Archive selected conversations'), 'click');
    expect(props.onApply).toHaveBeenCalledExactlyOnceWith(['read-receipt'], true, 'archive');
  });

  it('allows explicit moves of a known conversation without inferring permission to mark missing content as read', () => {
    const { view, props } = mount(review({ items: [
      item('content-gap', { recommendation: 'needs_review', manualSelectionAllowed: false, mailActionsAllowed: true, bodyUnavailable: true, attachmentsUnknown: true }),
    ] }));
    fire(button(view, 'Needs review 1'), 'click');
    expect(checkbox(view, 'content-gap').disabled).toBe(false);
    toggle(checkbox(view, 'content-gap'));
    expect((button(view, 'Mark selected as read') as HTMLButtonElement).disabled).toBe(true);
    fire(view.byLabel('Move selected conversations to Trash'), 'click');
    expect(props.onApply).toHaveBeenCalledExactlyOnceWith(['content-gap'], true, 'trash');
  });

  it.each(['busy', 'expired'] as const)('locks group selection and manual move actions when %s', condition => {
    const value = review({ items: [item('recommended', { mailActionsAllowed: true })], ...(condition === 'expired' ? { status: 'expired' as const } : {}) });
    const { view, props } = mount(value, { busy: condition === 'busy' });
    expect((button(view, 'Select this group') as HTMLButtonElement).disabled).toBe(true);
    for (const label of ['Archive selected conversations', 'Move selected conversations to Trash']) {
      expect((view.byLabel(label) as HTMLButtonElement).disabled).toBe(true);
      fire(view.byLabel(label), 'click');
    }
    expect(props.onApply).not.toHaveBeenCalled();
  });

  it('rechecks expiry on Archive and Trash clicks before the expiry timer renders', () => {
    const { view, props } = mount(review({ items: [item('recommended', { mailActionsAllowed: true })] }));
    vi.setSystemTime(NOW + 60_001);
    fire(view.byLabel('Archive selected conversations'), 'click');
    fire(view.byLabel('Move selected conversations to Trash'), 'click');
    expect(props.onApply).not.toHaveBeenCalled();
  });

  it('shows the acknowledged archive and Trash decisions without relabeling an unfinished server sync as completed', () => {
    const { view } = mount(review({ items: [
      item('archived', { status: 'applied', appliedAction: 'archive', mailActionsAllowed: true }),
      item('trashed', { status: 'applied', appliedAction: 'trash', mailActionsAllowed: true }),
      item('queued', { status: 'queued', appliedAction: 'archive', mailActionsAllowed: true }),
    ] }));
    expect(view.container.textContent).toContain('Archived');
    expect(view.container.textContent).toContain('Moved to Trash');
    expect(view.container.textContent).toContain('Queued for sync');
  });

  it('allows explicit selection in Keep unread and Needs review without preselecting either group', () => {
    const { view, props } = mount(review({ items: [
      item('keep', { recommendation: 'keep_unread', manualSelectionAllowed: true, protectedReasons: ['A customer is waiting for a reply.'] }),
      item('uncertain', { recommendation: 'needs_review', manualSelectionAllowed: true }),
      item('incomplete', { recommendation: 'needs_review', manualSelectionAllowed: false, bodyUnavailable: true }),
    ] }));
    expect(view.container.textContent).toContain('0 conversations selected');
    fire(button(view, 'Keep unread 1'), 'click');
    expect(checkbox(view, 'keep').disabled).toBe(false);
    expect(checkbox(view, 'keep').checked).toBe(false);
    toggle(checkbox(view, 'keep'));
    expect(view.container.textContent).toContain('1 selection overrides the agent’s recommendation');
    fire(button(view, 'Mark selected as read'), 'click');
    expect(props.onApply).toHaveBeenCalledExactlyOnceWith(['keep'], true);
    fire(button(view, 'Needs review 2'), 'click');
    expect(checkbox(view, 'uncertain').disabled).toBe(false);
    expect(checkbox(view, 'incomplete').disabled).toBe(true);
    toggle(checkbox(view, 'uncertain'));
    expect(view.container.textContent).toContain('2 conversations selected · 4 unread emails');
    fire(button(view, 'Mark selected as read'), 'click');
    expect(props.onApply).toHaveBeenLastCalledWith(['keep', 'uncertain'], true);
    fire(button(view, 'Clear selection'), 'click');
    expect(view.container.textContent).toContain('0 conversations selected');
  });

  it('requires a fresh manual selection when an automatic selection becomes protected', () => {
    const value = review({ items: [item('changed', { manualSelectionAllowed: true })] });
    const { view, props } = mount(value);
    view.rerender(<AssistantReviewCard {...props} review={{ ...value, items: [item('changed', { manualSelectionAllowed: true, protectedReasons: ['Marked important'] })] }} />);
    expect(checkbox(view, 'changed').checked).toBe(false);
    expect(view.container.textContent).toContain('0 conversations selected');
    toggle(checkbox(view, 'changed'));
    expect(checkbox(view, 'changed').checked).toBe(true);
    fire(button(view, 'Mark selected as read'), 'click');
    expect(props.onApply).toHaveBeenCalledExactlyOnceWith(['changed'], true);
  });

  it('offers exact undo for a manually applied nonrecommended conversation', () => {
    const { view, props } = mount(review({ items: [item('manual', { recommendation: 'keep_unread', manualSelectionAllowed: true, protectedReasons: ['Important'], status: 'applied', undoAvailable: true })] }));
    fire(button(view, 'Keep unread 1'), 'click');
    fire(view.byLabel('Undo marked read: Subject manual (owner@example.test)'), 'click');
    expect(props.onUndo).toHaveBeenCalledExactlyOnceWith(['manual']);
    expect(props.onApply).not.toHaveBeenCalled();
  });

  it('keeps expired manual choices locked and offers refresh beside the footer action', () => {
    const { view, props } = mount(review({ status: 'expired', items: [item('keep', { recommendation: 'keep_unread', manualSelectionAllowed: true })] }));
    fire(button(view, 'Keep unread 1'), 'click');
    expect(checkbox(view, 'keep').disabled).toBe(true);
    toggle(checkbox(view, 'keep'));
    expect(checkbox(view, 'keep').checked).toBe(false);
    const footerRefresh = [...view.byLabel('Review actions')!.querySelectorAll('button')].find(value => value.textContent?.trim() === 'Refresh review')!;
    fire(footerRefresh, 'click');
    expect(props.onRefresh).toHaveBeenCalledExactlyOnceWith();
    expect(props.onApply).not.toHaveBeenCalled();
  });

  it.each(['mark_read', 'mark_unread'] as const)('allows exact sender-matched %s and its undo without irrelevant content-review gates', kind => {
    const targetRead = kind === 'mark_read';
    const value = review({ kind, scope: { query: 'sender@example.test', field: 'sender' }, items: [
      item('matched', { recommendation: kind, targetEmailIds: ['matching-mail'], targetRead, confidence: 1, bodyUnavailable: true, attachmentsUnknown: true }),
      item('changed', { recommendation: kind, targetEmailIds: ['changed-mail'], targetRead, confidence: 1, bodyUnavailable: true, attachmentsUnknown: true, status: 'applied', undoAvailable: true }),
    ] });
    const { view, props } = mount(value);
    expect(checkbox(view, 'matched').checked).toBe(true);
    expect(checkbox(view, 'matched').disabled).toBe(false);
    expect(view.container.textContent).not.toContain('Attachments need review.');
    expect(view.container.textContent).not.toContain('Message content is unavailable.');
    fire(button(view, `Mark selected as ${targetRead ? 'read' : 'unread'}`), 'click');
    expect(props.onApply).toHaveBeenCalledExactlyOnceWith(['matched']);
    const undo = view.byLabel(`Undo marked ${targetRead ? 'read' : 'unread'}: Subject changed (owner@example.test)`) as HTMLButtonElement;
    expect(undo.disabled).toBe(false);
    fire(undo, 'click');
    expect(props.onUndo).toHaveBeenCalledExactlyOnceWith(['changed']);
    view.rerender(<AssistantReviewCard {...props} review={{ ...value, id: 'unscoped', kind: 'unread', scope: undefined, items: value.items.map(entry => ({ ...entry, recommendation: 'mark_read' })) }} />);
    expect(checkbox(view, 'matched').disabled).toBe(true);
    expect(checkbox(view, 'matched').checked).toBe(false);
    expect(view.container.textContent).toContain('Attachments need review.');
    expect(view.container.textContent).toContain('Message content is unavailable.');
    expect(view.byLabel('Undo marked read: Subject changed (owner@example.test)')).toBeNull();
    expect((button(view, 'Mark selected as read') as HTMLButtonElement).disabled).toBe(true);
    expect(props.onUndo).toHaveBeenCalledOnce();
  });

  it('keeps confidence, protection and exact flag direction checks for scoped commands', () => {
    const { view, props } = mount(review({ kind: 'mark_read', scope: { query: 'sender@example.test', field: 'sender' }, items: [
      item('protected', { targetEmailIds: ['one'], targetRead: true, bodyUnavailable: true, attachmentsUnknown: true, protectedReasons: ['Read status changed since review'] }),
      item('uncertain', { targetEmailIds: ['two'], targetRead: true, bodyUnavailable: true, attachmentsUnknown: true, confidence: 0.89 }),
      item('missing-direction', { targetEmailIds: ['three'], bodyUnavailable: true, attachmentsUnknown: true }),
      item('wrong-direction', { targetEmailIds: ['four'], targetRead: false, bodyUnavailable: true, attachmentsUnknown: true }),
    ] }));
    for (const id of ['protected', 'uncertain', 'missing-direction', 'wrong-direction']) {
      expect(checkbox(view, id).disabled).toBe(true);
      expect(checkbox(view, id).checked).toBe(false);
    }
    expect((button(view, 'Mark selected as read') as HTMLButtonElement).disabled).toBe(true);
    fire(button(view, 'Mark selected as read'), 'click');
    expect(props.onApply).not.toHaveBeenCalled();
  });

  it('selects only exact matched targets for marking unread even when the conversation currently has no unread mail', () => {
    const value = review({ kind: 'mark_unread', scope: { query: 'Acme', field: 'subject' }, items: [
      item('target', { recommendation: 'mark_unread', unreadCount: 0, unreadEmailIds: [], messageCount: 8, targetEmailIds: ['matching-one', 'matching-two'], targetRead: false }),
      item('none', { recommendation: 'mark_unread', targetEmailIds: [], targetRead: false }),
      item('protected', { recommendation: 'mark_unread', targetEmailIds: ['protected-mail'], protectedReasons: ['Newer state needs review'] }),
      item('uncertain', { recommendation: 'needs_review' }),
    ] });
    const { view, props } = mount(value);
    expect(view.container.textContent).toContain('Mark matching mail as unread');
    expect(view.container.textContent).toContain('Subject matches: Acme');
    expect(view.container.textContent).toContain('1 conversation selected · 2 emails to mark unread');
    expect(checkbox(view, 'target').checked).toBe(true);
    expect(checkbox(view, 'target').disabled).toBe(false);
    expect(checkbox(view, 'none').disabled).toBe(true);
    expect(checkbox(view, 'protected').disabled).toBe(true);
    fire(button(view, 'Mark selected as unread'), 'click');
    expect(props.onApply).toHaveBeenCalledExactlyOnceWith(['target']);
    expect(props.onUndo).not.toHaveBeenCalled();
  });

  it('shows scoped mark-read counts from exact targets rather than all unread messages in a matching thread', () => {
    const { view, props } = mount(review({ kind: 'mark_read', scope: { query: 'sender@example.test', field: 'sender' },
      items: [item('target', { unreadCount: 6, unreadEmailIds: ['match', 'sibling-a', 'sibling-b', 'sibling-c', 'sibling-d', 'sibling-e'], targetEmailIds: ['match'], targetRead: true })] }));
    expect(view.container.textContent).toContain('1 matching email');
    expect(view.container.textContent).toContain('1 conversation selected · 1 email to mark read');
    expect(view.container.textContent).toContain('6 unread emails');
    fire(button(view, 'Mark selected as read'), 'click');
    expect(props.onApply).toHaveBeenCalledExactlyOnceWith(['target']);
  });

  it('labels undo according to the acknowledged unread mutation without selecting the receipt again', () => {
    const { view, props } = mount(review({ kind: 'mark_unread', items: [item('changed', { recommendation: 'mark_unread', status: 'applied', undoAvailable: true, targetEmailIds: ['matching-mail'], targetRead: false })] }));
    expect(checkbox(view, 'changed').checked).toBe(false);
    fire(view.byLabel('Undo marked unread: Subject changed (owner@example.test)'), 'click');
    expect(props.onUndo).toHaveBeenCalledExactlyOnceWith(['changed']);
    expect((button(view, 'Mark selected as unread') as HTMLButtonElement).disabled).toBe(true);
    expect(props.onApply).not.toHaveBeenCalled();
  });

  it('defaults to safe high-confidence pending recommendations and applies only their item tokens', () => {
    const { view, props } = mount();
    expect(checkbox(view, 'safe-a').checked).toBe(true);
    expect(checkbox(view, 'safe-b', 'other@example.test').checked).toBe(true);
    for (const id of ['protected', 'body-gap', 'attachment-gap', 'low-confidence']) {
      expect(checkbox(view, id).checked).toBe(false);
      expect(checkbox(view, id).disabled).toBe(true);
      toggle(checkbox(view, id));
      expect(checkbox(view, id).checked).toBe(false);
    }
    expect(view.container.textContent).toContain('2 conversations selected · 3 unread emails');
    expect(view.container.textContent).toContain('Starred by you');
    expect(view.container.textContent).toContain('Message content is unavailable.');
    expect(view.container.textContent).toContain('Attachments need review.');
    fire(button(view, 'Mark selected as read'), 'click');
    expect(props.onApply).toHaveBeenCalledExactlyOnceWith(['safe-a', 'safe-b']);
    expect(props.onUndo).not.toHaveBeenCalled();
  });

  it('clears and restores selection without selecting protected items', () => {
    const { view, props } = mount();
    fire(button(view, 'Clear selection'), 'click');
    expect(view.container.textContent).toContain('0 conversations selected · 0 unread emails');
    expect((button(view, 'Mark selected as read') as HTMLButtonElement).disabled).toBe(true);
    fire(button(view, 'Select recommended'), 'click');
    toggle(checkbox(view, 'safe-a'));
    expect(view.container.textContent).toContain('1 conversation selected · 1 unread email');
    fire(button(view, 'Mark selected as read'), 'click');
    expect(props.onApply).toHaveBeenCalledExactlyOnceWith(['safe-b']);
  });

  it('filters recommendations, keeps protected mail visible and keeps counts separate from selection', () => {
    const { view, props } = mount();
    expect(button(view, 'Mark read 6')?.getAttribute('aria-pressed')).toBe('true');
    expect(view.container.textContent).toContain('Uncategorized');
    expect(view.container.textContent).toContain('important');
    fire(button(view, 'Keep unread 1'), 'click');
    expect(view.byLabel('Reviewed conversations')?.textContent).toContain('A customer is waiting for a reply.');
    expect(checkbox(view, 'keep').disabled).toBe(true);
    expect(checkbox(view, 'safe-a')).toBeNull();
    fire(button(view, 'Needs review 1'), 'click');
    expect(view.byLabel('Reviewed conversations')?.textContent).toContain('The request is ambiguous.');
    expect(checkbox(view, 'uncertain').disabled).toBe(true);
    expect(view.container.textContent).toContain('2 conversations selected · 3 unread emails');
    expect(props.onApply).not.toHaveBeenCalled();
  });

  it('opens the exact account and source without selecting or mutating read state', () => {
    const { view, props } = mount();
    fire(view.byLabel('Open conversation: Subject safe-b (other@example.test)'), 'click');
    expect(props.onOpen).toHaveBeenCalledExactlyOnceWith({
      id: 'safe-b', kind: 'message', accountId: 'other', accountEmail: 'other@example.test',
      emailId: 'mail-safe-b', threadId: 'thread-safe-b', subject: 'Subject safe-b', from: 'sender@example.test',
      to: [], date: NOW / 1000, folder: '', sent: false, excerpt: 'Reason for safe-b',
    });
    expect(checkbox(view, 'safe-b', 'other@example.test').checked).toBe(true);
    expect(props.onApply).not.toHaveBeenCalled();
    expect(props.onUndo).not.toHaveBeenCalled();
    expect(view.container.textContent).toContain('2026');
    expect(view.container.textContent).not.toContain('1970');
  });

  it('lets users inspect a protected conversation’s details without selecting it or changing mail', () => {
    const { view, props } = mount(review({ items: [
      item('safe'),
      item('financial', { protectedReasons: ['Financial reports require your review.'], categories: ['finance'], uncategorized: false }),
    ] }));
    const summary = view.byLabel('Review details: Subject financial (owner@example.test)');
    const details = summary?.closest('details') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    act(() => summary?.focus());
    fire(summary, 'click');
    expect(details.open).toBe(true);
    expect(details.textContent).toContain('Financial reports require your review.');
    expect(details.textContent).toContain('96% confidence');
    expect(checkbox(view, 'financial').checked).toBe(false);
    expect(checkbox(view, 'financial').disabled).toBe(true);
    expect(checkbox(view, 'safe').checked).toBe(true);
    expect(props.onApply).not.toHaveBeenCalled();
    expect(props.onOpen).not.toHaveBeenCalled();
  });

  it.each([2, 3])('summarizes %s duplicated protection reasons while keeping every reason in Details and distinct recommendations intact', total => {
    const reasons = ['Financial report requires your review.', 'Your team is part of this conversation.', 'Attachments need review.'].slice(0, total);
    const distinctReason = 'The latest message asks you to approve a revised business report.';
    const { view, props } = mount(review({ items: [
      item('duplicated', { protectedReasons: reasons, reason: reasons.join(' ') }),
      item('distinct', { protectedReasons: reasons, reason: distinctReason }),
    ] }));
    const row = view.byLabel('Open conversation: Subject duplicated (owner@example.test)')?.closest('li');
    const visibleReason = [...row!.querySelectorAll('p')].find(paragraph => !paragraph.closest('details') && paragraph.textContent.includes(reasons[0]!));
    expect(visibleReason?.textContent).toBe(`${reasons[0]} ${total - 1} more ${total === 2 ? 'reason' : 'reasons'} in Details`);
    const details = view.byLabel('Review details: Subject duplicated (owner@example.test)')?.closest('details');
    for (const reason of reasons) expect(details?.textContent).toContain(reason);
    const distinctRow = view.byLabel('Open conversation: Subject distinct (owner@example.test)')?.closest('li');
    expect([...distinctRow!.querySelectorAll('p')].some(paragraph => !paragraph.closest('details') && paragraph.textContent === distinctReason)).toBe(true);
    expect(props.onApply).not.toHaveBeenCalled();
  });

  it('labels a rule-protected decision separately from actual model confidence', () => {
    const { view } = mount(review({ items: [
      item('rules', { recommendation: 'keep_unread', protectedReasons: ['Financial report'], confidence: 0 }),
      item('model', { recommendation: 'keep_unread', confidence: 0.94 }),
    ] }));
    const protectedDetails = view.byLabel('Review details: Subject rules (owner@example.test)')?.closest('details');
    expect(protectedDetails?.textContent).toContain('Protected by review rules');
    expect(protectedDetails?.textContent).not.toContain('0% confidence');
    expect(view.byLabel('Review details: Subject model (owner@example.test)')?.closest('details')?.textContent).toContain('94% confidence');
  });

  it('shows receipts and offers undo only when the backend retained an undo snapshot, including partial failures', () => {
    const value = review({ items: [
      item('applied', { status: 'applied', undoAvailable: true }), item('queued', { status: 'queued', undoAvailable: true }),
      item('partial-failure', { status: 'failed', undoAvailable: true, reason: 'One message changed; another could not be marked read.' }),
      item('failed', { status: 'failed' }), item('skipped', { status: 'skipped' }), item('undone', { status: 'undone' }),
      item('without-snapshot', { status: 'applied' }),
      item('protected-applied', { status: 'applied', undoAvailable: true, protectedReasons: ['Manual important flag'] }),
    ] });
    const { view, props } = mount(value);
    for (const text of ['Applied', 'Queued for sync', 'Failed', 'Skipped', 'Undone']) expect(view.container.textContent).toContain(text);
    expect(view.byLabel('Undo marked read: Subject protected-applied (owner@example.test)')).toBeNull();
    expect(view.byLabel('Undo marked read: Subject failed (owner@example.test)')).toBeNull();
    expect(view.byLabel('Undo marked read: Subject without-snapshot (owner@example.test)')).toBeNull();
    expect((button(view, 'Mark selected as read') as HTMLButtonElement).disabled).toBe(true);
    fire(view.byLabel('Undo marked read: Subject applied (owner@example.test)'), 'click');
    expect(props.onUndo).toHaveBeenCalledExactlyOnceWith(['applied']);
    fire(view.byLabel('Undo marked read: Subject partial-failure (owner@example.test)'), 'click');
    expect(props.onUndo).toHaveBeenLastCalledWith(['partial-failure']);
    fire(button(view, 'Undo 3 conversations'), 'click');
    expect(props.onUndo).toHaveBeenLastCalledWith(['applied', 'queued', 'partial-failure']);
    expect(props.onApply).not.toHaveBeenCalled();
  });

  it('disables changes when the review expires while keeping refresh and source inspection available', () => {
    const value = review({ expiresAt: NOW + 500, items: [item('safe-a'), item('applied', { status: 'applied', undoAvailable: true })] });
    const { view, props } = mount(value);
    act(() => { vi.advanceTimersByTime(500); });
    expect(view.container.textContent).toContain('This review has expired.');
    expect(checkbox(view, 'safe-a').disabled).toBe(true);
    expect((button(view, 'Mark selected as read') as HTMLButtonElement).disabled).toBe(true);
    const undo = view.byLabel('Undo marked read: Subject applied (owner@example.test)') as HTMLButtonElement;
    expect(undo.disabled).toBe(true);
    fire(button(view, 'Mark selected as read'), 'click');
    fire(undo, 'click');
    expect(props.onApply).not.toHaveBeenCalled();
    expect(props.onUndo).not.toHaveBeenCalled();
    fire(button(view, 'Refresh review'), 'click');
    expect(props.onRefresh).toHaveBeenCalledExactlyOnceWith();
    fire(view.byLabel('Open conversation: Subject safe-a (owner@example.test)'), 'click');
    expect(props.onOpen).toHaveBeenCalledOnce();
  });

  it('reschedules an expiry timer that fires just before the trusted deadline', () => {
    const { view } = mount(review({ expiresAt: NOW + 500 }));
    vi.setSystemTime(NOW - 1);
    act(() => { vi.advanceTimersByTime(500); });
    expect(view.container.textContent).not.toContain('This review has expired.');
    expect((button(view, 'Mark selected as read') as HTMLButtonElement).disabled).toBe(false);
    act(() => { vi.advanceTimersByTime(1); });
    expect(view.container.textContent).toContain('This review has expired.');
    expect((button(view, 'Mark selected as read') as HTMLButtonElement).disabled).toBe(true);
  });

  it.each(['focus', 'visibilitychange'] as const)('refreshes expired action state after a clock jump on %s', event => {
    const { view, props } = mount(review({ expiresAt: NOW + 500 }));
    vi.setSystemTime(NOW + 501);
    act(() => { (event === 'focus' ? window : document).dispatchEvent(new Event(event)); });
    const actions = view.byLabel('Review actions')!;
    expect(actions.textContent).toContain('This review has expired.');
    expect((button(view, 'Mark selected as read') as HTMLButtonElement).disabled).toBe(true);
    expect([...actions.querySelectorAll('button')].some(value => value.textContent === 'Refresh review' && !value.disabled)).toBe(true);
    expect(props.onApply).not.toHaveBeenCalled();
  });

  it('locks mutations while busy and uses fresh default tokens when a new review replaces it', () => {
    const { view, props } = mount(review(), { busy: true });
    expect(checkbox(view, 'safe-a').disabled).toBe(true);
    expect((button(view, 'Refresh review') as HTMLButtonElement).disabled).toBe(true);
    fire(button(view, 'Mark selected as read'), 'click');
    expect(props.onApply).not.toHaveBeenCalled();
    fire(button(view, 'Keep unread 1'), 'click');
    view.rerender(<AssistantReviewCard {...props} busy={false} review={review({ id: 'review-2', items: [item('fresh')] })} />);
    expect(checkbox(view, 'fresh').checked).toBe(true);
    fire(button(view, 'Mark selected as read'), 'click');
    expect(props.onApply).toHaveBeenCalledExactlyOnceWith(['fresh']);
  });

  it('checks expiry again on click even before an overdue timer has rendered', () => {
    const { view, props } = mount(review({ items: [item('safe-a'), item('applied', { status: 'applied', undoAvailable: true })] }));
    vi.setSystemTime(NOW + 60_001);
    fire(button(view, 'Mark selected as read'), 'click');
    fire(view.byLabel('Undo marked read: Subject applied (owner@example.test)'), 'click');
    expect(props.onApply).not.toHaveBeenCalled();
    expect(props.onUndo).not.toHaveBeenCalled();
  });

  it('offers the next review batch separately from mail changes and disables continuation when busy or expired', () => {
    const value = review({ coverage: [{ accountId: 'work', email: 'owner@example.test', status: 'reviewed', reviewedThreads: 8, scannedThreads: 9, truncated: true, hasMore: true, warnings: [] }] });
    const onContinue = vi.fn();
    const { view, props } = mount(value, { onContinue });
    fire(button(view, 'Review next batch'), 'click');
    expect(onContinue).toHaveBeenCalledExactlyOnceWith();
    expect(props.onApply).not.toHaveBeenCalled();
    expect(props.onUndo).not.toHaveBeenCalled();
    expect(props.onRefresh).not.toHaveBeenCalled();
    view.rerender(<AssistantReviewCard {...props} busy />);
    expect((button(view, 'Review next batch') as HTMLButtonElement).disabled).toBe(true);
    fire(button(view, 'Review next batch'), 'click');
    view.rerender(<AssistantReviewCard {...props} review={{ ...value, status: 'expired' }} />);
    expect((button(view, 'Review next batch') as HTMLButtonElement).disabled).toBe(true);
    fire(button(view, 'Review next batch'), 'click');
    expect(onContinue).toHaveBeenCalledOnce();
  });

  it('clears applied or newly protected items from an existing selection after a receipt update', () => {
    const value = review({ items: [item('safe-a'), item('safe-b')] });
    const { view, props } = mount(value);
    view.rerender(<AssistantReviewCard {...props} review={{ ...value, items: [item('safe-a', { status: 'applied' }), item('safe-b', { protectedReasons: ['New important flag'] })] }} />);
    expect(view.container.textContent).toContain('0 conversations selected · 0 unread emails');
    expect((button(view, 'Mark selected as read') as HTMLButtonElement).disabled).toBe(true);
    fire(button(view, 'Mark selected as read'), 'click');
    expect(props.onApply).not.toHaveBeenCalled();
  });

  it('renders source text as text and reports real partial coverage', () => {
    const { view } = mount(review({ kind: 'uncategorized', truncated: true, items: [item('text', { subject: '<img src=x onerror=alert(1)>', reason: '<script>sendMail()</script>' })],
      coverage: [{ accountId: 'other', email: 'other@example.test', status: 'unavailable', reviewedThreads: 0, scannedThreads: 0, truncated: true, hasMore: true, warnings: ['Some message bodies could not be loaded.'] }],
    }));
    expect(view.container.textContent).toContain('Uncategorized mail review');
    expect(view.container.textContent).toContain('<script>sendMail()</script>');
    expect(view.container.querySelector('script')).toBeNull();
    expect(view.container.querySelector('img')).toBeNull();
    expect(view.container.textContent).toContain('Account unavailable; its mail was not reviewed.');
    expect(view.container.textContent).toContain('Some message bodies could not be loaded.');
  });
});

describe('Explicit automatic review', () => {
  it.each(['ready', 'expired', 'nothing-left'] as const)('puts %s continuation guidance in a hover tooltip and accessible description without expanding the label', state => {
    const onStartAutoReview = vi.fn();
    const value = review({
      ...(state === 'expired' ? { expiresAt: NOW - 1 } : {}),
      ...(state === 'nothing-left' ? { items: [item('keep', { recommendation: 'keep_unread' })] } : {}),
    });
    const { view, props } = mount(value, { onStartAutoReview });
    const preference = view.byLabel('Continue automatically') as HTMLInputElement;
    const label = preference.closest('label')!;
    const description = document.getElementById(preference.getAttribute('aria-describedby')!);
    const help = state === 'expired' ? 'Refresh this expired review before starting.'
      : state === 'nothing-left' ? 'No recommendations or remaining batches. Refresh to check for new mail.'
        : 'Mark all recommended mail as read, then review the next batches. Important and uncertain mail stays unread.';
    expect(label.title).toBe(help);
    expect(description?.textContent).toBe(help);
    expect(description?.classList.contains('sr-only')).toBe(true);
    expect(label.querySelector('p')).toBeNull();
    toggle(preference);
    expect(preference.checked).toBe(true);
    expect(label.title).toBe(help);
    expect(label.querySelector('p')).toBeNull();
    expect([...label.querySelectorAll('span')].filter(span => !span.classList.contains('sr-only')).map(span => span.textContent)).toEqual(['Continue automatically']);
    expect(onStartAutoReview).not.toHaveBeenCalled();
    expect(props.onApply).not.toHaveBeenCalled();
  });

  it.each(['already-expired', 'clock-jumped'] as const)('allows an idle continuation preference when %s while keeping expired mail changes locked', condition => {
    const onStartAutoReview = vi.fn();
    const value = review({ expiresAt: condition === 'already-expired' ? NOW - 1 : NOW + 500 });
    const { view, props } = mount(value, { onStartAutoReview });
    if (condition === 'clock-jumped') vi.setSystemTime(NOW + 501);
    const preference = view.byLabel('Continue automatically') as HTMLInputElement;
    expect(preference.disabled).toBe(false);
    toggle(preference);
    expect(preference.checked).toBe(true);
    expect(view.byLabel('Review actions')?.textContent).toContain('This review has expired.');
    expect((button(view, 'Mark recommended & continue') as HTMLButtonElement).disabled).toBe(true);
    view.rerender(<AssistantReviewCard {...props} review={{ ...value }} />);
    expect(preference.checked).toBe(true);
    fire(button(view, 'Mark recommended & continue'), 'click');
    expect(onStartAutoReview).not.toHaveBeenCalled();
    expect(props.onApply).not.toHaveBeenCalled();
    toggle(preference);
    expect(preference.checked).toBe(false);
  });

  it('can explicitly start continuous review for incomplete classifications without eligible mail or another page', () => {
    const onStartAutoReview = vi.fn();
    const { view, props } = mount(review({ items: [item('retry', { recommendation: 'needs_review', needsRetry: true })] }), { onStartAutoReview });
    expect(view.container.textContent).toContain('0 conversations selected');
    toggle(view.byLabel('Continue automatically'));
    expect((button(view, 'Mark recommended & continue') as HTMLButtonElement).disabled).toBe(false);
    expect(onStartAutoReview).not.toHaveBeenCalled();
    fire(button(view, 'Mark recommended & continue'), 'click');
    expect(onStartAutoReview).toHaveBeenCalledExactlyOnceWith();
    expect(props.onApply).not.toHaveBeenCalled();
  });

  it('keeps a custom manual selection separate from continuous recommended-only processing', () => {
    const onStartAutoReview = vi.fn();
    const { view, props } = mount(review({ items: [item('safe'), item('keep', { recommendation: 'keep_unread', manualSelectionAllowed: true })] }), { onStartAutoReview });
    const continuous = view.byLabel('Continue automatically') as HTMLInputElement;
    expect(continuous.checked).toBe(false);
    toggle(continuous);
    expect(button(view, 'Review next batch')).toBeNull();
    expect(button(view, 'Mark selected as read')).toBeNull();
    fire(button(view, 'Keep unread 1'), 'click');
    toggle(checkbox(view, 'keep'));
    expect(continuous.checked).toBe(false);
    expect(button(view, 'Mark recommended & continue')).toBeNull();
    fire(button(view, 'Mark selected as read'), 'click');
    expect(props.onApply).toHaveBeenCalledExactlyOnceWith(['safe', 'keep'], true);
    expect(onStartAutoReview).not.toHaveBeenCalled();
  });

  it('paginates long reviews without discarding selections or mixing page changes with AI requests', () => {
    const { view, props } = mount(review({ items: Array.from({ length: 45 }, (_, index) => item(`row-${index}`)) }));
    expect(view.all('input[aria-label^="Select conversation:"]')).toHaveLength(20);
    toggle(checkbox(view, 'row-0'));
    fire(view.byLabel('Next reviewed conversations'), 'click');
    expect(checkbox(view, 'row-20').checked).toBe(true);
    toggle(checkbox(view, 'row-20'));
    fire(view.byLabel('Previous reviewed conversations'), 'click');
    expect(checkbox(view, 'row-0').checked).toBe(false);
    fire(button(view, 'Mark selected as read'), 'click');
    const ids = (props.onApply as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string[];
    expect(ids).toHaveLength(43);
    expect(ids).not.toContain('row-0');
    expect(ids).not.toContain('row-20');
    expect(props.onRefresh).not.toHaveBeenCalled();
  });

  it('provides keyboard access to the reviewed list and starts each page or group at the top without clearing selection', () => {
    const { view, props } = mount(review({ items: [
      ...Array.from({ length: 25 }, (_, index) => item(`row-${index}`)),
      item('keep', { recommendation: 'keep_unread' }),
    ] }));
    const list = view.byLabel('Reviewed conversations')!;
    expect(list.getAttribute('role')).toBe('region');
    act(() => list.focus());
    expect(document.activeElement).toBe(list);
    toggle(checkbox(view, 'row-0'));
    list.scrollTop = 250;
    fire(view.byLabel('Next reviewed conversations'), 'click');
    expect(list.scrollTop).toBe(0);
    expect(checkbox(view, 'row-20').checked).toBe(true);
    list.scrollTop = 150;
    fire(button(view, 'Keep unread 1'), 'click');
    expect(list.scrollTop).toBe(0);
    fire(button(view, 'Mark read 25'), 'click');
    expect(checkbox(view, 'row-0').checked).toBe(false);
    expect(view.container.textContent).toContain('24 conversations selected');
    expect(props.onApply).not.toHaveBeenCalled();
    expect(props.onRefresh).not.toHaveBeenCalled();
  });

  it('retries incomplete AI classifications with the continuation checkpoint and leaves mail unchanged', () => {
    const onContinue = vi.fn();
    const { view, props } = mount(review({ items: [item('retry', { recommendation: 'needs_review', needsRetry: true })] }), { onContinue });
    expect(view.container.textContent).toContain('1 conversation still needs classification');
    fire(button(view, 'Retry incomplete review'), 'click');
    expect(onContinue).toHaveBeenCalledExactlyOnceWith();
    expect(props.onApply).not.toHaveBeenCalled();
    expect(props.onRefresh).not.toHaveBeenCalled();
  });

  it('keeps the optional control absent for existing callers', () => {
    const { view } = mount();
    expect(view.byLabel('Automatic unread review')).toBeNull();
    expect(button(view, 'Mark recommended & continue')).toBeNull();
  });

  it.each(['unread', 'uncategorized'] as const)('starts %s automation only on click without sending selected or overridden item IDs', kind => {
    const onStartAutoReview = vi.fn();
    const { view, props } = mount(review({ kind, items: [
      item('safe'), item('manual', { recommendation: 'keep_unread', manualSelectionAllowed: true, mailActionsAllowed: true }),
    ] }), { onStartAutoReview });
    expect(onStartAutoReview).not.toHaveBeenCalled();
    expect(view.container.textContent).toContain('Only recommended mail is marked as read. Important and uncertain mail stays unread. Nothing is archived or deleted.');
    expect(view.container.textContent).toContain('Up to 10 batches and 20 AI classification calls per run.');
    fire(button(view, 'Keep unread 1'), 'click');
    toggle(checkbox(view, 'manual'));
    expect(view.container.textContent).toContain('2 conversations selected');
    expect(button(view, 'Mark recommended & continue')).toBeNull();
    toggle(view.byLabel('Continue automatically') as HTMLInputElement);
    expect(view.container.textContent).toContain('1 conversation selected');
    fire(button(view, 'Mark recommended & continue'), 'click');
    expect(onStartAutoReview).toHaveBeenCalledExactlyOnceWith();
    expect(props.onApply).not.toHaveBeenCalled();
    expect(props.onUndo).not.toHaveBeenCalled();
    expect(props.onContinue).toBeUndefined();
  });

  it.each(['mark_read', 'mark_unread'] as const)('does not offer automatic recommendation processing for scoped %s commands', kind => {
    const { view } = mount(review({ kind }), { onStartAutoReview: vi.fn() });
    expect(view.byLabel('Automatic unread review')).toBeNull();
    expect(button(view, 'Mark recommended & continue')).toBeNull();
  });

  it('can advance beyond a batch containing only kept and uncertain conversations', () => {
    const onStartAutoReview = vi.fn();
    const value = review({ items: [item('keep', { recommendation: 'keep_unread' }), item('uncertain', { recommendation: 'needs_review' })] });
    const { view, props } = mount(value, { onStartAutoReview });
    const preference = view.byLabel('Continue automatically') as HTMLInputElement;
    expect(preference.disabled).toBe(false);
    expect(preference.checked).toBe(false);
    toggle(preference);
    expect((button(view, 'Mark recommended & continue') as HTMLButtonElement).disabled).toBe(true);
    expect(view.container.textContent).toContain('No recommendations or remaining batches. Refresh to check for new mail.');
    expect(onStartAutoReview).not.toHaveBeenCalled();
    view.rerender(<AssistantReviewCard {...props} review={{ ...value, coverage: [{ ...value.coverage[0]!, hasMore: true }] }} />);
    expect(preference.checked).toBe(true);
    expect((button(view, 'Mark recommended & continue') as HTMLButtonElement).disabled).toBe(false);
    fire(button(view, 'Mark recommended & continue'), 'click');
    expect(onStartAutoReview).toHaveBeenCalledExactlyOnceWith();
    expect(props.onApply).not.toHaveBeenCalled();
  });

  it.each(['busy', 'expired', 'protected'] as const)('does not start when the current batch is %s', condition => {
    const onStartAutoReview = vi.fn();
    const value = review({ ...(condition === 'expired' ? { expiresAt: NOW - 1 } : {}),
      ...(condition === 'protected' ? { items: [item('protected', { protectedReasons: ['Starred by you'], manualSelectionAllowed: true, mailActionsAllowed: true })] } : {}) });
    const { view } = mount(value, { onStartAutoReview, busy: condition === 'busy' });
    const preference = view.byLabel('Continue automatically') as HTMLInputElement;
    expect(preference.disabled).toBe(condition === 'busy');
    if (condition !== 'busy') {
      toggle(preference);
      expect(preference.checked).toBe(true);
      expect((button(view, 'Mark recommended & continue') as HTMLButtonElement).disabled).toBe(true);
      fire(button(view, 'Mark recommended & continue'), 'click');
    } else expect(button(view, 'Mark recommended & continue')).toBeNull();
    expect(onStartAutoReview).not.toHaveBeenCalled();
  });

  it('rechecks expiry before starting even if the expiry timer has not rendered', () => {
    const onStartAutoReview = vi.fn();
    const { view } = mount(review(), { onStartAutoReview });
    toggle(view.byLabel('Continue automatically') as HTMLInputElement);
    vi.setSystemTime(NOW + 60_001);
    fire(button(view, 'Mark recommended & continue'), 'click');
    expect(onStartAutoReview).not.toHaveBeenCalled();
  });

  it('shows live progress instead of an older saved receipt and keeps queued emails separate from confirmed changes', () => {
    const value = review({ automation: automation({ status: 'completed', batchesReviewed: 9, markedEmails: 30 }) });
    const { view } = mount(value, { automation: automation() });
    expect(view.container.textContent).toContain('Automatic review running');
    expect(view.container.textContent).toContain('2 batches reviewed · 12 conversations reviewed');
    expect(view.container.textContent).toContain('3 conversations marked as read · 5 emails marked as read');
    expect(view.container.textContent).toContain('2 emails queued for sync; server changes are not confirmed yet.');
    expect(view.byLabel('Automatic unread review')?.textContent).toContain('5 emails marked as read · 2 emails queued for sync');
    expect(view.container.textContent).not.toContain('30 emails marked as read');
    expect(view.container.textContent).not.toContain('9 batches reviewed');
    expect(view.container.querySelector('[role="progressbar"]')).toBeNull(); // The mailbox total is not known.
  });

  it.each([false, true])('avoids a duplicate Stop and locks manual changes while running, with busy=%s', busy => {
    const { view, props } = mount(review({ expiresAt: NOW - 1, automation: automation() }), { busy, onStartAutoReview: vi.fn(), onContinue: vi.fn() });
    expect(view.byLabel('Stop automatic review')).toBeNull();
    expect(button(view, 'Stop')).toBeNull();
    expect(button(view, 'Mark recommended & continue')).toBeNull();
    expect(button(view, 'Mark selected as read')).toBeNull();
    expect(view.byLabel('Archive selected conversations')).toBeNull();
    expect(view.byLabel('Move selected conversations to Trash')).toBeNull();
    fire(button(view, 'Refresh review'), 'click');
    expect(props.onApply).not.toHaveBeenCalled();
    expect(props.onRefresh).not.toHaveBeenCalled();
    expect(props.onContinue).not.toHaveBeenCalled();
  });

  it('locks a fresh review against competing manual actions during automation even if busy was not set', () => {
    const { view, props } = mount(review({ automation: automation(), items: [item('safe', { mailActionsAllowed: true })] }), { onContinue: vi.fn() });
    expect(checkbox(view, 'safe').disabled).toBe(true);
    expect((button(view, 'Refresh review') as HTMLButtonElement).disabled).toBe(true);
    expect(button(view, 'Mark selected as read')).toBeNull();
    expect(view.byLabel('Archive selected conversations')).toBeNull();
    expect(view.byLabel('Move selected conversations to Trash')).toBeNull();
    fire(button(view, 'Refresh review'), 'click');
    expect(props.onApply).not.toHaveBeenCalled();
    expect(props.onRefresh).not.toHaveBeenCalled();
  });

  it('keeps a restored running snapshot free of a duplicate Stop', () => {
    const { view } = mount(review({ automation: automation() }));
    expect(view.byLabel('Stop automatic review')).toBeNull();
    expect(button(view, 'Stop')).toBeNull();
  });

  it.each(['completed', 'stopped', 'failed'] as const)('restores a %s receipt without restarting automation', status => {
    const onStartAutoReview = vi.fn();
    const value = review({ automation: automation({ status, reason: '<script>private()</script>', queuedEmails: 0 }) });
    const { view, props } = mount(value, { onStartAutoReview });
    expect(view.container.textContent).toContain(status === 'completed' ? 'Automatic review complete' : `Automatic review ${status}`);
    expect(view.container.textContent).toContain('<script>private()</script>');
    expect(view.container.querySelector('script')).toBeNull();
    expect(view.byLabel('Stop automatic review')).toBeNull();
    expect(view.container.textContent).not.toContain('queued for sync; server changes');
    view.rerender(<AssistantReviewCard {...props} />);
    expect(onStartAutoReview).not.toHaveBeenCalled();
    expect(props.onApply).not.toHaveBeenCalled();
  });

  it.each(['stopped', 'failed'] as const)('explicitly resumes a %s run through the same callback without selected IDs', status => {
    const onStartAutoReview = vi.fn();
    const { view, props } = mount(review({ automation: automation({ status }) }), { onStartAutoReview });
    expect(button(view, 'Mark recommended & continue')).toBeNull();
    const resume = button(view, 'Resume automatic review') as HTMLButtonElement;
    expect(resume.disabled).toBe(false);
    expect(onStartAutoReview).not.toHaveBeenCalled();
    fire(resume, 'click');
    expect(onStartAutoReview).toHaveBeenCalledExactlyOnceWith();
    expect(props.onApply).not.toHaveBeenCalled();
  });

  it.each(['stopped', 'failed'] as const)('allows the host to resume a %s checkpoint with retryable mail after the anchor’s recommendations were applied', status => {
    const onStartAutoReview = vi.fn();
    const value = review({
      automation: automation({ status }),
      items: [
        item('applied', { status: 'applied', appliedAction: 'mark_read' }),
        item('retry', { recommendation: 'needs_review', needsRetry: true, manualSelectionAllowed: false }),
        item('write-retry', { status: 'failed', appliedAction: 'mark_read' }),
      ],
    });
    const { view, props } = mount(value, { onStartAutoReview });
    const resume = button(view, 'Resume automatic review') as HTMLButtonElement;
    expect(view.container.textContent).toContain('0 conversations selected');
    expect(value.coverage.some(account => account.hasMore)).toBe(false);
    expect(resume.disabled).toBe(false);
    expect(onStartAutoReview).not.toHaveBeenCalled();
    fire(resume, 'click');
    expect(onStartAutoReview).toHaveBeenCalledExactlyOnceWith();
    expect(props.onApply).not.toHaveBeenCalled();
    expect(props.onUndo).not.toHaveBeenCalled();
  });

  it('offers a fresh review rather than restarting a completed sweep even if its old snapshot has pending items', () => {
    const onStartAutoReview = vi.fn();
    const { view, props } = mount(review({ automation: automation({ status: 'completed' }) }), { onStartAutoReview });
    expect(button(view, 'Mark recommended & continue')).toBeNull();
    expect(button(view, 'Resume automatic review')).toBeNull();
    expect(view.container.textContent).toContain('Refresh review to check for newly arrived mail.');
    fire(button(view, 'Refresh review'), 'click');
    expect(props.onRefresh).toHaveBeenCalledExactlyOnceWith();
    expect(onStartAutoReview).not.toHaveBeenCalled();
    expect(props.onApply).not.toHaveBeenCalled();
  });

  it('uses the live terminal status for resume and completion controls instead of the saved status', () => {
    const onStartAutoReview = vi.fn();
    const value = review({ automation: automation({ status: 'completed' }) });
    const { view, props } = mount(value, { automation: automation({ status: 'stopped' }), onStartAutoReview });
    expect((button(view, 'Resume automatic review') as HTMLButtonElement).disabled).toBe(false);
    view.rerender(<AssistantReviewCard {...props} automation={automation({ status: 'completed' })} />);
    expect(button(view, 'Resume automatic review')).toBeNull();
    expect(button(view, 'Mark recommended & continue')).toBeNull();
    expect(onStartAutoReview).not.toHaveBeenCalled();
  });

  it('shows measured cache reuse and fresh AI review counts, including actual zero', () => {
    const value = review({ coverage: [{ accountId: 'work', email: 'owner@example.test', status: 'reviewed', reviewedThreads: 8, scannedThreads: 8, truncated: false, hasMore: false, warnings: [], cachedRecommendations: 6, aiReviewedThreads: 2 }] });
    const { view, props } = mount(value);
    expect(view.container.textContent).toContain('6 cached recommendations · 2 conversations newly reviewed by AI');
    view.rerender(<AssistantReviewCard {...props} review={{ ...value, coverage: [{ ...value.coverage[0]!, cachedRecommendations: 0, aiReviewedThreads: 0 }] }} />);
    expect(view.container.textContent).toContain('0 cached recommendations · 0 conversations newly reviewed by AI');
    view.rerender(<AssistantReviewCard {...props} review={review()} />);
    expect(view.container.textContent).not.toContain('cached recommendations');
    expect(view.container.textContent).not.toContain('newly reviewed by AI');
  });
});
