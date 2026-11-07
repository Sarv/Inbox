import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AICategorizationService } from '../../../../electron/services/ai-categorization-service';
import { emailRecord } from '../../../helpers/email-fixtures';

/**
 * Where the standalone categorizer sends mail (CASA audit I-7).
 *
 * It used to resolve its address with its own copy of effectiveAIBaseUrl plus
 * an extra `|| openai` fallback, so a Custom provider saved without an address
 * sent the user's mail to OpenAI — a provider they never chose. It now uses
 * the shared helper and refuses an empty address, and both of its requests
 * refuse redirects.
 *
 * What breaks if this file fails: mail goes to OpenAI for a Custom provider
 * with no address, or a redirect carries the key and the mail to an address
 * nobody checked.
 */

const h = vi.hoisted(() => ({ fetch: vi.fn(), send: vi.fn() }));
const email = () => emailRecord({
  id: 'm1', fromAddress: 'vendor@example.com', toAddress: 'buyer@sarv.com', subject: 'Quote', tags: '|INBOX|',
  rawBody: '<p>Prices attached.</p>',
});
vi.mock('../../../../electron/shared', () => ({
  getMainWindow: () => ({ isDestroyed: () => false, webContents: { send: h.send } }),
  requireStorage: () => ({
    getEmail: async () => email(),
    getEligibleEmailsForAI: () => [email()],
    getFolders: async () => [{ path: 'INBOX' }],
    getFolder: async () => ({ path: 'INBOX' }),
    getEnabledCategoryDefinitions: () => [{ slug: 'needs_response', name: 'Needs Response', prompt: 'a request' }],
    getSenderContextBatch: () => ({}),
    getSenderRepetitionStats: () => ({ sameSubject: {}, totalEmails: 1 }),
    getThreadDepths: () => ({}),
    saveEmailCategoriesBatch: (batch: unknown[]) => batch.length,
    getRepositories: () => ({ prompts: { getContent: () => null } }),
  }),
}));
vi.mock('../../../../electron/services/net-fetch', () => ({ chromiumFetch: (...args: unknown[]) => h.fetch(...args) }));

const verdict = JSON.stringify([{ emailId: 'm1', categories: ['needs_response'], is_spam: false, confidence: 0.9 }]);
const chat = () => new Response(JSON.stringify({ choices: [{ message: { content: verdict } }] }), { status: 200 });
const gemini = () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: verdict }] } }] }), { status: 200 });
const run = (config: Record<string, unknown>) =>
  new AICategorizationService().start(config as any, 'realtime', { emailIds: ['m1'], userEmail: 'buyer@sarv.com' });

beforeEach(() => {
  h.fetch.mockReset().mockImplementation(async () => chat());
  h.send.mockReset();
});

describe('standalone categorizer — where mail goes', () => {
  // THE regression. Breaks: a Custom provider with no address sends mail to OpenAI.
  it.each(['custom', 'sarv'])('sends nothing anywhere for a %s provider with no address', async (type) => {
    await run({ type, apiKey: 'k', model: 'm' });
    expect(h.fetch).not.toHaveBeenCalled();
  });

  // Breaks: providers with a type default (OpenAI) stop working without an explicit address.
  it("uses the type's default address through the shared helper", async () => {
    await run({ type: 'openai', apiKey: 'k', model: 'm' });
    expect(h.fetch).toHaveBeenCalledExactlyOnceWith('https://api.openai.com/v1/chat/completions', expect.anything());
  });

  // Breaks: a redirect carries the bearer and the mail to an unchecked address.
  it('refuses redirects on the OpenAI-compatible request', async () => {
    await run({ type: 'custom', apiKey: 'k', model: 'm', baseUrl: 'https://models.example/v1' });
    expect(h.fetch.mock.calls[0][0]).toBe('https://models.example/v1/chat/completions');
    expect(h.fetch.mock.calls[0][1]).toMatchObject({ redirect: 'error' });
  });

  // Breaks: a redirect carries the Gemini key and the mail to an unchecked address.
  it('refuses redirects on the Gemini request', async () => {
    h.fetch.mockImplementation(async () => gemini());
    await run({ type: 'gemini', apiKey: 'k', model: 'gm' });
    expect(h.fetch.mock.calls[0][0]).toBe('https://generativelanguage.googleapis.com/v1beta/models/gm:generateContent');
    expect(h.fetch.mock.calls[0][1]).toMatchObject({ redirect: 'error' });
  });
});
