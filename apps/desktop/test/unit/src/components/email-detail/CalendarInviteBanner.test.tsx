// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CalendarInviteBanner } from '../../../../../src/components/email-detail/CalendarInviteBanner';
import { act, cleanup, fire, render, settle, type Mounted } from '../../../../helpers/render';

const invite = [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Sarv Inbox//test//EN',
  'BEGIN:VEVENT', 'UID:synthetic-event', 'DTSTAMP:20260801T000000Z',
  'DTSTART:20261006T100000Z', 'DTEND:20261006T110000Z',
  'SUMMARY:Synthetic review', 'LOCATION:Test room',
  'ORGANIZER:mailto:organizer@example.invalid',
  'ATTENDEE:mailto:first@example.invalid', 'ATTENDEE:mailto:second@example.invalid',
  'END:VEVENT', 'END:VCALENDAR',
].join('\r\n');

const api = {
  getCalendarInvite: vi.fn(),
  openCalendarInvite: vi.fn(),
  setCalendarAdded: vi.fn(),
};
let mounted: Mounted;
const mount = (props: Partial<React.ComponentProps<typeof CalendarInviteBanner>> = {}) => {
  mounted = render(<CalendarInviteBanner emailId="email-1" accountId="account-1" calendarIcs={invite} {...props} />);
  return mounted;
};
const addButton = () => mounted.all('button').find((button) => button.textContent?.includes('Add to calendar'))!;
const add = async () => { fire(addButton(), 'click'); await settle(); };

