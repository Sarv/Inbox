import { beforeEach, describe, expect, it, vi } from 'vitest';

// Phone mining at the end of a contact scan.
//
// Two things it must get right, both silent when wrong — the user just sees a
// contact card with no number:
//   1. The contact DIRECTORY is shared across accounts but `emails` is not, so
//      a person's signature may only exist in a mailbox other than the one the
//      scan was started from.
//   2. A reply is top-posted: the sender's own signature sits ABOVE the quoted
//      chain, so a body window taken from the end of the message reads somebody
//      else's sign-off.
//
// The handler is captured at registration and driven directly; only the
// module's own edges (electron, ../shared) are mocked, so the real mining and
// classification code from @sarvinbox/core runs.

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...a: any[]) => any>(),
  runtimes: [] as Array<[string, { storage: any }]>,
  primary: null as any,
}));

vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, fn: (...a: any[]) => any) => h.handlers.set(name, fn) },
  dialog: {}, shell: {}, app: { getPath: () => '/tmp' },
}));
vi.mock('../../../../electron/shared', () => ({
  requireStorage: () => h.primary,
  getStorageFor: (id: string) => h.runtimes.find(([rid]) => rid === id)?.[1].storage ?? null,
  getAllAccountRuntimes: () => h.runtimes,
}));

import { registerContactsHandlers } from '../../../../electron/ipc/contacts-handlers';

const AMIT = 'amit.shukla@acme.in';
const AMIT_MOBILE = '+919876543210';

const SIGNATURE = `
  <p>Regards,</p>
  <p>Amit Shukla<br>Engineering Lead<br>M: +91 98765 43210<br>acme.in</p>`;

/** A reply longer than the 12KB conversion budget, signature at the TOP. */
const topPostedReply = (): string => {
  const quoted = `
    <div>On Mon, 2 Mar 2026 at 10:04, Ravi Menon &lt;ravi@vendor.co.in&gt; wrote:</div>
    <blockquote>
      ${'<p>Circling back on the revised timeline for the integration work.</p>'.repeat(300)}
      <p>Best,<br>Ravi Menon<br>Account Manager<br>M: +91 90000 11111</p>
    </blockquote>`;
  const reply = `<p>Thanks Ravi, looks good.</p>${SIGNATURE}${quoted}`;
  // Guard the fixture itself: if it ever shrinks under the budget the test
  // would pass without exercising the window at all.
  if (reply.length < 12 * 1024) throw new Error('fixture is under the conversion budget');
  return reply;
};

/** A folder the scan will walk, with the emails it holds. */
interface FakeFolder { id: string; name: string; path: string; emails: any[] }

/** A mailbox: a contact list (shared — same rows for every account) plus mail. */
function fakeStorage(
  mail: Record<string, Array<{ date: number; raw_body: string }>> = {},
  folders: FakeFolder[] = [],
) {
  return {
    getFolders: vi.fn(async () => folders.map(({ id, name, path }) => ({ id, name, path }))),
    getEmailsByFolder: vi.fn(async (folderId: string, { offset }: { limit: number; offset: number }) =>
      (offset === 0 ? folders.find((f) => f.id === folderId)?.emails ?? [] : [])),
    extractContactsFromEmail: vi.fn(async () => {}),
    setSenderStatsCounts: vi.fn(async (_rows: Array<{ email: string }>) => {}),
    upsertSenderStats: vi.fn(async () => {}),
    getContactsCount: vi.fn(async () => 1),
    getContacts: vi.fn(async () => [{ id: 'c1', email: AMIT }]),
    getPhoneMiningState: vi.fn(() => new Map()),
    getNewestEmailDateBySender: vi.fn(() => new Map(
      Object.entries(mail).map(([email, rows]) => [email, Math.max(...rows.map((r) => r.date))]),
    )),
    getRecentInboundEmailsForContact: vi.fn(async (email: string) => mail[email.toLowerCase()] ?? []),
    setPhoneMiningState: vi.fn(),
    applyPhoneClassification: vi.fn(async () => {}),
    applyPersonalUrls: vi.fn(async () => {}),
    applyCompanyUrls: vi.fn(async () => {}),
  };
}

