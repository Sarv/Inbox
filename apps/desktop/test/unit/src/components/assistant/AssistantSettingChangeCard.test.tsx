// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AssistantSettingChangeCard, type AssistantSettingChangeCardProps } from '../../../../../src/components/assistant/AssistantSettingChangeCard';
import type { InboxAgentSettingChange } from '../../../../../src/types/inbox-assistant-changes';
import { act, cleanup, fire, render, toggle } from '../../../../helpers/render';

// The card where the user approves a setting the Inbox Agent asked to change.
// A regression here is the existing-mail option ticked by default, an Approve
// that sends the wrong choice, or buttons on a card the host can no longer act on.

const NOW = Date.UTC(2026, 10, 19, 10, 0, 0);

function change(over: Partial<InboxAgentSettingChange> = {}): InboxAgentSettingChange {
  return {
    id: 'r-1', label: 'R1', kind: 'create_filter', accountId: 'work', accountEmail: 'owner@example.test', summary: 'Create filter "Shop news"',
    details: ['When From contains "news@shop.test"', 'Then: Archive'], createdAt: NOW, approveBy: NOW + 60_000, undoBy: 0, status: 'pending',
    existing: { text: 'Also apply it to the emails it matches now', count: 12, protectedCount: 2 }, ...over,
  };
}

