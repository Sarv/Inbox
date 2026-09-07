import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * New-mail notification rules (main process). Everything here is module-level
 * state (config, the coalescing buffer, the "already notified" set,
 * SERVICE_STARTED_AT captured at import), so each test re-imports the module
 * with a fixed system time via `load()`.
 *
 * Pinned invariants:
 *   - backfill-safe: mail older than launch never notifies,
 *   - coalescing: >= 3 mails in a window collapse into ONE summary toast,
 *   - sound minimum-gap + working-hours gating (outside hours: shown, SILENT),
 *   - per-account notify flags and focus suppression,
 *   - the in-app mirror fires when native notifications are unavailable (or dev).
 */

const h = vi.hoisted(() => {
  interface FakeWin {
    destroyed: boolean;
    focused: boolean;
    minimized: boolean;
    restored: boolean;
    shown: boolean;
    focusCalls: number;
    sendThrows: boolean;
    sent: Array<{ channel: string; payload: unknown }>;
    isDestroyed: () => boolean;
    isFocused: () => boolean;
    isMinimized: () => boolean;
    restore: () => void;
    show: () => void;
    focus: () => void;
    webContents: { send: (channel: string, payload: unknown) => void };
  }

  const makeWin = (): FakeWin => {
    const win: FakeWin = {
      destroyed: false,
      focused: false,
      minimized: false,
      restored: false,
      shown: false,
      focusCalls: 0,
      sendThrows: false,
      sent: [],
      isDestroyed: () => win.destroyed,
      isFocused: () => win.focused,
      isMinimized: () => win.minimized,
      restore: () => { win.restored = true; win.minimized = false; },
      show: () => { win.shown = true; },
      focus: () => { win.focusCalls += 1; },
      webContents: {
        send: (channel: string, payload: unknown) => {
          if (win.sendThrows) throw new Error('renderer gone');
          win.sent.push({ channel, payload });
        },
      },
    };
    return win;
  };

  const state = {
    supported: true,
    win: null as FakeWin | null,
    getWindowThrows: false,
  };

  interface FakeNotifOpts { title: string; body: string; subtitle?: string; silent?: boolean }
  const notifications: Array<{
    opts: FakeNotifOpts;
    shown: boolean;
    handlers: Map<string, () => void>;
  }> = [];

  class FakeNotification {
    opts: FakeNotifOpts;
    shown = false;
    handlers = new Map<string, () => void>();
    constructor(opts: FakeNotifOpts) {
      this.opts = opts;
      notifications.push(this);
    }
    static isSupported(): boolean { return state.supported; }
    on(event: string, cb: () => void): this { this.handlers.set(event, cb); return this; }
    show(): void { this.shown = true; }
  }

  const bus = {
    handlers: [] as Array<[string, (e: unknown) => void]>,
    unsubCalls: 0,
    unsubThrows: false,
    onThrows: false,
  };

  return { makeWin, state, notifications, FakeNotification, bus };
});

vi.mock('electron', () => ({
  Notification: h.FakeNotification,
  app: { getPath: () => '/tmp/sarvinbox-test', getName: () => 'Sarv Inbox Test', isPackaged: false },
}));

vi.mock('../../../../electron/shared', () => ({
  getMainWindow: () => {
    if (h.state.getWindowThrows) throw new Error('no window');
    return h.state.win;
  },
}));

vi.mock('@sarvinbox/core', () => ({
  createLogger: () => ({
    info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {},
    isLevelEnabled: () => false,
  }),
  getEventBus: () => ({
    on: (event: string, cb: (e: unknown) => void) => {
      if (h.bus.onThrows) throw new Error('bus unavailable');
      h.bus.handlers.push([event, cb]);
      return () => {
        h.bus.unsubCalls += 1;
        if (h.bus.unsubThrows) throw new Error('unsub failed');
      };
    },
  }),
}));

type Service = typeof import('../../../../electron/services/notification-service');

// 2026-06-15T12:00:00Z is a Monday — inside the default Mon–Fri window when the
// test's local timezone puts noon UTC inside 09:00–18:00; every working-hours
// test sets the window explicitly around the mocked local time instead of
// assuming a zone.
const LAUNCH_MS = Date.UTC(2026, 5, 15, 12, 0, 0);
const LAUNCH_SEC = Math.floor(LAUNCH_MS / 1000);

