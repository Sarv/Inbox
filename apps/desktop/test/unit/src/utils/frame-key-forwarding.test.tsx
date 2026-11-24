// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ state: {} as Record<string, any> }));
vi.mock('../../../../src/store/email-store', () => ({ useEmailStore: { getState: () => h.state } }));

import { useKeyboardShortcuts } from '../../../../src/hooks/useKeyboardShortcuts';
import {
  forwardFrameKeys,
  installFrameKeyForwarding,
  isScriptlessFrame,
  isTypingTarget,
} from '../../../../src/utils/frame-key-forwarding';
import { act, cleanup, render } from '../../../helpers/render';

/**
 * Keyboard shortcuts after a click inside a mail body.
 *
 * What breaks if this file goes red: clicking a link (or anything) in a
 * message moves keyboard focus into the body's sandboxed iframe, a separate
 * document, and every shortcut — j/k, e, #, /, Escape — goes dead until the
 * user clicks outside the body. That was the reported bug.
 *
 * Frames here are real srcdoc frames: happy-dom gives each its own window and
 * document, so elements inside one belong to another realm, as in the app.
 */

/** The sandbox both mail-body frames use (SandboxedEmailBody and the chat view's SandboxedBody). */
const MAIL_SANDBOX = 'allow-same-origin allow-popups';

function frameWith(sandbox: string | null, body = '<p>Mail</p><a href="https://example.test/">Link</a>') {
  const frame = document.createElement('iframe');
  if (sandbox !== null) frame.setAttribute('sandbox', sandbox);
  frame.setAttribute('srcdoc', `<!DOCTYPE html><html><body>${body}</body></html>`);
  document.body.appendChild(frame);
  const doc = frame.contentDocument!;
  return {
    frame,
    doc,
    /** Replace the frame's document, as a srcdoc change (re-colour, images loaded) does. */
    async reload(next: string): Promise<Document> {
      const loaded = new Promise((resolve) => frame.addEventListener('load', resolve, { once: true }));
      frame.setAttribute('srcdoc', `<!DOCTYPE html><html><body>${next}</body></html>`);
      await loaded;
      return frame.contentDocument!;
    },
  };
}

/** Focus moving into a child frame: the app's window blurs with the frame active. */
function focusInto(frame: HTMLIFrameElement | null) {
  vi.spyOn(document, 'activeElement', 'get').mockReturnValue(frame ?? document.body);
  window.dispatchEvent(new Event('blur'));
}

