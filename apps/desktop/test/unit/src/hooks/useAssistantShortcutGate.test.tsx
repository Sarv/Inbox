// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ state: {} as Record<string, any> }));
vi.mock('../../../../src/store/email-store', () => ({ useEmailStore: { getState: () => h.state } }));

import { AssistantWorkspace } from '../../../../src/components/assistant/AssistantWorkspace';
import { useAssistantShortcutGate } from '../../../../src/hooks/useAssistantShortcutGate';
import { useKeyboardShortcuts } from '../../../../src/hooks/useKeyboardShortcuts';
import { act, cleanup, fire, render, settle } from '../../../helpers/render';

/** Stands in for the chat tree: a composer, and the cited email shown beside it. */
function Chat() {
  return <>
    <textarea aria-label="Composer" />
    <div data-assistant-source="true"><button type="button" aria-label="Cited email">Open source</button></div>
  </>;
}
/** The real workspace, gate and shortcut hook wired the way App wires them. */
function Shell({ section, source = null, onboarding = false }: { section: string; source?: object | null; onboarding?: boolean }) {
  const { setAssistantFocused, ...shortcuts } = useAssistantShortcutGate({ onboarding, section, source });
  useKeyboardShortcuts({ setActiveSection: vi.fn(), focusSearch: vi.fn(), ...shortcuts });
  return <AssistantWorkspace section={section} onOpenInbox={() => {}} onOpenAssistant={() => {}} onFocusChange={setAssistantFocused} renderAssistant={() => <Chat />}>
    <button type="button" aria-label="Mail row">An email in the list</button>
    <iframe aria-label="Email body" title="Email body" />
  </AssistantWorkspace>;
}
function key(value: string) { act(() => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true })); }); }
function pointerDown(element: Element | null) { act(() => { element!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 })); }); }
/** What Chromium does when the focused control is disabled or unmounted. */
function dropFocusToBody(element: HTMLElement) {
  act(() => { element.blur(); element.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null })); });
}
const mailChanges = () => h.state.deleteEmail.mock.calls.length + h.state.archiveEmail.mock.calls.length + h.state.bulkRemoveEmails.mock.calls.length;

beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 });
  h.state = {
    selectedEmailId: 'open-email', highlightedEmailId: 'open-email', threadAccountId: 'account', threadEmails: [{ id: 'open-email', accountId: 'account' }],
    emails: [{ id: 'open-email', accountId: 'account' }], searchResults: [], searchQuery: '', compose: { isOpen: false }, pendingDeletes: [],
    getNavigationThreads: vi.fn(() => [{ threadId: 'open-thread', emails: [{ id: 'open-email' }] }]),
    archiveEmail: vi.fn(), deleteEmail: vi.fn(), bulkRemoveEmails: vi.fn(), clearSelectedEmail: vi.fn(), clearSearch: vi.fn(), selectEmail: vi.fn(),
  };
});
afterEach(cleanup);