/** Fresh module instance with a fixed clock (so SERVICE_STARTED_AT is known). */
const load = async (atMs = LAUNCH_MS): Promise<Service> => {
  vi.setSystemTime(atMs);
  vi.resetModules();
  return import('../../../../electron/services/notification-service');
};

const mail = (over: Partial<Parameters<Service['notifyNewMail']>[0]> = {}) => ({
  emailId: 'e1',
  accountId: 'acct-a',
  fromName: 'Alice',
  fromAddress: 'alice@example.com',
  subject: 'Hello',
  date: LAUNCH_SEC + 60,
  categories: ['important'],
  tags: '|INBOX|',
  folderId: 'INBOX',
  ...over,
});

beforeEach(() => {
  vi.useFakeTimers();
  h.notifications.length = 0;
  h.bus.handlers.length = 0;
  h.bus.unsubCalls = 0;
  h.bus.unsubThrows = false;
  h.bus.onThrows = false;
  h.state.supported = true;
  h.state.getWindowThrows = false;
  h.state.win = h.makeWin();
  delete process.env['VITE_DEV_SERVER_URL'];
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env['VITE_DEV_SERVER_URL'];
});

/** Advance past the 5s coalescing window so the buffer flushes. */
const flush = (): void => { vi.advanceTimersByTime(5_000); };

describe('the notify rule chain', () => {
  it('mode=off drops everything', async () => {
    const svc = await load();
    svc.setNotificationConfig({ mode: 'off' });
    svc.notifyNewMail(mail());
    flush();
    expect(h.notifications).toHaveLength(0);
  });

  it('dedupes the same emailId across the arrival and post-categorisation paths', async () => {
    const svc = await load();
    svc.setNotificationConfig({ mode: 'all' });
    svc.notifyNewMail(mail({ categories: undefined })); // arrival
    svc.notifyNewMail(mail({ categories: ['important'] })); // post-cat, same id
    flush();
    expect(h.notifications).toHaveLength(1);
  });

  it('drops mail whose date is OLDER than app launch (backfill guard)', async () => {
    const svc = await load();
    svc.setNotificationConfig({ mode: 'all' });
    svc.notifyNewMail(mail({ date: LAUNCH_SEC - 1 }));
    flush();
    expect(h.notifications).toHaveLength(0);
  });

  it('drops mail with a missing/zero date', async () => {
    const svc = await load();
    svc.setNotificationConfig({ mode: 'all' });
    svc.notifyNewMail(mail({ date: 0 }));
    flush();
    expect(h.notifications).toHaveLength(0);
  });

  it('tolerates a date passed in MILLISECONDS', async () => {
    const svc = await load();
    svc.setNotificationConfig({ mode: 'all' });
    svc.notifyNewMail(mail({ date: (LAUNCH_SEC + 60) * 1000 }));
    flush();
    expect(h.notifications).toHaveLength(1);
  });

  it.each([
    ['|sent|'],
    ['|drafts|'],
    ['|spam|'],
    ['|trash|'],
    ['|[gmail]/sent mail|'],
    ['|[Gmail]/Spam|'],
    ['|[Gmail]/Trash|'],
  ])('drops non-inbound mail tagged %s', async (tags) => {
    const svc = await load();
    svc.setNotificationConfig({ mode: 'all' });
    svc.notifyNewMail(mail({ tags }));
    flush();
    expect(h.notifications).toHaveLength(0);
  });

  it('allows inbound mail with no tags at all', async () => {
    const svc = await load();
    svc.setNotificationConfig({ mode: 'all' });
    svc.notifyNewMail(mail({ tags: undefined }));
    flush();
    expect(h.notifications).toHaveLength(1);
  });

  it('honors a per-account notify=false, and defaults to ON for unknown accounts', async () => {
    const svc = await load();
    svc.setNotificationConfig({
      mode: 'all',
      accounts: { 'acct-a': { notify: false, label: 'A' } },
    });
    svc.notifyNewMail(mail({ emailId: 'off', accountId: 'acct-a' }));
    svc.notifyNewMail(mail({ emailId: 'unknown', accountId: 'acct-unknown' }));
    flush();
    expect(h.notifications).toHaveLength(1);
    expect(h.notifications[0].opts.title).toBe('Alice');
  });

  describe('mode=important', () => {
    it('waits for the AI verdict — undefined categories are NOT notified', async () => {
      const svc = await load();
      svc.setNotificationConfig({ mode: 'important' });
      svc.notifyNewMail(mail({ categories: undefined }));
      flush();
      expect(h.notifications).toHaveLength(0);
    });

    it('drops mail the AI did not mark important/needs_response', async () => {
      const svc = await load();
      svc.setNotificationConfig({ mode: 'important' });
      svc.notifyNewMail(mail({ categories: ['newsletter'] }));
      flush();
      expect(h.notifications).toHaveLength(0);
    });

    it.each([['important'], ['needs_response']])('notifies on the %s slug', async (slug) => {
      const svc = await load();
      svc.setNotificationConfig({ mode: 'important' });
      svc.notifyNewMail(mail({ categories: [slug] }));
      flush();
      expect(h.notifications).toHaveLength(1);
    });
  });

  it('mode=all notifies on the arrival path (no categories yet)', async () => {
    const svc = await load();
    svc.setNotificationConfig({ mode: 'all' });
    svc.notifyNewMail(mail({ categories: undefined }));
    flush();
    expect(h.notifications).toHaveLength(1);
  });

  it('falls back to the from ADDRESS, then a generic title, and to "(no subject)"', async () => {
    const svc = await load();
    svc.setNotificationConfig({ mode: 'all' });
    svc.notifyNewMail(mail({ emailId: 'addr', fromName: null, subject: null }));
    flush();
    expect(h.notifications[0].opts).toMatchObject({
      title: 'alice@example.com',
      body: '(no subject)',
    });

    h.notifications.length = 0;
    svc.notifyNewMail(mail({ emailId: 'anon', fromName: '', fromAddress: '' }));
    flush();
    expect(h.notifications[0].opts.title).toBe('New mail');
  });

  it('never throws when the window lookup blows up', async () => {
    const svc = await load();
    svc.setNotificationConfig({ mode: 'all' });
    h.state.getWindowThrows = true;
    expect(() => svc.notifyNewMail(mail())).not.toThrow();
    h.state.getWindowThrows = false;
    flush();
    expect(h.notifications).toHaveLength(0); // it bailed before buffering
  });
});

