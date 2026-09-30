import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getCachedCategorySlugs, warmCategoryDefs } from '../../../../src/components/email-list/CategoryBadges';
import { SETTINGS_WRITTEN_EVENT } from '../../../../src/config/inbox-types';
import { setActiveCacheAccount } from '../../../../src/utils/account-scoped-cache';
import {
  clearImageAllowedCache,
  EMAILED_REFRESH_DELAY_MS,
  emailedAddresses,
  forgetImagesAllowed,
  forgetImageTrustAccount,
  getImageTrustVersion,
  getRemoteImageMode,
  hasEmailedAddress,
  imageAllowlist,
  isImageExcludedCategory,
  isPromoOrSpam,
  isSenderImagesAllowed,
  isSocialCategorySlug,
  isSpamFolderMail,
  isSuspectSender,
  isTrustedForImages,
  noteAccountFolders,
  notifyRemoteImageModeChanged,
  PERSIST_RETRY_DELAYS_MS,
  qualifiesForCategorizedAutoLoad,
  refreshEmailedAddresses,
  rememberImagesAllowed,
  rememberSenderImagesAllowed,
  REMOTE_IMAGE_MODES,
  remoteImageFactsOf,
  remoteImageModeFor,
  remoteImageModeOf,
  remoteImageSourcesOf,
  saveRemoteImageMode,
  setImageTrustAccount,
  shouldAutoLoadRemoteImages,
  subscribeImageTrust,
  warmImageAllowedSenders,
  type RemoteImageMessage,
  type RemoteImageMode,
  type RemoteImageSources,
} from '../../../../src/utils/remote-images';
import { clearSenderIdentityCache } from '../../../../src/utils/sender-identity';
import { resetTrustedSenders } from '../../../../src/utils/trusted-senders';

/**
 * The ONE answer to "does this message's remote content load without the
 * reader asking", shared by the classic card and the chat view, and the trust
 * sources it reads.
 *
 * What breaks if this file goes red: tracking pixels fetched for mail the
 * reader never trusted (a spoofed "trusted" sender, spam, promotions, another
 * account's allowance), or the opposite — a remembered sender or a person the
 * reader writes to still hidden behind the banner.
 */

// CategoryBadges owns the AI-category slug cache categorized mail gates on; a stub
// keeps the slugs under test control instead of behind an IPC round trip.
const cat = vi.hoisted(() => ({ slugs: [] as string[], version: 0, listeners: new Set<() => void>() }));
vi.mock('../../../../src/components/email-list/CategoryBadges', () => ({
  getCachedCategorySlugs: vi.fn(() => cat.slugs),
  warmCategoryDefs: vi.fn(),
  subscribeCategoryDefs: (listener: () => void) => {
    cat.listeners.add(listener);
    return () => { cat.listeners.delete(listener); };
  },
  getCategoryDefsVersion: () => cat.version,
}));

const SETTINGS_KEY = 'sarvinbox-settings';

/** Minimal in-memory localStorage — the vitest env is 'node', which has none. */
const installLocalStorage = () => {
  const store = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  };
};
/** Write the settings blob as another writer would, and say so — the parsed
 *  mode is kept in memory and re-read only when told the blob changed. */
const writeSettings = (settings: Record<string, unknown> | string) => {
  localStorage.setItem(SETTINGS_KEY, typeof settings === 'string' ? settings : JSON.stringify(settings));
  notifyRemoteImageModeChanged();
};
const setMode = (mode: RemoteImageMode) => writeSettings({ remoteImageMode: mode });

/** Per-account lists the stubbed main process answers from ('' = active). */
interface Lists { allowed: string[]; emailed: string[]; trusted: string[] }
let accounts: Record<string, Lists>;
const listsOf = (accountId?: string) => accounts[accountId ?? ''] ?? (accounts[accountId ?? ''] = { allowed: [], emailed: [], trusted: [] });
/** BIMI standing per sender address, as main's identity cache would answer. */
let identities: Record<string, 'verified' | 'logo' | 'none'>;

let api: {
  emails: Record<string, ReturnType<typeof vi.fn>>;
  spam: Record<string, ReturnType<typeof vi.fn>>;
  identity: Record<string, ReturnType<typeof vi.fn>>;
};

// ONE window for the whole file: the mode's write listeners attach to the
// window they first see, and must keep hearing this file's events.
const fakeWindow = new EventTarget() as EventTarget & { electronAPI?: unknown };

const installElectronAPI = () => {
  api = {
    emails: {
      getImageAllowedSenders: vi.fn(async (accountId?: string) => ({ success: true, data: [...listsOf(accountId).allowed] })),
      allowImagesForSender: vi.fn(async (key: string, accountId?: string) => {
        listsOf(accountId).allowed.push(key);
        return { success: true };
      }),
      disallowImagesForSender: vi.fn(async (key: string, accountId?: string) => {
        listsOf(accountId).allowed = listsOf(accountId).allowed.filter((k) => k !== key);
        return { success: true };
      }),
      getEmailedAddresses: vi.fn(async (accountId?: string) => ({ success: true, data: [...listsOf(accountId).emailed] })),
    },
    spam: {
      listTrustedSenders: vi.fn(async (accountId?: string) => ({
        success: true,
        data: listsOf(accountId).trusted.map((email) => ({ email, createdAt: 1 })),
      })),
    },
    identity: {
      getSender: vi.fn(async (address: string) => ({
        success: true,
        data: {
          address,
          domain: address.split('@')[1] ?? null,
          bimi: identities[address] ? { status: identities[address], logo: null, organization: 'Brand', issuer: 'MVA', detail: '', dmarcPolicy: 'reject', expires: null } : null,
          favicon: null, faviconStatus: null, contactPhoto: null, pending: false,
        },
      })),
      onUpdated: vi.fn(),
    },
  };
  fakeWindow.electronAPI = api;
  (globalThis as any).window = fakeWindow;
};

const PASS = JSON.stringify({ spf: 'pass', dkim: 'pass', dmarc: 'pass', overall: 'pass' });
const DMARC_FAIL = JSON.stringify({ spf: 'fail', dkim: 'fail', dmarc: 'fail', overall: 'fail' });

const message = (over: Partial<RemoteImageMessage> = {}): RemoteImageMessage => ({
  fromAddress: 'someone@x.test',
  tags: '|INBOX|',
  authStatus: PASS,
  accountId: null,
  ...over,
});

/** Let the trust caches' loads (a microtask chain) land. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Warm every source for the active account (and an optional other one). */
const warm = async (...accountIds: Array<string | undefined>) => {
  for (const id of accountIds.length ? accountIds : [undefined]) {
    await Promise.all([
      warmImageAllowedSenders(id),
      emailedAddresses.reload(id),
      (await import('../../../../src/utils/trusted-senders')).trustedSendersCache.reload(id),
    ]);
  }
};

beforeEach(() => {
  installLocalStorage();
  notifyRemoteImageModeChanged(); // a fresh store: forget the last test's mode
  accounts = {};
  identities = {};
  installElectronAPI();
  cat.slugs = [];
  vi.mocked(getCachedCategorySlugs).mockImplementation(() => cat.slugs);
  vi.mocked(warmCategoryDefs).mockClear();
});

afterEach(() => {
  clearImageAllowedCache();
  emailedAddresses.clear();
  resetTrustedSenders();
  clearSenderIdentityCache();
  setActiveCacheAccount(null);
  vi.useRealTimers();
  delete (globalThis as any).localStorage;
  delete (globalThis as any).window;
});

// ───────────────────────────────── the mode ────────────────────────────────

