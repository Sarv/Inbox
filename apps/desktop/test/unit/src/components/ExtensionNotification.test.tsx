// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ExtensionNotification } from '../../../../src/components/ExtensionNotification';
import { act, fire, render, type Mounted } from '../../../helpers/render';

/**
 * Extension notification cards.
 *
 * What breaks if this file goes red: the `ui:notify` permission stops producing
 * anything a user can see. The card is the whole point of the OTP extension —
 * a verification code found two minutes after it expired is the same as a code
 * never found — so the pieces pinned here are the ones that make it usable:
 * the value is on screen, the countdown is live, an updated card replaces the
 * stale one instead of stacking beside it, and the stack cannot grow without
 * bound however many extensions are installed.
 */

const h = vi.hoisted(() => ({
  notify: null as ((card: unknown) => void) | null,
  dismiss: null as ((payload: { id: string; extensionId: string }) => void) | null,
  offNotify: 0,
  offDismiss: 0,
  opened: [] as Array<{ emailId: string; accountId?: string }>,
  actions: [] as Array<{ notificationId: string; action: Record<string, unknown> }>,
  cardActionFails: false,
}));

// `vi.mock` is hoisted above the imports above, so the component under test
// picks this up even though it is declared after them.
vi.mock('../../../../src/utils/open-email-from-notification', () => ({
  openEmailFromNotification: (emailId: string, accountId?: string) => {
    h.opened.push({ emailId, accountId });
  },
}));

const NOW = 1_800_000_000_000;

interface CardInput {
  id: string;
  title: string;
  body?: string;
  fields?: Array<{ label: string; value: string; copyable?: boolean; emphasis?: boolean }>;
  expiresAt?: number;
  timeoutMs?: number;
  emailId?: string;
  accountId?: string;
}

function card(overrides: Partial<CardInput> = {}): CardInput & { extensionId: string } {
  return { id: 'otp-code:c1', extensionId: 'otp-code', title: 'Verification code', ...overrides };
}

function push(input: ReturnType<typeof card>): void {
  act(() => {
    h.notify?.(input);
  });
}

function text(mounted: Mounted): string {
  return mounted.container.textContent ?? '';
}

let mounted: Mounted | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  h.notify = null;
  h.dismiss = null;
  h.offNotify = 0;
  h.offDismiss = 0;
  h.opened.length = 0;
  h.actions.length = 0;
  h.cardActionFails = false;
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn(async () => {}) },
  });

  (window as any).electronAPI = {
    extensions: {
      onNotify: (callback: (c: unknown) => void) => {
        h.notify = callback;
        return () => {
          h.offNotify += 1;
        };
      },
      onDismiss: (callback: (p: { id: string; extensionId: string }) => void) => {
        h.dismiss = callback;
        return () => {
          h.offDismiss += 1;
        };
      },
      cardAction: async (notificationId: string, action: Record<string, unknown>) => {
        if (h.cardActionFails) throw new Error('that extension is disabled');
        h.actions.push({ notificationId, action });
        return { success: true, data: true };
      },
    },
  };
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  vi.useRealTimers();
  delete (window as any).electronAPI;
});

