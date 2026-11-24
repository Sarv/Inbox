/**
 * Keyboard shortcuts keep working after a click inside a mail body.
 *
 * A mail body renders in a sandboxed `<iframe>` — the standard reader's
 * `SandboxedEmailBody` and every bubble of the chat view's `SandboxedBody` —
 * which is a document of its own. Clicking in it (a link above all: an anchor
 * is focusable, and opening it externally leaves it focused) makes that frame
 * the focused frame, and Chromium then delivers every keydown to the FRAME's
 * document. The app's shortcut listeners are on the app's document, so j/k,
 * e, #, / and the rest went dead until the user clicked somewhere outside the
 * body. Coming back from the browser the link opened in did not help: the
 * window-focus restore in App.tsx leaves an element that already has focus
 * alone, and the frame is that element.
 *
 * Moving focus back out after a click is not the answer: the reader's text
 * selection lives in the frame, so Cmd/Ctrl+C would stop copying it. Instead,
 * a keydown in such a frame is replayed on the `<iframe>` element in the app's
 * document, where it bubbles through every listener a key pressed in the app
 * itself would reach; if one of them handles it (prevents its default), the
 * original is prevented too, so a shortcut that scrolls the reader does not
 * also scroll by key-repeat chaining out of the frame.
 *
 * Which frames: those that run no script — `sandbox` set and `allow-scripts`
 * not in it. Those are the mail bodies, and a frame with no script cannot use
 * a key itself, so its keys are the app's. A frame that DOES run script (an
 * extension's panel) owns its own keyboard and is left alone, and an
 * unsandboxed frame (the PDF viewer) is cross-origin anyway. Because nothing
 * in a forwarded frame can run, nothing in it can forge a key either.
 *
 * Keys typed into a field are not forwarded: a mail can carry an `<input>` or
 * a contenteditable region, and a letter typed there is text, not a shortcut —
 * the same rule the shortcut handler applies to the app's own fields.
 *
 * Works the same on macOS, Windows and Linux: it is Chromium's frame focus,
 * not the OS's.
 */

/**
 * Whether a key's target is somewhere the user types text. Realm-agnostic —
 * an element inside a frame is not an `instanceof` the app's `HTMLElement` —
 * so it answers the same for the app's fields and a mail body's.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as (Partial<HTMLElement> & { nodeType?: number }) | null;
  if (!el || el.nodeType !== 1) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return el.isContentEditable === true;
}

/** A frame that runs no script: sandboxed, without `allow-scripts`. */
export function isScriptlessFrame(el: Element | null): el is HTMLIFrameElement {
  if (!el || el.tagName !== 'IFRAME') return false;
  const frame = el as HTMLIFrameElement;
  return frame.hasAttribute('sandbox') && !frame.sandbox.contains('allow-scripts');
}

/** Documents already forwarding, so a frame re-focused many times attaches once. */
const forwarding = new WeakSet<Document>();
/** Frames whose later documents (a srcdoc change, a re-colour) follow on load. */
const followed = new WeakSet<HTMLIFrameElement>();

/**
 * Forward keydowns in `frame`'s current document to the frame element.
 * Idempotent per document; a frame whose document cannot be reached (not
 * same-origin, not loaded) or that runs script is left alone. Once a frame
 * has forwarded, each new document it loads forwards too — focus can stay in
 * a frame whose srcdoc is replaced, and no new window blur would announce it.
 */
export function forwardFrameKeys(frame: HTMLIFrameElement): void {
  if (!isScriptlessFrame(frame)) return;
  if (!followed.has(frame)) {
    followed.add(frame);
    frame.addEventListener('load', () => forwardFrameKeys(frame));
  }
  let doc: Document | null = null;
  try {
    doc = frame.contentDocument;
  } catch {
    doc = null;
  }
  if (!doc || forwarding.has(doc)) return;
  forwarding.add(doc);
  doc.addEventListener('keydown', (event) => {
    // An IME composing text, or a key typed into a field in the mail: not ours.
    if (event.isComposing || event.key === 'Process') return;
    if (isTypingTarget(event.target)) return;
    const replay = new KeyboardEvent('keydown', {
      key: event.key,
      code: event.code,
      location: event.location,
      repeat: event.repeat,
      shiftKey: event.shiftKey,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      metaKey: event.metaKey,
      bubbles: true,
      cancelable: true,
      composed: true,
    });
    if (!frame.dispatchEvent(replay)) event.preventDefault();
  });
}

/**
 * Install once per window, at boot. Focus moving into a child frame blurs the
 * app's window with that frame as its active element (the same signal
 * `useClickAway` uses); that is when its document starts forwarding. A window
 * blur for any other reason (switching apps) finds no frame and does nothing.
 * Returns the uninstaller (for tests).
 */
export function installFrameKeyForwarding(win: Window = window): () => void {
  const onBlur = () => {
    const active = win.document.activeElement;
    if (isScriptlessFrame(active)) forwardFrameKeys(active);
  };
  win.addEventListener('blur', onBlur);
  return () => win.removeEventListener('blur', onBlur);
}
