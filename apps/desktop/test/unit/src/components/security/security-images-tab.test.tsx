// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Security } from '../../../../../src/components/security/Security';
import { useEmailStore } from '../../../../../src/store/email-store';
import {
  clearImageAllowedCache,
  emailedAddresses,
  getRemoteImageMode,
  notifyRemoteImageModeChanged,
  shouldAutoLoadRemoteImages,
  useRemoteImageAutoLoad,
  type RemoteImageMessage,
  type RemoteImageMode,
} from '../../../../../src/utils/remote-images';
import { resetTrustedSenders } from '../../../../../src/utils/trusted-senders';
import { act, fire, render, toggle, typeInto, type Mounted } from '../../../../helpers/render';

/**
 * Security → Remote images.
 *
 * What breaks if this file goes red: the only surface where a reader can grant
 * (or take back) a standing "load images from here" allowance by hand. A
 * newsletter's envelope sender is a per-campaign address, so the DOMAIN form is
 * the only one that ever sticks — if the field stops accepting `example.com`,
 * or stores it as a sender key, the allowance silently never matches and the
 * user has no way to tell.
 *
 * It is also the ONLY place the reader chooses what loads on its own —
 * trusted senders and categorized mail, each on or off, or everything (it
 * left Settings → General): if the switches stop showing the stored choice,
 * stop saving, or save without the open messages re-deciding, the reader's
 * privacy choice silently does nothing.
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
    // The trust sources the switches read, for the messages open elsewhere.
    spam: { listTrustedSenders: vi.fn(async () => ({ success: true, data: [] })) },
    ai: { getCategoryDefinitions: vi.fn(async () => ({ success: true, data: [{ slug: 'work', name: 'Work', isEnabled: true }] })) },
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
  notifyRemoteImageModeChanged(); // a fresh store: forget the last test's mode
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

describe('Security → Remote images allowlist — whose list', () => {
  afterEach(() => { useEmailStore.setState({ accounts: [], activeAccountId: null }); });

  // Breaks: the list is per account, but the section read and wrote "whatever
  // main has active" without saying which account it showed — so an allowance
  // saved from another account's mail in All Inboxes seemed to vanish, and an
  // add could land in a different account from the list on screen.
  it("shows, adds to and revokes from the active account's list, and names that account", async () => {
    useEmailStore.setState({
      accounts: [{ id: 'acct-a', email: 'me@a.test', imapConfig: {}, smtpConfig: null, smtpConfigured: false } as never],
      activeAccountId: 'acct-a',
    });
    allowed.push('boss@x.com');
    await mountImagesTab();
    const emails = (window as unknown as { electronAPI: { emails: Record<string, ReturnType<typeof vi.fn>> } }).electronAPI.emails;
    expect(emails.getImageAllowedSenders).toHaveBeenCalledWith('acct-a');
    const heading = mounted.all('h2').find((h) => h.textContent?.startsWith('Allowed to load images'));
    expect(heading?.textContent).toContain('me@a.test');

    type('example.com');
    clickByText('button', 'Allow');
    await act(async () => { await Promise.resolve(); });
    expect(emails.allowImagesForSender).toHaveBeenCalledWith('@example.com', 'acct-a');

    fire(mounted.byLabel('Stop auto-loading images from boss@x.com'), 'click');
    await act(async () => { await Promise.resolve(); });
    clickByText('button', 'Stop auto-loading');
    await act(async () => { await Promise.resolve(); });
    expect(emails.disallowImagesForSender).toHaveBeenCalledWith('boss@x.com', 'acct-a');
  });
});

/* ------------------------------------------------ what loads automatically */

const SETTINGS_KEY = 'sarvinbox-settings';
const TRUSTED = 'From trusted senders';
const CATEGORIZED = 'From categorized mail';
const ALWAYS = 'Always load all remote images';

const checkboxes = () => mounted.all('input[type="checkbox"]') as HTMLInputElement[];
/** A checkbox's accessible name: the title its aria-labelledby points at. */
const nameOf = (input: Element) => document.getElementById(input.getAttribute('aria-labelledby') ?? '')?.textContent ?? '';
const checkboxNamed = (title: string) => checkboxes().find((c) => nameOf(c) === title) ?? null;
/** Everything a checkbox's aria-describedby points at, joined. */
const descriptionOf = (title: string) => (checkboxNamed(title)?.getAttribute('aria-describedby') ?? '')
  .split(' ').filter(Boolean).map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
