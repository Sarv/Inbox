import { buildCategorizationPrompt } from '@sarvinbox/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AICategorizationService } from '../../../../electron/services/ai-categorization-service';
import { emailRecord } from '../../../helpers/email-fixtures';

const h = vi.hoisted(() => ({
  fetch: vi.fn(),
  save: vi.fn((batch: unknown[]) => batch.length),
  send: vi.fn(),
  getTemplate: vi.fn<() => string | null>(() => null),
  repositories: 'present' as 'present' | 'missing-api' | 'missing-repository' | 'missing-prompts',
}));
const categories = [
  { slug: 'needs_response', name: 'Needs Response', prompt: 'a genuine human request' },
  { slug: 'promotions', name: 'Promotions', prompt: 'marketing as the primary purpose' },
];
const email = () => emailRecord({
  id: 'quote', fromAddress: 'vendor@example.com', toAddress: 'buyer@sarv.com',
  subject: 'Re: Requested GPU quote', tags: '|INBOX|',
  rawBody: '<p>Here are the prices you asked for. Which configuration should we reserve?</p>',
});
vi.mock('../../../../electron/shared', () => ({
  getMainWindow: () => ({ isDestroyed: () => false, webContents: { send: h.send } }),
  requireStorage: () => ({
    getEmail: async () => email(),
    getEligibleEmailsForAI: () => [email()],
    getFolders: async () => [{ path: 'INBOX' }],
    getFolder: async () => ({ path: 'INBOX' }),
    getEnabledCategoryDefinitions: () => categories,
    getSenderContextBatch: () => ({
      'vendor@example.com': {
        tier: 'first-time', receivedCount: 1, sentToCount: 2, repliedCount: 0,
        readCount: 0, deletedCount: 0, isVip: false, isFavorite: false, isBlocked: false,
      },
    }),
    getSenderRepetitionStats: () => ({ sameSubject: {}, totalEmails: 1 }),
    getThreadDepths: () => ({}),
    saveEmailCategoriesBatch: h.save,
    getRepositories: h.repositories === 'missing-api' ? undefined : () =>
      h.repositories === 'missing-repository' ? undefined : {
        prompts: h.repositories === 'missing-prompts' ? undefined : { getContent: h.getTemplate },
      },
  }),
}));
vi.mock('../../../../electron/services/net-fetch', () => ({ chromiumFetch: (...args: unknown[]) => h.fetch(...args) }));

const config = { type: 'openai' as const, apiKey: 'test-key', model: 'test-model', baseUrl: 'https://provider.test/v1' };
const reply = (assigned = ['needs_response']) => new Response(JSON.stringify({
  choices: [{ message: { content: JSON.stringify([{
    emailId: 'quote', categories: assigned, is_spam: false, confidence: 0.9,
  }]) } }],
}), { status: 200, headers: { 'Content-Type': 'application/json' } });
const requestMessages = () => JSON.parse(h.fetch.mock.calls[0][1].body as string).messages as Array<{ role: string; content: string }>;
const run = (mode: 'bulk' | 'realtime' = 'realtime', userEmail = 'buyer@sarv.com') =>
  new AICategorizationService().start(config, mode, { emailIds: ['quote'], userEmail });

beforeEach(() => {
  h.repositories = 'present';
  h.getTemplate.mockReset().mockReturnValue(null);
  h.save.mockClear();
  h.send.mockClear();
  h.fetch.mockReset().mockImplementation(async () => reply());
});

describe('standalone categorizer shares classification guidance', () => {
  // Regression: manual bulk/realtime runs retained the zero-reply heuristic,
  // turning requested quotes and first customer inquiries into false Promotions.
  it.each(['bulk', 'realtime'] as const)('sends shared business-purpose guidance for %s processing', async mode => {
    await run(mode);

    expect(h.fetch).toHaveBeenCalledOnce();
    const messages = requestMessages();
    expect(messages[0].content).toBe(buildCategorizationPrompt(categories, 'buyer@sarv.com'));
    expect(messages[0].content).toContain("CLASSIFY THE CURRENT MESSAGE'S PRIMARY PURPOSE");
    expect(messages[0].content).toContain('No recorded replies is only a supporting signal');
    expect(messages[0].content).not.toContain('NEVER replying to a sender');
    // Keep the existing transport facts/recipient role and cleaned message body.
    expect(messages[1].content).toContain('Sent-to: 2');
    expect(messages[1].content).toContain('User-Role: TO (direct recipient)');
    expect(messages[1].content).toContain('Here are the prices you asked for');
    expect(h.save).toHaveBeenCalledOnce();
  });

  // Regression: consolidating defaults must not overwrite a user's custom
  // prompt, and changing account identity must still render its own variables.
  it.each(['buyer@sarv.com', 'other@example.com'])('renders a stored custom prompt for %s', async userEmail => {
    const custom = 'MY POLICY for {{userEmail}}: {{categorySection}}';
    h.getTemplate.mockReturnValue(custom);

    await run('realtime', userEmail);

    expect(h.getTemplate).toHaveBeenCalledWith('categorization_system');
    expect(requestMessages()[0].content).toBe(buildCategorizationPrompt(categories, userEmail, custom));
    expect(requestMessages()[0].content).not.toContain('CLASSIFY THE CURRENT MESSAGE');
  });

  // Regression: older or minimal storage bridges have no editable templates;
  // absence uses the default, and a deliberately blank template does too.
  it.each(['missing-api', 'missing-repository', 'missing-prompts', 'blank'] as const)('uses the shared default for %s templates', async absence => {
    if (absence === 'blank') h.getTemplate.mockReturnValue('   ');
    else h.repositories = absence;

    await run();

    expect(requestMessages()[0].content).toBe(buildCategorizationPrompt(categories, 'buyer@sarv.com'));
  });

  // Regression: an unreadable custom policy must stop the request rather than
  // silently send email using a default the user never selected; retry recovers.
  it.each(['storage timeout', 'database unavailable'])('does not bypass a failed template read: %s', async message => {
    h.getTemplate.mockImplementationOnce(() => { throw new Error(message); });
    const service = new AICategorizationService();

    await service.start(config, 'realtime', { emailIds: ['quote'], userEmail: 'buyer@sarv.com' });

    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.save).not.toHaveBeenCalled();
    expect(service.getStatus().running).toBe(false);
    expect(h.send).toHaveBeenCalledWith('ai-categorization:complete', expect.objectContaining({
      ok: false, progress: expect.objectContaining({ lastError: message, failed: 1 }),
    }));
    await service.start(config, 'realtime', { emailIds: ['quote'], userEmail: 'buyer@sarv.com' });
    expect(h.fetch).toHaveBeenCalledOnce();
    expect(h.save).toHaveBeenCalledOnce();
  });

  // Regression: correcting misleading guidance must not become a parser-level
  // blacklist; genuinely independent mixed category choices remain supported.
  it('preserves multiple categories returned by the provider', async () => {
    h.fetch.mockImplementation(async () => reply(['needs_response', 'promotions']));

    await run();

    expect(h.save.mock.calls[0][0]).toEqual(expect.arrayContaining([
      expect.objectContaining({ emailId: 'quote', categories: [
        { slug: 'needs_response', confidence: 0.9 }, { slug: 'promotions', confidence: 0.9 },
      ] }),
    ]));
  });
});
