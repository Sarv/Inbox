// @vitest-environment happy-dom
import type { EmailRecord } from '@sarvinbox/core';
import { act } from 'react-dom/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { render } from '../../../../helpers/render';

import { email, TEN_AM } from './email-fixture';

/**
 * Opening an attachment from the chat view.
 *
 * What breaks if this file goes red: the chat surface loses the only path it
 * has to an attachment. The library's own chips are deliberately not used —
 * they are inert `<span>`s, so they cannot be focused and cannot carry a
 * tooltip — and the app draws its own strip from `renderFooter` instead. If the
 * handlers below go back to the library, or the pill stops being a button, the
 * chat view silently returns to what it was: a chip that does nothing on click
 * and nothing at all from the keyboard.
 */

/** Props the component handed the library on the last render. */
const handed: { onPreviewAttachment?: unknown; onDownloadAttachment?: unknown } = {};

// A stand-in for the chat library. `renderFooter` is where the app's strip
// lands (in the real library it is the last child of the bubble, directly after
// the strip this app hides), so the mock only has to call it.
vi.mock('@sarv-in/email-chat-view', () => ({
  MailChatView: ({
    messages,
    renderFooter,
    onPreviewAttachment,
    onDownloadAttachment,
  }: {
    messages: readonly { id: string }[];
    renderFooter?: (message: { id: string }) => unknown;
    onPreviewAttachment?: unknown;
    onDownloadAttachment?: unknown;
  }) => {
    handed.onPreviewAttachment = onPreviewAttachment;
    handed.onDownloadAttachment = onDownloadAttachment;
    return (
      <div data-testid="chat-view">
        {messages.map((message) => (
          <div key={message.id} data-message-id={message.id}>
            {renderFooter?.(message) as never}
          </div>
        ))}
      </div>
    );
  },
}));

// The app's shared Tooltip, reduced to what it was asked to say and how fast.
// The real one is a hover-delayed portal, which a jsdom-less harness cannot
// hover; what matters here is that every icon-only control got one.
vi.mock('../../../../../src/components/Tooltip', () => ({
  Tooltip: ({
    children,
    content,
    delayMs,
  }: {
    children: React.ReactNode;
    content: string;
    delayMs?: number;
  }) => (
    <span data-tooltip={content} data-tooltip-delay={delayMs}>
      {children}
    </span>
  ),
}));

vi.mock('../../../../../src/components/email-detail/EmailMenu', () => ({
  EmailMenu: () => <div data-testid="menu" />,
}));
vi.mock('../../../../../src/components/InlineReply', () => ({ InlineReply: () => null }));
vi.mock('../../../../../src/components/InlineForward', () => ({ InlineForward: () => null }));

/** The viewer, reduced to the props it was opened with. */
const opened: { emailId?: string; initialIndex?: number; names?: string[] }[] = [];
vi.mock('../../../../../src/components/attachment-viewer/AttachmentViewer', () => ({
  AttachmentViewer: ({
    emailId,
    initialIndex,
    attachments,
  }: {
    emailId: string;
    initialIndex: number;
    attachments: { name: string }[];
  }) => {
    opened.push({ emailId, initialIndex, names: attachments.map((a) => a.name) });
    return <div data-testid="viewer" />;
  },
  // The pills render the size with the viewer's own formatter, so the header
  // and the chip can never disagree. Stubbed to something recognisable.
  formatSize: (bytes: number | string | null | undefined) =>
    typeof bytes === 'number' ? `${bytes} B` : '',
}));

const saveCopy = vi.fn();
vi.mock('../../../../../src/components/attachment-viewer/useAttachmentActions', () => ({
  useAttachmentActions: () => ({ saveCopy, isBusy: () => false }),
}));
vi.mock('../../../../../src/services/ai-service', () => ({
  buildPolishThreadContext: () => '',
  getCurrentUserEmail: () => 'me@acme.example',
}));
vi.mock('../../../../../src/services/image-cache', () => ({
  resolveRefsInHtml: (html: string) => html,
}));
vi.mock('../../../../../src/store/helpers', () => ({
  qualifiesForSafeAutoLoad: () => false,
  shouldAutoLoadRemoteImages: () => false,
}));

const storeState = {
  failedBodies: new Set<string>(),
  fetchEmailBody: vi.fn(),
  markMessageStarred: vi.fn(),
  clearSelectedEmail: vi.fn(),
};
vi.mock('../../../../../src/store/email-store', () => ({
  useEmailStore: Object.assign(
    (select: (state: typeof storeState) => unknown) => select(storeState),
    { getState: () => storeState, setState: vi.fn() },
  ),
}));

const { ThreadChatView } = await import('../../../../../src/components/email-detail/ThreadChatView');

const WITH_FILES = email({
  id: 'files-1',
  date: TEN_AM,
  rawBody: '<p>Both attached.</p>',
  hasAttachments: true,
  attachmentNames: 'report.pdf,notes.txt',
  attachmentSizes: '[1024,568]',
} as Partial<EmailRecord> & { id: string });

const NO_FILES = email({
  id: 'plain-1',
  date: TEN_AM,
  rawBody: '<p>Nothing attached.</p>',
} as Partial<EmailRecord> & { id: string });