describe('focus suppression', () => {
  it('suppresses when the focused window shows that exact account + folder', async () => {
    const svc = await load();
    h.state.win!.focused = true;
    svc.setNotificationConfig({
      mode: 'all',
      view: { accountId: 'acct-a', folderId: 'INBOX' },
    });
    svc.notifyNewMail(mail());
    flush();
    expect(h.notifications).toHaveLength(0);
  });

  it('suppresses for ANY folder when the view has no folder pinned', async () => {
    const svc = await load();
    h.state.win!.focused = true;
    svc.setNotificationConfig({ mode: 'all', view: { accountId: 'acct-a', folderId: null } });
    svc.notifyNewMail(mail({ folderId: 'Archive' }));
    flush();
    expect(h.notifications).toHaveLength(0);
  });

  it('still notifies for a DIFFERENT folder of the viewed account', async () => {
    const svc = await load();
    h.state.win!.focused = true;
    svc.setNotificationConfig({ mode: 'all', view: { accountId: 'acct-a', folderId: 'INBOX' } });
    svc.notifyNewMail(mail({ folderId: 'Archive' }));
    flush();
    expect(h.notifications).toHaveLength(1);
  });

  it('still notifies for a different account, an unfocused window, or no window', async () => {
    const svc = await load();
    svc.setNotificationConfig({ mode: 'all', view: { accountId: 'acct-a', folderId: 'INBOX' } });

    h.state.win!.focused = true;
    svc.notifyNewMail(mail({ emailId: 'other-account', accountId: 'acct-b' }));
    h.state.win!.focused = false;
    svc.notifyNewMail(mail({ emailId: 'unfocused' }));
    h.state.win = null;
    svc.notifyNewMail(mail({ emailId: 'no-window' }));
    flush();
    // 3 in one window -> one summary toast; the point is none were suppressed.
    expect(h.notifications).toHaveLength(1);
    expect(h.notifications[0].opts.title).toBe('3 new emails');
  });

  it('still notifies when the window is destroyed', async () => {
    const svc = await load();
    h.state.win!.focused = true;
    h.state.win!.destroyed = true;
    svc.setNotificationConfig({ mode: 'all', view: { accountId: 'acct-a', folderId: 'INBOX' } });
    svc.notifyNewMail(mail());
    flush();
    expect(h.notifications).toHaveLength(1);
  });
});

