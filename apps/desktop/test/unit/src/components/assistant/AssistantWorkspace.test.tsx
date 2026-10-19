// @vitest-environment happy-dom
import { useEffect, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AssistantWorkspace } from '../../../../../src/components/assistant/AssistantWorkspace';
import type { InboxAssistantViewState } from '../../../../../src/components/assistant/InboxAssistant';
import { act, cleanup, fire, render, settle, typeInto } from '../../../../helpers/render';

const mounted = vi.fn(); const unmounted = vi.fn();
let report: (state: InboxAssistantViewState) => void;
const running: InboxAssistantViewState = { chatId: 'test-chat', title: 'TCS quote', requestId: 'request-1', running: true, status: 'Reading original emails' };
function Probe({ onStateChange }: { onStateChange: typeof report }) {
  report = onStateChange;
  const [draft, setDraft] = useState('');
  useEffect(() => { mounted(); return () => { unmounted(); }; }, []);
  return <input aria-label="Retained draft" value={draft} onChange={event => setDraft(event.target.value)} />;
}
function harness(section: string, options: { onFocusChange?: (focused: boolean) => void; onOpenInbox?: () => void; onOpenAssistant?: () => void } = {}) {
  return <AssistantWorkspace section={section} onOpenInbox={options.onOpenInbox ?? (() => {})} onOpenAssistant={options.onOpenAssistant ?? (() => {})} onFocusChange={options.onFocusChange}
    renderAssistant={props => <Probe onStateChange={props.onStateChange} />}><p>Underlying Inbox</p></AssistantWorkspace>;
}
function resize(width: number, height = 900) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
  act(() => { window.dispatchEvent(new Event('resize')); });
}
beforeEach(() => { localStorage.clear(); vi.clearAllMocks(); resize(1440); });
afterEach(cleanup);

