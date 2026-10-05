// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CategoryMenu } from '../../../../src/components/CategoryMenu';
import { act, cleanup, fire, render, settle } from '../../../helpers/render';

const ui = vi.hoisted(() => ({ apply: vi.fn(), refresh: vi.fn() }));
vi.mock('../../../../src/components/email-list/CategoryBadges', () => ({ applyEmailCategories: ui.apply }));
vi.mock('../../../../src/store/email-store', () => ({ useEmailStore: { getState: () => ({ refreshCategoryCounts: ui.refresh }) } }));

const getDefinitions = vi.fn();
const getCategories = vi.fn();
const setCategory = vi.fn();
const definitions = [{ slug: 'important', name: 'Important', isEnabled: true },
  { slug: 'promotions', name: 'Promotions', isEnabled: true }];

beforeEach(() => {
  vi.clearAllMocks();
  getDefinitions.mockResolvedValue({ success: true, data: definitions });
  getCategories.mockResolvedValue({ success: true, data: { message: ['promotions'] } });
  setCategory.mockResolvedValue({ success: true, data: ['promotions', 'important'], syncStatus: 'queued' });
  window.electronAPI = { ai: { getCategoryDefinitions: getDefinitions, getEmailCategoriesBatch: getCategories, setEmailCategory: setCategory } } as unknown as typeof window.electronAPI;
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const button = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find((element) => element.textContent === name)!;
async function open() {
  const view = render(<CategoryMenu emailId="message" accountId="account-b" />);
  fire(view.byLabel('Categories'), 'click');
  await settle();
  return view;
}

describe('manual category popup', () => {
  // Regression: a unified-inbox row must read and update its owning account, not the active account.
  it('shows current selections and stages an independent Important choice until Apply', async () => {
    await open();
    expect(getDefinitions).toHaveBeenCalledWith('account-b');
    expect(getCategories).toHaveBeenCalledWith(['message'], 'account-b');
    expect(button('Promotions').getAttribute('aria-checked')).toBe('true');
    fire(button('Important'), 'click');
    expect(setCategory).not.toHaveBeenCalled();
    fire(button('Apply'), 'click');
    await settle();
    expect(setCategory).toHaveBeenCalledWith('message', 'important', true, 'account-b');
    expect(ui.apply).toHaveBeenCalledWith('message', ['promotions', 'important']);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  // Regression: Cancel must not send an IMAP write or retain the abandoned selection.
  it('discards edits on Cancel and Escape', async () => {
    const view = await open();
    fire(button('Promotions'), 'click');
    fire(button('Cancel'), 'click');
    expect(setCategory).not.toHaveBeenCalled();
    fire(view.byLabel('Categories'), 'click');
    await settle();
    expect(button('Promotions').getAttribute('aria-checked')).toBe('true');
    fire(document.querySelector('[role="dialog"]'), 'keydown', { key: 'Escape' });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  // Regression: failed server sync must remain visible and cannot replace the current local categories.
  it('shows server errors without applying a rejected category', async () => {
    setCategory.mockResolvedValue({ success: false, error: 'Sign in with Gmail OAuth to change built-in categories' });
    await open();
    fire(button('Promotions'), 'click');
    fire(button('Apply'), 'click');
    await settle();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Gmail OAuth');
    expect(ui.apply).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });

  // Regression: an unreadable category list must never be treated as an empty writable selection.
  it('disables Apply when loading category definitions fails', async () => {
    getDefinitions.mockResolvedValue({ success: false, error: 'Account unavailable' });
    await open();
    expect(button('Apply').disabled).toBe(true);
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('Account unavailable');
    expect(setCategory).not.toHaveBeenCalled();
  });

  // Regression: slow category loads from a previous account must not overwrite the new account's popup.
  it('ignores a late result after switching the owning account', async () => {
    let resolveOld!: (value: unknown) => void;
    getCategories.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }));
    const view = await open();
    view.rerender(<CategoryMenu emailId="message" accountId="account-c" />);
    await settle();
    await act(async () => { resolveOld({ success: true, data: { message: ['important'] } }); });
    expect(button('Promotions').getAttribute('aria-checked')).toBe('true');
    expect(button('Important').getAttribute('aria-checked')).toBe('false');
    expect(getCategories).toHaveBeenLastCalledWith(['message'], 'account-c');
  });

  // Regression: completing an old message's save must not close or overwrite the new message's popup.
  it('keeps the new account popup intact when an earlier save completes', async () => {
    let finish!: (value: unknown) => void;
    setCategory.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const view = await open();
    fire(button('Important'), 'click');
    fire(button('Apply'), 'click');
    view.rerender(<CategoryMenu emailId="message" accountId="account-c" />);
    await settle();
    await act(async () => { finish({ success: true, data: ['important'] }); });
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(button('Promotions').getAttribute('aria-checked')).toBe('true');
    expect(ui.apply).not.toHaveBeenCalled();
    expect(setCategory).toHaveBeenCalledWith('message', 'important', true, 'account-b');
  });

  it('keeps Apply disabled while the account categories are loading', async () => {
    let finish!: (value: unknown) => void;
    getCategories.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await open();
    expect(document.querySelector('[role="status"]')?.textContent).toContain('Loading');
    expect(button('Apply').disabled).toBe(true);
    expect(setCategory).not.toHaveBeenCalled();
    await act(async () => { finish({ success: true, data: { message: [] } }); });
    expect(document.querySelector('[role="status"]')).toBeNull();
    expect(button('Apply').disabled).toBe(false);
  });

  it.each([
    ['category read', { success: false, error: 'Mailbox unavailable' }, 'Mailbox unavailable'],
    ['missing error detail', { success: false }, 'Unable to load categories.'],
  ])('explains a failed %s without allowing writes', async (_name, response, message) => {
    getCategories.mockResolvedValueOnce(response);
    await open();
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(message);
    expect(button('Apply').disabled).toBe(true);
  });

  it('shows a useful error for an unexpected category transport rejection', async () => {
    getDefinitions.mockRejectedValueOnce('connection closed');
    await open();
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('Unable to load categories.');
    expect(button('Apply').disabled).toBe(true);
  });

  it('does not resurrect a dismissed popup when its read later fails', async () => {
    let fail!: (reason: unknown) => void;
    getCategories.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
    await open();
    fire(button('Cancel'), 'click');
    await act(async () => { fail(new Error('Mailbox disconnected')); });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });

  it('shows an empty state when no definitions or selections are returned', async () => {
    getDefinitions.mockResolvedValueOnce({ success: true });
    getCategories.mockResolvedValueOnce({ success: true });
    await open();
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('No categories available.');
    expect(button('Apply').disabled).toBe(true);
    expect(document.querySelector('[role="checkbox"]')).toBeNull();
  });

  it('retains selected disabled and unknown categories so the user can clear them', async () => {
    getDefinitions.mockResolvedValueOnce({ success: true, data: [
      ...definitions,
      { slug: 'finance', name: 'Finance', isEnabled: false },
      { slug: 'meetings', name: 'Meetings', isEnabled: false },
    ] });
    getCategories.mockResolvedValueOnce({ success: true, data: { message: ['finance', 'legacy-label'] } });
    await open();
    expect(button('Finance').getAttribute('aria-checked')).toBe('true');
    expect(button('legacy-label').getAttribute('aria-checked')).toBe('true');
    expect(button('Meetings')).toBeUndefined();
    fire(button('Finance'), 'click');
    fire(button('legacy-label'), 'click');
    setCategory.mockResolvedValue({ success: true });
    fire(button('Apply'), 'click');
    await settle();
    expect(setCategory).toHaveBeenCalledWith('message', 'finance', false, 'account-b');
    expect(setCategory).toHaveBeenCalledWith('message', 'legacy-label', false, 'account-b');
    expect(ui.apply).toHaveBeenLastCalledWith('message', []);
  });

  it('closes on outside click, while clicking the popup or its trigger does not discard edits', async () => {
    const view = await open();
    fire(document.querySelector('[role="dialog"]'), 'mousedown');
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    fire(view.byLabel('Categories'), 'mousedown');
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    fire(button('Important'), 'click');
    fire(document.body, 'mousedown');
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(setCategory).not.toHaveBeenCalled();
    fire(view.byLabel('Categories'), 'click');
    await settle();
    expect(button('Important').getAttribute('aria-checked')).toBe('false');
  });

  it('uses successful acknowledgements without category data and retries only unsaved choices', async () => {
    setCategory.mockResolvedValueOnce({ success: true });
    setCategory.mockResolvedValueOnce({ success: false });
    setCategory.mockResolvedValueOnce({ success: true });
    await open();
    fire(button('Promotions'), 'click');
    fire(button('Important'), 'click');
    fire(button('Apply'), 'click');
    await settle();
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('Unable to change category.');
    expect(ui.apply).toHaveBeenLastCalledWith('message', []);
    fire(button('Apply'), 'click');
    await settle();
    expect(setCategory.mock.calls.map(([, slug, on]) => [slug, on])).toEqual([
      ['promotions', false], ['important', true], ['important', true],
    ]);
    expect(ui.apply).toHaveBeenLastCalledWith('message', ['important']);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('shows a useful save error when transport rejects without an Error object', async () => {
    setCategory.mockRejectedValueOnce('transport closed');
    await open();
    fire(button('Important'), 'click');
    fire(button('Apply'), 'click');
    await settle();
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('Unable to change category.');
    expect(ui.apply).not.toHaveBeenCalled();
    expect(button('Apply').disabled).toBe(false);
  });

  it('ignores a failed old save after switching messages', async () => {
    let fail!: (reason: unknown) => void;
    setCategory.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
    const view = await open();
    fire(button('Important'), 'click');
    fire(button('Apply'), 'click');
    view.rerender(<CategoryMenu emailId="new-message" accountId="account-c" />);
    await settle();
    await act(async () => { fail(new Error('Old request failed')); });
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(button('Important').getAttribute('aria-checked')).toBe('false');
  });

  it('keeps pending saves open and ignores unrelated keys', async () => {
    let finish!: (value: unknown) => void;
    setCategory.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const view = await open();
    fire(view.byLabel('Categories'), 'keydown', { key: 'ArrowDown' });
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    fire(button('Important'), 'click');
    fire(button('Apply'), 'click');
    fire(document.querySelector('[role="dialog"]'), 'keydown', { key: 'Escape' });
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(button('Cancel').disabled).toBe(true);
    expect(button('Applying…').disabled).toBe(true);
    await act(async () => { finish({ success: true, data: ['important'] }); });
    fire(view.byLabel('Categories'), 'click');
    await settle();
    fire(view.byLabel('Categories'), 'keydown', { key: 'Escape' });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it.each(['left edge', 'right edge'])('keeps the popup in the viewport near the %s', async (edge) => {
    const height = 200;
    const triggerTop = window.innerHeight - 24;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const dialog = this.getAttribute('role') === 'dialog';
      return {
        top: dialog ? 0 : triggerTop, bottom: dialog ? height : triggerTop + 20,
        left: dialog ? 0 : edge === 'left edge' ? -30 : window.innerWidth + 30,
        right: dialog ? 264 : 0, width: dialog ? 264 : 20, height: dialog ? height : 20,
        x: 0, y: 0, toJSON: () => ({}),
      };
    });
    const view = render(<CategoryMenu emailId="message" buttonClassName="compact-button" label="Edit categories" showIcon={false} />);
    expect(view.byLabel('Categories')?.textContent).toBe('Edit categories');
    fire(view.byLabel('Categories'), 'click');
    await settle();
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    const left = Number.parseFloat(dialog.style.left);
    const top = Number.parseFloat(dialog.style.top);
    expect(left).toBeGreaterThanOrEqual(0);
    expect(left + 264).toBeLessThanOrEqual(window.innerWidth);
    expect(top).toBeGreaterThanOrEqual(0);
    expect(top + height).toBeLessThanOrEqual(triggerTop);
  });
});
