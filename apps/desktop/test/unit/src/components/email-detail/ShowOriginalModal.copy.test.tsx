// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { fire, render, settle } from '../../../../helpers/render';

/**
 * "Show original" → Copy to Clipboard.
 *
 * What breaks if this file goes red: the one place in the app that hands a
 * user the raw RFC822 source either copies the wrong thing or copies silently.
 * The value is read at click time on purpose — the source arrives from the
 * server AFTER the modal first renders, so a value captured at render would
 * put the fallback reconstruction on the clipboard instead of the real source.
 */

const store = vi.hoisted(() => ({
  state: {
    rawSourceCache: {} as Record<string, string>,
    rawSourceLoading: new Set<string>(),
    prefetchRawSource: vi.fn(),
  },
}));

vi.mock('../../../../../src/store/email-store', () => ({
  useEmailStore: (selector: (s: typeof store.state) => unknown) => selector(store.state),
}));

const { ShowOriginalModal } = await import(
  '../../../../../src/components/email-detail/ShowOriginalModal'
);

const writeText = vi.fn(async (_text: string) => {});

const email = {
  id: 'email-1',
  messageId: '<m1@test>',
  fromName: 'Ada',
  fromAddress: 'ada@test',
  toAddress: 'bob@test',
  subject: 'Hello',
  cleanBody: 'body text',
};

let mounted: ReturnType<typeof render> | null = null;

beforeEach(() => {
  store.state.rawSourceCache = {};
  store.state.rawSourceLoading = new Set();
  store.state.prefetchRawSource.mockReset();
  writeText.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

const copyButton = () =>
  mounted!.all('button').find((el) => el.getAttribute('aria-label')?.startsWith('Cop')) ?? null;

// The fetched source — not the reconstruction — is what the pane shows, so it
// is what the clipboard must get.
it('copies the fetched raw source and confirms the copy', async () => {
  store.state.rawSourceCache = { 'email-1': 'From: ada@test\r\n\r\nthe real source' };
  mounted = render(<ShowOriginalModal email={email} onClose={() => {}} />);

  expect(copyButton()!.textContent).toContain('Copy to Clipboard');
  fire(copyButton(), 'click');
  await settle();

  expect(writeText).toHaveBeenCalledWith('From: ada@test\r\n\r\nthe real source');
  expect(copyButton()!.textContent).toContain('Copied to clipboard');
});

// While the source is still in flight the pane shows a loader, not content —
// copying then would put the placeholder reconstruction on the clipboard.
it('cannot be clicked while the source is still loading', async () => {
  store.state.rawSourceLoading = new Set(['email-1']);
  mounted = render(<ShowOriginalModal email={email} onClose={() => {}} />);

  expect(copyButton()!.hasAttribute('disabled')).toBe(true);
  fire(copyButton(), 'click');
  await settle();

  expect(writeText).not.toHaveBeenCalled();
});
