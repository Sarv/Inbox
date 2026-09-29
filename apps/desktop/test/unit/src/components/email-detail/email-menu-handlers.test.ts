import { afterEach, describe, expect, it, vi } from 'vitest';

import type { EmailMenuContext } from '../../../../../src/components/email-detail/email-menu-handlers';

const storeState = { clearSelectedEmail: vi.fn() };
vi.mock('../../../../../src/store/email-store', () => ({
  useEmailStore: { getState: () => storeState },
}));

const { buildEmailMenuHandlers, buildReplyHandlers } = await import(
  '../../../../../src/components/email-detail/email-menu-handlers'
);

/**
 * The one wiring behind every copy of the message menu — the three-dot menu on
 * a reply in the list, on the anchor card, in the toolbar and on a chat bubble,
 * and the chat's right-click menu.
 *
 * What breaks if this file goes red: the same item means different things in
 * different places. Forward opening the popup from the chat (which has its own
 * composer), Delete removing the whole conversation from a single reply's menu,
 * or an action reaching a different message than the one it was chosen on.
 */

const MAIL = { id: 'm1', fromAddress: 'bob@acme.example' };

const newContext = () => {
  const ctx = {
    handleReply: vi.fn(),
    handleReplyAll: vi.fn(),
    handleForward: vi.fn(),
    handleInlineForward: vi.fn(),
    handleDelete: vi.fn(async () => {}),
    handleArchive: vi.fn(async () => {}),
    deleteEmail: vi.fn(async () => {}),
    archiveEmail: vi.fn(async () => {}),
    markAsRead: vi.fn(async () => {}),
    handleReportSpam: vi.fn(async () => {}),
    handlePrintEmail: vi.fn(),
    handleDownloadEmail: vi.fn(),
    handleShowOriginal: vi.fn(),
    handleFilterLikeThis: vi.fn(),
    handleTranslate: vi.fn(),
    handleDetectSignature: vi.fn(async () => {}),
  };
  return ctx satisfies EmailMenuContext;
};

afterEach(() => {
  storeState.clearSelectedEmail.mockReset();
});

describe('buildReplyHandlers', () => {
  // Reply and Reply all open inline from every surface — `false` is "not the
  // popup" — and each answers the message it was built for.
  it('replies inline to the given message', () => {
    const ctx = newContext();
    const handlers = buildReplyHandlers(ctx, MAIL, 'popup');
    handlers.onReply();
    handlers.onReplyAll();
    expect(ctx.handleReply.mock.calls).toEqual([[MAIL, false]]);
    expect(ctx.handleReplyAll.mock.calls).toEqual([[MAIL, false]]);
  });

  // The regression the forward mode exists for: the standard view's menus
  // forward in the popup, the chat's inline — and neither may do both.
  it('forwards in the popup composer in popup mode', () => {
    const ctx = newContext();
    buildReplyHandlers(ctx, MAIL, 'popup').onForward();
    expect(ctx.handleForward.mock.calls).toEqual([[MAIL]]);
    expect(ctx.handleInlineForward).not.toHaveBeenCalled();
  });

  it('forwards inline in inline mode', () => {
    const ctx = newContext();
    buildReplyHandlers(ctx, MAIL, 'inline').onForward();
    expect(ctx.handleInlineForward.mock.calls).toEqual([[MAIL]]);
    expect(ctx.handleForward).not.toHaveBeenCalled();
  });
});

