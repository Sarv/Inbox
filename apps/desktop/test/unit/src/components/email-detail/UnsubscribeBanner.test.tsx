// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const requestConfirm = vi.hoisted(() => vi.fn(async () => true));
vi.mock('../../../../../src/store/confirm-service', () => ({ requestConfirm }));

import { UnsubscribeBanner } from '../../../../../src/components/email-detail/UnsubscribeBanner';
import { fire, render, settle } from '../../../../helpers/render';

/**
 * The Unsubscribe affordance on a message whose sender published a way off
 * their list.
 *
 * What breaks if this suite goes red, in the order it costs:
 *  - The banner appears on ordinary mail — every message grows an Unsubscribe
 *    button that cannot do anything.
 *  - The button sends a URL instead of a route, which is the whole security
 *    boundary: a crafted message would then name the address the app posts to.
 *  - A browser route reports "Unsubscribed" when the reader still has a form
 *    to submit, leaving them believing they left a list they are still on.
 */

const ONE_CLICK = '<https://brand.example/u/abc>';
const run = vi.fn(async () => ({ success: true }) as Record<string, unknown>);

const mount = (over: Record<string, unknown> = {}) =>
  render(<UnsubscribeBanner emailId="e1" listUnsubscribe={ONE_CLICK} listUnsubscribePost="List-Unsubscribe=One-Click" {...over} />);

const button = (view: ReturnType<typeof mount>) =>
  view.all('button').find((element) => element.textContent?.includes('Unsubscribe')) ?? null;

beforeEach(() => {
  vi.clearAllMocks();
  requestConfirm.mockResolvedValue(true);
  run.mockResolvedValue({ success: true });
  vi.stubGlobal('window', Object.assign(globalThis.window, {
    electronAPI: { unsubscribe: { run } },
  }));
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('UnsubscribeBanner', () => {
  // Most mail publishes nothing. A banner there is noise on every message.
  it('renders nothing when the sender published no way off a list', () => {
    const view = render(<UnsubscribeBanner emailId="e1" />);
    expect(view.container.textContent).toBe('');
    view.unmount();

    const empty = render(<UnsubscribeBanner emailId="e1" listUnsubscribe="" listUnsubscribePost="List-Unsubscribe=One-Click" />);
    expect(empty.container.textContent).toBe('');
    empty.unmount();
  });

  // THE security assertion: the IPC carries a route name, never an address.
  it('asks the main process for a route, never for a URL', async () => {
    const view = mount({ accountId: 'acct-2' });
    fire(button(view), 'click');
    await settle();

    expect(run).toHaveBeenCalledWith('e1', 'one-click', 'acct-2');
    // Nothing from the header reaches the call.
    expect(JSON.stringify(run.mock.calls[0])).not.toContain('brand.example');
    view.unmount();
  });

  // Nothing leaves the machine until the reader has said yes — a one-click
  // POST confirms to the sender that this address is read.
  it('sends nothing when the confirmation is declined', async () => {
    requestConfirm.mockResolvedValue(false);
    const view = mount();
    fire(button(view), 'click');
    await settle();

    expect(requestConfirm).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();
    view.unmount();
  });

  // A sender who published an address but never declared one-click gets the
  // page route — opened in the browser, and reported as UNFINISHED.
  it('offers the browser route, and never claims the reader is unsubscribed', async () => {
    run.mockResolvedValue({ success: true, needsBrowser: true });
    const view = mount({ listUnsubscribePost: null });

    const trigger = button(view);
    expect(trigger?.textContent).toContain('Unsubscribe in browser');

    fire(trigger, 'click');
    await settle();

    expect(run).toHaveBeenCalledWith('e1', 'page', undefined);
    expect(view.container.textContent).toContain('Finish unsubscribing in your browser');
    expect(view.container.textContent).not.toContain('Unsubscribed.');
    view.unmount();
  });

  // Mailto-only mail: the message goes through the outbox, so the wording says
  // sent-and-pending rather than done.
  it('takes the mailto route when that is all the sender offered', async () => {
    const view = mount({ listUnsubscribe: '<mailto:u@brand.example>', listUnsubscribePost: null });
    fire(button(view), 'click');
    await settle();

    expect(run).toHaveBeenCalledWith('e1', 'mailto', undefined);
    expect(view.container.textContent).toContain('Unsubscribe message sent');
    view.unmount();
  });

  // A refusal from the sender's server must be shown, not swallowed into a
  // "Done" the reader will believe.
  it('shows the failure and keeps the button usable', async () => {
    run.mockResolvedValue({ success: false, error: "The sender's server answered 500" });
    const view = mount();
    fire(button(view), 'click');
    await settle();

    expect(view.container.textContent).toContain("The sender's server answered 500");
    expect(view.container.textContent).not.toContain('Done');
    expect((button(view) as HTMLButtonElement).disabled).toBe(false);
    view.unmount();
  });

  // A dead IPC bridge throws rather than answering; the banner must not be
  // left spinning on a promise that already rejected.
  it('recovers when the bridge itself throws', async () => {
    run.mockRejectedValue(new Error('bridge gone'));
    const view = mount();
    fire(button(view), 'click');
    await settle();

    expect(view.container.textContent).toContain('bridge gone');
    expect((button(view) as HTMLButtonElement).disabled).toBe(false);
    view.unmount();
  });

  // Once it has succeeded the button is replaced, so a second POST cannot be
  // fired by an impatient double-click on a request that already landed.
  it('replaces the button once the request has landed', async () => {
    const view = mount();
    fire(button(view), 'click');
    await settle();

    expect(view.container.textContent).toContain('Done');
    expect(button(view)).toBeNull();
    expect(run).toHaveBeenCalledTimes(1);
    view.unmount();
  });
});