const context = (threadEmails: EmailRecord[]) =>
  new Proxy(
    {
      displayEmail: threadEmails[0],
      threadEmails,
      conversationMessages: null,
      conversationLoading: false,
      conversationError: null,
      conversationProgress: null,
      showAIView: false,
      showInlineReply: false,
      showInlineForward: false,
      replyingToEmail: null,
      forwardingEmail: null,
      inlineReplyDraft: null,
      inlineReplyMode: 'reply',
      handleReExtractMessage: undefined,
    } as Record<string, unknown>,
    { get: (target, key) => (key in target ? target[key as string] : vi.fn()) },
  ) as never;

const click = (element: Element) =>
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });

// The render helper's `all`/`byLabel` search the whole document, so that they
// can reach portalled tooltips and overlays. Mounts therefore have to be torn
// down between tests, or a query here matches the PREVIOUS test's DOM — which
// reads as a pass for markup this render never produced.
const mounted: ReturnType<typeof render>[] = [];
const mount = (element: Parameters<typeof render>[0]) => {
  const view = render(element);
  mounted.push(view);
  return view;
};
afterEach(() => {
  mounted.splice(0).forEach((view) => view.unmount());
});

const openPill = (view: ReturnType<typeof render>, filename: string) =>
  view.all('.sarv-chip__open').find((el) => el.textContent?.includes(filename))!;

describe('ThreadChatView attachments', () => {
  // Regression: the library's chips come back. Passing either handler is what
  // draws them, and they would then sit above the app's own strip — two rows of
  // the same attachments, one of them inert.
  it('hands the library neither attachment handler, so it draws no chips', () => {
    mount(<ThreadChatView ctx={context([WITH_FILES])} />);
    expect(handed.onPreviewAttachment).toBeUndefined();
    expect(handed.onDownloadAttachment).toBeUndefined();
  });

  // Regression: the pill goes back to being a `<span>`. That is what made the
  // chip unreachable by keyboard and left it with no element the app owns to
  // hang a tooltip on — the whole reason the strip moved into app code.
  it('renders each attachment as a button with a tooltip and an accessible name', () => {
    const view = mount(<ThreadChatView ctx={context([WITH_FILES])} />);
    const pill = openPill(view, 'report.pdf');

    expect(pill.tagName).toBe('BUTTON');
    expect(pill.getAttribute('aria-label')).toBe('Open report.pdf');

    const tip = pill.closest('[data-tooltip]');
    // The full filename, because the pill ellipsises it at 22ch and the native
    // `title` that used to reveal it is deliberately gone.
    expect(tip?.getAttribute('data-tooltip')).toBe('Open report.pdf');
    // 40ms, per the project's UI convention — the default 150ms reads as lag.
    expect(tip?.getAttribute('data-tooltip-delay')).toBe('40');

    // The size comes from the viewer's formatter, not a second one here.
    expect(pill.textContent).toContain('1024 B');
  });

  // Regression: clicking a pill opens the wrong file, or opens it with no
  // siblings so the viewer's next/previous arrows dead-end.
  it('opens the viewer on the clicked attachment, with its siblings alongside', () => {
    opened.length = 0;
    const view = mount(<ThreadChatView ctx={context([WITH_FILES])} />);
    click(openPill(view, 'notes.txt'));

    const last = opened[opened.length - 1];
    expect(last.emailId).toBe('files-1');
    // Every attachment on the message travels, so the arrows work here too...
    expect(last.names).toEqual(['report.pdf', 'notes.txt']);
    // ...positioned at the one that was actually clicked.
    expect(last.initialIndex).toBe(1);
  });

  // Regression: the same click both downloads AND opens the viewer. The save
  // button sits inside the pill, so its click bubbles through it.
  it('saves a copy without opening the viewer when the save button is clicked', () => {
    opened.length = 0;
    saveCopy.mockClear();
    const view = mount(<ThreadChatView ctx={context([WITH_FILES])} />);
    click(view.byLabel('Save a copy of report.pdf')!);

    expect(saveCopy).toHaveBeenCalledWith(
      expect.objectContaining({ emailId: 'files-1', filename: 'report.pdf' }),
    );
    expect(opened).toHaveLength(0);
  });

  // Regression: the save button loses its tooltip. It is icon-only, which the
  // project's UI convention says must always name what it does.
  it('gives the save button a tooltip of its own', () => {
    const view = mount(<ThreadChatView ctx={context([WITH_FILES])} />);
    const save = view.byLabel('Save a copy of report.pdf')!;

    expect(save.tagName).toBe('BUTTON');
    expect(save.closest('[data-tooltip]')?.getAttribute('data-tooltip')).toBe('Save a copy');
    expect(save.closest('[data-tooltip]')?.getAttribute('data-tooltip-delay')).toBe('40');
  });

  // Regression: an empty strip renders under every message without an
  // attachment, adding the library's `--sec-gap` of dead space to each bubble.
  it('renders no strip for a message with no attachments', () => {
    const view = mount(<ThreadChatView ctx={context([NO_FILES])} />);
    expect(view.all('.sarv-attachments')).toHaveLength(0);
  });
});
