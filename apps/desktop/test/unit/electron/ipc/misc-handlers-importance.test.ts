import { beforeEach, describe, expect, it, vi } from 'vitest';

// processor:processEmails runs the RULE-based importance scorer (keywords, bulk
// headers, sender stats). The behaviour under test: it may store the score, but
// it must never write the `important` TAG. That tag drives the "Important" chip
// and the "Important and unread" section, and this app's AI is its sole author —
// a heuristic promoting mail on its own is how mail synced while the AI was down
// still arrived wearing an "Important" chip nobody had decided on.
//
// We capture the ipcMain handler at registration and drive it directly, mocking
// only the module's own edges.

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...a: any[]) => any>(),
  /** The scorer itself, so its ARGUMENTS can be asserted, not just its result. */
  score_fn: vi.fn(),
  /** Score the mocked scorer returns; high enough to trip the old threshold. */
  score: 10,
  isImportant: true,
  storage: {
    getEmail: vi.fn(),
    getEmailsNeedingProcessing: vi.fn(),
    getSenderStats: vi.fn(),
    updateEmail: vi.fn(),
    updateEmailImportance: vi.fn(),
    updateEmailAuthStatus: vi.fn(),
    upsertSenderStats: vi.fn(),
  },
}));

vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, fn: (...a: any[]) => any) => h.handlers.set(name, fn) },
  dialog: {}, shell: {}, app: { getPath: () => '/tmp' },
}));
vi.mock('../../../../electron/shared', () => ({
  requireStorage: () => h.storage,
  getMainWindow: () => null,
}));
vi.mock('@sarvinbox/core', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  calculateImportanceScore: (...args: unknown[]) => {
    h.score_fn(...args);
    return { score: h.score, factors: [], isImportant: h.isImportant, authStatus: { overall: 'pass' } };
  },
}));

import { registerMiscHandlers } from '../../../../electron/ipc/misc-handlers';

const anEmail = (over: Record<string, unknown> = {}) => ({
  id: 'e1',
  threadId: 't1',
  fromAddress: 'boss@example.com',
  subject: 'URGENT: act today',
  cleanBody: 'please respond immediately',
  tags: '|INBOX|',
  ...over,
});

const processEmails = () => h.handlers.get('processor:processEmails')!;
const tagWrites = () =>
  h.storage.updateEmail.mock.calls.filter((c) => typeof c[1]?.tags === 'string');

beforeEach(() => {
  h.handlers.clear();
  h.score_fn.mockReset();
  h.score = 10;
  h.isImportant = true;
  for (const fn of Object.values(h.storage)) fn.mockReset();
  h.storage.getEmailsNeedingProcessing.mockResolvedValue([anEmail()]);
  h.storage.getSenderStats.mockResolvedValue(null);
  h.storage.updateEmail.mockResolvedValue(undefined);
  h.storage.updateEmailImportance.mockResolvedValue(undefined);
  h.storage.updateEmailAuthStatus.mockResolvedValue(undefined);
  h.storage.upsertSenderStats.mockResolvedValue(undefined);
  registerMiscHandlers();
});

describe('processor:processEmails — the rule scorer never authors the important tag', () => {
  // THE REGRESSION: a top-scoring email used to get `|important|` written here,
  // putting an "Important" chip on it with no AI involved at all.
  it('does not tag an email important however high the rule score is', async () => {
    const result = await processEmails()({}, {});

    expect(result).toEqual({ success: true, data: { processed: 1 } });
    expect(tagWrites()).toEqual([]);
  });

  // The score itself is still useful (sorting, agent context) and is recorded
  // under source 'rule' — removing the tag write must not silence the score.
  it('still stores the score and auth status under the rule source', async () => {
    await processEmails()({}, {});

    expect(h.storage.updateEmailImportance).toHaveBeenCalledWith('e1', 10, 'rule');
    expect(h.storage.updateEmailAuthStatus).toHaveBeenCalledWith('e1', JSON.stringify({ overall: 'pass' }));
  });

  // An email the AI HAS marked important keeps its tag: this handler only stops
  // writing the tag, it never strips one another author put there.
  it('leaves an existing important tag untouched', async () => {
    h.storage.getEmailsNeedingProcessing.mockResolvedValue([anEmail({ tags: '|INBOX|important|' })]);

    await processEmails()({}, {});

    expect(tagWrites()).toEqual([]);
  });

  // A low score took the same path (no tag) before and after — pinned so a
  // future "only tag when score is low enough" rewrite can't sneak back in.
  it('does not tag an email important on a low score either', async () => {
    h.score = 0;
    h.isImportant = false;

    await processEmails()({}, {});

    expect(tagWrites()).toEqual([]);
    expect(h.storage.updateEmailImportance).toHaveBeenCalledWith('e1', 0, 'rule');
  });

  // Explicit-ids mode is a second entry point into the same loop; it must not
  // become a back door for the tag.
  it('does not tag important when driven by explicit emailIds', async () => {
    h.storage.getEmail.mockResolvedValue(anEmail({ id: 'e2' }));

    const result = await processEmails()({}, { emailIds: ['e2'] });

    expect(result.data.processed).toBe(1);
    expect(h.storage.getEmailsNeedingProcessing).not.toHaveBeenCalled();
    expect(tagWrites()).toEqual([]);
  });
});

describe('processor:processEmails — what the scorer is actually handed', () => {
  // THE REGRESSION: both call sites passed `email.cleanBody` as the SIXTH
  // argument, which is `rawHeaders`. Every header arm of the scorer — SPF/DKIM/
  // DMARC, List-Unsubscribe, Precedence, Feedback-ID, Auto-Submitted — was then
  // reading body prose, so a mail whose text happened to say "unsubscribe" or
  // "dkim=pass" scored as though its headers said it. A stored row has no raw
  // headers; the honest value is null.
  it('passes null for rawHeaders, never the body', async () => {
    await processEmails()({}, {});

    expect(h.score_fn).toHaveBeenCalledTimes(1);
    const rawHeaders = h.score_fn.mock.calls[0][5];
    expect(rawHeaders).toBeNull();
    expect(rawHeaders).not.toBe('please respond immediately');
  });

  // The explicit-ids entry point is the second call site and had the same bug;
  // fixing one and not the other leaves the scorer lying on half the traffic.
  it('passes null for rawHeaders on the explicit-ids path too', async () => {
    h.storage.getEmail.mockResolvedValue(anEmail({ id: 'e2' }));

    await processEmails()({}, { emailIds: ['e2'] });

    expect(h.score_fn).toHaveBeenCalledTimes(1);
    expect(h.score_fn.mock.calls[0][5]).toBeNull();
  });
});
