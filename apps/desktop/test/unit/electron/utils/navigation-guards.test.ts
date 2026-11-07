import { ATTACHMENT_SCHEME, panelAssetUrl } from '@sarvinbox/core';
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
  const fire = (
    name: 'will-navigate' | 'will-frame-navigate',
    url: unknown,
    isMainFrame?: boolean,
    from?: Pick<GuardedNavigation, 'frame' | 'initiator'>,
  ) => {
    const event = { url, isMainFrame, ...from, preventDefault: vi.fn() } as unknown as GuardedNavigation & { preventDefault: ReturnType<typeof vi.fn> };
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

  describe('extension panels', () => {
    const PANEL = panelAssetUrl('clamav-scan', 'panel/index.html');
    const OTHER = panelAssetUrl('other-ext', 'panel/index.html');
    /** A WebFrameMain whose render frame is gone: Electron's getters throw. */
    const disposed = {
      get url(): string {
        throw new Error('Render frame was disposed before WebFrameMain could be accessed');
      },
    };

    // Breaks: no panel loads. The frame guard must hand the policy the frame
    // that set the iframe's src, or the app's own panel load is refused.
    it('lets the app load a panel into an iframe', () => {
      const { fire, deps } = harness();
      const event = fire('will-frame-navigate', PANEL, false, { frame: { url: '' }, initiator: { url: APP } });
      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(deps.warn).not.toHaveBeenCalled();
    });

    // Breaks: a panel navigates itself into another extension's page.
    it('blocks a panel moving itself to another extension', () => {
      const { fire, deps } = harness();
      const event = fire('will-frame-navigate', OTHER, false, { frame: { url: PANEL }, initiator: { url: PANEL } });
      expect(event.preventDefault).toHaveBeenCalledOnce();
      expect(deps.warn).toHaveBeenCalledWith(expect.stringContaining('Blocked frame-level'), OTHER);
    });

    // Breaks: a panel replaces the window. The main frame gets the top-level
    // rules even when the app itself started the navigation.
    it('blocks a panel in the main frame on both events', () => {
      const { fire } = harness();
      expect(fire('will-frame-navigate', PANEL, true, { frame: { url: APP }, initiator: { url: APP } }).preventDefault).toHaveBeenCalledOnce();
      expect(fire('will-navigate', PANEL).preventDefault).toHaveBeenCalledOnce();
    });

    // Breaks: a disposed frame's throwing getter escapes the guard before
    // preventDefault, and the navigation goes ahead unchecked.
    it('blocks when the frame and initiator cannot be read', () => {
      const { fire } = harness();
      expect(fire('will-frame-navigate', PANEL, false, { frame: disposed, initiator: disposed }).preventDefault).toHaveBeenCalledOnce();
      expect(fire('will-frame-navigate', PANEL, false, { frame: null, initiator: null }).preventDefault).toHaveBeenCalledOnce();
    });

    // Breaks: one unreadable field sinks the other. A panel following its own
    // link is decided by the frame alone when the initiator is gone.
    it('reads the frame even when the initiator is unreadable', () => {
      const { fire } = harness();
      const next = panelAssetUrl('clamav-scan', 'panel/details.html');
      expect(fire('will-frame-navigate', next, false, { frame: { url: PANEL }, initiator: disposed }).preventDefault).not.toHaveBeenCalled();
    });
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