describe('getRemoteImageMode', () => {
  // Privacy-relevant: 'block' must never be silently upgraded, and a legacy
  // setting must map to the choice the user actually made.
  it('defaults new installs to safe', () => {
    expect(getRemoteImageMode()).toBe('safe');
    writeSettings({});
    expect(getRemoteImageMode()).toBe('safe');
  });

  // Breaks: a reader who picked trusted senders only, or categorized mail
  // only (the value added with the independent switches), is silently reset.
  it('returns each explicit mode verbatim, trusted-only and categorized-only included', () => {
    for (const mode of ['block', 'trusted', 'categorized', 'safe', 'always'] as const) {
      setMode(mode);
      expect(getRemoteImageMode()).toBe(mode);
    }
  });

  it('migrates the legacy "important" mode to safe', () => {
    writeSettings({ remoteImageMode: 'important' });
    expect(getRemoteImageMode()).toBe('safe');
  });

  it('maps the legacy autoLoadRemoteImages boolean to always/block', () => {
    writeSettings({ autoLoadRemoteImages: true });
    expect(getRemoteImageMode()).toBe('always');
    writeSettings({ autoLoadRemoteImages: false });
    expect(getRemoteImageMode()).toBe('block');
  });

  it('prefers the new mode field over the legacy boolean', () => {
    writeSettings({ remoteImageMode: 'block', autoLoadRemoteImages: true });
    expect(getRemoteImageMode()).toBe('block');
    writeSettings({ remoteImageMode: 'trusted', autoLoadRemoteImages: true });
    expect(getRemoteImageMode()).toBe('trusted');
    writeSettings({ remoteImageMode: 'categorized', autoLoadRemoteImages: true });
    expect(getRemoteImageMode()).toBe('categorized');
  });

  // Breaks: a renderer without storage (a locked-down profile) throws out of
  // every message render instead of using the default.
  it('falls back to safe when storage cannot be read at all', () => {
    (globalThis as any).localStorage = { getItem: () => { throw new Error('denied'); } };
    expect(getRemoteImageMode()).toBe('safe');
  });

  // Breaks: a typo'd or corrupt settings blob widens (or throws out of) every decision.
  it('falls back to safe on an unknown mode or corrupt settings', () => {
    writeSettings({ remoteImageMode: 'sometimes' });
    expect(getRemoteImageMode()).toBe('safe');
    writeSettings('{not json');
    expect(getRemoteImageMode()).toBe('safe');
    expect(remoteImageModeOf(null)).toBe('safe');
    expect(remoteImageModeOf('always')).toBe('safe');
  });
});

describe('remoteImageSourcesOf / remoteImageModeFor', () => {
  // Breaks: a stored value means different switches from the ones the Security
  // page shows (a reader ticks "trusted senders only" and gets categorized
  // mail too) — these two are the ONLY translation between them.
  it('reads each stored value as its switches', () => {
    expect(remoteImageSourcesOf('block')).toEqual({ trusted: false, categorized: false, always: false });
    expect(remoteImageSourcesOf('trusted')).toEqual({ trusted: true, categorized: false, always: false });
    expect(remoteImageSourcesOf('categorized')).toEqual({ trusted: false, categorized: true, always: false });
    expect(remoteImageSourcesOf('safe')).toEqual({ trusted: true, categorized: true, always: false });
    // "Always" includes both: the page shows them ticked (and locked).
    expect(remoteImageSourcesOf('always')).toEqual({ trusted: true, categorized: true, always: true });
  });

  // Breaks: a combination of switches saves as a value that reads back as a
  // different combination — the reader's tick flips back on the next render.
  it('round-trips every combination of the switches, and every stored value', () => {
    for (const trusted of [false, true]) {
      for (const categorized of [false, true]) {
        const sources: RemoteImageSources = { trusted, categorized, always: false };
        expect([sources, remoteImageSourcesOf(remoteImageModeFor(sources))]).toEqual([sources, sources]);
        // With "always" on, the two do not matter: it is everything.
        expect(remoteImageModeFor({ trusted, categorized, always: true })).toBe('always');
      }
    }
    for (const mode of REMOTE_IMAGE_MODES) {
      expect([mode, remoteImageModeFor(remoteImageSourcesOf(mode))]).toEqual([mode, mode]);
    }
  });

  // Breaks: both on stops being the default (every existing default reader
  // silently loses one source), or neither on stops meaning 'block'.
  it("maps both on to 'safe' (the default) and neither to 'block'", () => {
    expect(remoteImageModeFor({ trusted: true, categorized: true, always: false })).toBe('safe');
    expect(remoteImageModeFor({ trusted: false, categorized: false, always: false })).toBe('block');
  });

  // Breaks: a caller that mutates the answer changes what every later read of
  // that mode means; or a value that is not a mode widens past the default.
  it('hands out a fresh copy, and reads a value that is not a mode as the default', () => {
    const first = remoteImageSourcesOf('block');
    first.trusted = true;
    expect(remoteImageSourcesOf('block').trusted).toBe(false);
    for (const junk of ['sometimes', 'constructor', 'toString', undefined]) {
      expect(remoteImageSourcesOf(junk as unknown as RemoteImageMode)).toEqual(remoteImageSourcesOf('safe'));
    }
  });
});

describe('saveRemoteImageMode', () => {
  // Breaks: choosing a mode wipes the rest of the reader's settings, or an
  // open message keeps deciding under the old mode.
  it('stores the mode beside every other setting and re-decides open messages', () => {
    writeSettings({ remoteImageMode: 'block', emailsPerPage: 50 });
    const listener = vi.fn();
    const off = subscribeImageTrust(listener);
    const before = getImageTrustVersion();

    expect(saveRemoteImageMode('trusted')).toBe(true);
    expect(JSON.parse(localStorage.getItem(SETTINGS_KEY)!)).toEqual({ remoteImageMode: 'trusted', emailsPerPage: 50 });
    expect(getRemoteImageMode()).toBe('trusted');
    expect(listener).toHaveBeenCalled();
    expect(getImageTrustVersion()).toBeGreaterThan(before);
    off();
  });

  // Breaks: a first-run reader (no settings blob yet) cannot choose a mode.
  it('writes a fresh blob when none exists', () => {
    expect(saveRemoteImageMode('always')).toBe(true);
    expect(getRemoteImageMode()).toBe('always');
  });

  // Breaks: an unreadable settings blob is overwritten with one field,
  // destroying every other setting the reader had.
  it('refuses to write over an unreadable blob, and refuses an unknown mode', () => {
    writeSettings('{not json');
    expect(saveRemoteImageMode('block')).toBe(false);
    expect(localStorage.getItem(SETTINGS_KEY)).toBe('{not json');
    writeSettings('[1,2]');
    expect(saveRemoteImageMode('block')).toBe(false);
    writeSettings({});
    expect(saveRemoteImageMode('sometimes' as RemoteImageMode)).toBe(false);
  });

  // Breaks: a settings write that throws (storage full, a locked profile) is
  // reported as saved, or open messages re-decide under a mode that was never
  // stored — the reader would believe a narrower choice is in force.
  it('reports a failed write as not saved and leaves the mode and open messages as they were', () => {
    writeSettings({ remoteImageMode: 'safe', emailsPerPage: 50 });
    const listener = vi.fn();
    const off = subscribeImageTrust(listener);
    const setItem = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    expect(saveRemoteImageMode('block')).toBe(false);
    setItem.mockRestore();
    expect(JSON.parse(localStorage.getItem(SETTINGS_KEY)!)).toEqual({ remoteImageMode: 'safe', emailsPerPage: 50 });
    expect(getRemoteImageMode()).toBe('safe');
    expect(listener).not.toHaveBeenCalled();
    off();
  });
});