describe('mail shortcuts while the Inbox Agent is on screen', () => {
  // THE regression. Sending a question disabled the composer; Chromium then
  // moved focus to <body>, the workspace read that blur as "the user left the
  // chat", and the next keys of the follow-up ran on the email open in Mail:
  // d and Backspace moved it to Trash, e archived it. If this fails, typing in
  // the split view can silently file the mail being read.
  it('never runs d, e or Backspace on the open email after a chat control drops focus (split view)', async () => {
    localStorage.setItem('sarvinbox-assistant-workspace', 'split');
    const view = render(<Shell section="mail" />); await settle();
    expect(view.find('[data-assistant-layout]')?.getAttribute('data-assistant-layout')).toBe('split');
    const composer = view.byLabel('Composer') as HTMLTextAreaElement;
    act(() => composer.focus());
    dropFocusToBody(composer);
    expect(document.activeElement).not.toBe(composer);
    for (const typed of ['d', 'e', 'Backspace', '#', 'did they reply?'.split('')].flat()) key(typed);
    expect(mailChanges()).toBe(0);
  });

  it('hands the keyboard back to Mail when the user clicks a mail row, and takes it again on a click in the chat', async () => {
    localStorage.setItem('sarvinbox-assistant-workspace', 'split');
    const view = render(<Shell section="mail" />); await settle();
    act(() => (view.byLabel('Composer') as HTMLTextAreaElement).focus());
    dropFocusToBody(view.byLabel('Composer')!);
    pointerDown(view.byLabel('Mail row'));
    key('d');
    expect(h.state.deleteEmail).toHaveBeenCalledExactlyOnceWith('open-email');
    pointerDown(view.find('[data-assistant-workspace]'));
    key('d'); key('e');
    expect(mailChanges()).toBe(1);
  });

  // A click inside an email frame never reaches this document. Without the
  // window-blur check the chat would keep the keyboard after the user moved to
  // the reading pane, and Mail's shortcuts would stay dead.
  it('hands the keyboard back to Mail when focus moves into the email frame', async () => {
    localStorage.setItem('sarvinbox-assistant-workspace', 'split');
    const view = render(<Shell section="mail" />); await settle();
    act(() => (view.byLabel('Composer') as HTMLTextAreaElement).focus());
    key('d');
    expect(mailChanges()).toBe(0);
    const frame = view.byLabel('Email body')!;
    const active = Object.getOwnPropertyDescriptor(Document.prototype, 'activeElement');
    Object.defineProperty(document, 'activeElement', { configurable: true, get: () => frame });
    try { act(() => { window.dispatchEvent(new Event('blur')); }); } finally {
      delete (document as unknown as Record<string, unknown>).activeElement;
      if (active) Object.defineProperty(Document.prototype, 'activeElement', active);
    }
    key('d');
    expect(h.state.deleteEmail).toHaveBeenCalledExactlyOnceWith('open-email');
  });

  it('keeps Mail shortcuts working when the app only loses and regains window focus', async () => {
    localStorage.setItem('sarvinbox-assistant-workspace', 'split');
    const view = render(<Shell section="mail" />); await settle();
    act(() => (view.byLabel('Composer') as HTMLTextAreaElement).focus());
    act(() => { window.dispatchEvent(new Event('blur')); });
    key('d');
    expect(mailChanges()).toBe(0);
  });

  // Full chat with a cited email beside it: the email's own shortcuts work once
  // it opens or is clicked, but not while the chat is the surface in use.
  it('arms shortcuts for a cited email only while that email, not the chat, was used last (full view)', async () => {
    const first = { emailId: 'open-email' };
    const view = render(<Shell section="assistant" />); await settle();
    key('d');
    expect(mailChanges()).toBe(0); // no source open: nothing for a shortcut to act on
    pointerDown(view.byLabel('Composer')); // e.g. the click on a citation in the chat
    view.rerender(<Shell section="assistant" source={first} />); await settle();
    key('d');
    expect(h.state.deleteEmail).toHaveBeenCalledTimes(1); // opening a source hands it the keyboard
    act(() => (view.byLabel('Composer') as HTMLTextAreaElement).focus());
    dropFocusToBody(view.byLabel('Composer')!);
    key('d'); key('e');
    expect(mailChanges()).toBe(1); // back in the chat: typing cannot touch the cited email
    pointerDown(view.byLabel('Cited email'));
    key('d');
    expect(h.state.deleteEmail).toHaveBeenCalledTimes(2);
    pointerDown(view.byLabel('Composer'));
    view.rerender(<Shell section="assistant" source={{ emailId: 'another' }} />); await settle();
    key('d');
    expect(h.state.deleteEmail).toHaveBeenCalledTimes(3); // a newly opened source takes the keyboard again
  });

  it('treats the cited-email pane as part of the chat in the split view, as before', async () => {
    localStorage.setItem('sarvinbox-assistant-workspace', 'split');
    const view = render(<Shell section="mail" source={{ emailId: 'open-email' }} />); await settle();
    pointerDown(view.byLabel('Cited email'));
    key('d');
    expect(mailChanges()).toBe(0);
  });

  it('never arms shortcuts during onboarding, and releases the keyboard when the chat is hidden', async () => {
    const onboarding = render(<Shell section="mail" onboarding />); await settle();
    key('d');
    expect(mailChanges()).toBe(0);
    onboarding.unmount();
    localStorage.setItem('sarvinbox-assistant-workspace', 'split');
    const view = render(<Shell section="mail" />); await settle();
    act(() => (view.byLabel('Composer') as HTMLTextAreaElement).focus());
    fire(view.byLabel('Hide AI view'), 'click'); await settle();
    key('d');
    expect(h.state.deleteEmail).toHaveBeenCalledExactlyOnceWith('open-email');
  });
});
