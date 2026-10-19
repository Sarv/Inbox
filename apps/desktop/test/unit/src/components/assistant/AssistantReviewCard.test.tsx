// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AssistantReviewCard, type AssistantReviewCardProps } from '../../../../../src/components/assistant/AssistantReviewCard';
import type { InboxAssistantReview, InboxAssistantReviewItem } from '../../../../../src/types/inbox-assistant-actions';
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
