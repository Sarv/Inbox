// @vitest-environment happy-dom
import { StrictMode, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConfirmDialogView, useConfirm } from '../../../../src/components/ConfirmDialog';
import { GlobalConfirmDialog } from '../../../../src/components/GlobalConfirmDialog';
import { SetupDialog } from '../../../../src/components/SetupDialog';
import { requestConfirm, useConfirmStore } from '../../../../src/store/confirm-service';
import { act, cleanup, fire, render, settle, type Mounted } from '../../../helpers/render';

const button = (view: Mounted, label: string) => view.all('button').find((element) => element.textContent === label) ?? null;
const confirmOverlay = (view: Mounted) => view.all('[role="dialog"]').at(-1) ?? null;

afterEach(() => {
  cleanup();
  useConfirmStore.getState().resolve(false);
  document.body.innerHTML = '';
});

function NestedSetup({ onClose }: { onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState('');
  return <>
    <SetupDialog title="Add account" steps={['Provider', 'Connect']} activeStep={1} onClose={onClose} closeDisabled={busy}>
      <h2>Connect Sarv</h2>
      <button disabled={busy} onClick={() => {
        setBusy(true);
        void requestConfirm({ title: 'Mailbox already connected', message: 'Reconnect this mailbox?', confirmLabel: 'Reconnect', cancelLabel: 'Keep existing connection' })
          .then((confirmed) => { setResult(confirmed ? 'Reconnected' : 'Kept existing mailbox'); setBusy(false); });
      }}>Connect mailbox</button>
      <p role="status">{result}</p>
    </SetupDialog>
    <GlobalConfirmDialog />
  </>;
}

describe('nested confirmation keyboard and focus safety', () => {
  // Regression: declining an account replacement must return keyboard focus to setup while its opener is still disabled.
  it('restores focus to the unchanged setup after a real global confirmation is declined', async () => {
    const close = vi.fn(); const behind = vi.fn(); document.addEventListener('keydown', behind);
    const view = render(<NestedSetup onClose={close} />);
    button(view, 'Connect mailbox')!.focus(); fire(button(view, 'Connect mailbox'), 'click');
    expect(view.all('[role="dialog"]')).toHaveLength(2);
    expect(document.activeElement).toBe(button(view, 'Reconnect'));
    expect(button(view, 'Connect mailbox')).toHaveProperty('disabled', true);
    fire(button(view, 'Keep existing connection'), 'click'); await settle();
    expect(view.all('[role="dialog"]')).toHaveLength(1);
    expect(view.find('[role="status"]')?.textContent).toBe('Kept existing mailbox');
    expect(document.activeElement).toBe(view.find('h2'));
    fire(document.activeElement as HTMLElement, 'keydown', { key: 'j' });
    expect(behind).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled();
    document.removeEventListener('keydown', behind);
  });

  // Regression: Escape can decline a nested prompt only once; the same event cannot also dismiss its parent.
  it('consumes Escape from a real global confirmation while keeping setup open', async () => {
    const close = vi.fn(); const view = render(<NestedSetup onClose={close} />);
    fire(button(view, 'Connect mailbox'), 'click');
    fire(document.activeElement as HTMLElement, 'keydown', { key: 'Escape' }); await settle();
    expect(view.all('[role="dialog"]')).toHaveLength(1);
    expect(close).not.toHaveBeenCalled(); expect(document.activeElement).toBe(view.find('h2'));
    fire(document.activeElement as HTMLElement, 'keydown', { key: 'Escape' }); expect(close).toHaveBeenCalledOnce();
  });

  // Regression: Tab must stay in the top confirmation, and Enter on its Cancel button must not reconnect the mailbox.
  it('traps both Tab edges and activates the focused confirmation choice', async () => {
    const view = render(<NestedSetup onClose={vi.fn()} />); fire(button(view, 'Connect mailbox'), 'click');
    const confirm = button(view, 'Reconnect')!; const cancel = button(view, 'Keep existing connection')!;
    fire(confirm, 'keydown', { key: 'Tab' }); expect(document.activeElement).toBe(cancel);
    fire(cancel, 'keydown', { key: 'Tab', shiftKey: true }); expect(document.activeElement).toBe(confirm);
    cancel.focus(); fire(cancel, 'keydown', { key: 'Enter' }); await settle();
    expect(view.find('[role="status"]')?.textContent).toBe('Kept existing mailbox');
  });

  // Regression: the primary keyboard action must still resolve the original promise to true and restore setup focus.
  it('confirms with Enter and keeps confirmation letters away from mailbox shortcuts', async () => {
    const behind = vi.fn(); document.addEventListener('keydown', behind);
    const view = render(<NestedSetup onClose={vi.fn()} />); fire(button(view, 'Connect mailbox'), 'click');
    fire(document.activeElement as HTMLElement, 'keydown', { key: 'j' }); expect(behind).not.toHaveBeenCalled();
    fire(document.activeElement as HTMLElement, 'keydown', { key: 'Enter' }); await settle();
    expect(view.find('[role="status"]')?.textContent).toBe('Reconnected');
    expect(document.activeElement).toBe(view.find('h2'));
    document.removeEventListener('keydown', behind);
  });
});

describe('confirmation focus lifecycle and choices', () => {
  // Regression: Enter's focused-choice click must not submit a form hosting the confirmation.
  it.each(['Cancel', 'Download all', 'Download recent'])('selects %s with Enter without submitting its parent form', (label) => {
    const submitted = vi.fn(); const confirm = vi.fn(); const cancel = vi.fn(); const secondary = vi.fn();
    const view = render(<form onSubmit={(event) => { event.preventDefault(); submitted(); }}>
      <ConfirmDialogView message="How much mail?" confirmLabel="Download recent" secondaryLabel="Download all" onConfirm={confirm} onCancel={cancel} onSecondary={secondary} />
    </form>);
    const choice = button(view, label)!;
    expect(choice.getAttribute('type')).toBe('button');
    choice.focus(); fire(choice, 'keydown', { key: 'Enter' });
    expect(label === 'Cancel' ? cancel : label === 'Download all' ? secondary : confirm).toHaveBeenCalledOnce();
    expect(submitted).not.toHaveBeenCalled();
  });

  // Regression: StrictMode's effect replay must leave focus in the confirmation, then restore the actual opener on close.
  it('captures the opener before focusing, including StrictMode effect replay', () => {
    const opener = document.createElement('button'); document.body.appendChild(opener); opener.focus();
    const view = render(<StrictMode><ConfirmDialogView title="Confirm" message="Proceed?" onConfirm={vi.fn()} onCancel={vi.fn()} /></StrictMode>);
    expect(document.activeElement).toBe(button(view, 'Delete'));
    view.unmount(); expect(document.activeElement).toBe(opener);
  });

  // Regression: an opener removed with its screen must not be focused on cleanup or throw during dismissal.
  it('handles an opener removed before the prompt is dismissed', () => {
    const opener = document.createElement('button'); document.body.appendChild(opener); opener.focus();
    const view = render(<ConfirmDialogView message="Proceed?" onConfirm={vi.fn()} onCancel={vi.fn()} />);
    opener.remove(); view.unmount(); expect(document.activeElement).toBe(document.body);
  });

  // Regression: parent dialogs without a focused heading still need a safe visible control after the nested overlay closes.
  it('falls back to a parent control when the document body was focused', async () => {
    const view = render(<><div role="dialog"><button>Parent control</button></div><GlobalConfirmDialog /></>);
    act(() => { void requestConfirm({ message: 'Proceed?' }); });
    fire(confirmOverlay(view), 'click'); await settle();
    expect(document.activeElement).toBe(button(view, 'Parent control'));
  });

  // Regression: a disappearing/empty parent must never break confirmation cleanup.
  it('handles an empty parent and an underlying dialog removed before cleanup', () => {
    const parent = document.createElement('div'); parent.setAttribute('role', 'dialog'); document.body.appendChild(parent);
    const view = render(<ConfirmDialogView message="Proceed?" onConfirm={vi.fn()} onCancel={vi.fn()} />);
    view.unmount(); expect(document.activeElement).toBe(document.body);
    const next = render(<ConfirmDialogView message="Proceed?" onConfirm={vi.fn()} onCancel={vi.fn()} />);
    parent.remove(); next.unmount(); expect(document.activeElement).toBe(document.body);
  });

  // Regression: Enter from a non-button keeps the legacy primary action while a focused secondary choice resolves distinctly.
  it('preserves the hook secondary choice and Enter primary fallback', async () => {
    let outcome = '';
    function Harness() {
      const { choose, confirm, confirmDialog } = useConfirm();
      return <><button onClick={() => { void choose({ message: 'How much mail?', secondaryLabel: 'Download all', confirmLabel: 'Download recent' }).then((choice) => { outcome = choice; }); }}>Choose</button><button onClick={() => { void confirm({ message: 'Proceed?' }).then((yes) => { outcome = String(yes); }); }}>Confirm</button>{confirmDialog}</>;
    }
    const view = render(<Harness />); fire(button(view, 'Choose'), 'click');
    button(view, 'Download all')!.focus(); fire(button(view, 'Download all'), 'keydown', { key: 'Enter' }); await settle();
    expect(outcome).toBe('secondary');
    fire(button(view, 'Confirm'), 'click'); fire(view.find('p'), 'keydown', { key: 'Enter' }); await settle(); expect(outcome).toBe('true');
  });
});