describe('the mode, kept in memory', () => {
  // Breaks: every decision (one per card and per chat bubble, re-run on each
  // trust-source change) re-reads and re-parses the whole settings blob,
  // signatures and all — or, the other way, a kept copy never learns of a new
  // choice. It is re-read only when the blob may have changed.
  it('reads the blob once, and again only after it was written', () => {
    writeSettings({ remoteImageMode: 'trusted' });
    const getItem = vi.spyOn(localStorage, 'getItem');
    expect(getRemoteImageMode()).toBe('trusted');
    expect(getRemoteImageMode()).toBe('trusted');
    expect(getItem).toHaveBeenCalledTimes(1);

    // Any write of the blob in this window (app-settings-sync announces it).
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ remoteImageMode: 'block' }));
    fakeWindow.dispatchEvent(new Event(SETTINGS_WRITTEN_EVENT));
    expect(getRemoteImageMode()).toBe('block');

    // Another window's write arrives as a `storage` event.
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ remoteImageMode: 'always' }));
    fakeWindow.dispatchEvent(Object.assign(new Event('storage'), { key: SETTINGS_KEY }));
    expect(getRemoteImageMode()).toBe('always');
    // A `storage` event about another key is not a reason to re-read.
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ remoteImageMode: 'block' }));
    fakeWindow.dispatchEvent(Object.assign(new Event('storage'), { key: 'sarvinbox-view-mode' }));
    expect(getRemoteImageMode()).toBe('always');
    // …but a cleared store (key null) is.
    fakeWindow.dispatchEvent(Object.assign(new Event('storage'), { key: null }));
    expect(getRemoteImageMode()).toBe('block');
  });

  // Breaks: saving a signature (or any setting) re-decides every open message
  // although the mode did not change.
  it('tells open messages only when the mode itself changed', () => {
    writeSettings({ remoteImageMode: 'block', signatures: [] });
    getRemoteImageMode();
    const listener = vi.fn();
    const off = subscribeImageTrust(listener);

    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ remoteImageMode: 'block', signatures: [{ id: 's1' }] }));
    fakeWindow.dispatchEvent(new Event(SETTINGS_WRITTEN_EVENT));
    expect(listener).not.toHaveBeenCalled();

    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ remoteImageMode: 'always', signatures: [{ id: 's1' }] }));
    fakeWindow.dispatchEvent(new Event(SETTINGS_WRITTEN_EVENT));
    expect(listener).toHaveBeenCalled();
    off();
  });

  // Transient failure: storage that cannot be read once is not remembered as
  // "the default" — the next read tries again and finds the reader's choice.
  it('does not keep the default after a read that failed', () => {
    writeSettings({ remoteImageMode: 'block' });
    const real = localStorage.getItem.bind(localStorage);
    const getItem = vi.spyOn(localStorage, 'getItem').mockImplementationOnce(() => { throw new Error('denied'); });
    expect(getRemoteImageMode()).toBe('safe');
    getItem.mockImplementation(real);
    expect(getRemoteImageMode()).toBe('block');
  });
});

// ─────────────────────────── categories ('safe') ───────────────────────────

describe('isPromoOrSpam / isSpamFolderMail', () => {
  it('matches the AI promotions category and every spam/junk folder tag', () => {
    expect(isPromoOrSpam('|INBOX|promotions|')).toBe(true);
    expect(isPromoOrSpam('|Junk|')).toBe(true);
    expect(isPromoOrSpam('|Spam|')).toBe(true);
    expect(isPromoOrSpam('|[Gmail]/Spam|')).toBe(true);
  });

  // Breaks: Outlook's and nested Spam folders read as ordinary mail, so a
  // trusted-looking spam message fetches its pixels.
  it('recognises every provider\'s Spam/Junk folder, not just three spellings', () => {
    for (const tags of ['|Junk Email|', '|Junk E-mail|', '|Bulk Mail|', '|INBOX/Spam|']) {
      expect(isSpamFolderMail(tags)).toBe(true);
    }
    expect(isSpamFolderMail('|INBOX|Social|read|')).toBe(false);
  });

  it('is false for ordinary mail and for missing tags', () => {
    expect(isPromoOrSpam('|INBOX|read|')).toBe(false);
    expect(isPromoOrSpam(null)).toBe(false);
    expect(isPromoOrSpam(undefined)).toBe(false);
  });

  // Breaks: Dovecot/Courier servers name folders with '.' — trusted, emailed
  // and verified-brand mail sitting in their Junk folder loaded its pixels.
  it("recognises a Spam/Junk folder under the '.' hierarchy delimiter", () => {
    for (const tags of ['|INBOX.Junk|', '|INBOX.Spam|', '|INBOX.Junk E-mail|']) {
      expect([tags, isSpamFolderMail(tags)]).toEqual([tags, true]);
    }
    expect(isSpamFolderMail('|INBOX.Projects|')).toBe(false);
  });

  // Breaks: a Junk folder known only by its special-use (a localized name, or
  // "Junk Mail") is treated as ordinary mail. The account's folder list says
  // which folder it is — and only for that account.
  it("recognises the account's special-use Junk folder whatever it is called", () => {
    const listener = vi.fn();
    const off = subscribeImageTrust(listener);
    noteAccountFolders('acct-a', [{ path: 'INBOX' }, { path: 'Courrier indésirable', specialUse: '\\Junk' }]);
    expect(listener).toHaveBeenCalledTimes(1); // open messages re-decide
    expect(isSpamFolderMail('|Courrier indésirable|', 'acct-a')).toBe(true);
    expect(isSpamFolderMail('|Courrier indésirable|', 'acct-b')).toBe(false);

    // The same list again is not a change.
    noteAccountFolders('acct-a', [{ path: 'Courrier indésirable', specialUse: '\\Junk' }]);
    expect(listener).toHaveBeenCalledTimes(1);

    // Active account: a read naming no account means it.
    setActiveCacheAccount('acct-a');
    expect(isSpamFolderMail('|Courrier indésirable|')).toBe(true);
    // A removed account's folders go with it.
    forgetImageTrustAccount('acct-a');
    expect(isSpamFolderMail('|Courrier indésirable|', 'acct-a')).toBe(false);
    off();
  });
});

describe('qualifiesForCategorizedAutoLoad', () => {
  // Categorized mail auto-loads images ONLY for mail the AI positively
  // recognised. Every uncertain case must stay behind the banner — that's the
  // privacy guarantee of the switch.
  it('refuses promotional / spam mail outright', () => {
    cat.slugs = ['promotions', 'work'];
    expect(qualifiesForCategorizedAutoLoad('|INBOX|promotions|')).toBe(false);
    expect(qualifiesForCategorizedAutoLoad('|Spam|work|')).toBe(false);
  });

  // Breaks: the reader's Social category (a feed of tracking-pixel mail) is
  // treated as trusted as categorized mail. There is no built-in Social category:
  // a reader's own gets its slug from its name, so "Social Media" (social_media)
  // and "Socials" count as much as "Social".
  it('refuses Social mail even though it is a real category, however the reader named it', () => {
    cat.slugs = ['social', 'social_media', 'socials', 'work'];
    for (const social of ['social', 'social_media', 'socials']) {
      expect([social, qualifiesForCategorizedAutoLoad(`|INBOX|${social}|`)]).toEqual([social, false]);
      expect([social, qualifiesForCategorizedAutoLoad(`|INBOX|${social}|work|`)]).toEqual([social, false]);
    }
    // A Social tag excludes even when that category is not (or no longer) enabled.
    cat.slugs = ['work'];
    expect(qualifiesForCategorizedAutoLoad('|INBOX|social_networks|work|')).toBe(false);
    expect(qualifiesForCategorizedAutoLoad('|INBOX|work|')).toBe(true);
  });

  // Breaks: the Social rule swallows categories that are not social, or misses
  // spellings a reader's own category can get.
  it('names Social categories by a word starting with "social"', () => {
    for (const slug of ['social', 'Social', 'social_media', 'socials', 'socialnetworks', 'my-social']) {
      expect([slug, isSocialCategorySlug(slug)]).toEqual([slug, true]);
    }
    for (const slug of ['work', 'finance', 'associations', 'promotions']) {
      expect([slug, isSocialCategorySlug(slug)]).toEqual([slug, false]);
    }
    expect(isImageExcludedCategory('promotions')).toBe(true);
    expect(isImageExcludedCategory('social_media')).toBe(true);
    expect(isImageExcludedCategory('finance')).toBe(false);
  });

  it('stays conservative on a cold slug cache AND warms it for next time', () => {
    cat.slugs = [];
    expect(qualifiesForCategorizedAutoLoad('|INBOX|work|')).toBe(false);
    expect(warmCategoryDefs).toHaveBeenCalled();
  });

  it('auto-loads mail carrying a real enabled category slug', () => {
    cat.slugs = ['work', 'finance'];
    expect(qualifiesForCategorizedAutoLoad('|INBOX|finance|read|')).toBe(true);
  });

  it('keeps UNcategorized mail behind the banner even with a warm cache', () => {
    cat.slugs = ['work'];
    expect(qualifiesForCategorizedAutoLoad('|INBOX|read|')).toBe(false);
    expect(qualifiesForCategorizedAutoLoad(null)).toBe(false);
  });
});

