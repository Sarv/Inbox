// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SetupDialog } from '../../../../src/components/SetupDialog';
import { act, cleanup, fire, render } from '../../../helpers/render';

const steps = ['Provider', 'Connect', 'Model'];
afterEach(() => { cleanup(); document.body.innerHTML = ''; });

describe('shared provider setup dialog', () => {
  // Regression: advancing setup must move keyboard focus to the current step and keep the Inbox brand.
  it('centers the shared wizard and focuses each stage heading', () => {
    const view = render(<SetupDialog title="Add account" steps={steps} activeStep={0} onClose={vi.fn()}><h2>Choose provider</h2><button>Provider</button></SetupDialog>);
    expect(view.find('[role="dialog"]')?.getAttribute('aria-modal')).toBe('true');
    expect(view.find('img')?.getAttribute('src')).toBe('/icon.png');
    expect(view.find('[aria-current="step"]')?.textContent).toBe('1Provider');
    expect(document.activeElement?.textContent).toBe('Choose provider');
    view.rerender(<SetupDialog title="Add account" steps={steps} activeStep={2} onClose={vi.fn()}><h2>Choose model</h2><button>Save model</button></SetupDialog>);
    expect(document.activeElement?.textContent).toBe('Choose model');
    expect(view.find('[aria-current="step"]')?.textContent).toBe('3Model');
    expect(view.all('li svg')).toHaveLength(2);
  });

  // Regression: modal keyboard shortcuts must not act on the mailbox behind it, including at either Tab edge.
  it('contains Tab navigation and mailbox shortcuts, then restores the opener', () => {
    const opener = document.createElement('button'); document.body.appendChild(opener); opener.focus();
    const close = vi.fn(); const behind = vi.fn(); document.addEventListener('keydown', behind);
    const view = render(<SetupDialog title="Add provider" steps={steps} activeStep={0} onClose={close}><h2>Provider</h2><button>First provider</button><button>Last action</button></SetupDialog>);
    const closeButton = view.byLabel('Close setup')!;
    const last = view.all('button').find((node) => node.textContent === 'Last action')!;
    fire(document.activeElement as HTMLElement, 'keydown', { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
    fire(last, 'keydown', { key: 'Tab' }); expect(document.activeElement).toBe(closeButton);
    fire(closeButton, 'keydown', { key: 'Tab', shiftKey: true }); expect(document.activeElement).toBe(last);
    fire(last, 'keydown', { key: 'j' }); expect(behind).not.toHaveBeenCalled();
    fire(last, 'keydown', { key: 'Escape' }); expect(close).toHaveBeenCalledOnce();
    view.unmount(); expect(document.activeElement).toBe(opener);
    document.removeEventListener('keydown', behind);
  });

  // Regression: backdrop and Close can cancel a draft, but cannot interrupt a durable account/provider save.
  it('blocks every dismissal path only during a committed save', () => {
    const close = vi.fn();
    const content = <><h2>Connect</h2><button>Connect</button></>;
    const view = render(<SetupDialog title="Add account" steps={steps} activeStep={1} onClose={close} closeDisabled>{content}</SetupDialog>);
    fire(view.find('[role="dialog"]'), 'click'); fire(view.byLabel('Close setup'), 'click');
    fire(document.activeElement as HTMLElement, 'keydown', { key: 'Escape' });
    expect(close).not.toHaveBeenCalled();
    view.rerender(<SetupDialog title="Add account" steps={steps} activeStep={1} onClose={close}>{content}</SetupDialog>);
    fire(view.find('h2'), 'click'); expect(close).not.toHaveBeenCalled();
    fire(view.find('[role="dialog"]'), 'click'); fire(view.byLabel('Close setup'), 'click');
    expect(close).toHaveBeenCalledTimes(2);
  });

  // Regression: a temporarily empty loading view and an opener removed by Settings must not break dialog cleanup.
  it('handles a loading-only dialog and a removed opener', () => {
    const opener = document.createElement('button'); document.body.appendChild(opener); opener.focus();
    const view = render(<SetupDialog title="Loading" steps={[]} activeStep={0} onClose={vi.fn()}><p role="status">Loading</p></SetupDialog>);
    opener.remove(); act(() => view.unmount());
    expect(document.activeElement).toBe(document.body);
  });
});