describe('coalescing', () => {
  it('collapses a burst of 3+ into ONE summary toast', async () => {
    const svc = await load();
    svc.setNotificationConfig({ mode: 'important' });
    for (const [i, name] of ['Alice', 'Bob', 'Carol'].entries()) {
      svc.notifyNewMail(mail({ emailId: `e${i}`, fromName: name }));
    }
    flush();
    expect(h.notifications).toHaveLength(1);
    expect(h.notifications[0].opts.title).toBe('3 new important emails');
    expect(h.notifications[0].opts.body).toBe('From Alice, Bob, Carol');
    expect(h.notifications[0].shown).toBe(true);
  });

  it('summary drops the "important" word in mode=all and dedupes senders', async () => {
    const svc = await load();
    svc.setNotificationConfig({ mode: 'all' });
    for (const i of [0, 1, 2]) svc.notifyNewMail(mail({ emailId: `e${i}`, fromName: 'Alice' }));
    flush();
    expect(h.notifications[0].opts.title).toBe('3 new emails');
    expect(h.notifications[0].opts.body).toBe('From Alice');
  });

  it('summary lists 3 senders then "and N more"', async () => {
    const svc = await load();
    svc.setNotificationConfig({ mode: 'all' });
    ['A', 'B', 'C', 'D', 'E'].forEach((n, i) => svc.notifyNewMail(mail({ emailId: `e${i}`, fromName: n })));
    flush();
    expect(h.notifications[0].opts.body).toBe('From A, B, C and 2 more');
  });

  it('1–2 mails become individual toasts, and the sound only fires on the first', async () => {
    const svc = await load();
    svc.setNotificationConfig({ mode: 'all', sound: true });
    svc.notifyNewMail(mail({ emailId: 'a', fromName: 'Alice', subject: 'One' }));
    svc.notifyNewMail(mail({ emailId: 'b', fromName: 'Bob', subject: 'Two' }));
    flush();
    expect(h.notifications.map((n) => [n.opts.title, n.opts.body, n.opts.silent])).toEqual([
      ['Alice', 'One', false],
      ['Bob', 'Two', true],
    ]);
  });

  it('only ONE flush timer is armed per window (a later mail joins the same flush)', async () => {
    const svc = await load();
    svc.setNotificationConfig({ mode: 'all' });
    svc.notifyNewMail(mail({ emailId: 'a' }));
    vi.advanceTimersByTime(3_000);
    svc.notifyNewMail(mail({ emailId: 'b' }));
    vi.advanceTimersByTime(2_000); // 5s after the FIRST mail
    expect(h.notifications).toHaveLength(2);
  });

  it('the flush timer does not re-fire once drained (no repeat toasts)', async () => {
    const svc = await load();
    svc.setNotificationConfig({ mode: 'all' });
    svc.notifyNewMail(mail());
    flush();
    h.notifications.length = 0;
    vi.advanceTimersByTime(60_000);
    expect(h.notifications).toHaveLength(0);
  });

  it('shows the account label as a subtitle only when MULTIPLE accounts exist', async () => {
    const svc = await load();
    svc.setNotificationConfig({
      mode: 'all',
      accounts: {
        'acct-a': { notify: true, label: 'a@x.com' },
        'acct-b': { notify: true, label: 'b@x.com' },
      },
    });
    svc.notifyNewMail(mail());
    flush();
    expect(h.notifications[0].opts.subtitle).toBe('a@x.com');

    h.notifications.length = 0;
    svc.setNotificationConfig({ accounts: { 'acct-a': { notify: true, label: 'a@x.com' } } });
    svc.notifyNewMail(mail({ emailId: 'single' }));
    flush();
    expect(h.notifications[0].opts.subtitle).toBeUndefined();
  });

  it('multi-account summaries append the account labels', async () => {
    const svc = await load();
    svc.setNotificationConfig({
      mode: 'all',
      accounts: {
        'acct-a': { notify: true, label: 'a@x.com' },
        'acct-b': { notify: true, label: 'b@x.com' },
      },
    });
    svc.notifyNewMail(mail({ emailId: '1', fromName: 'Alice', accountId: 'acct-a' }));
    svc.notifyNewMail(mail({ emailId: '2', fromName: 'Bob', accountId: 'acct-b' }));
    svc.notifyNewMail(mail({ emailId: '3', fromName: 'Carol', accountId: 'acct-b' }));
    flush();
    expect(h.notifications[0].opts.body).toBe('From Alice, Bob, Carol · a@x.com, b@x.com');
  });

  it('multi-account summary omits the label suffix when no label is known', async () => {
    const svc = await load();
    svc.setNotificationConfig({
      mode: 'all',
      accounts: {
        'acct-a': { notify: true, label: '' },
        'acct-b': { notify: true, label: '' },
      },
    });
    for (const i of [1, 2, 3]) svc.notifyNewMail(mail({ emailId: `m${i}`, accountId: 'acct-a' }));
    flush();
    expect(h.notifications[0].opts.body).toBe('From Alice');
  });
});