beforeEach(() => {
  api.getCalendarInvite.mockReset().mockResolvedValue({ success: true, ics: null });
  api.openCalendarInvite.mockReset().mockResolvedValue({ success: true });
  api.setCalendarAdded.mockReset().mockResolvedValue({ success: true });
  (window as unknown as { electronAPI: unknown }).electronAPI = { emails: api };
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('optional antivirus calendar opening', () => {
  // Breaks: accepting a missing-setup warning hands an unchecked generated ICS
  // to the calendar app without retaining its unscanned state on the card.
  it('marks an accepted unscanned calendar import and keeps normal added behavior', async () => {
    api.openCalendarInvite.mockResolvedValueOnce({ success: true, notScanned: true });
    mount();
    expect(api.getCalendarInvite).not.toHaveBeenCalled();
    await add();
    expect(api.openCalendarInvite).toHaveBeenCalledExactlyOnceWith('email-1', 'account-1');
    expect(api.setCalendarAdded).toHaveBeenCalledExactlyOnceWith('email-1', true, 'account-1');
    expect(mounted.container.textContent).toContain('Added to calendar');
    expect(mounted.find('[role="status"]')?.textContent).toBe('Not scanned for viruses.');
  });

  // Breaks: ordinary imports or truthy malformed reply flags are advertised as
  // accepted unscanned imports without a host warning decision.
  it.each([undefined, false, 'true'])('requires the exact host unscanned flag (%s)', async (notScanned) => {
    api.openCalendarInvite.mockResolvedValueOnce({ success: true, notScanned });
    mount();
    await add();
    expect(mounted.container.textContent).toContain('Added to calendar');
    expect(mounted.find('[role="status"]')).toBeNull();
  });

  // Breaks: failed or cancelled host operations persist an added marker or
  // display a successful unscanned notice, hiding the existing error.
  it.each([
    { success: false, error: 'Download cancelled.', notScanned: true },
    { success: false, error: 'Calendar import blocked: save or open the calendar attachment after scanning it.', notScanned: true },
    { success: false, noHandler: true, notScanned: true },
    { success: false },
  ])('keeps errors and cancellation separate from successful imports (%j)', async (reply) => {
    api.openCalendarInvite.mockResolvedValueOnce(reply);
    mount();
    await add();
    expect(api.setCalendarAdded).not.toHaveBeenCalled();
    expect(mounted.find('[role="status"]')).toBeNull();
    expect(addButton()).toBeTruthy();
    expect(mounted.container.textContent).toContain(reply.noHandler ? 'No calendar app is set up' : reply.error || 'Could not open the invite.');
  });

  // Breaks: an IPC rejection leaves the action disabled or hides its normal
  // generic failure, or exposes the raw exception through the card.
  it('keeps a rejected import retryable without an unscanned result', async () => {
    api.openCalendarInvite.mockRejectedValueOnce(new Error('private-path'));
    mount();
    await add();
    expect(mounted.container.textContent).toContain('Could not open the invite.');
    expect(mounted.container.textContent).not.toContain('private-path');
    expect((addButton() as HTMLButtonElement).disabled).toBe(false);
    expect(mounted.find('[role="status"]')).toBeNull();
  });

  // Breaks: clearing our added marker leaves a stale warning attached to a
  // later import, or stops the existing clear-and-retry workflow.
  it('clears the previous unscanned notice with the added marker and retries normally', async () => {
    api.openCalendarInvite.mockResolvedValueOnce({ success: true, notScanned: true });
    mount();
    await add();
    fire(mounted.byLabel('Clear added-to-calendar mark'), 'click');
    expect(api.setCalendarAdded).toHaveBeenLastCalledWith('email-1', false, 'account-1');
    expect(mounted.find('[role="status"]')).toBeNull();
    await add();
    expect(mounted.container.textContent).toContain('Added to calendar');
    expect(mounted.find('[role="status"]')).toBeNull();
  });

  // Breaks: a late import result attributes an unscanned file from the previous
  // mailbox/message to the card now displayed in All Inboxes.
  it.each([
    { emailId: 'email-2', accountId: 'account-1' },
    { emailId: 'email-1', accountId: 'account-2' },
  ])('keeps late unscanned notices bound to their owner (%j)', async (target) => {
    let finish!: (result: unknown) => void;
    api.openCalendarInvite.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    mount();
    fire(addButton(), 'click');
    mounted.rerender(<CalendarInviteBanner {...target} calendarIcs={invite} />);
    finish({ success: true, notScanned: true });
    await settle();
    expect(mounted.find('[role="status"]')).toBeNull();
    expect(mounted.container.textContent).not.toContain('Added to calendar');
    expect((addButton() as HTMLButtonElement).disabled).toBe(false);
    expect(api.setCalendarAdded).toHaveBeenCalledExactlyOnceWith('email-1', true, 'account-1');
  });

  // Breaks: a warning dismissed for the previous mailbox displays its error
  // on the newly selected message, or leaves the new action busy.
  it.each(['reply', 'throw'])('ignores an old account import %s failure in the current card', async (failure) => {
    let finish!: (result: unknown) => void;
    let reject!: (error: Error) => void;
    api.openCalendarInvite.mockReturnValueOnce(new Promise((resolve, rejectPromise) => {
      finish = resolve;
      reject = rejectPromise;
    }));
    mount();
    fire(addButton(), 'click');
    mounted.rerender(<CalendarInviteBanner emailId="email-1" accountId="account-2" calendarIcs={invite} />);
    if (failure === 'reply') finish({ success: false, error: 'Previous account warning dismissed.' });
    else reject(new Error('old-private-path'));
    await settle();
    expect(mounted.container.textContent).not.toContain('Previous account warning dismissed.');
    expect(mounted.container.textContent).not.toContain('Could not open the invite.');
    expect((addButton() as HTMLButtonElement).disabled).toBe(false);
    expect(api.setCalendarAdded).not.toHaveBeenCalled();
  });

  // Breaks: finishing the old warning clears a newer account's opening state
  // or overwrites its outcome while its own native operation is still pending.
  it('keeps a newer account operation pending when the old import completes', async () => {
    let finishOld!: (result: unknown) => void;
    let finishCurrent!: (result: unknown) => void;
    api.openCalendarInvite
      .mockReturnValueOnce(new Promise((resolve) => { finishOld = resolve; }))
      .mockReturnValueOnce(new Promise((resolve) => { finishCurrent = resolve; }));
    mount();
    fire(addButton(), 'click');
    mounted.rerender(<CalendarInviteBanner emailId="email-1" accountId="account-2" calendarIcs={invite} />);
    fire(addButton(), 'click');
    expect((addButton() as HTMLButtonElement).disabled).toBe(true);
    finishOld({ success: true, notScanned: true });
    await settle();
    expect((addButton() as HTMLButtonElement).disabled).toBe(true);
    expect(mounted.container.textContent).not.toContain('Added to calendar');
    expect(mounted.find('[role="status"]')).toBeNull();
    expect(api.setCalendarAdded).toHaveBeenCalledExactlyOnceWith('email-1', true, 'account-1');
    finishCurrent({ success: false, error: 'Current account import blocked.' });
    await settle();
    expect((addButton() as HTMLButtonElement).disabled).toBe(false);
    expect(mounted.container.textContent).toContain('Current account import blocked.');
  });
});

describe('invite resolution', () => {
  // Breaks: the scan outcome notice disrupts sparse/cancelled invite cards,
  // which must still render their normal event and guest information.
  it.each([
    ['cancelled', invite.replace('BEGIN:VEVENT', 'METHOD:CANCEL\r\nBEGIN:VEVENT'), 'Cancelled'],
    ['one guest', invite.split('\r\n').filter((line) => !line.startsWith('ORGANIZER:') && line !== 'ATTENDEE:mailto:second@example.invalid').join('\r\n'), '1 guest'],
    ['organizer only', invite.split('\r\n').filter((line) => !line.startsWith('ATTENDEE:')).join('\r\n'), 'organizer@example.invalid'],
    ['minimal', invite.split('\r\n').filter((line) => !['SUMMARY:', 'LOCATION:', 'ORGANIZER:', 'ATTENDEE:'].some((field) => line.startsWith(field))).join('\r\n'), 'Add to calendar'],
  ])('keeps %s cards usable without an unscanned outcome', (_kind, calendarIcs, text) => {
    mount({ calendarIcs });
    expect(mounted.container.textContent).toContain(text);
    expect(mounted.find('[role="status"]')).toBeNull();
  });

  // Breaks: a checked-empty row starts a background attachment fetch whenever
  // the message is opened, despite having no calendar invite to show.
  it('does not fetch or render a checked-empty invite', () => {
    mount({ calendarIcs: '' });
    expect(api.getCalendarInvite).not.toHaveBeenCalled();
    expect(mounted.container.textContent).toBe('');
  });

  // Breaks: legacy calendar cards disappear, or resolve another account's
  // message instead of the mailbox stamped on this card.
  it('resolves a legacy invite from the owning account', async () => {
    api.getCalendarInvite.mockResolvedValueOnce({ success: true, ics: invite });
    mount({ calendarIcs: null });
    await settle();
    expect(api.getCalendarInvite).toHaveBeenCalledExactlyOnceWith('email-1', 'account-1');
    expect(mounted.container.textContent).toContain('Synthetic review');
  });

  // Breaks: switching between equal message IDs in different mailboxes reuses
  // the first account's legacy invite instead of resolving the current owner.
  it('resolves legacy invites again when their owning account changes', async () => {
    api.getCalendarInvite.mockResolvedValue({ success: true, ics: invite });
    mount({ calendarIcs: null });
    await settle();
    mounted.rerender(<CalendarInviteBanner emailId="email-1" accountId="account-2" calendarIcs={null} />);
    await settle();
    expect(api.getCalendarInvite).toHaveBeenCalledTimes(2);
    expect(api.getCalendarInvite).toHaveBeenLastCalledWith('email-1', 'account-2');
  });

  // Breaks: a missing or rejected legacy invite crashes the message card.
  it.each(['missing', 'rejected'])('renders nothing for a %s legacy invite', async (result) => {
    if (result === 'rejected') api.getCalendarInvite.mockRejectedValueOnce(new Error('offline'));
    mount({ calendarIcs: null });
    await settle();
    expect(mounted.container.textContent).toBe('');
  });

  // Breaks: a reply after leaving the card resurrects a stale invite.
  it('ignores a legacy invite resolution after unmount', async () => {
    let finish!: (result: unknown) => void;
    api.getCalendarInvite.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    mount({ calendarIcs: null });
    mounted.unmount();
    await act(async () => { finish({ success: true, ics: invite }); });
    expect(document.body.textContent).toBe('');
  });
});