function mount(value = change(), extra: Partial<AssistantSettingChangeCardProps> = {}) {
  const props: AssistantSettingChangeCardProps = { change: value, busy: false, onDecision: vi.fn(), ...extra };
  return { view: render(<AssistantSettingChangeCard {...props} />), props };
}
const button = (view: ReturnType<typeof render>, label: string) => view.all('button').find(value => value.textContent?.trim() === label) ?? null;
const option = (view: ReturnType<typeof render>) => view.all('input').find(input => (input as HTMLInputElement).type === 'checkbox') as HTMLInputElement | undefined;

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('Inbox Agent setting change card', () => {
  // Breaks: the user cannot see what the filter does, or existing mail is ticked by default.
  it('shows what it does, says nothing changed yet, and offers existing mail unticked', () => {
    const { view } = mount();
    const text = view.container.textContent!;
    expect(text).toContain('Create filter "Shop news"');
    expect(text).toContain('Waiting for your approval. Nothing has changed yet.');
    expect(text).toContain('Setting for owner@example.test. It keeps acting on new mail after this chat.');
    expect(text).toContain('When From contains "news@shop.test"');
    expect(text).toContain('Also apply it to the emails it matches now: 12 emails. 2 protected emails stay as they are.');
    expect(option(view)!.checked).toBe(false);
  });

  // Breaks: Approve applies to existing mail the user did not tick, or ignores the tick.
  it('approves with the user\'s choice about existing mail', () => {
    const { view, props } = mount();
    fire(button(view, 'Approve'), 'click');
    expect(props.onDecision).toHaveBeenLastCalledWith('approve', false);
    toggle(option(view)!);
    fire(button(view, 'Approve'), 'click');
    expect(props.onDecision).toHaveBeenLastCalledWith('approve', true);
    fire(button(view, 'Cancel'), 'click');
    expect(props.onDecision).toHaveBeenLastCalledWith('cancel');
  });

  // Breaks: a tick carries over to a different card rendered in the same place.
  it('starts a different change unticked', () => {
    const { view, props } = mount();
    toggle(option(view)!);
    view.rerender(<AssistantSettingChangeCard {...props} change={change({ id: 'r-2', existing: { text: 'Also move their emails here to Spam', count: 1, protectedCount: 0 } })} />);
    expect(option(view)!.checked).toBe(false);
    expect(view.container.textContent).toContain('Also move their emails here to Spam: 1 email.');
  });

  // Breaks: a saved change offers Approve again, hides its Undo, or a failure on existing mail cannot be retried.
  it('offers Undo once saved, and a retry when existing mail failed', () => {
    const { view, props } = mount(change({ status: 'applied', undoBy: NOW + 60_000, existingApplied: true, existing: { text: 'x', count: 3, protectedCount: 0, result: '2 emails changed · 1 failed' } }));
    expect(view.container.textContent).toContain('Saved · 2 emails changed · 1 failed');
    expect(button(view, 'Approve')).toBeNull();
    expect(option(view)).toBeUndefined();
    fire(button(view, 'Retry failed emails'), 'click');
    expect(props.onDecision).toHaveBeenLastCalledWith('approve');
    fire(button(view, 'Undo'), 'click');
    expect(props.onDecision).toHaveBeenLastCalledWith('undo');
  });

  // Breaks: the card of a setting the agent asked to undo lets the user
  // re-approve it, tick its existing mail or retry, instead of only undoing it.
  it('shows only Undo on a change the agent asked to undo', () => {
    const { view, props } = mount(change({ status: 'applied', undoBy: NOW + 60_000, existingApplied: true, existing: { text: 'x', count: 3, protectedCount: 0, result: '2 emails changed · 1 failed' } }), { undoOnly: 'waiting' });
    const text = () => view.container.textContent!;
    expect(text()).toContain('Inbox Agent asked to undo this. Nothing changes until you click Undo.');
    for (const label of ['Approve', 'Cancel', 'Retry failed emails']) expect(button(view, label)).toBeNull();
    expect(option(view)).toBeUndefined();
    fire(button(view, 'Undo'), 'click');
    expect(props.onDecision).toHaveBeenLastCalledWith('undo');
    // Never an Approve or an existing-mail tick, even on a change still pending.
    view.rerender(<AssistantSettingChangeCard {...props} undoOnly="waiting" change={change()} />);
    expect(view.byLabel('Setting actions')).toBeNull();
    expect(option(view)).toBeUndefined();
    expect(text()).toContain('This can no longer be undone from here.');
    // Undone since, by the user's click: its own status says so.
    view.rerender(<AssistantSettingChangeCard {...props} undoOnly="waiting" change={change({ status: 'undone' })} />);
    expect(text()).toContain('Undone');
    expect(text()).not.toContain('Inbox Agent asked');
    expect(text()).not.toContain('no longer be undone');
  });

  // Breaks: a reason a decision did not go through is hidden from the user.
  it('shows why a decision did not go through', () => {
    const { view } = mount(change({ detail: 'Could not be saved. Approve again to retry.', existing: undefined }));
    expect(view.container.textContent).toContain('Could not be saved. Approve again to retry.');
    expect(option(view)).toBeUndefined();
  });

  // Breaks: a card the host can no longer act on still shows buttons.
  it.each([
    [change({ approveBy: NOW - 1 }), 'This expired before it was approved. Nothing was changed.'],
    [change({ status: 'expired', approveBy: 0 }), 'This expired before it was approved. Nothing was changed.'],
    [change({ status: 'cancelled' }), 'Cancelled. Nothing was changed.'],
    [change({ status: 'undone', existingApplied: true, existing: { text: 'x', count: 1, protectedCount: 0, result: '1 email put back' } }), 'Undone · 1 email put back'],
    [change({ status: 'applied', undoBy: 0 }), 'Saved'],
  ])('shows no actions on a finished or unavailable card (%#)', (value, line) => {
    const { view } = mount(value);
    expect(view.container.textContent).toContain(line);
    expect(view.byLabel('Setting actions')).toBeNull();
  });

  // Breaks: an approval window that passes while the card is open still lets the user approve.
  it('turns the buttons off when the approval window passes while open', () => {
    const { view } = mount(change({ approveBy: NOW + 20_000 }));
    expect(button(view, 'Approve')).not.toBeNull();
    act(() => { vi.advanceTimersByTime(30_000); });
    expect(view.byLabel('Setting actions')).toBeNull();
  });
});