describe('buildEmailMenuHandlers — each site keeps its own flavour', () => {
  // Per site, what Forward opens and what Delete / Archive remove. These are
  // the combinations the four sites pass; a change to any of them is a change
  // to what that site's menu does.
  it.each([
    ['a reply in the list', 'popup', 'message'],
    ['the anchor card', 'popup', 'thread'],
    ['the toolbar', 'popup', 'thread'],
    ['a chat bubble', 'inline', 'message'],
  ] as const)('%s: forward %s, removes the %s', (_site, forward, removes) => {
    const ctx = newContext();
    const handlers = buildEmailMenuHandlers(ctx, MAIL, { forward, removes });
    handlers.onForward();
    handlers.onDelete();
    handlers.onArchive();

    expect(ctx.handleForward).toHaveBeenCalledTimes(forward === 'popup' ? 1 : 0);
    expect(ctx.handleInlineForward).toHaveBeenCalledTimes(forward === 'inline' ? 1 : 0);
    if (removes === 'thread') {
      expect(ctx.handleDelete.mock.calls).toEqual([[]]);
      expect(ctx.handleArchive.mock.calls).toEqual([[]]);
      expect(ctx.deleteEmail).not.toHaveBeenCalled();
      expect(ctx.archiveEmail).not.toHaveBeenCalled();
    } else {
      expect(ctx.deleteEmail.mock.calls).toEqual([['m1']]);
      expect(ctx.archiveEmail.mock.calls).toEqual([['m1']]);
      expect(ctx.handleDelete).not.toHaveBeenCalled();
      expect(ctx.handleArchive).not.toHaveBeenCalled();
    }
  });

  // Every other item acts on THIS message — by id where the handler takes an
  // id, by the record where it takes the record.
  it('points every other item at the given message', () => {
    const ctx = newContext();
    const handlers = buildEmailMenuHandlers(ctx, MAIL, { forward: 'inline', removes: 'message' });
    handlers.onReportSpam();
    handlers.onPrint();
    handlers.onDownload();
    handlers.onShowOriginal();
    handlers.onFilterLikeThis();
    handlers.onTranslate();
    handlers.onDetectSignature();

    expect(ctx.handleReportSpam.mock.calls).toEqual([['m1']]);
    for (const fn of [
      ctx.handlePrintEmail,
      ctx.handleDownloadEmail,
      ctx.handleShowOriginal,
      ctx.handleFilterLikeThis,
      ctx.handleTranslate,
      ctx.handleDetectSignature,
    ]) {
      expect(fn.mock.calls).toEqual([[MAIL]]);
    }
  });

  // Mark as unread writes the flag, THEN closes the message — the order every
  // copy of this wiring had.
  it('marks unread, then closes the message', async () => {
    const ctx = newContext();
    const order: string[] = [];
    ctx.markAsRead.mockImplementation(async () => void order.push('flag'));
    storeState.clearSelectedEmail.mockImplementation(() => void order.push('close'));

    await buildEmailMenuHandlers(ctx, MAIL, { forward: 'popup', removes: 'message' }).onMarkUnread();

    expect(ctx.markAsRead.mock.calls).toEqual([['m1', false]]);
    expect(order).toEqual(['flag', 'close']);
  });

  // Failure path: the flag write failed (the store is unreachable), so the
  // message stays open — closing it would tell the reader it worked.
  it('leaves the message open when marking it unread fails', async () => {
    const ctx = newContext();
    ctx.markAsRead.mockRejectedValue(new Error('storage unavailable'));

    await expect(
      buildEmailMenuHandlers(ctx, MAIL, { forward: 'popup', removes: 'message' }).onMarkUnread(),
    ).rejects.toThrow('storage unavailable');
    expect(storeState.clearSelectedEmail).not.toHaveBeenCalled();
  });

  // Reply and Reply all come from the same builder as the hover icons', so a
  // menu and an icon on one message can never answer differently.
  it('answers exactly as buildReplyHandlers does', () => {
    const viaMenu = newContext();
    const viaIcons = newContext();
    const menu = buildEmailMenuHandlers(viaMenu, MAIL, { forward: 'inline', removes: 'message' });
    const icons = buildReplyHandlers(viaIcons, MAIL, 'inline');
    for (const key of ['onReply', 'onReplyAll', 'onForward'] as const) {
      menu[key]();
      icons[key]();
    }
    for (const key of ['handleReply', 'handleReplyAll', 'handleInlineForward', 'handleForward'] as const) {
      expect(viaMenu[key].mock.calls).toEqual(viaIcons[key].mock.calls);
    }
  });

  // The handlers read the message they were built for, not whatever is open:
  // two menus on two messages act on two messages.
  it('keeps two messages\' handlers apart', () => {
    const ctx = newContext();
    const other = { id: 'm2' };
    const first = buildEmailMenuHandlers(ctx, MAIL, { forward: 'inline', removes: 'message' });
    const second = buildEmailMenuHandlers(ctx, other, { forward: 'inline', removes: 'message' });
    second.onDelete();
    first.onDelete();
    expect(ctx.deleteEmail.mock.calls).toEqual([['m2'], ['m1']]);
  });
});
