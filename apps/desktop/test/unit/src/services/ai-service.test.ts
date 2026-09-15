import { readFileSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { addProvider, getDefaultProvider, loadAISettings, pruneOrphanedOAuthProviders, removeOAuthProvidersForAccount } from '../../../../src/services/ai-service';

// removeOAuthProvidersForAccount is the fix for the "delete account → app
// beachballs" bug: the Sarv account is BOTH mailbox AND LLM provider, so when the
// mail account is deleted its OAuth token vanishes but the AI provider entry used
// to linger — getDefaultProvider() kept returning it and the extraction /
// body-rewrite loop retried against a dead session forever ("No OAuth account for
// sarv"), spinning the event loop until the UI locked up. Pruning the provider on
// account removal is what stops the loop; these tests pin that contract.

const installEnv = () => {
  const store = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  };
  // saveAISettings/removeProvider push keys to the vault via window.electronAPI;
  // stub it so removal doesn't reach for real IPC.
  (globalThis as any).window = {
    electronAPI: { aiSecrets: { set: vi.fn(), delete: vi.fn() } },
  };
};

beforeEach(installEnv);
afterEach(() => {
  delete (globalThis as any).localStorage;
  delete (globalThis as any).window;
  vi.restoreAllMocks();
});

describe('removeOAuthProvidersForAccount', () => {
  it('removes the OAuth provider backed by the deleted account and returns the count', () => {
    // If this ever regresses, deleting the Sarv account leaves its LLM provider
    // behind and the retry loop that beachballs the app comes back.
    addProvider('sarv', '', 'sarv-model', {
      authMethod: 'oauth',
      oauthProvider: 'sarv',
      oauthEmail: 'advik.d@sarv.com',
    });

    const removed = removeOAuthProvidersForAccount('sarv', 'advik.d@sarv.com');

    expect(removed).toBe(1);
    expect(loadAISettings().providers).toHaveLength(0);
    expect(getDefaultProvider()).toBeNull();
  });

  it('matches the account email case-insensitively', () => {
    // The registry stores addresses with the user's casing; a case mismatch must
    // NOT leave the dead provider (and its loop) alive.
    addProvider('sarv', '', 'sarv-model', {
      authMethod: 'oauth',
      oauthProvider: 'sarv',
      oauthEmail: 'Advik.D@Sarv.com',
    });

    expect(removeOAuthProvidersForAccount('sarv', 'advik.d@sarv.com')).toBe(1);
    expect(loadAISettings().providers).toHaveLength(0);
  });

  it('leaves an unrelated API-key provider and a different OAuth email intact', () => {
    // Removing one account must never nuke a working provider belonging to a
    // different account or an API-key provider.
    addProvider('gemini', 'key-123', 'gemini-model'); // apiKey provider, first → default
    addProvider('sarv', '', 'sarv-model', {
      authMethod: 'oauth',
      oauthProvider: 'sarv',
      oauthEmail: 'someone.else@sarv.com',
    });

    expect(removeOAuthProvidersForAccount('sarv', 'advik.d@sarv.com')).toBe(0);
    expect(loadAISettings().providers).toHaveLength(2);
  });

  it('promotes a remaining provider to default when the removed one was default', () => {
    // The deleted OAuth provider was the default; a surviving provider must take
    // over so AI keeps working for the remaining account.
    addProvider('sarv', '', 'sarv-model', {
      authMethod: 'oauth',
      oauthProvider: 'sarv',
      oauthEmail: 'advik.d@sarv.com',
    }); // first → default
    addProvider('gemini', 'key-123', 'gemini-model');

    expect(removeOAuthProvidersForAccount('sarv', 'advik.d@sarv.com')).toBe(1);
    const remaining = loadAISettings().providers;
    expect(remaining).toHaveLength(1);
    expect(remaining[0].type).toBe('gemini');
    expect(getDefaultProvider()?.type).toBe('gemini');
  });

  it('is a no-op (returns 0) for missing provider/email args', () => {
    // Non-OAuth mail accounts pass no oauthProvider; the prune must simply skip.
    addProvider('sarv', '', 'sarv-model', {
      authMethod: 'oauth',
      oauthProvider: 'sarv',
      oauthEmail: 'advik.d@sarv.com',
    });

    expect(removeOAuthProvidersForAccount('', 'advik.d@sarv.com')).toBe(0);
    expect(removeOAuthProvidersForAccount('sarv', '')).toBe(0);
    expect(loadAISettings().providers).toHaveLength(1);
  });
});

describe('pruneOrphanedOAuthProviders (startup self-heal)', () => {
  it('removes an OAuth provider whose backing account is gone', () => {
    // The exact state the user is stuck in: the account was deleted by an older
    // build, so the provider is orphaned and the loop beachballs on next launch.
    addProvider('sarv', '', 'sarv-model', {
      authMethod: 'oauth',
      oauthProvider: 'sarv',
      oauthEmail: 'advik.d@sarv.com',
    });

    const removed = pruneOrphanedOAuthProviders([]); // no accounts left

    expect(removed).toBe(1);
    expect(loadAISettings().providers).toHaveLength(0);
  });

  it('keeps an OAuth provider whose backing account still exists', () => {
    // A provider for a live account must survive startup untouched.
    addProvider('sarv', '', 'sarv-model', {
      authMethod: 'oauth',
      oauthProvider: 'sarv',
      oauthEmail: 'advik.d@sarv.com',
    });

    const removed = pruneOrphanedOAuthProviders([
      { email: 'advik.d@sarv.com', imapConfig: { oauthProvider: 'sarv' } },
    ]);

    expect(removed).toBe(0);
    expect(loadAISettings().providers).toHaveLength(1);
  });

  it('matches the backing account case-insensitively and never touches API-key providers', () => {
    addProvider('gemini', 'key-123', 'gemini-model'); // apiKey provider — must survive
    addProvider('sarv', '', 'sarv-model', {
      authMethod: 'oauth',
      oauthProvider: 'sarv',
      oauthEmail: 'Advik.D@Sarv.com',
    });

    const removed = pruneOrphanedOAuthProviders([
      { email: 'advik.d@sarv.com', imapConfig: { oauthProvider: 'sarv' } },
    ]);

    expect(removed).toBe(0);
    expect(loadAISettings().providers).toHaveLength(2);
  });

  it('spells the provider/email map-key separator as a \\u0000 escape, never a raw NUL byte', () => {
    // The prune keys are `${provider}\u0000${email}` — NUL can't occur in either
    // half, so the pair is unambiguous. It used to be a RAW 0x00 byte pasted into
    // the template string: same runtime value, but `file`, git and GitHub then
    // classify this 90 KB module as BINARY — diffs collapse to "Binary files
    // differ", secret scanners skip it, and nobody reviews changes to it.
    const src = readFileSync(new URL('../../../../src/services/ai-service.ts', import.meta.url));
    expect(src.includes(0)).toBe(false);
    expect(src.toString('utf8')).toContain('\\u0000${');
  });
});
