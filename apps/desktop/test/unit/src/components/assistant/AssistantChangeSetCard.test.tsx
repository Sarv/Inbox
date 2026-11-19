// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AssistantChangeSetCard, type AssistantChangeSetCardProps } from '../../../../../src/components/assistant/AssistantChangeSetCard';
import type { InboxAgentChangeItem, InboxAgentChangeSet } from '../../../../../src/types/inbox-assistant-changes';
import { act, cleanup, fire, render, toggle } from '../../../../helpers/render';

// The card is where the user approves what the Inbox Agent prepared. A
// regression here is a protected email ticked by default, an Approve that sends
// rows the user unticked, or a button on a card the host can no longer act on.

const NOW = Date.UTC(2026, 10, 19, 10, 0, 0);

function item(id: string, over: Partial<InboxAgentChangeItem> = {}): InboxAgentChangeItem {
  return {
    id, accountId: 'work', accountEmail: 'owner@example.test', emailId: `mail-${id}`, threadId: `thread-${id}`,
    subject: `Subject ${id}`, from: 'Shop <shop@example.test>', date: NOW / 1000, status: 'pending', ...over,
  };
}

function set(over: Partial<InboxAgentChangeSet> = {}): InboxAgentChangeSet {
  return {
    id: 'set-1', label: 'C1', action: 'mark_read', summary: 'Mark 3 emails read', createdAt: NOW,
    approveBy: NOW + 60_000, undoBy: 0, status: 'pending',
    items: [item('c1-1', { reason: 'A promotion' }), item('c1-2'), item('c1-3', { protectedReason: 'Starred' })],
    ...over,
  };
}

