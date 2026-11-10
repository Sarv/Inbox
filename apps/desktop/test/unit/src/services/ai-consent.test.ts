import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { askAiConsent, getAiConsent, providerAIDisclosure, SARV_AI_DISCLOSURE, setAiConsent } from '../../../../src/services/ai-consent';
import { registerSarvProvider } from '../../../../src/services/sarv-llm-provider';
import { useConfirmStore } from '../../../../src/store/confirm-service';

// The stored answer to "Let Sarv AI read your new mail?". Breaks if: a "no" is
// forgotten (Sarv AI turns itself on at the next launch), an unreadable store
// is read as "yes", or choosing a model doesn't record the agreement it is.

const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  (globalThis as any).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
  };
  (globalThis as any).window = {
    electronAPI: {
      aiSecrets: { set: () => {}, delete: () => {}, get: () => {} },
      ai: { setProviderConfigured: async () => ({ success: true }) },
      agent: { setAIConfig: async () => ({ success: true }) },
    },
  };
});
afterEach(() => {
  delete (globalThis as any).localStorage;
  delete (globalThis as any).window;
  useConfirmStore.setState({ current: null });
});

describe('ai consent store', () => {
  it('is null until answered, then remembers the answer', () => {
    expect(getAiConsent()).toBeNull();
    setAiConsent('declined');
    expect(getAiConsent()).toBe('declined');
    setAiConsent('granted');
    expect(getAiConsent()).toBe('granted');
  });

  // Unknown ≠ yes: junk or an unavailable store must never read as consent.
  it('reads junk or an unavailable store as never asked', () => {
    store.set('sarvinbox-ai-consent', 'maybe');
    expect(getAiConsent()).toBeNull();
    (globalThis as any).localStorage = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
    expect(getAiConsent()).toBeNull();
    expect(() => setAiConsent('granted')).not.toThrow();
  });
});

describe('askAiConsent', () => {
  it('shows the disclosure and records yes', async () => {
    const answer = askAiConsent();
    const prompt = useConfirmStore.getState().current!;
    expect(prompt.title).toBe('Let Sarv AI read your new mail?');
    expect(prompt.message).toMatch(/sender, recipients, subject and text/);
    expect(prompt.message).toMatch(/does not use your mail to train/);
    useConfirmStore.getState().resolve(true);
    await expect(answer).resolves.toBe('granted');
    expect(getAiConsent()).toBe('granted');
  });

  // "Not now" / Escape is recorded, so the user isn't nagged every launch.
  it('records no on dismissal', async () => {
    const answer = askAiConsent();
    useConfirmStore.getState().resolve(false);
    await expect(answer).resolves.toBe('declined');
    expect(getAiConsent()).toBe('declined');
  });
});

describe('registerSarvProvider', () => {
  // Choosing a model (next to the disclosure) is the agreement: without this,
  // Settings' auto-register would stay gated after an explicit choice.
  it('records consent when Sarv AI is registered', () => {
    setAiConsent('declined');
    registerSarvProvider({
      name: 'Sarv Mati', providerCode: 'sarv_partners', modelCode: 'gpt-oss-120b',
      zoneCode: 'jpr1', baseUrl: 'https://jpr1.ai.sarv.com', email: 'me@sarv.com',
    } as any);
    expect(getAiConsent()).toBe('granted');
  });
});

// CASA audit I-7: the consent the user ticks for a non-Sarv provider must say
// what actually happens — connecting turns sorting on and new mail goes to the
// provider as it arrives — just as Sarv's does. For a Custom provider, whose
// name the user typed, it must name the server the mail goes to.
describe('providerAIDisclosure', () => {
  // Breaks: the OpenAI/Gemini consent no longer says mail is sent as it arrives.
  it('says new messages go to the named provider as they arrive, like the Sarv text', () => {
    const text = providerAIDisclosure('OpenAI');
    expect(text).toContain('sending new messages');
    expect(text).toContain('to OpenAI as they arrive, for every connected account');
    expect(text).toContain("Your provider's terms and data policy apply.");
    expect(SARV_AI_DISCLOSURE).toContain('as they arrive, for every connected account');
  });

  // Breaks: a Custom provider called e.g. "Company AI" hides that mail goes to some other host.
  it('names the server a custom provider sends to', () => {
    expect(providerAIDisclosure('Company AI', 'https://llm.example.net:8443/v1')).toContain('to Company AI (llm.example.net:8443) as they arrive');
    expect(providerAIDisclosure('Local model', 'http://localhost:11434/v1')).toContain('to Local model (localhost:11434) as they arrive');
  });

  // Breaks: a repeated or garbled destination when the name IS the host, or the address can't be parsed.
  it('names the destination once when the name is the host, and falls back to the name for a bad address', () => {
    expect(providerAIDisclosure('llm.example.net', 'https://llm.example.net/v1')).toContain('to llm.example.net as they arrive');
    expect(providerAIDisclosure('My AI', 'not a url')).toContain('to My AI as they arrive');
  });
});