describe('persistent Inbox and AI workspace', () => {
  it('does not load the assistant until first visited, then keeps its draft mounted after leaving', async () => {
    const view = render(harness('mail')); await settle();
    expect(mounted).not.toHaveBeenCalled();
    view.rerender(harness('assistant')); await settle();
    const input = view.byLabel('Retained draft'); typeInto(input, 'Keep this draft');
    view.rerender(harness('contacts')); await settle();
    expect(view.find('[data-assistant-layout]')?.getAttribute('data-assistant-layout')).toBe('hidden');
    expect(view.byLabel('Retained draft')).toBe(input);
    view.rerender(harness('assistant')); await settle();
    expect((view.byLabel('Retained draft') as HTMLInputElement).value).toBe('Keep this draft');
    expect(mounted).toHaveBeenCalledTimes(1); expect(unmounted).not.toHaveBeenCalled();
  });

  it('opens PiP automatically only for running work, stays hidden after dismissal, and preserves completion', async () => {
    const view = render(harness('assistant')); await settle();
    act(() => report(running)); view.rerender(harness('mail')); await settle();
    expect(view.find('[data-assistant-layout]')?.getAttribute('data-assistant-layout')).toBe('pip');
    fire(view.byLabel('Hide AI view'), 'click'); await settle();
    act(() => report({ ...running, status: 'Checking attachments' })); await settle();
    expect(view.find('[data-assistant-layout]')?.getAttribute('data-assistant-layout')).toBe('hidden');
    expect(view.byLabel('Show running AI chat')?.textContent).toContain('Checking attachments');
    act(() => report({ ...running, running: false, requestId: null, status: 'Ready' })); await settle();
    expect(view.byLabel('Show AI chat')).not.toBeNull();
    act(() => report({ ...running, requestId: 'request-2' })); await settle();
    expect(view.find('[data-assistant-layout]')?.getAttribute('data-assistant-layout')).toBe('pip');
    expect(mounted).toHaveBeenCalledTimes(1); expect(unmounted).not.toHaveBeenCalled();
  });

  it('retains one child through float, split, hidden and full views and saves the split preference', async () => {
    const openInbox = vi.fn(); const view = render(harness('assistant', { onOpenInbox: openInbox })); await settle();
    const input = view.byLabel('Retained draft'); typeInto(input, 'Same conversation');
    fire(view.byLabel('Inbox + AI split view'), 'click'); await settle();
    expect(openInbox).toHaveBeenCalledOnce();
    view.rerender(harness('mail')); await settle();
    expect(view.find('[data-assistant-layout]')?.getAttribute('data-assistant-layout')).toBe('split');
    expect(localStorage.getItem('sarvinbox-assistant-workspace')).toBe('split');
    fire(view.byLabel('Float AI chat'), 'click'); await settle();
    expect(view.find('[data-assistant-layout]')?.getAttribute('data-assistant-layout')).toBe('pip');
    fire(view.byLabel('Hide AI view'), 'click'); await settle();
    expect(view.find('[data-assistant-workspace]')?.getAttribute('inert')).not.toBeNull();
    fire(view.byLabel('Show AI chat'), 'click'); await settle();
    view.rerender(harness('assistant')); await settle();
    expect(view.byLabel('Retained draft')).toBe(input);
    expect(mounted).toHaveBeenCalledTimes(1); expect(unmounted).not.toHaveBeenCalled();
  });

  it('restores the saved split view and falls back to bounded PiP on narrow windows', async () => {
    localStorage.setItem('sarvinbox-assistant-workspace', 'split');
    const view = render(harness('mail')); await settle();
    expect(view.find('[data-assistant-layout]')?.getAttribute('data-assistant-layout')).toBe('split');
    resize(600, 500); await settle();
    expect(view.find('[data-assistant-layout]')?.getAttribute('data-assistant-layout')).toBe('pip');
    const aside = view.byLabel('Floating Inbox Agent')!;
    expect(parseFloat(aside.style.width)).toBeLessThanOrEqual(576);
    expect(parseFloat(aside.style.height)).toBeLessThanOrEqual(476);
    resize(1440); await settle();
    expect(view.find('[data-assistant-layout]')?.getAttribute('data-assistant-layout')).toBe('split');
    expect(mounted).toHaveBeenCalledTimes(1);
  });

  it('supports keyboard resizing with viewport bounds and a keyboard-accessible split separator', async () => {
    localStorage.setItem('sarvinbox-assistant-workspace', 'split');
    const focus = vi.fn(); const view = render(harness('mail', { onFocusChange: focus })); await settle();
    const separator = view.byLabel('Resize Inbox and AI panels')!;
    act(() => { separator.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 })); });
    act(() => { window.dispatchEvent(new PointerEvent('pointerup')); });
    expect(document.activeElement).toBe(separator);
    expect(focus).toHaveBeenLastCalledWith(true);
    fire(separator, 'keydown', { key: 'Home' });
    expect(separator.getAttribute('aria-valuenow')).toBe('360');
    fire(separator, 'keydown', { key: 'ArrowLeft' });
    expect(separator.getAttribute('aria-valuenow')).toBe('384');
    fire(separator, 'keydown', { key: 'End' });
    expect(Number(separator.getAttribute('aria-valuenow'))).toBeLessThanOrEqual(800);
    fire(view.byLabel('Float AI chat'), 'click'); await settle();
    const aside = view.byLabel('Floating Inbox Agent')!;
    const width = parseFloat(aside.style.width);
    fire(view.byLabel('Resize floating chat'), 'keydown', { key: 'ArrowRight' });
    expect(parseFloat(aside.style.width)).toBe(width + 24);
    resize(400, 400); await settle();
    fire(view.byLabel('Resize floating chat'), 'keydown', { key: 'ArrowDown' });
    expect(parseFloat(aside.style.height)).toBeLessThanOrEqual(376);
    expect(parseFloat(aside.style.left) + parseFloat(aside.style.width)).toBeLessThanOrEqual(388);
  });

  it('drags PiP within the viewport and releases focus when hidden', async () => {
    const focus = vi.fn(); const view = render(harness('assistant', { onFocusChange: focus })); await settle();
    act(() => report(running)); view.rerender(harness('mail', { onFocusChange: focus })); await settle();
    const aside = view.byLabel('Floating Inbox Agent')!;
    const bar = aside.firstElementChild!;
    act(() => { bar.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 500, clientY: 500 })); });
    act(() => { window.dispatchEvent(new PointerEvent('pointermove', { clientX: -5000, clientY: -5000 })); });
    act(() => { window.dispatchEvent(new PointerEvent('pointerup')); });
    expect(parseFloat(aside.style.left)).toBe(12); expect(parseFloat(aside.style.top)).toBe(12);
    act(() => { view.byLabel('Retained draft')!.focus(); });
    expect(focus).toHaveBeenLastCalledWith(true);
    fire(view.byLabel('Hide AI view'), 'click'); await settle();
    expect(focus).toHaveBeenLastCalledWith(false);
    expect(unmounted).not.toHaveBeenCalled();
  });

  it('keeps PiP visible if a guarded full-view navigation is declined', async () => {
    const guarded = vi.fn(); const view = render(harness('assistant', { onOpenAssistant: guarded })); await settle();
    act(() => report(running)); view.rerender(harness('settings', { onOpenAssistant: guarded })); await settle();
    fire(view.byLabel('Open full AI chat'), 'click'); await settle();
    expect(guarded).toHaveBeenCalledOnce();
    expect(view.find('[data-assistant-layout]')?.getAttribute('data-assistant-layout')).toBe('pip');
    expect(unmounted).not.toHaveBeenCalled();
  });
});