// ────────────────────────────── the allowlist ──────────────────────────────

describe('per-sender image allowlist', () => {
  // Kept synchronous because the block-vs-load decision happens inside the
  // sandboxed-iframe render; a cold cache must answer "no" and warm in the
  // background rather than block the paint.
  it('answers false and warms in the background while the cache is cold', async () => {
    listsOf().allowed = ['boss@x.com'];
    expect(isSenderImagesAllowed('boss@x.com')).toBe(false); // cold → conservative
    await settle();
    expect(api.emails.getImageAllowedSenders).toHaveBeenCalled(); // …but the warm was kicked off
    expect(isSenderImagesAllowed('boss@x.com')).toBe(true);
  });

  it('normalises "Name <addr>" and casing so both forms match one entry', async () => {
    listsOf().allowed = ['Boss@X.com'];
    await warmImageAllowedSenders();
    expect(isSenderImagesAllowed('boss@x.com')).toBe(true);
    expect(isSenderImagesAllowed('The Boss <BOSS@X.com>')).toBe(true);
    expect(isSenderImagesAllowed('  boss@x.com  ')).toBe(true);
    expect(isSenderImagesAllowed('other@x.com')).toBe(false);
  });

  it('treats a missing/blank address as not allowed', async () => {
    await warmImageAllowedSenders();
    expect(isSenderImagesAllowed(undefined)).toBe(false);
    expect(isSenderImagesAllowed('')).toBe(false);
    expect(isSenderImagesAllowed('   ')).toBe(false);
  });

  // DELIBERATE CHANGE: a failed load used to be cached as an EMPTY list
  // ("nobody is allowed") until the next account switch. It now stays
  // unknown — conservative for this render — and is retried, so a transient
  // IPC failure never becomes a permanent banner on allowed senders.
  it('keeps a failed load unknown and retries it, instead of caching "nobody is allowed"', async () => {
    vi.useFakeTimers();
    listsOf().allowed = ['boss@x.com'];
    api.emails.getImageAllowedSenders.mockRejectedValueOnce(new Error('no channel'));
    await warmImageAllowedSenders();
    expect(isSenderImagesAllowed('boss@x.com')).toBe(false);

    api.emails.getImageAllowedSenders.mockResolvedValueOnce({ success: false, error: 'Storage not initialized' });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(isSenderImagesAllowed('boss@x.com')).toBe(false);

    await vi.advanceTimersByTimeAsync(3_000); // the next retry reads the real list
    expect(isSenderImagesAllowed('boss@x.com')).toBe(true);
  });

  // Breaks: "Load images" applies only after the database answered, so the
  // sender's other open messages keep their banner meanwhile.
  it('remembers a sender write-through: cache first, persistence in the background', () => {
    rememberSenderImagesAllowed(message({ fromAddress: 'The Boss <BOSS@X.com>' }));
    expect(isSenderImagesAllowed('boss@x.com')).toBe(true); // immediate, no await
    expect(api.emails.allowImagesForSender).toHaveBeenCalledWith('boss@x.com', undefined); // bare address only
  });

  // Transient failure: a persist that fails is retried (it is idempotent),
  // and one that never succeeds is withdrawn rather than left applying to
  // every message while the database never heard of it.
  it('retries a failing persist, and withdraws the allowance when it never lands', async () => {
    vi.useFakeTimers();
    api.emails.allowImagesForSender.mockRejectedValue(new Error('nope'));
    rememberSenderImagesAllowed(message({ fromAddress: '' }));
    expect(api.emails.allowImagesForSender).not.toHaveBeenCalled();

    expect(() => rememberSenderImagesAllowed(message({ fromAddress: 'a@x.com' }))).not.toThrow();
    expect(isSenderImagesAllowed('a@x.com')).toBe(true);
    await vi.advanceTimersByTimeAsync(PERSIST_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0));
    expect(api.emails.allowImagesForSender).toHaveBeenCalledTimes(1 + PERSIST_RETRY_DELAYS_MS.length);
    expect(isSenderImagesAllowed('a@x.com')).toBe(false);
  });

  // Idempotent re-run: a blip on the first attempt is recovered by the retry,
  // and the stored list holds the sender once.
  it('keeps an allowance whose first persist attempt failed but a retry landed', async () => {
    vi.useFakeTimers();
    api.emails.allowImagesForSender.mockResolvedValueOnce({ success: false, error: 'busy' });
    rememberSenderImagesAllowed(message({ fromAddress: 'boss@x.com' }));
    await vi.advanceTimersByTimeAsync(PERSIST_RETRY_DELAYS_MS[0]);
    expect(api.emails.allowImagesForSender).toHaveBeenCalledTimes(2);
    expect(listsOf().allowed).toEqual(['boss@x.com']);
    expect(isSenderImagesAllowed('boss@x.com')).toBe(true);
  });

  // Breaks: "Load images" on a forgery remembers the forged From. The allowlist
  // outranks every guard (Spam, the auth check, the mode), so every later
  // forgery of that address would load its tracking pixels, even in 'block'.
  it('never remembers the sender of mail in Spam or mail that failed authentication', () => {
    expect(rememberSenderImagesAllowed(message({ fromAddress: 'alerts@bank.test', tags: '|Junk|' }))).toBeNull();
    expect(rememberSenderImagesAllowed(message({ fromAddress: 'alerts@bank.test', authStatus: DMARC_FAIL }))).toBeNull();
    expect(rememberSenderImagesAllowed(null)).toBeNull();
    expect(api.emails.allowImagesForSender).not.toHaveBeenCalled();
    expect(isSenderImagesAllowed('alerts@bank.test')).toBe(false);

    expect(isSuspectSender(message({ tags: '|INBOX.Spam|' }))).toBe(true);
    expect(isSuspectSender(message())).toBe(false);
    // Unknown authentication is not a failure: an old message without a
    // stored verdict is still remembered.
    expect(rememberSenderImagesAllowed(message({ fromAddress: 'old@bank.test', authStatus: null }))?.key).toBe('old@bank.test');
  });

  it('lets one DOMAIN entry cover every sender on it, subdomains included', async () => {
    // The reason domains exist here: a newsletter's envelope sender is a
    // per-campaign address, so a per-sender allowance never sticks.
    listsOf().allowed = ['@Example.com'];
    await warmImageAllowedSenders();
    expect(isSenderImagesAllowed('bounce-987@example.com')).toBe(true);
    expect(isSenderImagesAllowed('News <news@mail.example.com>')).toBe(true);
    expect(isSenderImagesAllowed('news@notexample.com')).toBe(false);
    expect(isSenderImagesAllowed('news@example.com.evil.net')).toBe(false);
  });

  it('stores a typed domain as an "@domain" key and applies it immediately', () => {
    // Write-through: the body renderer reads the CACHE, so an entry that only
    // reached the DB would be listed in Security but honoured by nothing.
    expect(rememberImagesAllowed('Example.COM')).toEqual({ kind: 'domain', key: '@example.com', label: 'example.com' });
    expect(api.emails.allowImagesForSender).toHaveBeenCalledWith('@example.com', undefined);
    expect(isSenderImagesAllowed('anyone@example.com')).toBe(true);
  });

  it('refuses input that is neither an address nor a domain, and persists nothing', () => {
    for (const junk of ['', '   ', 'com', '@co.uk', 'not a domain']) {
      expect(rememberImagesAllowed(junk)).toBeNull();
    }
    expect(api.emails.allowImagesForSender).not.toHaveBeenCalled();
  });

  it('revoking drops the entry from the cache, not just the DB', async () => {
    // Otherwise a revoked allowance keeps loading images on every message
    // already open, until the next account switch.
    listsOf().allowed = ['@example.com'];
    await warmImageAllowedSenders();
    expect(isSenderImagesAllowed('a@example.com')).toBe(true);

    forgetImagesAllowed('@example.com');
    expect(isSenderImagesAllowed('a@example.com')).toBe(false);
    expect(api.emails.disallowImagesForSender).toHaveBeenCalledWith('@example.com', undefined);
    await settle();
    expect(isSenderImagesAllowed('a@example.com')).toBe(false);
  });

  // A revoke the main process did not store is rolled back: the database
  // still allows the domain, so pretending otherwise would only last until the
  // next load.
  it('ignores a blank revoke, and rolls back a revoke that fails or has no channel', async () => {
    listsOf().allowed = ['@x.com'];
    await warmImageAllowedSenders();
    api.emails.disallowImagesForSender.mockRejectedValue(new Error('nope'));
    forgetImagesAllowed('   ');
    forgetImagesAllowed(undefined);
    expect(api.emails.disallowImagesForSender).not.toHaveBeenCalled();
    expect(() => forgetImagesAllowed('@x.com')).not.toThrow();
    await settle();
    expect(isSenderImagesAllowed('a@x.com')).toBe(true);

    delete api.emails.disallowImagesForSender; // older preload with no channel
    expect(() => forgetImagesAllowed('@x.com')).not.toThrow();
    await settle();
    expect(isSenderImagesAllowed('a@x.com')).toBe(true);
  });

  it('clears the cache so the next read reloads', async () => {
    listsOf().allowed = ['boss@x.com'];
    await warmImageAllowedSenders();
    expect(isSenderImagesAllowed('boss@x.com')).toBe(true);

    clearImageAllowedCache();
    listsOf().allowed = [];
    expect(isSenderImagesAllowed('boss@x.com')).toBe(false);
    await settle();
    expect(api.emails.getImageAllowedSenders).toHaveBeenCalledTimes(2);
    expect(isSenderImagesAllowed('boss@x.com')).toBe(false);
  });

  // Multi-account: the allowlist is PER ACCOUNT. The same sender allowed in
  // account A must not auto-load in account B — and "Load images" on B's
  // message (unified view) is remembered in B, not in the active account.
  it('keeps each account\'s allowances to itself, and remembers in the message\'s own account', async () => {
    setActiveCacheAccount('acct-a');
    listsOf('acct-a').allowed = ['boss@x.com'];
    await warmImageAllowedSenders('acct-a');
    await warmImageAllowedSenders('acct-b');
    expect(isSenderImagesAllowed('boss@x.com')).toBe(true); // active = A
    expect(isSenderImagesAllowed('boss@x.com', 'acct-a')).toBe(true);
    expect(isSenderImagesAllowed('boss@x.com', 'acct-b')).toBe(false);

    rememberSenderImagesAllowed(message({ fromAddress: 'pal@y.com', accountId: 'acct-b' }));
    expect(api.emails.allowImagesForSender).toHaveBeenLastCalledWith('pal@y.com', 'acct-b');
    expect(isSenderImagesAllowed('pal@y.com', 'acct-b')).toBe(true);
    expect(isSenderImagesAllowed('pal@y.com', 'acct-a')).toBe(false);
    // A write that names no account goes to the ACTIVE account BY ID, so it
    // cannot land elsewhere if main switches while it is in flight.
    rememberSenderImagesAllowed(message({ fromAddress: 'new@z.com' }));
    expect(api.emails.allowImagesForSender).toHaveBeenLastCalledWith('new@z.com', 'acct-a');
  });
});