describe('sound gating', () => {
  it('the sound minimum-gap is measured between FLUSHES, which the 5s coalescing window already spaces past it', async () => {
    const svc = await load();
    svc.setNotificationConfig({ mode: 'all', sound: true });
    svc.notifyNewMail(mail({ emailId: 'a' }));
    flush();
    expect(h.notifications[0].opts.silent).toBe(false);

    // Two flushes can never be closer than COALESCE_MS (5s) apart, and the gap
    // is SOUND_MIN_GAP_MS (3s) — so back-to-back bursts both sound. Documents
    // that the guard is a belt-and-braces backstop, not the thing that stops a
    // burst from machine-gunning (coalescing does that: one toast per window).
    h.notifications.length = 0;
    svc.notifyNewMail(mail({ emailId: 'b' }));
    flush();
    expect(h.notifications[0].opts.silent).toBe(false);
    expect(h.notifications).toHaveLength(1);
  });

  it('sounds again once the gap has elapsed', async () => {
    const svc = await load();
    svc.setNotificationConfig({ mode: 'all', sound: true });
    svc.notifyNewMail(mail({ emailId: 'a' }));
    flush();
    h.notifications.length = 0;
    svc.notifyNewMail(mail({ emailId: 'b' }));
    flush(); // 5s later > the 3s gap
    expect(h.notifications[0].opts.silent).toBe(false);
  });

  it('sound:false is always silent', async () => {
    const svc = await load();
    svc.setNotificationConfig({ mode: 'all', sound: false });
    svc.notifyNewMail(mail());
    flush();
    expect(h.notifications[0].opts.silent).toBe(true);
  });

  describe('working hours', () => {
    // The service reads LOCAL hours, so build the window from the mocked local
    // time rather than assuming the runner's timezone.
    const localWindow = (startOffsetH: number, endOffsetH: number) => {
      const now = new Date(LAUNCH_MS);
      const pad = (n: number) => String(((n % 24) + 24) % 24).padStart(2, '0');
      return {
        start: `${pad(now.getHours() + startOffsetH)}:00`,
        end: `${pad(now.getHours() + endOffsetH)}:00`,
      };
    };

    it('inside the window: the toast sounds', async () => {
      const svc = await load();
      const { start, end } = localWindow(-1, 2);
      svc.setNotificationConfig({
        mode: 'all', sound: true,
        workingHours: { enabled: true, days: [0, 1, 2, 3, 4, 5, 6], start, end },
      });
      svc.notifyNewMail(mail());
      flush();
      expect(h.notifications[0].opts.silent).toBe(false);
    });

    it('outside the window: the toast is still SHOWN but silent', async () => {
      const svc = await load();
      const { start, end } = localWindow(2, 4);
      svc.setNotificationConfig({
        mode: 'all', sound: true,
        workingHours: { enabled: true, days: [0, 1, 2, 3, 4, 5, 6], start, end },
      });
      svc.notifyNewMail(mail());
      flush();
      expect(h.notifications).toHaveLength(1);
      expect(h.notifications[0].opts.silent).toBe(true);
    });

    it('an OVERNIGHT window (22:00–06:00) is handled', async () => {
      const svc = await load();
      const hour = new Date(LAUNCH_MS).getHours();
      const pad = (n: number) => String(((n % 24) + 24) % 24).padStart(2, '0');
      // Window starts 1h ago and wraps past midnight -> we are inside it.
      svc.setNotificationConfig({
        mode: 'all', sound: true,
        workingHours: {
          enabled: true, days: [0, 1, 2, 3, 4, 5, 6],
          start: `${pad(hour - 1)}:00`, end: `${pad(hour - 3)}:00`,
        },
      });
      svc.notifyNewMail(mail());
      flush();
      expect(h.notifications[0].opts.silent).toBe(false);
    });

    it('a day NOT in `days` is outside the window (silent)', async () => {
      const svc = await load();
      const today = new Date(LAUNCH_MS).getDay();
      const { start, end } = localWindow(-1, 2);
      svc.setNotificationConfig({
        mode: 'all', sound: true,
        workingHours: { enabled: true, days: [(today + 1) % 7], start, end },
      });
      svc.notifyNewMail(mail());
      flush();
      expect(h.notifications[0].opts.silent).toBe(true);
    });

    it('an EMPTY days list means every day', async () => {
      const svc = await load();
      const { start, end } = localWindow(-1, 2);
      svc.setNotificationConfig({
        mode: 'all', sound: true,
        workingHours: { enabled: true, days: [], start, end },
      });
      svc.notifyNewMail(mail());
      flush();
      expect(h.notifications[0].opts.silent).toBe(false);
    });

    it('unparseable start/end times degrade to 00:00 rather than throwing', async () => {
      const svc = await load();
      svc.setNotificationConfig({
        mode: 'all', sound: true,
        workingHours: { enabled: true, days: [], start: 'garbage', end: '' },
      });
      svc.notifyNewMail(mail());
      flush();
      // start === end === 0 -> `cur >= 0 && cur < 0` is false -> silent.
      expect(h.notifications[0].opts.silent).toBe(true);
    });

    it('disabled working hours always allow the sound', async () => {
      const svc = await load();
      svc.setNotificationConfig({
        mode: 'all', sound: true,
        workingHours: { enabled: false, days: [], start: '00:00', end: '00:00' },
      });
      svc.notifyNewMail(mail());
      flush();
      expect(h.notifications[0].opts.silent).toBe(false);
    });
  });
});

