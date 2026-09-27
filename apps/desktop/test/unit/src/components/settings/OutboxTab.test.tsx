// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OutboxTab } from '../../../../../src/components/settings/OutboxTab';
import { fire, render, settle } from '../../../../helpers/render';

// What breaks if this suite goes red: the only way to move a message that is
// already scheduled. The menu is absolutely positioned inside a row of the
// scheduled list, so a clipping ancestor or a missed click hands the reader a
// button that does nothing — and the message goes out at the old time.

const SCHEDULED_AT = 2_000_000_000; // far enough ahead to always classify as scheduled

const api = {
  outbox: {
    list: vi.fn(async () => ({
      success: true,
      data: [
        {
          id: 11,
          to: 'friend@example.com',
          subject: 'Later',
          status: 'pending',
          attempts: 0,
          createdAt: 1_700_000_000,
          nextRetryAt: SCHEDULED_AT,
          scheduledAt: SCHEDULED_AT,
        },
      ] as Array<Record<string, unknown>>,
    })),
    onChanged: vi.fn(() => () => {}),
    get: vi.fn(),
    retry: vi.fn(),
    retryAll: vi.fn(),
    discardAll: vi.fn(),
    delete: vi.fn(),
  },
  opQueue: { failed: vi.fn(async () => ({ success: true, data: [] })) },
  smtp: {
    rescheduleSend: vi.fn(async (_id: number, _sendAt: number) => ({ success: true, moved: true })),
    cancelSend: vi.fn(),
    commitSend: vi.fn(),
  },
};

/** Mount, let the initial load settle, and open the row's reschedule menu. */
const openReschedule = async () => {
  const view = render(<OutboxTab />);
  await settle();
  fire(view.byLabel('Change delivery time'), 'click');
  return view;
};

