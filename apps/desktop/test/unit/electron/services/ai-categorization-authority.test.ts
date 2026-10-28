import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AICategorizationService } from '../../../../electron/services/ai-categorization-service';
import { emailRecord } from '../../../helpers/email-fixtures';

const h = vi.hoisted(() => ({
  emails: new Map<string, Record<string, unknown>>(),
  otherEmails: new Map<string, Record<string, unknown>>(),
  owner: 'primary',
  onRead: undefined as undefined | ((owner: string) => void),
  history: vi.fn(),
  template: vi.fn(),
  count: vi.fn(async () => 1),
  otherSave: vi.fn((batch: unknown[]) => batch.length),
  fetch: vi.fn(),
  save: vi.fn((batch: unknown[]) => batch.length),
}));
vi.mock('../../../../electron/shared', () => ({
  getMainWindow: () => null,
  requireStorage: () => {
    const owner = h.owner;
    const rows = owner === 'primary' ? h.emails : h.otherEmails;
    return {
    getEmail: async (id: string) => { const result = rows.get(id); h.onRead?.(owner); return result; },
    getEligibleEmailsForAI: () => [...rows.values()],
    getUnprocessedEmailCount: () => h.count(),
    getRepositories: () => ({ agent: { getUnreadReviewSenderContextBatch: (senders: string[]) => h.history(owner, senders) }, prompts: { getContent: () => h.template(owner) } }),
    getFolders: async () => [{ path: '[Gmail]/Correo no deseado', specialUse: '\\Junk' }],
    getFolder: async (id: string) => id === 'junk' ? { path: '[Gmail]/Correo no deseado', specialUse: '\\Junk' } : { path: 'INBOX' },
    getEnabledCategoryDefinitions: () => [{ slug: 'important', name: 'Important', prompt: 'urgent' }, { slug: 'promotions', name: 'Promotions', prompt: 'marketing' }],
    getSenderContextBatch: () => ({}), getSenderRepetitionStats: () => ({ sameSubject: {}, totalEmails: 0 }), getThreadDepths: () => ({}),
    saveEmailCategoriesBatch: owner === 'primary' ? h.save : h.otherSave,
    };
  },
}));
vi.mock('../../../../electron/services/net-fetch', () => ({ chromiumFetch: (...args: unknown[]) => h.fetch(...args) }));