describe('the in-app mirror', () => {
  it('fires INSTEAD of a native toast when the OS cannot show notifications', async () => {
    const svc = await load();
    h.state.supported = false;
    svc.setNotificationConfig({ mode: 'all' });
    svc.notifyNewMail(mail());
    flush();
    expect(h.notifications).toHaveLength(0);
    expect(h.state.win!.sent).toEqual([
      {
        channel: 'notifications:in-app',
        payload: {
          id: '1',
          title: 'Alice',
          body: 'Hello',
          subtitle: undefined,
          accountId: 'acct-a',
          emailId: 'e1',
        },
      },
    ]);
  });

  it('mirrors the SUMMARY toast too, with an incrementing id', async () => {
    const svc = await load();
    h.state.supported = false;
    svc.setNotificationConfig({ mode: 'all' });
    for (const i of [1, 2, 3]) svc.notifyNewMail(mail({ emailId: `m${i}` }));
    flush();
    expect(h.state.win!.sent).toHaveLength(1);
    expect(h.state.win!.sent[0].payload).toMatchObject({ id: '1', title: '3 new emails' });
  });

  it('mirrors ALONGSIDE the native toast in dev (VITE_DEV_SERVER_URL set)', async () => {
    const svc = await load();
    process.env['VITE_DEV_SERVER_URL'] = 'http://localhost:5173';
    svc.setNotificationConfig({ mode: 'all' });
    svc.notifyNewMail(mail());
    flush();
    expect(h.notifications).toHaveLength(1);
    expect(h.state.win!.sent).toHaveLength(1);
  });

  it('does NOT mirror in a packaged build with native support', async () => {
    const svc = await load();
    svc.setNotificationConfig({ mode: 'all' });
    svc.notifyNewMail(mail());
    flush();
    expect(h.notifications).toHaveLength(1);
    expect(h.state.win!.sent).toHaveLength(0);
  });

  it('swallows a send failure / missing window', async () => {
    const svc = await load();
    h.state.supported = false;
    svc.setNotificationConfig({ mode: 'all' });
    h.state.win!.sendThrows = true;
    svc.notifyNewMail(mail());
    expect(() => flush()).not.toThrow();

    h.state.win = null;
    svc.notifyNewMail(mail({ emailId: 'no-win' }));
    expect(() => flush()).not.toThrow();
  });
});