// ─────────────────────────── trusted senders ('trusted') ───────────────────

describe('trusted senders for images', () => {
  // Breaks: each source of trust "From trusted senders" promises. The first three
  // are the reader's own signals; the brand is the blue tick.
  it('trusts "Trust this sender", people this account has emailed, and verified brands', async () => {
    listsOf().trusted = ['alerts@bank.test'];
    listsOf().emailed = ['colleague@work.test'];
    identities['news@brand.test'] = 'verified';
    await warm();

    expect(isTrustedForImages(message({ fromAddress: 'Bank <ALERTS@bank.test>' }))).toBe(true);
    expect(isTrustedForImages(message({ fromAddress: 'colleague@work.test' }))).toBe(true);
    expect(hasEmailedAddress(undefined, 'Colleague <colleague@work.test>')).toBe(true);

    // The brand's identity is looked up on first ask, and re-decided when it lands.
    expect(isTrustedForImages(message({ fromAddress: 'news@brand.test' }))).toBe(false);
    await settle();
    expect(isTrustedForImages(message({ fromAddress: 'news@brand.test' }))).toBe(true);

    expect(isTrustedForImages(message({ fromAddress: 'stranger@else.test' }))).toBe(false);
    expect(isTrustedForImages(message({ fromAddress: '' }))).toBe(false);
  });

  // Breaks: the blue tick without its evidence — a logo that is not
  // certificate-verified, or a verified brand's name on mail that did not pass
  // DMARC, is not the brand.
  it('trusts a brand only with a VERIFIED mark AND a DMARC pass', async () => {
    identities['news@logo.test'] = 'logo';
    identities['news@brand.test'] = 'verified';
    const noDmarc = JSON.stringify({ spf: 'pass', dkim: 'pass', dmarc: 'none', overall: 'partial' });
    isTrustedForImages(message({ fromAddress: 'news@logo.test' }));
    isTrustedForImages(message({ fromAddress: 'news@brand.test' }));
    await settle();
    expect(isTrustedForImages(message({ fromAddress: 'news@logo.test' }))).toBe(false);
    expect(isTrustedForImages(message({ fromAddress: 'news@brand.test', authStatus: noDmarc }))).toBe(false);
    expect(isTrustedForImages(message({ fromAddress: 'news@brand.test', authStatus: null }))).toBe(false);
    expect(isTrustedForImages(message({ fromAddress: 'news@brand.test' }))).toBe(true);
  });

  // THE safety guard: the From address is exactly what a forger copies. A
  // message claiming a trusted sender that FAILED authentication, or that sits
  // in Spam, must not fetch its tracking pixels.
  it('never trusts a sender on mail that failed authentication or sits in Spam/Junk', async () => {
    listsOf().trusted = ['alerts@bank.test'];
    listsOf().emailed = ['colleague@work.test'];
    identities['news@brand.test'] = 'verified';
    await warm();
    isTrustedForImages(message({ fromAddress: 'news@brand.test' }));
    await settle();

    for (const fromAddress of ['alerts@bank.test', 'colleague@work.test', 'news@brand.test']) {
      expect(isTrustedForImages(message({ fromAddress, authStatus: DMARC_FAIL }))).toBe(false);
      expect(isTrustedForImages(message({ fromAddress, tags: '|Spam|' }))).toBe(false);
      expect(isTrustedForImages(message({ fromAddress, tags: '|Junk Email|' }))).toBe(false);
    }
    setMode('trusted');
    expect(shouldAutoLoadRemoteImages(message({ fromAddress: 'alerts@bank.test', authStatus: DMARC_FAIL }))).toBe(false);
  });

  // Multi-account: trust and correspondents are per account — account A's
  // colleague is a stranger to account B.
  it('keeps trusted senders and correspondents per account', async () => {
    listsOf('acct-a').trusted = ['alerts@bank.test'];
    listsOf('acct-a').emailed = ['colleague@work.test'];
    await warm('acct-a', 'acct-b');
    expect(isTrustedForImages(message({ fromAddress: 'alerts@bank.test', accountId: 'acct-a' }))).toBe(true);
    expect(isTrustedForImages(message({ fromAddress: 'colleague@work.test', accountId: 'acct-a' }))).toBe(true);
    expect(isTrustedForImages(message({ fromAddress: 'alerts@bank.test', accountId: 'acct-b' }))).toBe(false);
    expect(isTrustedForImages(message({ fromAddress: 'colleague@work.test', accountId: 'acct-b' }))).toBe(false);
  });

  // Breaks: someone the reader writes to mid-session stays a stranger until
  // restart. A stored Sent copy re-reads the list — once per burst, only once
  // something uses it — and a failed re-read keeps the list it had.
  it('re-reads the correspondents after a Sent copy, gathered, only once loaded, keeping them on a failure', async () => {
    vi.useFakeTimers();
    refreshEmailedAddresses();
    await vi.advanceTimersByTimeAsync(EMAILED_REFRESH_DELAY_MS);
    expect(api.emails.getEmailedAddresses).not.toHaveBeenCalled(); // nobody asked yet

    listsOf().emailed = ['colleague@work.test'];
    await emailedAddresses.reload();
    api.emails.getEmailedAddresses.mockClear();
    listsOf().emailed = ['colleague@work.test', 'new@friend.test'];
    refreshEmailedAddresses();
    refreshEmailedAddresses(); // a burst of Sent copies…
    await vi.advanceTimersByTimeAsync(EMAILED_REFRESH_DELAY_MS);
    expect(api.emails.getEmailedAddresses).toHaveBeenCalledTimes(1); // …is one re-read
    expect(hasEmailedAddress(undefined, 'new@friend.test')).toBe(true);

    api.emails.getEmailedAddresses.mockRejectedValueOnce(new Error('busy'));
    refreshEmailedAddresses();
    await vi.advanceTimersByTimeAsync(EMAILED_REFRESH_DELAY_MS);
    expect(hasEmailedAddress(undefined, 'colleague@work.test')).toBe(true);
  });

  // Breaks: the re-read (a scan of the account's sender stats in main, and
  // every address over IPC) runs while trusted senders are off — categorized
  // mail only never consults the list — or stops running while they are on.
  it('re-reads the correspondents only while trusted senders are switched on', async () => {
    vi.useFakeTimers();
    await emailedAddresses.reload();
    api.emails.getEmailedAddresses.mockClear();
    for (const mode of ['block', 'categorized', 'always'] as const) {
      setMode(mode);
      refreshEmailedAddresses();
      await vi.advanceTimersByTimeAsync(EMAILED_REFRESH_DELAY_MS);
    }
    expect(api.emails.getEmailedAddresses).not.toHaveBeenCalled();
    for (const mode of ['trusted', 'safe'] as const) {
      setMode(mode);
      // Switching trusted senders on catches up what was skipped while off
      // (its own test below); only the Sent copy's re-read is counted here.
      await vi.advanceTimersByTimeAsync(0);
      api.emails.getEmailedAddresses.mockClear();
      refreshEmailedAddresses();
      await vi.advanceTimersByTimeAsync(EMAILED_REFRESH_DELAY_MS);
      expect([mode, api.emails.getEmailedAddresses.mock.calls.length]).toEqual([mode, 1]);
    }
  });

  // Breaks: someone the reader wrote to while "From trusted senders" was off
  // (or overruled by Always) stays a stranger after it is switched back on —
  // their replies keep the banner until restart or an account switch. The Sent
  // copy's re-read was skipped then, so switching back on must re-read.
  it('someone emailed while trusted senders was off is trusted once it is switched back on', async () => {
    vi.useFakeTimers();
    listsOf().emailed = ['old@pal.test'];
    await emailedAddresses.reload();
    const reply = message({ fromAddress: 'new@pal.test' });
    for (const [off, on] of [['categorized', 'safe'], ['block', 'trusted'], ['always', 'safe']] as const) {
      listsOf().emailed = ['old@pal.test'];
      setMode('safe');
      await emailedAddresses.reload();
      api.emails.getEmailedAddresses.mockClear();

      expect(saveRemoteImageMode(off)).toBe(true); // the Security page's save path
      listsOf().emailed = ['old@pal.test', 'new@pal.test']; // a Sent copy to someone new…
      refreshEmailedAddresses();
      await vi.advanceTimersByTimeAsync(EMAILED_REFRESH_DELAY_MS);
      expect([off, api.emails.getEmailedAddresses.mock.calls.length]).toEqual([off, 0]); // …not re-read while off

      expect(saveRemoteImageMode(on)).toBe(true);
      await vi.advanceTimersByTimeAsync(0);
      expect([off, on, api.emails.getEmailedAddresses.mock.calls.length]).toEqual([off, on, 1]);
      expect([off, on, shouldAutoLoadRemoteImages(reply)]).toEqual([off, on, true]);
      expect(shouldAutoLoadRemoteImages(message({ fromAddress: 'old@pal.test' }))).toBe(true);
    }
  });

  // Breaks: the catch-up re-reads on every mode change (a scan of the sender
  // stats per click), re-reads while the list is still unused, or re-reads a
  // list nobody has loaded. It runs once, when the list comes back into use,
  // only for what was skipped — also when another window changed the mode.
  it('catches up once, only when trusted senders come back on, only for what was skipped', async () => {
    vi.useFakeTimers();
    await emailedAddresses.reload();
    setMode('block');
    refreshEmailedAddresses();
    api.emails.getEmailedAddresses.mockClear();

    setMode('categorized'); // still off: nothing to catch up yet
    setMode('always'); // overrules trusted senders: still unused
    await vi.advanceTimersByTimeAsync(0);
    expect(api.emails.getEmailedAddresses).not.toHaveBeenCalled();

    // Another window turns trusted senders on: it arrives as a settings write.
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ remoteImageMode: 'trusted' }));
    fakeWindow.dispatchEvent(new Event(SETTINGS_WRITTEN_EVENT));
    await vi.advanceTimersByTimeAsync(0);
    expect(api.emails.getEmailedAddresses).toHaveBeenCalledTimes(1);

    setMode('safe'); // idempotent: nothing was skipped since
    setMode('trusted');
    await vi.advanceTimersByTimeAsync(0);
    expect(api.emails.getEmailedAddresses).toHaveBeenCalledTimes(1);

    // A Sent copy for a list nobody has loaded is not a reason to load it.
    emailedAddresses.clear();
    setMode('block');
    refreshEmailedAddresses();
    setMode('safe');
    await vi.advanceTimersByTimeAsync(0);
    expect(api.emails.getEmailedAddresses).toHaveBeenCalledTimes(1);
  });

  // Multi-account, and a transient failure: the catch-up re-reads exactly the
  // accounts whose Sent copies were skipped (a background one included), not
  // the rest, not a removed account; a failed catch-up keeps the old list
  // readable and is retried, never read as "emailed nobody".
  it('catches up per account, skips removed ones, and retries a failed catch-up', async () => {
    vi.useFakeTimers();
    setActiveCacheAccount('acct-a');
    listsOf('acct-b').emailed = ['old@pal.test'];
    await Promise.all(['acct-a', 'acct-b', 'acct-c', 'acct-d'].map((id) => emailedAddresses.reload(id)));
    api.emails.getEmailedAddresses.mockClear();

    setMode('categorized');
    refreshEmailedAddresses('acct-b'); // a background account's Sent copy
    refreshEmailedAddresses('acct-d');
    forgetImageTrustAccount('acct-d'); // …then acct-d is removed
    await emailedAddresses.reload('acct-d'); // and an account with its id is added again
    api.emails.getEmailedAddresses.mockClear();

    listsOf('acct-b').emailed = ['old@pal.test', 'new@pal.test'];
    api.emails.getEmailedAddresses.mockRejectedValueOnce(new Error('Storage busy'));
    setMode('safe');
    await vi.advanceTimersByTimeAsync(0);
    expect(api.emails.getEmailedAddresses.mock.calls).toEqual([['acct-b']]);
    const newReply = message({ fromAddress: 'new@pal.test', accountId: 'acct-b' });
    expect(hasEmailedAddress('acct-b', 'old@pal.test')).toBe(true); // the old list stays
    expect(shouldAutoLoadRemoteImages(newReply)).toBe(false);

    await vi.advanceTimersByTimeAsync(1_000); // the cache's retry
    expect(api.emails.getEmailedAddresses.mock.calls).toEqual([['acct-b'], ['acct-b']]);
    expect(shouldAutoLoadRemoteImages(newReply)).toBe(true);
    expect(shouldAutoLoadRemoteImages({ ...newReply, accountId: 'acct-c' })).toBe(false); // B's correspondent, not C's
  });

  // Breaks: an account switch re-reads the list anyway, and the catch-up then
  // scans it a second time for nothing when trusted senders come back on.
  it('does not catch up an account an account switch has just re-read', async () => {
    vi.useFakeTimers();
    await emailedAddresses.reload('acct-a');
    setActiveCacheAccount('acct-a');
    setMode('categorized');
    refreshEmailedAddresses('acct-a');
    setImageTrustAccount('acct-b');
    setImageTrustAccount('acct-a'); // back: warmed, fresh
    await vi.advanceTimersByTimeAsync(0);
    api.emails.getEmailedAddresses.mockClear();
    setMode('safe');
    await vi.advanceTimersByTimeAsync(0);
    expect(api.emails.getEmailedAddresses).not.toHaveBeenCalled();
  });

  // Multi-account: a Sent copy in a background account re-reads THAT account's
  // list, not the active one's.
  it("re-reads the named account's correspondents", async () => {
    vi.useFakeTimers();
    setActiveCacheAccount('acct-a');
    await emailedAddresses.reload('acct-a');
    await emailedAddresses.reload('acct-b');
    api.emails.getEmailedAddresses.mockClear();
    refreshEmailedAddresses('acct-b');
    await vi.advanceTimersByTimeAsync(EMAILED_REFRESH_DELAY_MS);
    expect(api.emails.getEmailedAddresses.mock.calls).toEqual([['acct-b']]);
  });

  // Transient failure: the correspondents list failing to load reads as
  // "not known yet", and is retried — never as "you have emailed nobody".
  it('retries a failed correspondents load instead of trusting nobody for the session', async () => {
    vi.useFakeTimers();
    listsOf().emailed = ['colleague@work.test'];
    api.emails.getEmailedAddresses.mockRejectedValueOnce(new Error('Storage not initialized'));
    expect(hasEmailedAddress(undefined, 'colleague@work.test')).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(hasEmailedAddress(undefined, 'colleague@work.test')).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(hasEmailedAddress(undefined, 'colleague@work.test')).toBe(true);
  });
});

