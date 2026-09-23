// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Security } from '../../../../../src/components/security/Security';
import { act, fire, render, typeInto, type Mounted } from '../../../../helpers/render';

/**
 * Security → Remote images.
 *
 * What breaks if this file goes red: the only surface where a reader can grant
 * (or take back) a standing "load images from here" allowance by hand. A
 * newsletter's envelope sender is a per-campaign address, so the DOMAIN form is
 * the only one that ever sticks — if the field stops accepting `example.com`,
 * or stores it as a sender key, the allowance silently never matches and the
 * user has no way to tell.
 */

const allowed: string[] = [];
const calls = { allow: [] as string[], disallow: [] as string[] };

const installElectronAPI = () => {
  (window as unknown as Record<string, unknown>).electronAPI = {
    emails: {
      getImageAllowedSenders: vi.fn(async () => ({ success: true, data: [...allowed] })),
      allowImagesForSender: vi.fn(async (key: string) => { calls.allow.push(key); allowed.push(key); return { success: true }; }),
      disallowImagesForSender: vi.fn(async (key: string) => {
        calls.disallow.push(key);
        const at = allowed.indexOf(key);
        if (at >= 0) allowed.splice(at, 1);
        return { success: true };
      }),
    },
    identity: {},
    spammers: { list: vi.fn(async () => ({ success: true, data: { spammers: [], total: 0 } })) },
  };
};

let mounted: Mounted;

/** Mount the images tab and let its initial load settle. */
const mountImagesTab = async () => {
  mounted = render(<Security initialTab="images" />);
  await act(async () => { await Promise.resolve(); });
  return mounted;
};

const rowLabels = () => mounted.all('.divide-y > div span.flex-1').map((el) => el.textContent);
const input = () => mounted.find('input[aria-label="Sender address or domain to always load images from"]') as HTMLInputElement;
const type = (value: string) => typeInto(input(), value);
const clickByText = (selector: string, text: string) => {
  const target = mounted.all(selector).find((el) => el.textContent?.trim() === text);
  fire(target ?? null, 'click');
};

beforeEach(() => {
  allowed.length = 0;
  calls.allow.length = 0;
  calls.disallow.length = 0;
  localStorage.clear();
  installElectronAPI();
  vi.clearAllMocks();
});

afterEach(() => {
  mounted?.unmount();
});

describe('Security → Remote images allowlist', () => {
  it('lists a domain entry as a whole domain and a sender as a sender', async () => {
    // The stored key is the ONLY thing distinguishing the two; render them the
    // same and a domain-wide allowance looks like one harmless address.
    allowed.push('boss@x.com', '@example.com');
    await mountImagesTab();

    expect(rowLabels()).toEqual(['example.com', 'boss@x.com']); // domains first
    expect(mounted.container.textContent).toContain('Whole domain');
    expect(mounted.container.textContent).toContain('Sender');
  });

  it('stores a typed domain with the @ prefix', async () => {
    await mountImagesTab();
    type('Example.COM');
    clickByText('button', 'Allow');
    await act(async () => { await Promise.resolve(); });

    expect(calls.allow).toEqual(['@example.com']);
    expect(rowLabels()).toEqual(['example.com']);
    expect(input().value).toBe(''); // the field clears, so a double-click can't double-add
  });

  it('stores a typed sender address as-is, display name stripped', async () => {
    await mountImagesTab();
    type('The Boss <BOSS@X.com>');
    clickByText('button', 'Allow');
    await act(async () => { await Promise.resolve(); });

    expect(calls.allow).toEqual(['boss@x.com']);
  });

  it('adds on Enter as well as the button', async () => {
    await mountImagesTab();
    type('example.com');
    fire(input(), 'keydown', { key: 'Enter' });
    await act(async () => { await Promise.resolve(); });

    expect(calls.allow).toEqual(['@example.com']);
  });

  it('refuses junk with a message and persists nothing', async () => {
    // A bare public suffix would allow every sender on it — the one typo here
    // that quietly disables the whole feature.
    await mountImagesTab();
    type('co.uk');
    clickByText('button', 'Allow');
    await act(async () => { await Promise.resolve(); });

    expect(calls.allow).toEqual([]);
    expect(mounted.container.textContent).toContain('Enter a sender address');
    expect(input().value).toBe('co.uk'); // kept, so the reader can fix it

    type('example.com'); // typing clears the error
    expect(mounted.container.textContent).not.toContain('Enter a sender address');
  });

  it('revokes only after the confirmation is accepted', async () => {
    allowed.push('@example.com');
    await mountImagesTab();

    fire(mounted.byLabel('Stop auto-loading images from example.com'), 'click');
    await act(async () => { await Promise.resolve(); });
    clickByText('button', 'Cancel');
    await act(async () => { await Promise.resolve(); });
    expect(calls.disallow).toEqual([]);
    expect(rowLabels()).toEqual(['example.com']);

    fire(mounted.byLabel('Stop auto-loading images from example.com'), 'click');
    await act(async () => { await Promise.resolve(); });
    clickByText('button', 'Stop auto-loading');
    await act(async () => { await Promise.resolve(); });
    expect(calls.disallow).toEqual(['@example.com']);
    expect(rowLabels()).toEqual([]);
  });

  it('names the sender, not the domain, when revoking a sender allowance', async () => {
    // The two allowances have different reach, so the confirmation has to say
    // which one is about to go — a domain revoke can un-allow dozens of senders.
    allowed.push('boss@x.com');
    await mountImagesTab();

    fire(mounted.byLabel('Stop auto-loading images from boss@x.com'), 'click');
    await act(async () => { await Promise.resolve(); });
    const dialog = mounted.find('[role="dialog"]');
    expect(dialog?.textContent).toContain('Stop auto-loading images?');
    expect(dialog?.textContent).toContain('until you choose “Load images” on a message');

    clickByText('button', 'Stop auto-loading');
    await act(async () => { await Promise.resolve(); });
    expect(calls.disallow).toEqual(['boss@x.com']);
  });

  it('warns that a domain revoke is the broader one', async () => {
    allowed.push('@example.com');
    await mountImagesTab();
    fire(mounted.byLabel('Stop auto-loading images from example.com'), 'click');
    await act(async () => { await Promise.resolve(); });
    expect(mounted.find('[role="dialog"]')?.textContent).toContain('Stop auto-loading for this domain?');
  });

  it('sorts domains before senders, each alphabetically', async () => {
    allowed.push('zoe@x.com', '@zeta.com', 'abe@x.com', '@alpha.com'); // arrives unordered
    await mountImagesTab();
    expect(rowLabels()).toEqual(['alpha.com', 'zeta.com', 'abe@x.com', 'zoe@x.com']);
  });

  it('renders an empty list rather than crashing when the allowlist cannot be read', async () => {
    // A failed IPC must not take the Security page down with it — the policy
    // card above is still the thing the reader came for.
    (window as unknown as Record<string, any>).electronAPI.emails.getImageAllowedSenders =
      vi.fn(async () => { throw new Error('no channel'); });
    await mountImagesTab();
    expect(mounted.container.textContent).toContain('No allowances yet');

    (window as unknown as Record<string, any>).electronAPI.emails.getImageAllowedSenders =
      vi.fn(async () => ({ success: false }));
    mounted.unmount();
    await mountImagesTab();
    expect(mounted.container.textContent).toContain('No allowances yet');
  });

  it('shows the empty state when nothing is allowed', async () => {
    await mountImagesTab();
    expect(mounted.container.textContent).toContain('No allowances yet');
  });
});