/** The (email, officePhone, directPhone) triples written back by the scan. */
const classified = (storage: ReturnType<typeof fakeStorage>) =>
  storage.applyPhoneClassification.mock.calls.map((c: any[]) => ({
    email: c[0], office: c[1], direct: c[2],
  }));

beforeEach(() => {
  h.handlers.clear();
  h.runtimes = [];
  h.primary = null;
  registerContactsHandlers();
});

const scan = () => h.handlers.get('contacts:scan')!();

describe('mining a top-posted reply', () => {
  // Regression: the scan converted only the LAST 12KB of a body, so in any
  // reply longer than that the sender's own signature — which sits above the
  // quoted chain — was outside the window. Their mobile never reached the
  // contact list, however many times they sent it.
  it("finds the sender's signature above a quoted chain longer than the budget", async () => {
    const storage = fakeStorage({ [AMIT]: [{ date: 1_770_000_000, raw_body: topPostedReply() }] });
    h.primary = storage;
    h.runtimes = [['acct-a', { storage }]];

    await scan();

    expect(classified(storage)).toContainEqual(
      expect.objectContaining({ email: AMIT, direct: AMIT_MOBILE }),
    );
  });
});

describe('mining across accounts', () => {
  // Regression: after the contact directory was unified, the contact list is
  // every account's and the mail is one account's. Mining only the storage the
  // scan was started from left every contact who writes to the user's OTHER
  // address looking like a contact with no signature.
  it('mines mail that only exists in another account', async () => {
    const scanning = fakeStorage(); // the active account has none of their mail
    const other = fakeStorage({ [AMIT]: [{ date: 1_770_000_000, raw_body: `<p>Hi</p>${SIGNATURE}` }] });
    h.primary = scanning;
    h.runtimes = [['acct-a', { storage: scanning }], ['acct-b', { storage: other }]];

    await scan();

    expect(other.getRecentInboundEmailsForContact).toHaveBeenCalledWith(AMIT, expect.any(Number));
    expect(classified(scanning)).toContainEqual(
      expect.objectContaining({ email: AMIT, direct: AMIT_MOBILE }),
    );
  });

  // Transient vs permanent: one account's database being momentarily
  // unreadable must not cost the contact the number the OTHER account can
  // still see. Reading nothing and writing null would clear a good number.
  it('survives one account failing to read', async () => {
    const broken = fakeStorage();
    broken.getRecentInboundEmailsForContact = vi.fn(
      async (_email: string): Promise<Array<{ date: number; raw_body: string }>> => {
        throw new Error('db is locked');
      },
    );
    const healthy = fakeStorage({ [AMIT]: [{ date: 1_770_000_000, raw_body: `<p>Hi</p>${SIGNATURE}` }] });
    h.primary = broken;
    h.runtimes = [['acct-a', { storage: broken }], ['acct-b', { storage: healthy }]];

    await scan();

    expect(classified(broken)).toContainEqual(
      expect.objectContaining({ email: AMIT, direct: AMIT_MOBILE }),
    );
  });

  // The watermark that drives the incremental skip is stored ONCE in the shared
  // directory, so it has to be the newest mail across ALL accounts. Taking one
  // account's would park it behind another account's newer mail and that
  // person's signature would never be re-read.
  it('records the newest mail across every account as the watermark', async () => {
    const older = fakeStorage({ [AMIT]: [{ date: 1_700_000_000, raw_body: `<p>Hi</p>${SIGNATURE}` }] });
    const newer = fakeStorage({ [AMIT]: [{ date: 1_770_000_000, raw_body: `<p>Hi</p>${SIGNATURE}` }] });
    h.primary = older;
    h.runtimes = [['acct-a', { storage: older }], ['acct-b', { storage: newer }]];

    await scan();

    expect(older.setPhoneMiningState).toHaveBeenCalledWith(AMIT, 1_770_000_000, expect.anything());
  });

  // Pre-multi-account installs have no registered runtimes at all. The scan
  // must still mine its own storage rather than finding no sources and
  // silently clearing everyone's numbers.
  it('falls back to the scanning account when no runtimes are registered', async () => {
    const storage = fakeStorage({ [AMIT]: [{ date: 1_770_000_000, raw_body: `<p>Hi</p>${SIGNATURE}` }] });
    h.primary = storage;
    h.runtimes = [];

    await scan();

    expect(classified(storage)).toContainEqual(
      expect.objectContaining({ email: AMIT, direct: AMIT_MOBILE }),
    );
  });
});

