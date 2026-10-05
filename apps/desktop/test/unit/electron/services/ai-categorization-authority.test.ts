import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AICategorizationService } from '../../../../electron/services/ai-categorization-service';
import { emailRecord } from '../../../helpers/email-fixtures';

const h = vi.hoisted(() => ({
  emails: new Map<string, Record<string, unknown>>(),
  fetch: vi.fn(),
  save: vi.fn((batch: unknown[]) => batch.length),
}));
vi.mock('../../../../electron/shared', () => ({
  getMainWindow: () => null,
  requireStorage: () => ({
    getEmail: async (id: string) => h.emails.get(id),
    getEnabledCategoryDefinitions: () => [{ slug: 'important', name: 'Important', prompt: 'urgent' }, { slug: 'promotions', name: 'Promotions', prompt: 'marketing' }],
    getSenderContextBatch: () => ({}), getSenderRepetitionStats: () => ({ sameSubject: {}, totalEmails: 0 }), getThreadDepths: () => ({}),
    saveEmailCategoriesBatch: h.save,
  }),
}));
vi.mock('../../../../electron/services/net-fetch', () => ({ chromiumFetch: (...args: unknown[]) => h.fetch(...args) }));

const config = { type: 'openai' as const, apiKey: 'test-key', model: 'test-model', baseUrl: 'https://provider.test/v1' };
const response = () => new Response(JSON.stringify({ choices: [{ message: { content: '[{"emailId":"plain","categories":["important"],"is_spam":false,"confidence":0.9}]' } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  h.emails.clear(); h.save.mockClear(); h.fetch.mockReset();
  h.fetch.mockResolvedValue(response());
});

describe('standalone categorization authority', () => {
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