describe('ExtensionNotification', () => {
  it('renders nothing until an extension asks for a card', () => {
    // Regression: an empty fixed-position container sits over the bottom-right
    // of the window, swallowing clicks on whatever is under it.
    mounted = render(<ExtensionNotification />);

    expect(mounted.container.innerHTML).toBe('');
  });

  it('shows the title, body and field value an extension sent', () => {
    // Regression: the card renders empty, which for a verification code means
    // the extension did all its work and showed the user nothing.
    mounted = render(<ExtensionNotification />);
    push(
      card({
        body: 'from Acme',
        fields: [{ label: 'Code', value: '481920', copyable: true, emphasis: true }],
      })
    );

    expect(text(mounted)).toContain('Verification code');
    expect(text(mounted)).toContain('from Acme');
    expect(text(mounted)).toContain('481920');
  });

  it('gives a copyable field a copy button labelled with the field', () => {
    // Regression: the code is on screen but has to be retyped by hand, which is
    // the entire convenience the extension exists to provide.
    mounted = render(<ExtensionNotification />);
    push(card({ fields: [{ label: 'Code', value: '481920', copyable: true }] }));

    expect(mounted.byLabel('Copy Code')).not.toBeNull();
  });

  it('replaces a card of the same id in place instead of stacking a copy', () => {
    // Regression: an extension updating its card (a corrected value, a restarted
    // countdown) leaves a queue of near-identical cards on screen.
    mounted = render(<ExtensionNotification />);
    push(card({ fields: [{ label: 'Code', value: '111111' }] }));
    push(card({ fields: [{ label: 'Code', value: '222222' }] }));

    expect(text(mounted)).toContain('222222');
    expect(text(mounted)).not.toContain('111111');
    expect(mounted.all('[aria-label="Dismiss"]')).toHaveLength(1);
  });

  it('keeps at most three cards, newest first', () => {
    // Regression: several chatty extensions fill the window with cards the user
    // has to dismiss one by one.
    mounted = render(<ExtensionNotification />);
    for (const index of [1, 2, 3, 4]) {
      push(card({ id: `ext:c${index}`, title: `Card ${index}` }));
    }

    const titles = text(mounted);
    expect(mounted.all('[aria-label="Dismiss"]')).toHaveLength(3);
    expect(titles).toContain('Card 4');
    expect(titles).not.toContain('Card 1');
  });

  it('takes a card away when its dismiss button is pressed', () => {
    // Regression: a card with no expiry can never be got rid of.
    mounted = render(<ExtensionNotification />);
    push(card());

    fire(mounted.byLabel('Dismiss'), 'click');

    expect(mounted.container.innerHTML).toBe('');
  });

  it('takes a card away when the extension dismisses it by id', () => {
    // Regression: an extension that notices its own card is stale (a code
    // already used) cannot retract it.
    mounted = render(<ExtensionNotification />);
    push(card({ id: 'otp-code:c1' }));

    act(() => {
      h.dismiss?.({ id: 'otp-code:c1', extensionId: 'otp-code' });
    });

    expect(mounted.container.innerHTML).toBe('');
  });

  it('auto-dismisses after timeoutMs', () => {
    // Regression: a card meant to be transient stays until the app restarts.
    mounted = render(<ExtensionNotification />);
    push(card({ timeoutMs: 5_000 }));

    act(() => {
      vi.advanceTimersByTime(4_999);
    });
    expect(text(mounted)).toContain('Verification code');

    act(() => {
      vi.advanceTimersByTime(2);
    });
    expect(mounted.container.innerHTML).toBe('');
  });

  it('lets expiresAt win over timeoutMs', () => {
    // Regression: a card that says when it stops being true disappears earlier
    // for an unrelated reason, taking a still-valid code with it.
    mounted = render(<ExtensionNotification />);
    push(card({ expiresAt: NOW + 300_000, timeoutMs: 2_000 }));

    act(() => {
      vi.advanceTimersByTime(10_000);
    });

    expect(text(mounted)).toContain('Verification code');
  });

  it('ticks the countdown down once a second and warns in the last minute', () => {
    // Regression: the countdown freezes at the value it had when the card
    // arrived, so it reads as valid long after the code stopped working.
    mounted = render(<ExtensionNotification />);
    push(card({ expiresAt: NOW + 125_000 }));

    expect(text(mounted)).toContain('2:05');

    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(text(mounted)).toContain('1:05');
    expect(mounted.find('.text-destructive')).toBeNull();

    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(text(mounted)).toContain('55s');
    expect(mounted.find('.text-destructive')).not.toBeNull();
  });

  it('removes the card once its expiry passes', () => {
    // Regression: an expired code stays on screen reading "Expired" forever.
    mounted = render(<ExtensionNotification />);
    push(card({ expiresAt: NOW + 30_000 }));

    act(() => {
      vi.advanceTimersByTime(30_001);
    });

    expect(mounted.container.innerHTML).toBe('');
  });

  it('offers "Open the message" only when the card names one', () => {
    // Regression: a button that goes nowhere, or no way back to the mail the
    // card came from.
    mounted = render(<ExtensionNotification />);
    push(card({ id: 'ext:no-mail' }));
    expect(text(mounted)).not.toContain('Open the message');

    push(card({ id: 'ext:with-mail', emailId: 'email-1', accountId: 'account-2' }));
    const button = mounted.all('button').find((el) => el.textContent === 'Open the message');
    fire(button ?? null, 'click');

    expect(h.opened).toEqual([{ emailId: 'email-1', accountId: 'account-2' }]);
  });

  it('names "Open the message" on hover', async () => {
    // Regression: the card's only navigation loses its hover label. The button
    // sits under whatever text the extension wrote, so "the message" is
    // ambiguous until the tooltip says it is the one the card came from.
    mounted = render(<ExtensionNotification />);
    push(card({ id: 'ext:with-mail', emailId: 'email-1' }));

    const button = mounted.all('button').find((el) => el.textContent === 'Open the message');
    // The shared Tooltip opens on `mouseover` after its delay and portals the
    // bubble to document.body.
    await act(async () => {
      button!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    await act(async () => {
      vi.advanceTimersByTime(100);
    });

    expect(document.body.textContent).toContain('Open the message this is about');
  });

  it('unsubscribes from both channels on unmount', () => {
    // Regression: every window reload leaves another pair of IPC listeners
    // behind, and one card then renders several times over.
    mounted = render(<ExtensionNotification />);
    mounted.unmount();
    mounted = null;

    expect(h.offNotify).toBe(1);
    expect(h.offDismiss).toBe(1);
  });

  it('renders without an extensions API at all', () => {
    // Regression: an older preload (or a test harness) with no extensions bridge
    // takes the whole renderer down on mount.
    delete (window as any).electronAPI;

    expect(() => {
      mounted = render(<ExtensionNotification />);
    }).not.toThrow();
  });
});

/**
 * The return leg of `ui:notify`.
 *
 * What breaks if this block goes red: a card becomes a dead end. The extension
 * can put a code on screen but never learns that the reader took it, so the
 * acceptance case — copying an OTP marks its message read — silently stops
 * working with nothing on screen to show for it. The four actions are
 * deliberately distinct: an extension treats a code that was copied differently
 * from one that expired unused.
 */
describe('reporting actions back to the extension', () => {
  it('reports a copy, naming the field that was copied', async () => {
    mounted = render(<ExtensionNotification />);
    push(
      card({
        emailId: 'email-1',
        accountId: 'account-1',
        fields: [
          { label: 'Sender', value: 'Acme' },
          { label: 'Code', value: '481920', copyable: true },
        ],
      })
    );

    fire(mounted.byLabel('Copy Code'), 'click');
    await act(async () => {});

    expect(h.actions).toEqual([
      {
        notificationId: 'otp-code:c1',
        action: {
          action: 'copy',
          emailId: 'email-1',
          accountId: 'account-1',
          fieldIndex: 1,
          fieldLabel: 'Code',
        },
      },
    ]);
  });

  // Regression: reporting a copy the clipboard refused would mark a message
  // read whose code the reader never actually got.
  it('reports nothing when the clipboard write fails', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    mounted = render(<ExtensionNotification />);
    push(card({ emailId: 'email-1', fields: [{ label: 'Code', value: '481920', copyable: true }] }));

    fire(mounted.byLabel('Copy Code'), 'click');
    await act(async () => {});

    expect(h.actions).toHaveLength(0);
  });

  it('reports a dismiss when the reader takes the card away', async () => {
    mounted = render(<ExtensionNotification />);
    push(card({ emailId: 'email-1' }));

    fire(mounted.byLabel('Dismiss'), 'click');
    await act(async () => {});

    expect(h.actions.map((entry) => entry.action.action)).toEqual(['dismiss']);
  });

  // Regression: 'expire' and 'dismiss' must not collapse into one. Nobody acted
  // on an expiry, so an extension that files a message on dismissal must not
  // file one that simply timed out.
  it('reports an expiry when the card times out on its own', async () => {
    mounted = render(<ExtensionNotification />);
    push(card({ emailId: 'email-1', timeoutMs: 5_000 }));

    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });

    expect(h.actions.map((entry) => entry.action.action)).toEqual(['expire']);
    expect(text(mounted)).not.toContain('Verification code');
  });

  it('reports an open before navigating to the message', async () => {
    mounted = render(<ExtensionNotification />);
    push(card({ emailId: 'email-1', accountId: 'account-1' }));

    const open = mounted.all('button').find((el) => el.textContent === 'Open the message');
    fire(open!, 'click');
    await act(async () => {});

    expect(h.actions.map((entry) => entry.action.action)).toEqual(['open']);
    expect(h.opened).toEqual([{ emailId: 'email-1', accountId: 'account-1' }]);
  });

  // The extension asked for the dismissal itself, so telling it back would be
  // an echo — and an extension that files on dismissal would file twice.
  it('does not report a dismissal the extension asked for', async () => {
    mounted = render(<ExtensionNotification />);
    push(card({ emailId: 'email-1' }));

    act(() => {
      h.dismiss?.({ id: 'otp-code:c1', extensionId: 'otp-code' });
    });
    await act(async () => {});

    expect(h.actions).toHaveLength(0);
  });

  // Regression: reporting is best-effort. A disabled or crashed extension must
  // not make the copy button look broken or leave the card stuck on screen.
  it('still behaves normally when the report is refused', async () => {
    h.cardActionFails = true;
    mounted = render(<ExtensionNotification />);
    push(card({ emailId: 'email-1' }));

    fire(mounted.byLabel('Dismiss'), 'click');
    await act(async () => {});

    expect(text(mounted)).not.toContain('Verification code');
  });

  // An older build's preload has no `cardAction` at all; the optional chain has
  // to hold, or every card action throws on a version mismatch.
  it('survives a host that offers no card-action channel', async () => {
    (window as any).electronAPI.extensions.cardAction = undefined;
    mounted = render(<ExtensionNotification />);
    push(card({ emailId: 'email-1' }));

    expect(() => fire(mounted!.byLabel('Dismiss'), 'click')).not.toThrow();
    await act(async () => {});
    expect(text(mounted)).not.toContain('Verification code');
  });
});