/** One received email in a folder the scan walks. */
const inbox = (from: string): FakeFolder => ({
  id: 'f-inbox', name: 'Inbox', path: 'INBOX',
  emails: [{ id: `m-${from}`, fromAddress: from, tags: '|read|', subject: 'Hi' }],
});

/** The addresses a mailbox extracted contacts for during the scan. */
const extracted = (storage: ReturnType<typeof fakeStorage>) =>
  storage.extractContactsFromEmail.mock.calls.map((c: any[]) => c[0].fromAddress);

describe('scanning every account', () => {
  // Regression: the contact directory is shared but `emails` is not. The scan
  // walked only the account it was started from, so everyone who writes to the
  // user's OTHER address was missing from a list that is meant to be one list —
  // and only appeared if the user happened to switch accounts and scan again.
  it('extracts contacts from every connected account', async () => {
    const first = fakeStorage({}, [inbox('one@acme.in')]);
    const second = fakeStorage({}, [inbox('two@vendor.co.in')]);
    h.primary = first;
    h.runtimes = [['acct-a', { storage: first }], ['acct-b', { storage: second }]];

    await scan();

    expect(extracted(first)).toEqual(['one@acme.in']);
    expect(extracted(second)).toEqual(['two@vendor.co.in']);
  });

  // Regression: sender stats are per-account and written ABSOLUTELY, so a scan
  // that tallied every mailbox into one map would credit the active account
  // with another account's mail and make its counts disagree with its folders.
  it("keeps each mailbox's sender stats to its own mail", async () => {
    const first = fakeStorage({}, [inbox('one@acme.in')]);
    const second = fakeStorage({}, [inbox('two@vendor.co.in')]);
    h.primary = first;
    h.runtimes = [['acct-a', { storage: first }], ['acct-b', { storage: second }]];

    await scan();

    const rows = (s: ReturnType<typeof fakeStorage>) =>
      (s.setSenderStatsCounts.mock.calls[0]?.[0] ?? []).map((r) => r.email);
    expect(rows(first)).toEqual(['one@acme.in']);
    expect(rows(second)).toEqual(['two@vendor.co.in']);
  });

  // Transient vs permanent: one account's DB being momentarily unreadable (a
  // lock mid-sync) must not abort the scan and cost every OTHER account its
  // contacts.
  it('finishes the other accounts when one mailbox fails to read', async () => {
    const broken = fakeStorage({}, []);
    broken.getFolders = vi.fn(async (): Promise<Array<{ id: string; name: string; path: string }>> => {
      throw new Error('db is locked');
    });
    const healthy = fakeStorage({}, [inbox('two@vendor.co.in')]);
    h.primary = broken;
    h.runtimes = [['acct-a', { storage: broken }], ['acct-b', { storage: healthy }]];

    const result = await scan();

    expect(extracted(healthy)).toEqual(['two@vendor.co.in']);
    expect(result.success).toBe(true);
  });

  // Pre-multi-account installs register no runtimes at all; the scan must still
  // walk its own mailbox rather than finding no mailboxes and reading nothing.
  it('falls back to the scanning account when no runtimes are registered', async () => {
    const storage = fakeStorage({}, [inbox('one@acme.in')]);
    h.primary = storage;
    h.runtimes = [];

    await scan();

    expect(extracted(storage)).toEqual(['one@acme.in']);
  });
});