// ─────────────────────────────── the decision ──────────────────────────────

describe('shouldAutoLoadRemoteImages', () => {
  // This is the ONE answer both renderers use — the classic card and the chat
  // view. It lived inside SandboxedEmailBody, so the chat view never asked and
  // kept the library's block-everything default: a reader on 'always' still got
  // the banner on half the app. Any drift here brings that split back.
  it('auto-loads everywhere on always, and nowhere on block', () => {
    setMode('always');
    expect(shouldAutoLoadRemoteImages(message())).toBe(true);
    // Even a message the AI never categorised, or none at all: 'always' means always.
    expect(shouldAutoLoadRemoteImages(message({ tags: '|Spam|' }))).toBe(true);
    expect(shouldAutoLoadRemoteImages(null)).toBe(true);

    cat.slugs = ['work'];
    setMode('block');
    expect(shouldAutoLoadRemoteImages(message({ tags: '|INBOX|work|' }))).toBe(false);
  });

  // 'safe' is the default mode, so getting this backwards would auto-load
  // tracking pixels for every new install; 'categorized' is the same category
  // gate without the trusted senders.
  it('defers to the category whenever categorized mail is on', () => {
    cat.slugs = ['work', 'social', 'promotions'];
    for (const mode of ['safe', 'categorized'] as const) {
      setMode(mode);
      expect([mode, shouldAutoLoadRemoteImages(message({ tags: '|INBOX|work|' }))]).toEqual([mode, true]);
      expect([mode, shouldAutoLoadRemoteImages(message({ tags: '|INBOX|' }))]).toEqual([mode, false]);
      expect([mode, shouldAutoLoadRemoteImages(message({ tags: '|INBOX|social|' }))]).toEqual([mode, false]);
      expect([mode, shouldAutoLoadRemoteImages(message({ tags: '|INBOX|promotions|' }))]).toEqual([mode, false]);
      expect([mode, shouldAutoLoadRemoteImages(message({ tags: '|Spam|work|' }))]).toEqual([mode, false]);
    }
  });

  // An allowlisted sender is an explicit per-sender decision by the reader, so
  // it outranks the global mode — including 'block', which is the whole point
  // of the "load images from this sender" affordance — and the spam guard.
  it('lets an allowlisted sender beat every mode', async () => {
    listsOf().allowed = ['boss@x.com'];
    await warmImageAllowedSenders();

    for (const mode of REMOTE_IMAGE_MODES) {
      setMode(mode);
      expect(shouldAutoLoadRemoteImages(message({ fromAddress: 'The Boss <BOSS@X.com>' }))).toBe(true);
      expect(shouldAutoLoadRemoteImages(message({ fromAddress: 'boss@x.com', tags: '|Spam|', authStatus: DMARC_FAIL }))).toBe(true);
    }

    setMode('block');
    expect(shouldAutoLoadRemoteImages(message({ fromAddress: 'stranger@x.com' }))).toBe(false);
  });

  // A missing sender must not throw or accidentally match the allowlist — a
  // chat bubble can carry a message whose From never parsed.
  it('treats a missing sender as not allowlisted', () => {
    setMode('block');
    expect(shouldAutoLoadRemoteImages(undefined)).toBe(false);
    expect(shouldAutoLoadRemoteImages(message({ fromAddress: null }))).toBe(false);
    for (const mode of ['trusted', 'categorized', 'safe'] as const) {
      setMode(mode);
      expect([mode, shouldAutoLoadRemoteImages(message({ fromAddress: null }))]).toEqual([mode, false]);
    }
  });

  // Breaks: the two switches stop being independent — categorized-only loading
  // a trusted sender's UNcategorized mail, trusted-only loading a stranger's
  // categorized mail — or either one drops its guard (Social/Promotional/Spam
  // for categories; Spam and failed authentication for trusted senders), or
  // the allowlist stops applying whatever is switched on.
  it('decides every stored value by its own switches, across every kind of mail', async () => {
    cat.slugs = ['work', 'social', 'promotions'];
    listsOf().allowed = ['boss@x.com'];
    listsOf().emailed = ['colleague@work.test'];
    listsOf().trusted = ['alerts@bank.test'];
    await warm();

    const kinds = {
      allowlisted: message({ fromAddress: 'boss@x.com' }),
      emailedUncategorized: message({ fromAddress: 'colleague@work.test' }),
      markedTrustedUncategorized: message({ fromAddress: 'alerts@bank.test' }),
      trustedPromotional: message({ fromAddress: 'colleague@work.test', tags: '|INBOX|promotions|' }),
      trustedCategorized: message({ fromAddress: 'colleague@work.test', tags: '|INBOX|work|' }),
      strangerCategorized: message({ fromAddress: 'robot@vendor.test', tags: '|INBOX|work|' }),
      strangerSocial: message({ fromAddress: 'robot@vendor.test', tags: '|INBOX|social|' }),
      strangerPromotional: message({ fromAddress: 'robot@vendor.test', tags: '|INBOX|promotions|' }),
      strangerUncategorized: message({ fromAddress: 'robot@vendor.test' }),
      spamCategorized: message({ fromAddress: 'robot@vendor.test', tags: '|Spam|work|' }),
      trustedInSpam: message({ fromAddress: 'colleague@work.test', tags: '|Junk|' }),
      trustedFailedAuth: message({ fromAddress: 'alerts@bank.test', authStatus: DMARC_FAIL }),
    };
    type Kind = keyof typeof kinds;
    //                                  block  trusted categorized safe  always
    const table: Record<Kind, [boolean, boolean, boolean, boolean, boolean]> = {
      allowlisted:                     [true,  true,   true,       true,  true],
      emailedUncategorized:            [false, true,   false,      true,  true],
      markedTrustedUncategorized:      [false, true,   false,      true,  true],
      trustedPromotional:              [false, true,   false,      true,  true],
      trustedCategorized:              [false, true,   true,       true,  true],
      strangerCategorized:             [false, false,  true,       true,  true],
      strangerSocial:                  [false, false,  false,      false, true],
      strangerPromotional:             [false, false,  false,      false, true],
      strangerUncategorized:           [false, false,  false,      false, true],
      spamCategorized:                 [false, false,  false,      false, true],
      trustedInSpam:                   [false, false,  false,      false, true],
      trustedFailedAuth:               [false, false,  false,      false, true],
    };
    const columns: RemoteImageMode[] = ['block', 'trusted', 'categorized', 'safe', 'always'];
    for (const [column, mode] of columns.entries()) {
      setMode(mode);
      for (const kind of Object.keys(kinds) as Kind[]) {
        expect([mode, kind, shouldAutoLoadRemoteImages(kinds[kind])]).toEqual([mode, kind, table[kind][column]]);
      }
    }
  });

  // Multi-account: the same sender allowed in account A is not allowed in B,
  // under every mode that consults the allowlist.
  it('decides each message against its own account', async () => {
    listsOf('acct-a').allowed = ['boss@x.com'];
    listsOf('acct-a').emailed = ['colleague@work.test'];
    await warm('acct-a', 'acct-b');
    setMode('block');
    expect(shouldAutoLoadRemoteImages(message({ fromAddress: 'boss@x.com', accountId: 'acct-a' }))).toBe(true);
    expect(shouldAutoLoadRemoteImages(message({ fromAddress: 'boss@x.com', accountId: 'acct-b' }))).toBe(false);
    setMode('trusted');
    expect(shouldAutoLoadRemoteImages(message({ fromAddress: 'colleague@work.test', accountId: 'acct-a' }))).toBe(true);
    expect(shouldAutoLoadRemoteImages(message({ fromAddress: 'colleague@work.test', accountId: 'acct-b' }))).toBe(false);
  });

  // Breaks: a mode starts reading (and loading) a source it ignores — 'block'
  // or categorized-only the trust lists, trusted-only the category slugs.
  it('reads only what the mode needs', () => {
    for (const mode of ['block', 'categorized'] as const) {
      setMode(mode);
      shouldAutoLoadRemoteImages(message({ tags: '|INBOX|work|' }));
      expect([mode, api.emails.getEmailedAddresses.mock.calls.length, api.spam.listTrustedSenders.mock.calls.length]).toEqual([mode, 0, 0]);
    }
    vi.mocked(getCachedCategorySlugs).mockClear();
    vi.mocked(warmCategoryDefs).mockClear(); // categorized-only asked (cold slugs) above
    setMode('trusted');
    shouldAutoLoadRemoteImages(message({ tags: '|INBOX|work|' }));
    expect(getCachedCategorySlugs).not.toHaveBeenCalled();
    expect(warmCategoryDefs).not.toHaveBeenCalled();
    setMode('always');
    clearImageAllowedCache();
    api.emails.getImageAllowedSenders.mockClear();
    shouldAutoLoadRemoteImages(message());
    expect(api.emails.getImageAllowedSenders).not.toHaveBeenCalled();
  });
});

