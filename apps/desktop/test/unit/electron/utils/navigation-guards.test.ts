import { ATTACHMENT_SCHEME } from '@sarvinbox/core';
import { describe, expect, it, vi } from 'vitest';

import { installNavigationGuards, type GuardedNavigation } from '../../../../electron/utils/navigation-guards';

// The wiring of the window's two navigation guards (main.ts cannot be imported
// by a test). What breaks if this file fails: a navigation the policy refuses
// still happens (no preventDefault), a web link renders inside the inbox
// instead of the browser, the frame guard offers its frame-only schemes to the
// whole window, or the guard reads a URL argument Electron no longer sends.

const APP = 'file:///Applications/Sarv%20Inbox.app/Contents/Resources/app.asar/dist/index.html';

function harness() {
  const listeners = new Map<string, (event: GuardedNavigation) => void>();
  const contents = { on: vi.fn((name: string, fn: (event: GuardedNavigation) => void) => { listeners.set(name, fn); }) };
  const deps = { openExternal: vi.fn(async () => {}), warn: vi.fn() };
  installNavigationGuards(contents as never, APP, deps);
  const fire = (name: 'will-navigate' | 'will-frame-navigate', url: unknown, isMainFrame?: boolean) => {
    const event = { url, isMainFrame, preventDefault: vi.fn() } as unknown as GuardedNavigation & { preventDefault: ReturnType<typeof vi.fn> };
    listeners.get(name)!(event);
    return event;
  };
  return { fire, deps };
}

describe('installNavigationGuards', () => {
  // CASA M-6: a local HTML file must not replace the app or the email frame.
  it.each(['will-navigate', 'will-frame-navigate'] as const)('blocks a foreign file: page on %s', (name) => {
    const { fire, deps } = harness();
    const event = fire(name, 'file:///Users/me/Downloads/invoice.html', name === 'will-navigate' ? undefined : false);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(deps.openExternal).not.toHaveBeenCalled();
    expect(deps.warn).toHaveBeenCalledWith(expect.stringContaining('Blocked'), 'file:///Users/me/Downloads/invoice.html');
  });

  it('lets the app reload itself', () => {
    const { fire } = harness();
    expect(fire('will-navigate', APP).preventDefault).not.toHaveBeenCalled();
    expect(fire('will-frame-navigate', APP, true).preventDefault).not.toHaveBeenCalled();
  });

  // Breaks: a link in an email renders inside the reading pane.
  it('sends web links to the browser instead', () => {
    const { fire, deps } = harness();
    const event = fire('will-frame-navigate', 'https://evil.example/login', false);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(deps.openExternal).toHaveBeenCalledWith('https://evil.example/login');
  });

  // will-frame-navigate also fires for the main frame. Breaks: the frame-only
  // allowance for the attachment scheme is offered to the whole window.
  it('applies the top-level rules when the main frame navigates', () => {
    const { fire } = harness();
    const url = `${ATTACHMENT_SCHEME}://attachment/email-1/report.pdf`;
    expect(fire('will-frame-navigate', url, true).preventDefault).toHaveBeenCalledOnce();
    expect(fire('will-frame-navigate', url, false).preventDefault).not.toHaveBeenCalled();
  });

  // The URL is read from the event object. Breaks: if Electron stops sending
  // it, the guard throws before preventDefault and the navigation proceeds.
  it('blocks when the event carries no url', () => {
    const { fire } = harness();
    expect(fire('will-navigate', undefined).preventDefault).toHaveBeenCalledOnce();
    expect(fire('will-frame-navigate', undefined, false).preventDefault).toHaveBeenCalledOnce();
  });

  it('logs a failed hand-off to the browser instead of rejecting unhandled', async () => {
    const { fire, deps } = harness();
    deps.openExternal.mockRejectedValueOnce(new Error('no handler'));
    fire('will-navigate', 'mailto:a@b.com');
    await Promise.resolve();
    await Promise.resolve();
    expect(deps.warn).toHaveBeenCalledWith('[Main] openExternal failed:', expect.any(Error));
  });
});