/** A key pressed while focus is on `target` inside the frame's document. */
function pressIn(target: EventTarget, key: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

let uninstall: () => void = () => {};
let seen: KeyboardEvent[] = [];
const record = (e: Event) => { seen.push(e as KeyboardEvent); };

beforeEach(() => {
  seen = [];
  document.addEventListener('keydown', record);
  uninstall = installFrameKeyForwarding();
});
afterEach(() => {
  uninstall();
  document.removeEventListener('keydown', record);
  vi.restoreAllMocks();
  cleanup();
  document.body.innerHTML = '';
});

describe('isTypingTarget', () => {
  // Shortcuts must not fire while the user types into a field (the app's own fields).
  it('is true for fields and editable regions, false for anything else', () => {
    document.body.innerHTML = '<input><textarea></textarea><select></select><div contenteditable="true">x</div><div>y</div>';
    const [input, textarea, select, editable, plain] = Array.from(document.body.children);
    expect([input, textarea, select].map(isTypingTarget)).toEqual([true, true, true]);
    // happy-dom does not compute isContentEditable; the property is what is read.
    Object.defineProperty(editable, 'isContentEditable', { value: true });
    expect(isTypingTarget(editable)).toBe(true);
    expect(isTypingTarget(plain)).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
    expect(isTypingTarget(document)).toBe(false);
    expect(isTypingTarget(document.createTextNode('t'))).toBe(false);
  });

  // A field inside a mail body is an element of ANOTHER realm: an
  // `instanceof HTMLElement` check would call it "not a field" and turn the
  // user's typing into shortcuts.
  it('recognises a field that belongs to another document', () => {
    const other = document.implementation.createHTMLDocument('mail');
    other.body.innerHTML = '<input>';
    expect(isTypingTarget(other.querySelector('input'))).toBe(true);
  });
});

describe('isScriptlessFrame', () => {
  // Which frames forward: mail bodies yes; an extension panel (runs script, owns
  // its keyboard) and an unsandboxed frame (the PDF viewer) no.
  it('accepts only a sandboxed frame without allow-scripts', () => {
    expect(isScriptlessFrame(frameWith(MAIL_SANDBOX).frame)).toBe(true);
    expect(isScriptlessFrame(frameWith('').frame)).toBe(true);
    expect(isScriptlessFrame(frameWith('allow-scripts allow-same-origin allow-forms').frame)).toBe(false);
    expect(isScriptlessFrame(frameWith(null).frame)).toBe(false);
    expect(isScriptlessFrame(document.createElement('div'))).toBe(false);
    expect(isScriptlessFrame(null)).toBe(false);
  });
});

describe('installFrameKeyForwarding', () => {
  // THE reported bug: after a click on a link in a mail, keys must still reach the app.
  it('replays a key pressed in a focused mail frame on the frame element in the app document', () => {
    const { frame, doc } = frameWith(MAIL_SANDBOX);
    focusInto(frame);
    pressIn(doc.querySelector('a')!, 'j', { code: 'KeyJ', shiftKey: true, repeat: true });
    expect(seen).toHaveLength(1);
    expect(seen[0].target).toBe(frame);
    expect(seen[0]).toMatchObject({ key: 'j', code: 'KeyJ', shiftKey: true, repeat: true, ctrlKey: false, metaKey: false, altKey: false });
  });

  // A handled shortcut must also stop the key's own default in the frame
  // (Space/arrows would otherwise scroll as well as act); an unhandled key
  // keeps its default (Cmd/Ctrl+C copying the selection in the mail).
  it('prevents the original only when an app listener handled the replay', () => {
    const { frame, doc } = frameWith(MAIL_SANDBOX);
    focusInto(frame);
    expect(pressIn(doc.body, 'c', { metaKey: true }).defaultPrevented).toBe(false);
    const handle = (e: Event) => e.preventDefault();
    document.addEventListener('keydown', handle);
    try {
      expect(pressIn(doc.body, 'ArrowDown').defaultPrevented).toBe(true);
    } finally {
      document.removeEventListener('keydown', handle);
    }
  });

  // Typing into a field a mail carries is text, not a shortcut; an IME composing is not ours either.
  it('does not forward typing into a field in the mail, or IME composition', () => {
    const { frame, doc } = frameWith(MAIL_SANDBOX, '<input>');
    focusInto(frame);
    pressIn(doc.querySelector('input')!, 'e');
    pressIn(doc.body, 'e', { isComposing: true });
    pressIn(doc.body, 'Process');
    expect(seen).toHaveLength(0);
  });

  // An extension panel runs its own script and owns its keyboard: its keys must not become app shortcuts.
  it('leaves a frame that runs script alone', () => {
    const { frame, doc } = frameWith('allow-scripts allow-same-origin allow-forms');
    focusInto(frame);
    forwardFrameKeys(frame);
    pressIn(doc.body, 'e');
    expect(seen).toHaveLength(0);
  });

  // The window also blurs when the user switches apps; nothing is attached then.
  it('does nothing on a blur with no frame focused', () => {
    const { doc } = frameWith(MAIL_SANDBOX);
    focusInto(null);
    pressIn(doc.body, 'e');
    expect(seen).toHaveLength(0);
  });

  // Clicking in and out of the same body many times must not multiply each key
  // (a doubled 'e' archives two threads).
  it('attaches once per document however often the frame is focused', () => {
    const { frame, doc } = frameWith(MAIL_SANDBOX);
    focusInto(frame); focusInto(frame); forwardFrameKeys(frame);
    pressIn(doc.body, 'e');
    expect(seen).toHaveLength(1);
  });

  // A closed thread's frame has left the app: a late key must not act on whatever is open now.
  it('drops a key from a frame no longer in the app', () => {
    const { frame, doc } = frameWith(MAIL_SANDBOX);
    focusInto(frame);
    frame.remove();
    pressIn(doc.body, 'e');
    expect(seen).toHaveLength(0);
  });

  // A re-coloured or images-loaded body is a NEW document in the same frame;
  // focus can stay in it with no new window blur, so it must forward too.
  it('forwards from the next document the frame loads', async () => {
    const { frame, doc, reload } = frameWith(MAIL_SANDBOX);
    focusInto(frame);
    const next = await reload('<p>Re-coloured</p>');
    expect(next).not.toBe(doc);
    pressIn(next.body, 'k');
    expect(seen.map((e) => e.key)).toEqual(['k']);
  });

  // A frame whose document cannot be reached (cross-origin, or not loaded) is skipped, never a crash.
  it('skips a frame whose document is unreachable', () => {
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', MAIL_SANDBOX);
    Object.defineProperty(frame, 'contentDocument', { get: () => { throw new DOMException('Blocked', 'SecurityError'); } });
    expect(() => focusInto(frame)).not.toThrow();
    const empty = document.createElement('iframe');
    empty.setAttribute('sandbox', MAIL_SANDBOX);
    Object.defineProperty(empty, 'contentDocument', { get: () => null });
    expect(() => forwardFrameKeys(empty)).not.toThrow();
  });

  // Uninstalled (tests, a torn-down window): a later blur attaches nothing.
  it('stops attaching once uninstalled', () => {
    uninstall();
    const { frame, doc } = frameWith(MAIL_SANDBOX);
    focusInto(frame);
    pressIn(doc.body, 'e');
    expect(seen).toHaveLength(0);
  });
});

describe('shortcuts end to end after a click in the mail body', () => {
  function Probe() {
    useKeyboardShortcuts({ setActiveSection: vi.fn(), focusSearch: vi.fn(), enabled: true, allowListNavigation: false });
    return <div>Reader</div>;
  }

  beforeEach(() => {
    localStorage.clear();
    h.state = {
      selectedEmailId: 'open-email', highlightedEmailId: null, threadAccountId: 'acct', threadEmails: [{ id: 'open-email', accountId: 'acct' }],
      emails: [], searchResults: [], searchQuery: '', compose: { isOpen: false },
      getNavigationThreads: vi.fn(() => []), archiveEmail: vi.fn(), deleteEmail: vi.fn(), bulkRemoveEmails: vi.fn(),
      clearSelectedEmail: vi.fn(), clearSearch: vi.fn(),
    };
  });

  // The user's exact report: click a link in the mail, press a shortcut, it must act.
  it('deletes the open mail and closes it with keys pressed after a link click in its body', () => {
    render(<Probe />);
    const { frame, doc } = frameWith(MAIL_SANDBOX);
    focusInto(frame);
    act(() => { pressIn(doc.querySelector('a')!, 'd'); });
    expect(h.state.deleteEmail).toHaveBeenCalledExactlyOnceWith('open-email');
    act(() => { pressIn(doc.querySelector('a')!, 'Escape'); });
    expect(h.state.clearSelectedEmail).toHaveBeenCalledOnce();
  });

  // The same key typed into a field inside the mail must not delete anything.
  it('does not delete when the key was typed into a field in the mail', () => {
    render(<Probe />);
    const { frame, doc } = frameWith(MAIL_SANDBOX, '<input>');
    focusInto(frame);
    act(() => { pressIn(doc.querySelector('input')!, 'd'); });
    expect(h.state.deleteEmail).not.toHaveBeenCalled();
  });
});
