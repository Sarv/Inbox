// @vitest-environment happy-dom
import type { AvailablePanel } from '@sarvinbox/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';


import { ExtensionPanelFrame } from '../../../../../src/components/extensions/ExtensionPanelFrame';
import { act, render, settle } from '../../../../helpers/render';

/**
 * The renderer half of the extension panel bridge.
 *
 * What breaks if this file goes red: the boundary between a panel and the app.
 * The frame relays panel requests to main, which is where permissions are
 * checked — so the two things that must never slip are (a) a request is only
 * ever attributed to the frame it actually came from, and (b) the request is
 * passed through untouched with the id of the message the reader has open now.
 * Get (a) wrong and any page in the app can speak as an extension; get (b)
 * wrong and a panel reads a message the reader is not looking at.
 */

const CHANNEL = 'sarv-panel-bridge';

const available: AvailablePanel = {
  extensionId: 'com.example.notes',
  extensionName: 'Notes',
  panel: { id: 'notes', title: 'Notes', entry: 'panel.html', surface: 'sidebar' },
  url: 'sarv-extension://com.example.notes/panel.html',
};

const panelRequest = vi.fn();
let mounted: ReturnType<typeof render> | null = null;

beforeEach(() => {
  // happy-dom tries to fetch an iframe's src and cannot resolve the app's
  // privileged scheme; the frame is driven directly here, so stop it loading.
  const happyDOM = (window as unknown as { happyDOM?: { settings: { disableIframePageLoading: boolean } } })
    .happyDOM;
  if (happyDOM) happyDOM.settings.disableIframePageLoading = true;
  // ...and it reports that refusal on the page console; nothing under test
  // writes there, so the whole channel is silenced for the duration.
  vi.spyOn(console, 'error').mockImplementation(() => {});
  panelRequest.mockReset().mockResolvedValue({ requestId: 'r1', ok: true, value: 'stored' });
  (window as unknown as Record<string, unknown>).electronAPI = {
    extensions: { panelRequest },
  };
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  delete (window as unknown as Record<string, unknown>).electronAPI;
  vi.restoreAllMocks();
});

/** The frame element and a spy standing in for the panel document inside it. */
function mountFrame(props: Partial<Parameters<typeof ExtensionPanelFrame>[0]> = {}) {
  mounted = render(
    <ExtensionPanelFrame available={available} currentMessageId="msg-1" {...props} />
  );
  const frame = mounted.find('iframe') as HTMLIFrameElement;
  const posted: unknown[] = [];
  const source = { postMessage: (payload: unknown) => posted.push(payload) };
  Object.defineProperty(frame, 'contentWindow', { configurable: true, value: source });
  return { frame, posted, source };
}

async function deliver(source: unknown, data: unknown) {
  await act(async () => {
    const event = new MessageEvent('message', { data });
    Object.defineProperty(event, 'source', { configurable: true, value: source });
    window.dispatchEvent(event);
    await Promise.resolve();
  });
  await settle();
}