/** How a switch looks: on/off, or ticked-and-locked ('included') under Always. */
const look = (title: string) => {
  const box = checkboxNamed(title);
  if (!box) return 'missing';
  if (box.disabled) return box.checked ? 'included' : 'locked off';
  return box.checked ? 'on' : 'off';
};
const switches = () => ({ trusted: look(TRUSTED), categorized: look(CATEGORIZED), always: look(ALWAYS) });
const storedBlob = () => JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null');
/** Seed the settings blob, and say so — the parsed mode is kept in memory and
 *  re-read only when told the blob changed (app-settings-sync does in the app). */
const storeSettings = (raw: string) => {
  localStorage.setItem(SETTINGS_KEY, raw);
  notifyRemoteImageModeChanged();
};
const NOTHING_ON_NOTE = 'Images load only after you choose “Load images” on a message';

/** Messages open elsewhere in the app, re-deciding as the switches change:
 *  someone this account has emailed (uncategorized), a stranger's mail the AI
 *  filed under a category, and a stranger's uncategorized newsletter. */
const COLLEAGUE: RemoteImageMessage = { fromAddress: 'colleague@work.test', tags: '|INBOX|', authStatus: null };
const FILED: RemoteImageMessage = { fromAddress: 'robot@vendor.test', tags: '|INBOX|work|', authStatus: null };
const NEWSLETTER: RemoteImageMessage = { fromAddress: 'news@shop.example', tags: '|INBOX|', authStatus: null };
function Probe({ name, message }: { name: string; message: RemoteImageMessage }) {
  return <span data-probe={name}>{useRemoteImageAutoLoad(message) ? 'loads' : 'blocked'}</span>;
}
const Probes = () => (
  <>
    <Probe name="colleague" message={COLLEAGUE} />
    <Probe name="filed" message={FILED} />
    <Probe name="newsletter" message={NEWSLETTER} />
  </>
);
/** What each open message shows now. */
const probes = (view: Mounted) => ({
  colleague: view.find('[data-probe="colleague"]')?.textContent,
  filed: view.find('[data-probe="filed"]')?.textContent,
  newsletter: view.find('[data-probe="newsletter"]')?.textContent,
});
/** Let the trust sources a newly switched-on source asks for (correspondents,
 *  category slugs) load, as they would in the app. */
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

