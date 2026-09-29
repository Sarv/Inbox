// @vitest-environment happy-dom
import { MailChatView, type ChatMessage } from '@sarv-in/email-chat-view';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AttachmentPills } from '../../../../../src/components/attachment-viewer/AttachmentPills';
import { act, render, toggle, type Mounted } from '../../../../helpers/render';

/**
 * The attachment strip inside a REAL chat bubble, with the viewer it opens.
 *
 * What breaks if this file goes red: a right-click inside an open attachment
 * preview is taken for a right-click on the message, and the message menu
 * (Reply, Delete…) opens over or under the preview — taking focus, so the next
 * Escape closes that menu instead of the preview. The pills are drawn through
 * the library's `renderFooter`, inside the bubble, and the viewer used to be
 * drawn inline with them; only the viewer living OUTSIDE the bubble in the DOM
 * makes the library's "is this inside the message?" check turn it away. The
 * real library is used on purpose: that check lives in it, and a stand-in
 * would only test the stand-in.
 */

vi.mock('../../../../../src/components/attachment-viewer/useAttachmentActions', () => ({
  useAttachmentActions: () => ({ isBusy: () => false, saveCopy: vi.fn(), openInSystemApp: vi.fn() }),
}));

const MESSAGE: ChatMessage = {
  id: 'm1',
  fromAddress: 'bob@acme.example',
  fromName: 'Bob Ray',
  date: Date.UTC(2026, 2, 3, 10),
  body: '<p>The signed copy, as promised.</p>',
};

let mounted: Mounted | null = null;
afterEach(() => {
  mounted?.unmount();
  mounted = null;
  document.body.innerHTML = '';
});

/** A bubble whose footer carries one image attachment, as ThreadChatView draws it. */
const mountBubble = (onMessageMenu: (message: ChatMessage) => boolean) => {
  mounted = render(
    <MailChatView
      messages={[MESSAGE]}
      onMessageMenu={onMessageMenu}
      renderFooter={() => (
        <AttachmentPills emailId="m1" attachments={[{ name: 'contract.png', size: 2048 }]} />
      )}
    />,
  );
  return mounted;
};

/** A right-click, as the browser dispatches it. */
const rightClick = (target: Element | null) => {
  if (!target) throw new Error('nothing to right-click');
  const event = new MouseEvent('contextmenu', {
    bubbles: true,
    cancelable: true,
    clientX: 300,
    clientY: 200,
  });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
};

describe('AttachmentPills in a chat bubble', () => {
  // The control: the message itself still answers a right-click — so the
  // assertions below are about the viewer, not a menu that never opens.
  it('lets a right-click on the message open its menu', () => {
    const onMessageMenu = vi.fn(() => true);
    const view = mountBubble(onMessageMenu);
    rightClick(view.find('.sec-body'));
    expect(onMessageMenu).toHaveBeenCalledTimes(1);
  });

  // THE regression: the preview is not the message.
  it('opens no message menu for a right-click inside an open preview', () => {
    const onMessageMenu = vi.fn(() => true);
    const view = mountBubble(onMessageMenu);
    toggle(view.byLabel('Open contract.png'));

    const viewer = view.find('[role="dialog"]');
    expect(viewer).not.toBeNull();
    // Out of the bubble in the DOM — the reason the library turns it away.
    expect(view.find('.sec-col')!.contains(viewer)).toBe(false);

    // The image, a control in the viewer's header, and the backdrop.
    const events = [
      rightClick(viewer!.querySelector('img')),
      rightClick(view.byLabel('Close attachment viewer')),
      rightClick(viewer),
    ];

    expect(onMessageMenu).not.toHaveBeenCalled();
    // Nor is the browser's own menu suppressed on the reader's behalf.
    expect(events.map((event) => event.defaultPrevented)).toEqual([false, false, false]);
  });
});