beforeEach(() => {
  vi.clearAllMocks();
  api.outbox.onChanged.mockReturnValue(() => {});
  api.smtp.rescheduleSend.mockResolvedValue({ success: true, moved: true });
  vi.stubGlobal('window', Object.assign(globalThis.window, { electronAPI: api }));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('OutboxTab scheduled rows', () => {
  // THE reported bug. `overflow-hidden` on the list clipped the absolutely
  // positioned menu, so the clock button opened a menu nobody could see. happy-dom
  // does no layout, so the clipping itself is unobservable — the class is the
  // only thing a test can hold onto.
  it('does not clip the row that holds the reschedule menu', async () => {
    const view = render(<OutboxTab />);
    await settle();

    const list = view.byLabel('Change delivery time')?.closest('.divide-y');
    expect(list).not.toBeNull();
    expect(list?.className).not.toContain('overflow-hidden');
    view.unmount();
  });

  it('opens the delivery-time menu from the clock button', async () => {
    const view = await openReschedule();

    expect(view.all('button').some((button) => button.textContent?.includes('Tomorrow morning'))).toBe(true);
    expect(view.byLabel('Change delivery time')?.getAttribute('aria-expanded')).toBe('true');
    view.unmount();
  });

  // Regression: picking a preset has to reach main with the row's id and the
  // chosen epoch. A menu that renders but never calls through is the same
  // broken button from the reader's side.
  it('reschedules the row to the time the reader picked', async () => {
    const view = await openReschedule();

    const preset = view.all('button').find((button) => button.textContent?.includes('Tomorrow morning'));
    fire(preset ?? null, 'click');
    await settle();

    expect(api.smtp.rescheduleSend).toHaveBeenCalledTimes(1);
    const [id, sendAt] = api.smtp.rescheduleSend.mock.calls[0];
    expect(id).toBe(11);
    expect(sendAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
    // The list is re-read, or the row keeps showing the old time.
    expect(api.outbox.list).toHaveBeenCalledTimes(2);
    view.unmount();
  });

  // The drain got there first: the reader is told, rather than shown a new time
  // for a message that is already gone.
  it('says so when the message was already on its way', async () => {
    api.smtp.rescheduleSend.mockResolvedValue({ success: true, moved: false });
    const view = await openReschedule();

    fire(view.all('button').find((button) => button.textContent?.includes('Tomorrow morning')) ?? null, 'click');
    await settle();

    expect(view.container.textContent).toContain('already on its way');
    view.unmount();
  });

  // A failing bridge must not leave the tab stuck on a spinner with no reason.
  it('surfaces a rejected reschedule instead of throwing', async () => {
    api.smtp.rescheduleSend.mockRejectedValue(new Error('SendQueue not initialized'));
    const view = await openReschedule();

    fire(view.all('button').find((button) => button.textContent?.includes('Tomorrow morning')) ?? null, 'click');
    await settle();

    expect(view.container.textContent).toContain('SendQueue not initialized');
    view.unmount();
  });

  // Click-away: the menu must close on a press elsewhere, or it sits over the
  // rows below and eats the next click.
  it('closes the menu on a press outside it', async () => {
    const view = await openReschedule();
    expect(view.all('button').some((button) => button.textContent?.includes('Tomorrow morning'))).toBe(true);

    fire(document.body, 'mousedown');
    await settle();

    expect(view.all('button').some((button) => button.textContent?.includes('Tomorrow morning'))).toBe(false);
    expect(api.smtp.rescheduleSend).not.toHaveBeenCalled();
    view.unmount();
  });
});

// What breaks if this block goes red: the Outbox telling the reader a message
// is still queued when it is already in the recipient's inbox — the row SMTP
// accepted but whose Sent-folder copy hasn't been filed yet. Beside it sat a
// Discard bin, offering to throw away mail that had already gone.
describe('OutboxTab delivered rows', () => {
  const row = (over: Record<string, unknown>) => ({
    id: 21,
    to: 'friend@example.com',
    subject: 'hi',
    status: 'pending',
    retryCount: 0,
    lastError: null,
    nextRetryAt: null,
    scheduledAt: null,
    smtpAccepted: false,
    sentAppendPending: false,
    createdAt: 1_700_000_000,
    ...over,
  });

  /** Mount with exactly these outbox rows. */
  const show = async (rows: Array<Record<string, unknown>>) => {
    api.outbox.list.mockResolvedValue({ success: true, data: rows });
    const view = render(<OutboxTab />);
    await settle();
    return view;
  };

  it('keeps a message SMTP has accepted out of the queued list', async () => {
    const view = await show([row({ status: 'append_pending', smtpAccepted: true, sentAppendPending: true })]);

    expect(view.container.textContent).toContain('Messages (0)');
    expect(view.container.textContent).toContain('Outbox is empty');
    // Nothing that implies the mail can still be stopped.
    expect(view.byLabel('Discard send')).toBeNull();
    view.unmount();
  });

  it('says the message was sent and where it is, rather than saying nothing', async () => {
    const view = await show([row({ status: 'append_pending', smtpAccepted: true, sentAppendPending: true })]);

    expect(view.container.textContent).toContain('1 message has been sent');
    expect(view.container.textContent).toContain('Sent folder');
    view.unmount();
  });

  it('counts several delivered messages in the plural', async () => {
    const view = await show([
      row({ id: 21, status: 'append_pending', smtpAccepted: true }),
      row({ id: 22, status: 'pending', smtpAccepted: true }),
    ]);

    expect(view.container.textContent).toContain('2 messages have been sent');
    view.unmount();
  });

  it('leaves a genuinely queued message in the list, unchanged', async () => {
    const view = await show([row({})]);

    expect(view.container.textContent).toContain('Messages (1)');
    expect(view.container.textContent).toContain('Queued');
    expect(view.container.textContent).not.toContain('has been sent');
    view.unmount();
  });

  // The badge reads from the shared classifier now; these are the readings it
  // has to keep giving for every row that IS still in the list.
  it('badges a send mid-transmission as sending, not queued', async () => {
    const view = await show([row({ status: 'executing' })]);
    expect(view.container.textContent).toContain('Sending');
    view.unmount();
  });

  it('badges a backing-off send with its attempt count', async () => {
    const view = await show([row({ retryCount: 2, lastError: 'connection reset' })]);
    expect(view.container.textContent).toContain('Retrying (2)');
    view.unmount();
  });

  it('badges a dead-lettered send as failed', async () => {
    const view = await show([row({ status: 'failed', retryCount: 5, lastError: 'mailbox unavailable' })]);
    expect(view.container.textContent).toContain('Failed');
    view.unmount();
  });
});