describe('toast click handlers', () => {
  it('a single-mail toast focuses the window and routes to the email', async () => {
    const svc = await load();
    svc.setNotificationConfig({ mode: 'all' });
    svc.notifyNewMail(mail());
    flush();
    h.state.win!.minimized = true;
    h.notifications[0].handlers.get('click')!();
    expect(h.state.win!.restored).toBe(true);
    expect(h.state.win!.shown).toBe(true);
    expect(h.state.win!.focusCalls).toBe(1);
    expect(h.state.win!.sent).toEqual([
      { channel: 'notifications:open-email', payload: { accountId: 'acct-a', emailId: 'e1' } },
    ]);
  });

  it('a summary toast just focuses the window', async () => {
    const svc = await load();
    svc.setNotificationConfig({ mode: 'all' });
    for (const i of [1, 2, 3]) svc.notifyNewMail(mail({ emailId: `m${i}` }));
    flush();
    h.notifications[0].handlers.get('click')!();
    expect(h.state.win!.shown).toBe(true);
    expect(h.state.win!.sent).toHaveLength(0);
  });

  it('clicking with a destroyed / absent window is safe', async () => {
    const svc = await load();
    svc.setNotificationConfig({ mode: 'all' });
    svc.notifyNewMail(mail());
    flush();
    h.state.win!.destroyed = true;
    expect(() => h.notifications[0].handlers.get('click')!()).not.toThrow();
    expect(h.state.win!.shown).toBe(false);

    h.state.win = null;
    expect(() => h.notifications[0].handlers.get('click')!()).not.toThrow();
  });
});

describe('showTestNotification', () => {
  it('shows a native toast and reports support', async () => {
    const svc = await load();
    expect(svc.showTestNotification()).toEqual({ supported: true });
    expect(h.notifications).toHaveLength(1);
    expect(h.notifications[0].opts).toMatchObject({
      title: 'Sarv Inbox — test notification',
      silent: false,
    });
    expect(h.state.win!.sent).toHaveLength(0);
    // Its click handler focuses the window.
    h.notifications[0].handlers.get('click')!();
    expect(h.state.win!.focusCalls).toBe(1);
  });

  it('falls back to the in-app card when unsupported', async () => {
    const svc = await load();
    h.state.supported = false;
    expect(svc.showTestNotification()).toEqual({ supported: false });
    expect(h.notifications).toHaveLength(0);
    expect(h.state.win!.sent[0].payload).toMatchObject({ title: 'Sarv Inbox — test notification' });
  });

  it('bypasses mode/working-hours/dedupe gating entirely', async () => {
    const svc = await load();
    svc.setNotificationConfig({
      mode: 'off', sound: false,
      workingHours: { enabled: true, days: [], start: '00:00', end: '00:00' },
    });
    svc.showTestNotification();
    svc.showTestNotification();
    expect(h.notifications).toHaveLength(2);
  });
});