const config = { type: 'openai' as const, apiKey: 'test-key', model: 'test-model', baseUrl: 'https://provider.test/v1' };
const response = () => new Response(JSON.stringify({ choices: [{ message: { content: '[{"emailId":"plain","categories":["important"],"is_spam":false,"confidence":0.9}]' } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  h.owner = 'primary'; h.onRead = undefined; h.otherEmails.clear(); h.otherSave.mockClear();
  h.history.mockReset().mockReturnValue({}); h.template.mockReset().mockReturnValue(null); h.count.mockReset().mockResolvedValue(1);
  h.emails.clear(); h.save.mockClear(); h.fetch.mockReset();
  h.fetch.mockResolvedValue(response());
});

describe('standalone categorization authority', () => {
  it('binds bodies, sender history, custom policy and writes to the starting mailbox across an account switch', async () => {
    h.emails.set('plain', emailRecord({ id: 'plain', fromAddress: 'primary-sender@example.com', rawBody: 'PRIMARY_BODY', tags: '|INBOX|' }) as unknown as Record<string, unknown>);
    h.otherEmails.set('plain', emailRecord({ id: 'plain', fromAddress: 'other-sender@example.com', rawBody: 'OTHER_PRIVATE_BODY', tags: '|INBOX|' }) as unknown as Record<string, unknown>);
    h.template.mockImplementation(owner => `${owner.toUpperCase()} CUSTOM POLICY`);
    h.onRead = owner => { expect(owner).toBe('primary'); h.owner = 'secondary'; h.onRead = undefined; };
    await new AICategorizationService().start(config, 'realtime', { emailIds: ['plain'], userEmail: 'primary@example.com' });
    expect(h.history).toHaveBeenCalledExactlyOnceWith('primary', ['primary-sender@example.com']);
    expect(h.template).toHaveBeenCalledExactlyOnceWith('primary');
    const messages = JSON.parse(h.fetch.mock.calls[0][1].body).messages as Array<{ content: string }>;
    expect(messages[0].content).toContain('PRIMARY CUSTOM POLICY');
    expect(messages[1].content).toContain('PRIMARY_BODY'); expect(messages[1].content).not.toContain('OTHER_PRIVATE_BODY');
    expect(h.save).toHaveBeenCalledOnce(); expect(h.otherSave).not.toHaveBeenCalled();
  });

  it('does not let a stopped late response save or clear a replacement job in another account', async () => {
    h.emails.set('plain', emailRecord({ id: 'plain', tags: '|INBOX|' }) as unknown as Record<string, unknown>);
    h.otherEmails.set('plain', emailRecord({ id: 'plain', tags: '|INBOX|' }) as unknown as Record<string, unknown>);
    let first!: (value: Response) => void; let second!: (value: Response) => void;
    h.fetch.mockImplementationOnce(() => new Promise<Response>(resolve => { first = resolve; }))
      .mockImplementationOnce(() => new Promise<Response>(resolve => { second = resolve; }));
    const service = new AICategorizationService();
    const oldJob = service.start(config, 'realtime', { emailIds: ['plain'], userEmail: 'primary@example.com' });
    await vi.waitFor(() => expect(first).toBeTypeOf('function'));
    service.stop(); h.owner = 'secondary';
    const newJob = service.start({ ...config, baseUrl: 'https://other-provider.test/v1' }, 'realtime', { emailIds: ['plain'], userEmail: 'other@example.com' });
    await vi.waitFor(() => expect(second).toBeTypeOf('function'));
    first(response()); await oldJob;
    expect(service.getStatus().running).toBe(true);
    expect(h.save).not.toHaveBeenCalled(); expect(h.otherSave).not.toHaveBeenCalled();
    second(response()); await newJob;
    expect(h.otherSave).toHaveBeenCalledOnce(); expect(h.save).not.toHaveBeenCalled();
    expect(service.getStatus().running).toBe(false);
  });

  it('keeps an automatic tick on the mailbox selected before its asynchronous count completed', async () => {
    h.emails.set('plain', emailRecord({ id: 'plain', tags: '|INBOX|' }) as unknown as Record<string, unknown>);
    h.otherEmails.set('plain', emailRecord({ id: 'plain', tags: '|INBOX|' }) as unknown as Record<string, unknown>);
    let finishCount!: (count: number) => void;
    h.count.mockImplementationOnce(() => new Promise<number>(resolve => { finishCount = resolve; }));
    const service = new AICategorizationService();
    try {
      service.startAutoProcess(config, { userEmail: 'primary@example.com' });
      await vi.waitFor(() => expect(finishCount).toBeTypeOf('function'));
      h.owner = 'secondary'; finishCount(1);
      await vi.waitFor(() => expect(h.save).toHaveBeenCalledOnce());
      expect(h.otherSave).not.toHaveBeenCalled(); expect(h.history.mock.calls.every(([owner]) => owner === 'primary')).toBe(true);
    } finally { service.stopAutoProcess(); service.stop(); }
  });

  it('resumes a transiently interrupted bulk run on its original mailbox and provider', async () => {
    vi.useFakeTimers();
    const service = new AICategorizationService();
    try {
      for (let index = 0; index < 16; index++) {
        const id = `mail-${index}`;
        h.emails.set(id, emailRecord({ id, fromAddress: 'primary-sender@example.com', rawBody: 'PRIMARY_BODY', tags: '|INBOX|' }) as unknown as Record<string, unknown>);
        h.otherEmails.set(id, emailRecord({ id, fromAddress: 'other-sender@example.com', rawBody: 'OTHER_PRIVATE_BODY', tags: '|INBOX|' }) as unknown as Record<string, unknown>);
      }
      h.fetch.mockImplementation(async () => new Response('busy', { status: 503 }));
      const firstRun = service.start(config, 'bulk', { userEmail: 'primary@example.com' });
      // Three chunks exhaust their 2s/4s/8s request retries and trigger the
      // 15s restart backoff. The UI changes accounts while that timer waits.
      await vi.advanceTimersByTimeAsync(50_000);
      await firstRun;
      expect(service.getStatus().running).toBe(false);
      expect(h.save).not.toHaveBeenCalled();
      h.owner = 'secondary';
      h.fetch.mockClear();
      h.history.mockClear();
      h.template.mockClear();
      h.fetch.mockImplementation(async (_url, options) => {
        const messages = JSON.parse(options.body).messages as Array<{ content: string }>;
        const id = /\(ID: ([^)]+)\)/u.exec(messages[1].content)![1];
        expect(messages[1].content).toContain('PRIMARY_BODY');
        expect(messages[1].content).not.toContain('OTHER_PRIVATE_BODY');
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify([{
          emailId: id, categories: ['important'], is_spam: false, confidence: 0.9,
        }]) } }] }), { status: 200 });
      });
      await vi.advanceTimersByTimeAsync(20_000);
      expect(h.save).toHaveBeenCalledTimes(4);
      expect(h.otherSave).not.toHaveBeenCalled();
      expect(h.history.mock.calls.every(([owner]) => owner === 'primary')).toBe(true);
      expect(h.template.mock.calls.every(([owner]) => owner === 'primary')).toBe(true);
      expect(h.fetch.mock.calls.every(([url]) => url === 'https://provider.test/v1/chat/completions')).toBe(true);
      expect(service.getStatus().running).toBe(false);
    } finally { service.stop(); vi.useRealTimers(); }
  });

  // Regression: provider/local Spam is excluded even through the direct realtime entrypoint.
  it.each([{ tags: '|spam|' }, { folderId: 'junk', tags: '||' }, { tags: '|INBOX|[Gmail]/Correo no deseado|spam|', spamUserVerdict: 'ham' as const }])('does not categorize protected Spam %j', async (overrides) => {
    h.emails.set('plain', emailRecord({ id: 'plain', ...overrides }) as unknown as Record<string, unknown>);
    await new AICategorizationService().start(config, 'realtime', { emailIds: ['plain'] });
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.save).not.toHaveBeenCalled();
  });

  // Regression: the native Important marker does not suppress AI for Gmail's remaining mail.
  it('categorizes Gmail Important independently', async () => {
    h.emails.set('plain', emailRecord({ id: 'plain', gmailImportant: true, tags: '|INBOX|important|' }) as unknown as Record<string, unknown>);
    await new AICategorizationService().start(config, 'realtime', { emailIds: ['plain'] });
    expect(h.fetch).toHaveBeenCalledOnce();
    expect(h.save).toHaveBeenCalledOnce();
  });

  // Regression: an in-flight verdict cannot relabel a message moved to Junk while waiting for AI.
  it('drops a late AI result after a provider Spam move', async () => {
    h.emails.set('plain', emailRecord({ id: 'plain', tags: '|INBOX|' }) as unknown as Record<string, unknown>);
    h.fetch.mockImplementationOnce(async () => { h.emails.get('plain')!.folderId = 'junk'; return response(); });
    await new AICategorizationService().start(config, 'realtime', { emailIds: ['plain'] });
    expect(h.fetch).toHaveBeenCalledOnce();
    expect(h.save).not.toHaveBeenCalled();
  });

  // Regression: the legacy realtime entrypoint must follow the same provider/user gate as the background pipeline.
  it('does not send existing provider or user classifications to AI', async () => {
    h.emails.set('gmail', emailRecord({ id: 'gmail', serverCategories: ['promotions'], tags: '|INBOX|promotions|' }) as unknown as Record<string, unknown>);
    h.emails.set('sarv', emailRecord({ id: 'sarv', serverCategories: ['important'], tags: '|INBOX|important|' }) as unknown as Record<string, unknown>);
    h.emails.set('manual', emailRecord({ id: 'manual', manualCategories: [] }) as unknown as Record<string, unknown>);
    h.emails.set('unknown', emailRecord({ id: 'unknown', gmailCategoriesPending: true }) as unknown as Record<string, unknown>);
    await new AICategorizationService().start(config, 'realtime', { emailIds: ['gmail', 'sarv', 'manual', 'unknown'] });
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.save).not.toHaveBeenCalled();
  });

  // Regression: ordinary mailbox flags remain eligible; classifying one account must not suppress unrelated plain mail.
  it('classifies an ordinary starred email in a mixed request', async () => {
    h.emails.set('plain', emailRecord({ id: 'plain', serverCategories: [], tags: '|INBOX|starred|' }) as unknown as Record<string, unknown>);
    h.emails.set('native', emailRecord({ id: 'native', serverCategories: ['promotions'] }) as unknown as Record<string, unknown>);
    await new AICategorizationService().start(config, 'realtime', { emailIds: ['native', 'plain'] });
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(h.save).toHaveBeenCalledTimes(1);
    expect(h.save.mock.calls[0]?.[0]).toEqual(expect.arrayContaining([expect.objectContaining({ emailId: 'plain' })]));
  });

  // Regression: a provider refresh received during a request cannot be overwritten by that request's old classification.
  it('rechecks authority before writing an in-flight categorization', async () => {
    h.emails.set('plain', emailRecord({ id: 'plain', tags: '|INBOX|' }) as unknown as Record<string, unknown>);
    h.fetch.mockImplementationOnce(async () => {
      h.emails.get('plain')!.serverCategories = ['promotions'];
      return response();
    });
    await new AICategorizationService().start(config, 'realtime', { emailIds: ['plain'] });
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(h.save).not.toHaveBeenCalled();
  });
});