function mount(value = set(), extra: Partial<AssistantChangeSetCardProps> = {}) {
  const props: AssistantChangeSetCardProps = { changeSet: value, busy: false, onDecision: vi.fn(), onOpen: vi.fn(), ...extra };
  return { view: render(<AssistantChangeSetCard {...props} />), props };
}
const button = (view: ReturnType<typeof render>, label: string) => view.all('button').find(value => value.textContent?.trim() === label) ?? null;
const box = (view: ReturnType<typeof render>, id: string) => view.byLabel(`Include: Subject ${id} (owner@example.test)`) as HTMLInputElement;

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('Inbox Agent change set card', () => {
  // Breaks: a protected email is changed because the card ticked it by default.
  it('ticks unprotected rows, leaves protected ones unticked with their reason, and says nothing changed yet', () => {
    const { view } = mount();
    expect(view.container.textContent).toContain('Mark 3 emails read');
    expect(view.container.textContent).toContain('Waiting for your approval. Nothing has changed yet.');
    expect(box(view, 'c1-1').checked).toBe(true);
    expect(box(view, 'c1-3').checked).toBe(false);
    expect(view.container.textContent).toContain('Protected: Starred');
    expect(view.container.textContent).toContain('1 email is protected and left unticked.');
    expect(view.container.textContent).toContain('A promotion');
    expect(view.container.textContent).toContain('2 emails selected');
  });

  // Breaks: Approve sends rows the user unticked, or misses one they ticked.
  it('approves exactly the rows the user selected', () => {
    const { view, props } = mount();
    toggle(box(view, 'c1-2'));
    toggle(box(view, 'c1-3'));
    expect(view.container.textContent).toContain('2 emails selected · 1 protected');
    fire(button(view, 'Approve selected'), 'click');
    expect(props.onDecision).toHaveBeenCalledExactlyOnceWith('approve', ['c1-1', 'c1-3']);
  });

  // Breaks: the button reads "Approve selected" when everything is selected, or approves nothing.
  it('says Approve when every row is selected, and cannot approve an empty selection', () => {
    const { view, props } = mount(set({ items: [item('c1-1'), item('c1-2')] }));
    expect(button(view, 'Approve')).not.toBeNull();
    toggle(box(view, 'c1-1'));
    toggle(box(view, 'c1-2'));
    expect((button(view, 'Approve selected') as HTMLButtonElement).disabled).toBe(true);
    fire(button(view, 'Approve selected'), 'click');
    expect(props.onDecision).not.toHaveBeenCalled();
  });

  // Breaks: Cancel changes mail, or opening an email is impossible from the card.
  it('cancels and opens an email', () => {
    const { view, props } = mount();
    fire(button(view, 'Cancel'), 'click');
    expect(props.onDecision).toHaveBeenCalledExactlyOnceWith('cancel');
    fire(view.byLabel('Open email: Subject c1-2 (owner@example.test)'), 'click');
    expect(props.onOpen).toHaveBeenCalledWith(expect.objectContaining({ kind: 'message', accountId: 'work', emailId: 'mail-c1-2' }));
  });

  // Breaks: an applied card offers Approve again, or hides its Undo.
  it('shows what was applied and offers Undo of the changed rows', () => {
    const { view, props } = mount(set({ status: 'applied', autoApplied: true, undoBy: NOW + 60_000, items: [
      item('c1-1', { status: 'applied' }), item('c1-2', { status: 'queued' }), item('c1-3', { status: 'unchanged' }), item('c1-4', { status: 'skipped', detail: 'Not selected.' }),
    ] }));
    expect(view.container.textContent).toContain('Applied for you · 2 emails changed · 1 will sync when the account is online · 1 already as asked');
    expect(view.container.textContent).toContain('Not selected.');
    expect(button(view, 'Approve')).toBeNull();
    expect(box(view, 'c1-1').disabled).toBe(true);
    fire(button(view, 'Undo 2 emails'), 'click');
    expect(props.onDecision).toHaveBeenCalledExactlyOnceWith('undo');
  });

  // Breaks: rows that failed cannot be retried, or a retry re-sends rows that worked.
  it('retries only the failed rows', () => {
    const { view, props } = mount(set({ status: 'partial', undoBy: NOW + 60_000, items: [item('c1-1', { status: 'applied' }), item('c1-2', { status: 'failed', detail: 'Could not be changed.' })] }));
    expect(view.container.textContent).toContain('1 failed');
    fire(button(view, 'Retry 1 failed email'), 'click');
    expect(props.onDecision).toHaveBeenCalledExactlyOnceWith('approve', ['c1-2']);
  });

  // Breaks: protected rows left by "Approve for me" cannot be decided, or Cancel throws away the Undo.
  it('offers the protected rest of an auto-applied set, and calls cancel "Leave the rest"', () => {
    const { view, props } = mount(set({ status: 'partial', autoApplied: true, undoBy: NOW + 60_000, items: [item('c1-1', { status: 'applied' }), item('c1-2', { protectedReason: 'Starred' })] }));
    expect(box(view, 'c1-2').checked).toBe(false);
    toggle(box(view, 'c1-2'));
    fire(button(view, 'Approve'), 'click');
    expect(props.onDecision).toHaveBeenCalledWith('approve', ['c1-2']);
    expect(button(view, 'Leave the rest')).not.toBeNull();
    expect(button(view, 'Undo 1 email')).not.toBeNull();
  });

  // Breaks: a card the host can no longer act on (expired, restarted, cancelled, undone) still shows buttons.
  it.each([
    [set({ approveBy: NOW - 1 }), 'This expired before it was approved. Nothing was changed.'],
    [set({ status: 'expired', approveBy: 0 }), 'This expired before it was approved. Nothing was changed.'],
    [set({ status: 'cancelled', items: [item('c1-1', { status: 'skipped' })] }), 'Cancelled. Nothing was changed.'],
    [set({ status: 'undone', undoBy: NOW + 1, items: [item('c1-1', { status: 'undone' })] }), 'Undone · 1 undone'],
    [set({ status: 'applied', undoBy: 0, items: [item('c1-1', { status: 'applied' })] }), 'Applied · 1 email changed'],
  ])('shows no actions on a finished or unavailable card (%#)', (value, line) => {
    const { view } = mount(value);
    expect(view.container.textContent).toContain(line);
    expect(view.byLabel('Change actions')).toBeNull();
  });

  // Breaks: a finished card's line misreports what happened, or a card replaced in place keeps the old selection.
  it('words finished cards and resets the selection for a different set', () => {
    const { view, props } = mount(set({ status: 'cancelled', items: [item('c1-1', { status: 'applied' }), item('c1-2', { status: 'skipped' })] }));
    expect(view.container.textContent).toContain('Cancelled · 1 email changed');
    view.rerender(<AssistantChangeSetCard {...props} changeSet={set({ status: 'undone', items: [item('c1-1', { status: 'skipped' })] })} />);
    expect(view.container.textContent).toContain('Undone · nothing left changed');
    view.rerender(<AssistantChangeSetCard {...props} changeSet={set({ status: 'applied', items: [item('c1-1', { status: 'skipped' })] })} />);
    expect(view.container.textContent).toContain('Applied · nothing needed changing');
    // The same set keeps the user's own selection (nothing ticked here)…
    view.rerender(<AssistantChangeSetCard {...props} changeSet={set()} />);
    expect(box(view, 'c1-1').checked).toBe(false);
    toggle(box(view, 'c1-1'));
    expect(box(view, 'c1-1').checked).toBe(true);
    // …and a different set starts from its own defaults.
    view.rerender(<AssistantChangeSetCard {...props} changeSet={set({ id: 'set-2', items: [item('c1-1', { date: Number.NaN })] })} />);
    expect(box(view, 'c1-1').checked).toBe(true);
    expect(view.container.textContent).toContain('Date unavailable');
  });

  // Breaks: an approval window that passes while the card is open still lets the user approve.
  it('turns the buttons off when the approval window passes while open', () => {
    const { view } = mount(set({ approveBy: NOW + 20_000 }));
    expect(button(view, 'Approve selected')).not.toBeNull();
    act(() => { vi.advanceTimersByTime(30_000); });
    expect(view.byLabel('Change actions')).toBeNull();
  });

  // Breaks: a busy card accepts a second decision, or a large set renders every row at once.
  it('ignores input while busy and pages long sets', () => {
    const many = set({ items: Array.from({ length: 60 }, (_, index) => item(`c1-${index + 1}`)) });
    const { view, props } = mount(many, { busy: true });
    expect(view.all('li')).toHaveLength(25);
    toggle(box(view, 'c1-1'));
    expect(box(view, 'c1-1').checked).toBe(true);
    fire(button(view, 'Approve'), 'click');
    fire(button(view, 'Cancel'), 'click');
    expect(props.onDecision).not.toHaveBeenCalled();
    fire(button(view, 'Show 35 more of 60'), 'click');
    expect(view.all('li')).toHaveLength(60);
  });
});