describe('the arrival subscription lifecycle', () => {
  it('subscribes once and forwards a new email to the rule chain', async () => {
    const svc = await load();
    svc.setNotificationConfig({ mode: 'all' });
    svc.startNotificationService();
    svc.startNotificationService(); // idempotent
    expect(h.bus.handlers).toHaveLength(1);
    expect(h.bus.handlers[0][0]).toBe('email:synced');

    const [, handler] = h.bus.handlers[0];
    handler({
      isNew: true,
      accountId: 'acct-a',
      email: {
        id: 'arrived',
        fromName: 'Alice',
        fromAddress: 'alice@example.com',
        subject: 'Hi',
        date: LAUNCH_SEC + 5,
        tags: '|INBOX|',
        folderId: 'INBOX',
      },
    });
    flush();
    expect(h.notifications).toHaveLength(1);
    expect(h.notifications[0].opts.title).toBe('Alice');
  });

  it('ignores non-new events and events with no email payload', async () => {
    const svc = await load();
    svc.setNotificationConfig({ mode: 'all' });
    svc.startNotificationService();
    const [, handler] = h.bus.handlers[0];
    handler({ isNew: false, email: { id: 'x', date: LAUNCH_SEC + 5 } });
    handler({ isNew: true, emailId: 'y' });
    handler(undefined);
    flush();
    expect(h.notifications).toHaveLength(0);
  });

  it('falls back to the event/`active` ids when the email row lacks them', async () => {
    const svc = await load();
    svc.setNotificationConfig({ mode: 'all' });
    svc.startNotificationService();
    h.bus.handlers[0][1]({
      isNew: true,
      emailId: 'from-event',
      email: { fromAddress: 'bob@example.com', date: LAUNCH_SEC + 5 },
    });
    flush();
    expect(h.notifications).toHaveLength(1);
    expect(h.notifications[0].opts.title).toBe('bob@example.com');
  });

  it('survives an event bus that refuses the subscription', async () => {
    const svc = await load();
    h.bus.onThrows = true;
    expect(() => svc.startNotificationService()).not.toThrow();
    expect(h.bus.handlers).toHaveLength(0);
  });

  it('stop() unsubscribes, cancels the pending flush and drops buffered mail', async () => {
    const svc = await load();
    svc.setNotificationConfig({ mode: 'all' });
    svc.startNotificationService();
    svc.notifyNewMail(mail());
    svc.stopNotificationService();
    flush();
    expect(h.notifications).toHaveLength(0);
    expect(h.bus.unsubCalls).toBe(1);
    // A second stop is a no-op, and a throwing unsubscribe is swallowed.
    expect(() => svc.stopNotificationService()).not.toThrow();
    expect(h.bus.unsubCalls).toBe(1);
  });

  it('swallows an unsubscribe that throws', async () => {
    const svc = await load();
    h.bus.unsubThrows = true;
    svc.startNotificationService();
    expect(() => svc.stopNotificationService()).not.toThrow();
    // ...and can be started again afterwards.
    svc.startNotificationService();
    expect(h.bus.handlers).toHaveLength(2);
  });
});

describe('setNotificationConfig', () => {
  it('patches only the supplied fields, keeping the rest', async () => {
    const svc = await load();
    svc.setNotificationConfig({ mode: 'all', sound: false, accounts: { a: { notify: true, label: 'A' } } });
    // Patch just the view; mode/sound/accounts must survive.
    svc.setNotificationConfig({ view: { accountId: 'other', folderId: null } });
    svc.notifyNewMail(mail({ accountId: 'a' }));
    flush();
    expect(h.notifications).toHaveLength(1);
    expect(h.notifications[0].opts.silent).toBe(true); // sound:false survived
  });

  it('an empty patch keeps the defaults (mode=important, sound on)', async () => {
    const svc = await load();
    svc.setNotificationConfig({});
    svc.notifyNewMail(mail({ categories: undefined }));
    flush();
    expect(h.notifications).toHaveLength(0); // default mode=important waits for AI
    svc.notifyNewMail(mail({ emailId: 'cat', categories: ['important'] }));
    flush();
    expect(h.notifications[0].opts.silent).toBe(false); // default sound=true
  });
});