describe('Security → Remote images: what loads automatically', () => {
  beforeEach(() => {
    // Every trust cache starts cold, so each test's switches decide on its own lists.
    clearImageAllowedCache();
    emailedAddresses.clear();
    resetTrustedSenders();
  });

  // Breaks if the two sources stop being separate choices (the old one-of-four
  // ladder), or "Always" is folded into the group as if it were a third source.
  it('offers trusted senders and categorized mail as two checkboxes in one labelled fieldset, and Always apart', async () => {
    await mountImagesTab();
    const fieldset = mounted.find('fieldset');
    expect(fieldset?.querySelector(':scope > legend')?.textContent).toBe('Load images automatically');
    expect([...(fieldset?.querySelectorAll('input[type="checkbox"]') ?? [])].map(nameOf)).toEqual([TRUSTED, CATEGORIZED]);
    const always = checkboxNamed(ALWAYS);
    expect(always).not.toBeNull();
    expect(fieldset?.contains(always!)).toBe(false);
    expect(mounted.all('input[type="radio"]')).toHaveLength(0);
    const heading = mounted.all('h2').find((h) => h.textContent === 'When to load remote images');
    expect(heading?.closest('section')?.getAttribute('aria-labelledby')).toBe(heading?.id);
  });

  // Breaks if a fresh install shows a state other than the one the decision
  // applies ('safe': both), or the reader cannot tell which state is the default.
  it('shows both on when nothing is stored, and says that is the default', async () => {
    await mountImagesTab();
    expect(switches()).toEqual({ trusted: 'on', categorized: 'on', always: 'off' });
    const intro = document.getElementById(mounted.find('fieldset')?.getAttribute('aria-describedby') ?? '');
    expect(intro?.textContent).toContain('both (the default)');
    expect(mounted.container.textContent).not.toContain(NOTHING_ON_NOTE);
  });

  // Breaks if the page shows something other than the stored choice — the
  // reader would "confirm" switches that are not the ones in force — including
  // for a reader whose choice predates the switches.
  it('shows each stored value as its switches, legacy values read the way the decision reads them', async () => {
    const cases: Array<[string, ReturnType<typeof switches>]> = [
      ['{"remoteImageMode":"block"}', { trusted: 'off', categorized: 'off', always: 'off' }],
      ['{"remoteImageMode":"trusted"}', { trusted: 'on', categorized: 'off', always: 'off' }],
      ['{"remoteImageMode":"categorized"}', { trusted: 'off', categorized: 'on', always: 'off' }],
      ['{"remoteImageMode":"safe"}', { trusted: 'on', categorized: 'on', always: 'off' }],
      ['{"remoteImageMode":"always"}', { trusted: 'included', categorized: 'included', always: 'on' }],
      // The old boolean from before the modes existed.
      ['{"autoLoadRemoteImages":true}', { trusted: 'included', categorized: 'included', always: 'on' }],
      ['{"autoLoadRemoteImages":false}', { trusted: 'off', categorized: 'off', always: 'off' }],
      // The retired 'important' mode became 'safe'.
      ['{"remoteImageMode":"important"}', { trusted: 'on', categorized: 'on', always: 'off' }],
    ];
    for (const [raw, expected] of cases) {
      storeSettings(raw);
      await mountImagesTab();
      expect([raw, switches()]).toEqual([raw, expected]);
      mounted.unmount();
    }
  });

  // Breaks if a description stops naming what its switch loads — above all the
  // trusted senders' safety limits and the categories left out, which the
  // reader cannot see anywhere else.
  it('says exactly what each switch loads', async () => {
    await mountImagesTab();
    const trusted = descriptionOf(TRUSTED);
    // The switch covers every account, so the correspondents must be pinned to
    // the message's own account ("from that account" named no account at all).
    for (const part of ['“I trust this sender”', 'people you’ve emailed from the account the message arrived in', 'verified brands', 'Spam', 'failed its sender check', 'allowed list below is separate']) {
      expect([part, trusted.includes(part)]).toEqual([part, true]);
    }
    const categorized = descriptionOf(CATEGORIZED);
    for (const part of ['categories', 'Social', 'Promotional', 'Spam', 'not the sender']) {
      expect([part, categorized.includes(part)]).toEqual([part, true]);
    }
    expect(descriptionOf(ALWAYS)).toContain('Every remote image');
    // The old read-only card pointed somewhere the setting no longer is.
    expect(mounted.container.textContent).not.toContain('Change this under Settings');
  });

  // Breaks if a change is not persisted as the one value the whole app reads,
  // is written over the reader's other settings, or a switch changes the other.
  it('saves each change at once, as the one stored value, beside every other setting', async () => {
    const signatures = [{ id: 's1', name: 'Work', html: '<b>Me</b>' }];
    storeSettings(JSON.stringify({ remoteImageMode: 'safe', signatures }));
    await mountImagesTab();

    const steps: Array<[string, RemoteImageMode, ReturnType<typeof switches>]> = [
      [TRUSTED, 'categorized', { trusted: 'off', categorized: 'on', always: 'off' }],
      [CATEGORIZED, 'block', { trusted: 'off', categorized: 'off', always: 'off' }],
      [TRUSTED, 'trusted', { trusted: 'on', categorized: 'off', always: 'off' }],
      [CATEGORIZED, 'safe', { trusted: 'on', categorized: 'on', always: 'off' }],
    ];
    for (const [title, mode, shown] of steps) {
      toggle(checkboxNamed(title));
      expect([title, storedBlob()]).toEqual([title, { remoteImageMode: mode, signatures }]);
      expect(getRemoteImageMode()).toBe(mode);
      expect(switches()).toEqual(shown);
    }
    expect(mounted.find('[role="alert"]')).toBeNull();
  });

  // Breaks if a reader who switched everything off is not told what that
  // means — or is told so while something still loads.
  it('says images wait for "Load images" only while nothing loads on its own', async () => {
    storeSettings(JSON.stringify({ remoteImageMode: 'block' }));
    await mountImagesTab();
    expect(mounted.container.textContent).toContain(NOTHING_ON_NOTE);
    expect(mounted.container.textContent).toContain('except from senders on your allowed list below');

    toggle(checkboxNamed(CATEGORIZED));
    expect(mounted.container.textContent).not.toContain(NOTHING_ON_NOTE);
    toggle(checkboxNamed(CATEGORIZED));
    toggle(checkboxNamed(ALWAYS));
    expect(mounted.container.textContent).not.toContain(NOTHING_ON_NOTE);
  });

  // Breaks if a switch only applies after a reload, or the two leak into each
  // other: categorized-only loading a trusted sender's uncategorized mail,
  // trusted-only loading a stranger's categorized mail. Both renderers use the
  // one decision function these messages go through.
  it('takes effect on open messages without a reload, each switch on its own', async () => {
    (window as unknown as { electronAPI: { emails: Record<string, unknown> } }).electronAPI.emails.getEmailedAddresses =
      vi.fn(async () => ({ success: true, data: ['colleague@work.test'] }));
    storeSettings(JSON.stringify({ remoteImageMode: 'block' }));
    await mountImagesTab();
    const view = render(<Probes />);
    await settle();
    expect(probes(view)).toEqual({ colleague: 'blocked', filed: 'blocked', newsletter: 'blocked' });

    toggle(checkboxNamed(TRUSTED)); // trusted senders only
    await settle();
    expect(probes(view)).toEqual({ colleague: 'loads', filed: 'blocked', newsletter: 'blocked' });

    toggle(checkboxNamed(TRUSTED));
    toggle(checkboxNamed(CATEGORIZED)); // categorized mail only
    await settle();
    expect(getRemoteImageMode()).toBe('categorized');
    expect(probes(view)).toEqual({ colleague: 'blocked', filed: 'loads', newsletter: 'blocked' });
    expect(shouldAutoLoadRemoteImages(COLLEAGUE)).toBe(false);

    toggle(checkboxNamed(TRUSTED)); // both
    await settle();
    expect(probes(view)).toEqual({ colleague: 'loads', filed: 'loads', newsletter: 'blocked' });

    toggle(checkboxNamed(ALWAYS));
    expect(probes(view)).toEqual({ colleague: 'loads', filed: 'loads', newsletter: 'loads' });

    toggle(checkboxNamed(ALWAYS));
    expect(probes(view)).toEqual({ colleague: 'loads', filed: 'loads', newsletter: 'blocked' });
    view.unmount();
  });

  // Breaks if Always leaves the two looking changeable (a tick that does
  // nothing), stops saying why they are locked, or turning it off loses the
  // reader's earlier choice and silently widens or narrows it.
  it('locks both as included under Always, says so, and gives back the earlier choice when it goes off', async () => {
    storeSettings(JSON.stringify({ remoteImageMode: 'categorized' }));
    await mountImagesTab();

    toggle(checkboxNamed(ALWAYS));
    expect(getRemoteImageMode()).toBe('always');
    expect(switches()).toEqual({ trusted: 'included', categorized: 'included', always: 'on' });
    for (const title of [TRUSTED, CATEGORIZED]) {
      expect(descriptionOf(title)).toContain('Both are included while “Always load all remote images” is on');
    }
    toggle(checkboxNamed(TRUSTED)); // a locked box cannot be changed
    expect(getRemoteImageMode()).toBe('always');

    toggle(checkboxNamed(ALWAYS));
    expect(getRemoteImageMode()).toBe('categorized');
    expect(switches()).toEqual({ trusted: 'off', categorized: 'on', always: 'off' });
    expect(descriptionOf(TRUSTED)).not.toContain('Both are included');
  });

  // Documented behaviour, not a gap: the choice from before Always is held by
  // the open page only. A page opened with Always already on has none, so
  // turning it off leaves both ticked — what the locked boxes showed, and the
  // default — rather than switching everything off.
  it('turns both on when Always goes off on a page that opened with it on', async () => {
    storeSettings(JSON.stringify({ remoteImageMode: 'always' }));
    await mountImagesTab();
    toggle(checkboxNamed(ALWAYS));
    expect(getRemoteImageMode()).toBe('safe');
    expect(switches()).toEqual({ trusted: 'on', categorized: 'on', always: 'off' });
  });

  // Breaks if the page keeps showing switches another window has since
  // changed, inviting the reader to believe the old ones are in force.
  it('follows a choice made in another window', async () => {
    storeSettings(JSON.stringify({ remoteImageMode: 'block' }));
    await mountImagesTab();
    expect(switches()).toEqual({ trusted: 'off', categorized: 'off', always: 'off' });

    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ remoteImageMode: 'categorized' }));
    act(() => { window.dispatchEvent(new StorageEvent('storage', { key: SETTINGS_KEY })); });
    expect(switches()).toEqual({ trusted: 'off', categorized: 'on', always: 'off' });
  });

  // Breaks if an unreadable settings blob is overwritten by a one-key blob
  // (every signature and preference gone), if the failure is silent and the
  // reader believes the change is in force, or if one failure sticks after the
  // settings become readable again.
  it('refuses to save over settings it cannot read, says so, and recovers once they are readable', async () => {
    storeSettings('{not json');
    await mountImagesTab();
    expect(switches()).toEqual({ trusted: 'on', categorized: 'on', always: 'off' }); // unreadable reads as the default

    toggle(checkboxNamed(TRUSTED));
    expect(localStorage.getItem(SETTINGS_KEY)).toBe('{not json');
    expect(mounted.find('[role="alert"]')?.textContent).toContain('not saved');
    expect(switches()).toEqual({ trusted: 'on', categorized: 'on', always: 'off' });
    toggle(checkboxNamed(ALWAYS));
    expect(localStorage.getItem(SETTINGS_KEY)).toBe('{not json');
    expect(switches()).toEqual({ trusted: 'on', categorized: 'on', always: 'off' });
    expect(getRemoteImageMode()).toBe('safe');

    storeSettings(JSON.stringify({ emailsPerPage: 50 }));
    toggle(checkboxNamed(TRUSTED));
    expect(storedBlob()).toEqual({ emailsPerPage: 50, remoteImageMode: 'categorized' });
    expect(mounted.find('[role="alert"]')).toBeNull();
  });

  // Breaks if a settings WRITE that fails (storage full, quota, a locked
  // profile) is shown as done, blames only an unreadable blob, or leaves the
  // switches showing a choice that is not in force.
  it('says the choice was not saved when the settings cannot be written, and keeps the old one', async () => {
    storeSettings(JSON.stringify({ remoteImageMode: 'safe', emailsPerPage: 50 }));
    await mountImagesTab();
    const setItem = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    });
    try {
      toggle(checkboxNamed(CATEGORIZED));
      expect(mounted.find('[role="alert"]')?.textContent).toBe(
        'Your choice was not saved: the app could not read or write your settings. Nothing was changed.',
      );
      expect(switches()).toEqual({ trusted: 'on', categorized: 'on', always: 'off' });
      expect(getRemoteImageMode()).toBe('safe');
    } finally {
      setItem.mockRestore();
    }
    // Writable again: the same click lands and the alert goes.
    toggle(checkboxNamed(CATEGORIZED));
    expect(storedBlob()).toEqual({ remoteImageMode: 'trusted', emailsPerPage: 50 });
    expect(mounted.find('[role="alert"]')).toBeNull();
  });

  // Breaks if a failed save while turning Always off is shown as done, or
  // throws away the earlier choice, so the retry that lands widens it to both.
  it('keeps Always on, and the earlier choice, when turning it off could not be saved', async () => {
    storeSettings(JSON.stringify({ remoteImageMode: 'trusted' }));
    await mountImagesTab();
    toggle(checkboxNamed(ALWAYS));
    expect(getRemoteImageMode()).toBe('always');

    // Another writer leaves the blob unreadable (the page still holds 'always').
    localStorage.setItem(SETTINGS_KEY, '{not json');
    toggle(checkboxNamed(ALWAYS));
    expect(localStorage.getItem(SETTINGS_KEY)).toBe('{not json');
    expect(mounted.find('[role="alert"]')?.textContent).toContain('not saved');
    expect(switches()).toEqual({ trusted: 'included', categorized: 'included', always: 'on' });

    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ remoteImageMode: 'always' }));
    toggle(checkboxNamed(ALWAYS));
    expect(getRemoteImageMode()).toBe('trusted');
    expect(switches()).toEqual({ trusted: 'on', categorized: 'off', always: 'off' });
    expect(mounted.find('[role="alert"]')).toBeNull();
  });

  // Breaks keyboard and screen-reader use: each switch must be a native,
  // focusable checkbox in the tab order, in a real <label>, announced by its
  // title with its description, and saving on its activation event. Keyboard
  // activation itself (Space on the focused box fires that click) is the native
  // checkbox's own behaviour: happy-dom does not synthesise it, so this test
  // guards the NATIVE control it relies on, not the key press.
  it('uses keyboard-operable native checkboxes with names, descriptions and labels', async () => {
    await mountImagesTab();
    const all = checkboxes();
    expect(all.map(nameOf)).toEqual([TRUSTED, CATEGORIZED, ALWAYS]);
    for (const box of all) {
      expect(box.disabled).toBe(false);
      expect(box.tabIndex).not.toBe(-1);
      expect(descriptionOf(nameOf(box))).not.toBe('');
      // The whole row is the label, tied to the box by id as well as by nesting.
      const label = box.closest('label');
      expect(label?.htmlFor).toBe(box.id);
      expect(box.id).not.toBe('');
    }
    // Focused, then activated (the click a browser fires for Space): it saves.
    const categorized = checkboxNamed(CATEGORIZED)!;
    categorized.focus();
    expect(document.activeElement).toBe(categorized);
    toggle(categorized);
    expect(getRemoteImageMode()).toBe('trusted');

    // Locked under Always: out of the tab order (disabled), still announced as ticked.
    toggle(checkboxNamed(ALWAYS));
    expect(checkboxNamed(TRUSTED)?.disabled).toBe(true);
    expect(checkboxNamed(TRUSTED)?.checked).toBe(true);
    expect(checkboxNamed(ALWAYS)?.disabled).toBe(false);
  });
});
