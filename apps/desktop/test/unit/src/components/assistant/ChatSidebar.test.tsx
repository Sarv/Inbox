// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChatSidebar } from '../../../../../src/components/assistant/ChatSidebar';
import { act, cleanup, fire, render } from '../../../../helpers/render';

afterEach(() => { cleanup(); vi.useRealTimers(); });
const chats = [
  { id: 'pinned', title: 'TCS quotation discussion', createdAt: 1720000000000, updatedAt: 1720000000000, exchangeCount: 4, pinned: true },
  { id: 'recent', title: 'Follow up on the proposal with the procurement team', createdAt: 1720000000000, updatedAt: 1720000000000, exchangeCount: 1 },
];
function mount(over = {}) {
  const props = { chats, activeChatId: 'recent', pendingChatIds: new Set<string>(), deletePending: false, error: null, onSelect: vi.fn(), onTogglePinned: vi.fn(), onDelete: vi.fn(), ...over };
  return { view: render(<ChatSidebar {...props} />), props };
}

describe('compact assistant conversation sidebar', () => {
  it('separates Pinned and Recents into neutral one-line rows without per-row dates', () => {
    const { view } = mount();
    expect(view.byLabel('Pinned conversations')?.textContent).toContain(chats[0]!.title);
    expect(view.byLabel('Recent conversations')?.textContent).toContain(chats[1]!.title);
    const row = view.find('[data-chat-row="recent"]');
    expect(row?.className).toContain('h-9');
    expect(row?.className).toContain('bg-muted');
    expect(row?.className).not.toContain('bg-primary');
    expect(row?.textContent).toBe(chats[1]!.title);
    expect(row?.querySelector('time')).toBeNull();
    expect(view.byLabel(`Open conversation: ${chats[1]!.title}`)?.getAttribute('aria-current')).toBe('page');
  });

  it('collapses the pinned group while retaining Recents', () => {
    const { view } = mount();
    const collapse = view.all('button').find(button => button.textContent === 'Pinned')!;
    fire(collapse, 'click');
    expect(collapse.getAttribute('aria-expanded')).toBe('false');
    expect(view.byLabel(`Open conversation: ${chats[0]!.title}`)).toBeNull();
    expect(view.byLabel(`Open conversation: ${chats[1]!.title}`)).not.toBeNull();
    fire(collapse, 'click');
    expect(view.byLabel(`Open conversation: ${chats[0]!.title}`)).not.toBeNull();
  });

  it('opens an accessible metadata card on keyboard focus without reading conversation content', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1720000060000);
    const { view, props } = mount();
    const open = view.byLabel(`Open conversation: ${chats[1]!.title}`)!;
    act(() => open.focus());
    expect(view.find('[role="tooltip"]')?.textContent).toContain(chats[1]!.title);
    expect(view.find('[role="tooltip"]')?.textContent).toContain('Updated 1m ago');
    expect(view.find('[role="tooltip"]')?.textContent).toContain('1 reply');
    expect(open.getAttribute('aria-describedby')).toBe(view.find('[role="tooltip"]')?.id);
    expect(props.onSelect).not.toHaveBeenCalled();
    fire(open, 'keydown', { key: 'Escape' });
    expect(view.find('[role="tooltip"]')).toBeNull();
  });

  it('keeps Pin, Unpin and Delete keyboard accessible as separate actions', () => {
    const { view, props } = mount();
    fire(view.byLabel(`Unpin conversation: ${chats[0]!.title}`), 'click');
    fire(view.byLabel(`Pin conversation: ${chats[1]!.title}`), 'click');
    fire(view.byLabel(`Delete conversation: ${chats[1]!.title}`), 'click');
    expect(props.onTogglePinned.mock.calls).toEqual([[chats[0]], [chats[1]]]);
    expect(props.onDelete).toHaveBeenCalledExactlyOnceWith(chats[1]);
    expect(props.onSelect).not.toHaveBeenCalled();
    expect(view.find('[data-chat-row="recent"] .group-focus-within\\:opacity-100')).not.toBeNull();
  });

  it('shows both section headers when there are no pinned conversations', () => {
    const { view } = mount({ chats: [chats[1]!] });
    expect(view.byLabel('Pinned conversations')?.textContent).toContain('Pin conversations');
    expect(view.byLabel('Recent conversations')).not.toBeNull();
  });

  it('keeps failed rows visible and prevents duplicate actions while updating', () => {
    const { view } = mount({ pendingChatIds: new Set(['recent']), error: 'Could not save this conversation.' });
    expect(view.byLabel(`Open conversation: ${chats[1]!.title}`)?.hasAttribute('disabled')).toBe(true);
    expect(view.byLabel('Updating conversation')).not.toBeNull();
    expect(view.byLabel(`Delete conversation: ${chats[1]!.title}`)).toBeNull();
    expect(view.find('[role="alert"]')?.textContent).toContain('Could not save');
  });
});