describe('remoteImageFactsOf', () => {
  // Breaks: a unified-view thread row (which carries no account) is decided
  // against the ACTIVE account's lists instead of the account it was read from.
  it('uses the row\'s account, else the open message\'s account, else the active one', () => {
    const row = { fromAddress: 'a@x.test', tags: '|INBOX|', authStatus: PASS };
    expect(remoteImageFactsOf({ ...row, accountId: 'acct-b' }, 'acct-c')?.accountId).toBe('acct-b');
    expect(remoteImageFactsOf(row, 'acct-c')).toEqual({ ...row, accountId: 'acct-c' });
    expect(remoteImageFactsOf(row)?.accountId).toBeNull();
    expect(remoteImageFactsOf({})).toEqual({ fromAddress: null, tags: null, authStatus: null, accountId: null });
    expect(remoteImageFactsOf(null)).toBeNull();
  });
});

// ─────────────────────────── observing / warming ───────────────────────────

describe('subscribeImageTrust / setImageTrustAccount', () => {
  // Breaks: the cold-cache bug — nothing told the open message that the list
  // it needed had arrived, so it kept the banner until the reader navigated.
  it('notifies when any trust source changes', async () => {
    const listener = vi.fn();
    const off = subscribeImageTrust(listener);
    const v0 = getImageTrustVersion();

    await warmImageAllowedSenders();
    expect(listener).toHaveBeenCalledTimes(1);
    rememberImagesAllowed('boss@x.com');
    expect(listener).toHaveBeenCalledTimes(2);
    isTrustedForImages(message({ fromAddress: 'news@brand.test' })); // identity lookup
    await settle();
    expect(listener.mock.calls.length).toBeGreaterThan(2);
    cat.version += 1;
    cat.listeners.forEach((l) => l());
    expect(getImageTrustVersion()).toBeGreaterThan(v0);

    off();
    listener.mockClear();
    rememberImagesAllowed('other@x.com');
    expect(listener).not.toHaveBeenCalled();
  });

  // Breaks: eager warming — after launch or a switch, the first message
  // opened was decided on cold caches. Every source loads for the new account
  // at once, by id.
  it('warms every source for the account at once, and makes it the active one', async () => {
    listsOf('acct-a').allowed = ['boss@x.com'];
    setImageTrustAccount('acct-a');
    expect(api.emails.getImageAllowedSenders).not.toHaveBeenCalled(); // queued, not inline
    await settle();
    expect(api.emails.getImageAllowedSenders).toHaveBeenCalledWith('acct-a');
    expect(api.emails.getEmailedAddresses).toHaveBeenCalledWith('acct-a');
    expect(api.spam.listTrustedSenders).toHaveBeenCalledWith('acct-a');
    expect(warmCategoryDefs).toHaveBeenCalled();
    expect(isSenderImagesAllowed('boss@x.com')).toBe(true);

    // Switch: reads that name no account now mean B, and B's lists load.
    setImageTrustAccount('acct-b');
    expect(isSenderImagesAllowed('boss@x.com')).toBe(false);
    await settle();
    expect(api.emails.getImageAllowedSenders).toHaveBeenCalledWith('acct-b');
    expect(isSenderImagesAllowed('boss@x.com')).toBe(false);
    expect(isSenderImagesAllowed('boss@x.com', 'acct-a')).toBe(true);
  });

  it('does not warm anything while no account is known', async () => {
    setImageTrustAccount(null);
    await settle();
    expect(api.emails.getImageAllowedSenders).not.toHaveBeenCalled();
  });

  // Breaks: removing an account and adding the same address again (the same
  // id) starts from the removed account's lists — an allowance the reader
  // revoked by deleting the account comes back until the next reload.
  it("forgets a removed account's lists, and only that account's", async () => {
    listsOf('acct-a').allowed = ['boss@x.com'];
    listsOf('acct-b').allowed = ['boss@x.com'];
    await warm('acct-a', 'acct-b');
    const listener = vi.fn();
    const off = subscribeImageTrust(listener);

    forgetImageTrustAccount('acct-a');
    expect(listener).toHaveBeenCalled();
    expect(imageAllowlist.isLoaded('acct-a')).toBe(false);
    expect(emailedAddresses.isLoaded('acct-a')).toBe(false);
    expect(isSenderImagesAllowed('boss@x.com', 'acct-b')).toBe(true);
    forgetImageTrustAccount('acct-never-loaded'); // nothing held: a no-op
    off();
  });
});
