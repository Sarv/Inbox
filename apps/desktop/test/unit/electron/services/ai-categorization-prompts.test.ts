import { buildCategorizationPrompt, formatSenderBehaviorFacts, SENDER_BEHAVIOR_GUIDANCE, SENDER_BEHAVIOR_UNAVAILABLE } from '@sarvinbox/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AICategorizationService } from '../../../../electron/services/ai-categorization-service';
import { emailRecord } from '../../../helpers/email-fixtures';

const h = vi.hoisted(() => ({
  fetch: vi.fn(),
  save: vi.fn((batch: unknown[]) => batch.length),
  send: vi.fn(),
  getTemplate: vi.fn<() => string | null>(() => null),
  humanHistory: vi.fn<(...args: unknown[]) => Record<string, unknown>>(() => ({})),
  seedTemplate: undefined as undefined | ((row: { id: string; content: string }) => void),
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
        tier: 'first-time', receivedCount: 1, sentToCount: 2, repliedCount: 700,
        readCount: 900, deletedCount: 800, isVip: false, isFavorite: false, isBlocked: false,
      },
    }),
    getSenderRepetitionStats: () => ({ sameSubject: {}, totalEmails: 1 }),
    getThreadDepths: () => ({}),
    saveEmailCategoriesBatch: h.save,
    getRepositories: h.repositories === 'missing-api' ? undefined : () =>
      h.repositories === 'missing-repository' ? undefined : {
        agent: { getUnreadReviewSenderContextBatch: (...args: unknown[]) => h.humanHistory(...args) },
        prompts: h.repositories === 'missing-prompts' ? undefined : { getContent: h.getTemplate, seedDefault: h.seedTemplate },
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

const humanSignals = () => ({
  received90d: 8, opened90d: 3, markedRead90d: 3, deleted90d: 5, archived90d: 1, replied90d: 0,
  keptUnread90d: 0, starred90d: 0, important90d: 0, sentLifetime: 2, lastSentAt: Math.floor(Date.now() / 1000) - 400 * 86400,
  isVip: false, isBlocked: false, readThenDeleted90d: 3, readThenDeletedFast90d: 2, readAndKept90d: 0,
  deletedWithoutRead90d: 2, recentDeleted30d: 4, recentReceived30d: 6,
});

beforeEach(() => {
  h.repositories = 'present';
  h.humanHistory.mockReset().mockImplementation(() => ({ 'vendor@example.com': humanSignals() }));
  h.getTemplate.mockReset().mockReturnValue(null);
  h.seedTemplate = undefined;
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
    expect(messages[0].content).toContain("A genuine new customer's question qualifies without prior history");
    expect(messages[0].content).toContain('Missing history means unknown, not proof of cold outreach');
    expect(messages[0].content).not.toContain('NEVER replying to a sender');
    // Keep the existing transport facts/recipient role and cleaned message body.
    expect(messages[1].content).toContain('outboundLifetime=2');
    expect(messages[1].content).toContain('replied=0');
    expect(messages[1].content).not.toContain('replied=700');
    expect(messages[1].content).not.toContain('Replied: 700');
    expect(h.humanHistory).toHaveBeenCalledExactlyOnceWith(['vendor@example.com']);
    expect(messages[1].content).toContain(formatSenderBehaviorFacts('vendor@example.com', humanSignals(), Math.floor(Date.now() / 1000))!);
    expect(messages.map(message => message.content).join('\n').split(SENDER_BEHAVIOR_GUIDANCE)).toHaveLength(2);
    expect(messages[1].content).not.toMatch(/(?:Read|Keep):\s*\d+%/u);
    expect(messages[1].content).toContain('User-Role: TO (direct recipient)');
    expect(messages[1].content).toContain('Here are the prices you asked for');
    expect(h.save).toHaveBeenCalledOnce();
  });

  it.each(['missing', 'failed', 'invalid'] as const)('describes %s human history as unavailable without reviving legacy mixed-source rates', async failure => {
    if (failure === 'missing') h.humanHistory.mockReturnValue({});
    if (failure === 'failed') h.humanHistory.mockImplementation(() => { throw new Error('History temporarily unavailable'); });
    if (failure === 'invalid') h.humanHistory.mockReturnValue({ 'vendor@example.com': { ...humanSignals(), deleted90d: -1 } });
    await run();
    const messages = requestMessages();
    expect(messages[1].content).toContain(SENDER_BEHAVIOR_UNAVAILABLE);
    expect(messages[1].content).not.toMatch(/(?:Read|Keep):\s*\d+%/u);
    expect(messages[1].content).not.toContain('No prior relationship');
    expect(messages[1].content).not.toContain('Replied:');
    expect(messages[1].content).toContain('Here are the prices you asked for');
    expect(h.save).toHaveBeenCalledOnce();
  });

  it('uses recorded human deletion outcomes rather than drawing user interest from a read flag', async () => {
    await run();
    const messages = requestMessages();
    expect(messages[1].content).toContain('readThenDeletedFast90d=2');
    expect(messages[1].content).toContain('deletedWithoutRead90d=2');
    expect(messages[0].content).toContain(SENDER_BEHAVIOR_GUIDANCE);
    expect(messages[1].content).not.toContain(SENDER_BEHAVIOR_GUIDANCE);
    expect(messages[1].content).not.toMatch(/(?:Read|Keep):\s*\d+%/u);
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

  it.each([false, true])('seeds the selected account before reading its categorization policy (custom=%s)', async customized => {
    let content = customized ? 'MY OWN POLICY for {{userEmail}}' : 'An older bundled policy';
    const previousDefault = 'An older bundled policy';
    const seed = vi.fn((row: { id: string; content: string }) => {
      if (row.id === 'categorization_system' && content === previousDefault) content = row.content;
    });
    h.seedTemplate = seed;
    h.getTemplate.mockImplementation(() => content);

    await run();

    expect(seed).toHaveBeenCalledTimes(3);
    expect(seed.mock.invocationCallOrder[0]).toBeLessThan(h.getTemplate.mock.invocationCallOrder[0]);
    expect(requestMessages()[0].content).toBe(buildCategorizationPrompt(categories, 'buyer@sarv.com', customized ? 'MY OWN POLICY for {{userEmail}}' : undefined));
  });

  it('sends no mail to a provider when upgrading the selected account\'s prompt fails', async () => {
    h.seedTemplate = () => { throw new Error('Prompt seed unavailable'); };
    h.getTemplate.mockReturnValue('Custom policy');
    await run();
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.getTemplate).not.toHaveBeenCalled();
    expect(h.save).not.toHaveBeenCalled();
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