describe('ExtensionPanelFrame', () => {
  // A request from anything but this panel's own frame must not be attributed
  // to the extension: origin is "null" for a sandboxed frame, so the window
  // identity is the only check standing between the app and a forged request.
  it('ignores a request that did not come from its own frame', async () => {
    const { source } = mountFrame();
    await deliver({ postMessage: () => {} }, {
      channel: CHANNEL,
      requestId: 'r1',
      method: 'storage.get',
      params: { key: 'k' },
    });
    expect(panelRequest).not.toHaveBeenCalled();
    expect(source).toBeDefined();
  });

  // Anything that is not a well-formed request is dropped rather than forwarded,
  // so main never has to parse renderer-shaped noise.
  it('ignores a payload that is not a panel request', async () => {
    const { source } = mountFrame();
    await deliver(source, { hello: 'world' });
    expect(panelRequest).not.toHaveBeenCalled();
  });

  // The panel asked the app to close it; the app owns the frame, so this is
  // answered locally and never reaches main.
  it('handles panel.close itself and acknowledges it', async () => {
    const onRequestClose = vi.fn();
    const { source, posted } = mountFrame({ onRequestClose });
    await deliver(source, { channel: CHANNEL, requestId: 'c1', method: 'panel.close' });
    expect(onRequestClose).toHaveBeenCalledTimes(1);
    expect(panelRequest).not.toHaveBeenCalled();
    expect(posted).toContainEqual({ channel: CHANNEL, requestId: 'c1', ok: true });
  });

  // Sizing belongs to the app, but an unanswered request leaves the panel's own
  // promise pending forever — so it is acknowledged, not dropped.
  it('acknowledges panel.resize without calling main', async () => {
    const { source, posted } = mountFrame();
    await deliver(source, { channel: CHANNEL, requestId: 'z1', method: 'panel.resize', params: { height: 400 } });
    expect(panelRequest).not.toHaveBeenCalled();
    expect(posted).toContainEqual({ channel: CHANNEL, requestId: 'z1', ok: true });
  });

  // The relay: untouched payload, the extension's own id, and the message that
  // is open right now — the renderer names the message, the panel never does.
  it('relays everything else to main and posts the reply back', async () => {
    const { source, posted } = mountFrame();
    const request = { channel: CHANNEL, requestId: 'r1', method: 'storage.get', params: { key: 'k' } };
    await deliver(source, request);
    expect(panelRequest).toHaveBeenCalledWith('com.example.notes', request, {
      currentMessageId: 'msg-1',
    });
    expect(posted).toContainEqual({
      channel: CHANNEL,
      requestId: 'r1',
      ok: true,
      value: 'stored',
    });
  });

  // A refusal from main is relayed verbatim: a panel denied a permission has to
  // see the denial, not a silent nothing.
  it('relays a refusal back to the panel', async () => {
    panelRequest.mockResolvedValue({
      requestId: 'r2',
      ok: false,
      error: "Permission denied: Extension requires 'storage:local' permission",
    });
    const { source, posted } = mountFrame();
    await deliver(source, { channel: CHANNEL, requestId: 'r2', method: 'storage.set' });
    expect(posted).toContainEqual({
      channel: CHANNEL,
      requestId: 'r2',
      ok: false,
      error: "Permission denied: Extension requires 'storage:local' permission",
    });
  });

  // The reply must describe the message open NOW. If the id were captured when
  // the listener was attached, a panel would keep answering about the message
  // the reader has already moved on from.
  it('sends the current message id, not the one open at mount', async () => {
    const { source } = mountFrame();
    mounted?.rerender(<ExtensionPanelFrame available={available} currentMessageId="msg-2" />);
    await deliver(source, { channel: CHANNEL, requestId: 'r3', method: 'message.current' });
    expect(panelRequest).toHaveBeenCalledWith('com.example.notes', expect.anything(), {
      currentMessageId: 'msg-2',
    });
  });

  // The push half: a panel refreshes on this event instead of polling, so a
  // missing push is a panel that quietly shows the wrong message.
  it('pushes message-changed when the open message changes', async () => {
    const { source, posted } = mountFrame();
    expect(source).toBeDefined();
    posted.length = 0;
    await act(async () => {
      mounted?.rerender(<ExtensionPanelFrame available={available} currentMessageId="msg-2" />);
      await Promise.resolve();
    });
    expect(posted).toContainEqual({
      channel: CHANNEL,
      event: 'message-changed',
      payload: { id: 'msg-2' },
    });
  });

  // The frame keeps the sandbox flags it was written with: no popups, no top
  // navigation, no native modals. Losing one is not visible in the UI.
  it('renders the panel url in a sandboxed frame', () => {
    const { frame } = mountFrame();
    expect(frame.getAttribute('src')).toBe('sarv-extension://com.example.notes/panel.html');
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts allow-same-origin allow-forms');
    expect(frame.getAttribute('referrerPolicy')).toBe('no-referrer');
  });

  // Nothing may be relayed after the panel is gone: the listener is a window
  // listener, and one left behind would answer for an unmounted frame.
  it('stops relaying once unmounted', async () => {
    const { source } = mountFrame();
    mounted?.unmount();
    mounted = null;
    await deliver(source, { channel: CHANNEL, requestId: 'r4', method: 'storage.keys' });
    expect(panelRequest).not.toHaveBeenCalled();
  });
});
