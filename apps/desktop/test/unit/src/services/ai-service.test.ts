import { readFileSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { addProvider, getDefaultProvider, loadAISettings, parseSearchQuery, pruneOrphanedOAuthProviders, removeOAuthProvidersForAccount } from '../../../../src/services/ai-service';

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


// `tag:` is the only search surface for a tag an extension applied — vip-scoring's
// `vip`, the receipts tracker's `receipt`/`subscription`. Those are written into
// the local tags column and never become a folder, an AI category or an IMAP flag,
// so before this operator existed the app stored the answer and had no question
// that returned it. These tests pin the FAST path (no provider configured, so a
// miss here doesn't silently fail over to an LLM round-trip).
describe('parseSearchQuery: tag: operator', () => {
  it('parses a bare tag: query without reaching for the AI', async () => {
    const result = await parseSearchQuery('tag:receipt');
    expect(result.query.tags).toEqual(['receipt']);
    expect(result.confidence).toBe(1.0);
    // Nothing else may be set — a stray textQuery would run a text search for
    // the literal word "tag:receipt" alongside the filter and return nothing.
    expect(result.query.textQuery).toBeUndefined();
  });

  // Two tags NARROW. Keeping only the last would quietly widen the search.
  it('collects every tag: in a combined query', async () => {
    const result = await parseSearchQuery('tag:receipt tag:subscription');
    expect(result.query.tags).toEqual(['receipt', 'subscription']);
  });

  it('combines with the other simple operators', async () => {
    const result = await parseSearchQuery('tag:vip is:unread from:boss');
    expect(result.query).toMatchObject({ tags: ['vip'], isUnread: true, from: 'boss' });
  });

  it('keeps free text alongside the tag', async () => {
    const result = await parseSearchQuery('tag:receipt netflix');
    expect(result.query.tags).toEqual(['receipt']);
    expect(result.query.textQuery).toBe('netflix');
  });

  // Tag matching is a literal comparison against the stored string, so
  // lowercasing here would make a Gmail label (stored with its own case)
  // unfindable. The SQL layer is what forgives a capitalised `tag:VIP`.
  it('preserves the case the reader typed', async () => {
    expect((await parseSearchQuery('tag:Work/Clients')).query.tags).toEqual(['Work/Clients']);
    expect((await parseSearchQuery('tag:VIP')).query.tags).toEqual(['VIP']);
  });

  // `tag:` means a TAG, `in:`/`label:` mean a FOLDER. Conflating them would send
  // a tag search down the folder-path predicate and return nothing.
  it('is distinct from in:/label:, which stay folder tokens', async () => {
    const tagged = await parseSearchQuery('tag:sent');
    expect(tagged.query.tags).toEqual(['sent']);
    expect(tagged.query.labels).toBeUndefined();

    const located = await parseSearchQuery('in:sent');
    expect(located.query.labels).toEqual(['sent']);
    expect(located.query.tags).toBeUndefined();
  });

  it('ignores a bare "tag:" with no name', async () => {
    const result = await parseSearchQuery('tag: netflix');
    expect(result.query.tags).toBeUndefined();
    expect(result.query.textQuery).toBe('netflix');
  });
});
