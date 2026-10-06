import { describe, expect, it, vi } from 'vitest';

import { ImapFlowClient } from '../../../src/imap/imapflow-client';

function setup(options: { host?: string; gmail?: boolean; permanentFlags?: string[]; validity?: number; readOnly?: boolean } = {}) {
  const client = new ImapFlowClient();
  const inner = {
    usable: true,
    mailbox: { path: 'INBOX', uidValidity: BigInt(options.validity ?? 7), readOnly: options.readOnly ?? false, permanentFlags: new Set(options.permanentFlags ?? ['\\*']) },
    messageFlagsAdd: vi.fn(async () => true),
    messageFlagsRemove: vi.fn(async () => true),
    fetchAll: vi.fn(async () => [{ uid: 1, flags: new Set(['\\Seen', 'Important']), labels: new Set(['Important', '\\Category_Promotions']) }]),
    search: vi.fn(async (_query: { uid: string; gmraw: string }, _options: { uid: boolean }) => [] as number[]),
    stats: () => ({ sent: 0, received: 0 }),
  };
  const state = client as unknown as { client: typeof inner; connectionState: string; currentFolder: string; capabilities: string[]; connectedHost: string };
  Object.assign(state, { client: inner, connectionState: 'selected', currentFolder: 'INBOX', capabilities: options.gmail ? ['X-GM-EXT-1'] : [], connectedHost: options.host ?? 'imap.sarv.com' });
  return { client, inner };
}

describe('provider-native importance mutation', () => {
  // Sarv stores Important as a bare keyword; stars and categories are untouched.
  it('adds and removes canonical Sarv Important', async () => {
    const { client, inner } = setup();
    await client.setImportance([1], true, 7);
    await client.setImportance([1], false, 7);
    expect(inner.messageFlagsAdd).toHaveBeenCalledWith([1], ['Important'], { uid: true });
    expect(inner.messageFlagsRemove).toHaveBeenCalledWith([1], ['Important'], { uid: true });
  });

  // Gmail labels are not normal FLAGS and must use X-GM-LABELS native scope.
  it('mutates Gmail native Important without replacing any other labels', async () => {
    const { client, inner } = setup({ gmail: true, host: 'imap.gmail.com' });
    await client.setImportance([1], true, 7);
    await client.setImportance([1], false, 7);
    expect(inner.messageFlagsAdd).toHaveBeenCalledWith([1], ['Important'], { uid: true, useLabels: true });
    expect(inner.messageFlagsRemove).toHaveBeenCalledWith([1], ['Important'], { uid: true, useLabels: true });
  });

  // Generic servers may support the registered keyword but never get invented folders.
  it('uses $Important only when supported, rejecting unsupported/read-only mailboxes', async () => {
    const supported = setup({ host: 'imap.example.test', permanentFlags: ['$Important'] });
    await supported.client.setImportance([1], true, 7);
    expect(supported.inner.messageFlagsAdd).toHaveBeenCalledWith([1], ['$Important'], { uid: true });
    const unsupported = setup({ host: 'imap.example.test', permanentFlags: ['\\Seen'] });
    await expect(unsupported.client.setImportance([1], true, 7)).rejects.toMatchObject({ code: 'IMPORTANCE_NOT_SUPPORTED' });
    expect(unsupported.inner.messageFlagsAdd).not.toHaveBeenCalled();
    await expect(setup({ readOnly: true }).client.setImportance([1], true, 7)).rejects.toMatchObject({ code: 'READ_ONLY_MAILBOX' });
  });

  // Offline UIDs must never apply to a mailbox whose identity was reset.
  it('rejects unknown/reused UIDVALIDITY before any STORE', async () => {
    const { client, inner } = setup({ validity: 8 });
    for (const expected of [0, 7]) await expect(client.setImportance([1], true, expected)).rejects.toMatchObject({ code: 'UIDVALIDITY_MISMATCH' });
    expect(inner.messageFlagsAdd).not.toHaveBeenCalled();
    await client.setImportance([], true, 8);
    expect(inner.messageFlagsAdd).not.toHaveBeenCalled();
  });

  // Gmail importance removals are visible only when flags reconciliation fetches labels.
  it('includes native Gmail labels in every flags reconciliation reply', async () => {
    const { client } = setup({ gmail: true });
    expect(await client.fetchAllFlags('INBOX')).toEqual([{ uid: 1, flags: ['\\Seen', 'Important'], labels: ['Important', '\\Category_Promotions'], categories: [], gmailCategoriesKnown: true }]);
    expect(await client.fetchFlagsOnly([1], undefined, 'INBOX')).toEqual([{ uid: 1, flags: ['\\Seen', 'Important'], labels: ['Important', '\\Category_Promotions'], categories: [], gmailCategoriesKnown: true }]);
  });

  // A STORE matching no message must not be reported as a synchronized flag.
  it('rejects false STORE results for both provider mechanisms', async () => {
    for (const gmail of [false, true]) {
      const { client, inner } = setup({ gmail });
      inner.messageFlagsAdd.mockResolvedValueOnce(false);
      await expect(client.setImportance([1], true, 7)).rejects.toMatchObject({ code: 'MESSAGE_NOT_FOUND' });
    }
  });

  // Network and permanent command errors must propagate to the durable queue.
  it('does not swallow a rejected STORE or mutate the other flag operation', async () => {
    const { client, inner } = setup();
    inner.messageFlagsAdd.mockRejectedValueOnce(new Error('Connection not available'));
    await expect(client.setImportance([1], true, 7)).rejects.toThrow('Connection not available');
    expect(inner.messageFlagsRemove).not.toHaveBeenCalled();
  });
});


describe('Gmail category discovery and mutation identity', () => {
  // Category tabs can be absent from X-GM-LABELS; bounded UID SEARCH is the authority.
  it('discovers only Promotions without labels using UIDs', async () => {
    const { client, inner } = setup({ gmail: true });
    inner.fetchAll.mockResolvedValue([{ uid: 1413, flags: new Set(), labels: new Set() }]);
    inner.search.mockImplementation(async (query) => query.gmraw === 'category:promotions' ? [1413] : []);
    const rows = await client.fetchFlagsOnly([1413], undefined, 'INBOX');
    expect(rows).toEqual([{ uid: 1413, flags: [], labels: [], categories: ['promotions'], gmailCategoriesKnown: true }]);
    expect(inner.search).toHaveBeenCalledTimes(1);
    expect(inner.search).toHaveBeenCalledWith({ uid: '1413', gmraw: 'category:promotions' }, { uid: true });
    expect(inner.search.mock.calls.map(([query]) => query.gmraw)).toEqual(['category:promotions']);
  });

  // One Promotions query per bounded batch avoids querying tabs that should go through AI.
  it('bounds category queries to 500 UIDs and avoids searches for ordinary IMAP', async () => {
    const { client, inner } = setup({ gmail: true });
    inner.fetchAll.mockResolvedValue(Array.from({ length: 501 }, (_, i) => ({ uid: i + 1, flags: new Set(), labels: new Set() })));
    expect(await client.fetchAllFlags('INBOX')).toHaveLength(501);
    expect(inner.search).toHaveBeenCalledTimes(2);
    for (const [query] of inner.search.mock.calls) expect(query.uid.split(',').length).toBeLessThanOrEqual(500);
    const plain = setup();
    await plain.client.fetchAllFlags('INBOX');
    expect(plain.inner.search).not.toHaveBeenCalled();
  });

  // Partial discovery is unknown and must defer AI, never clear an earlier category.
  it('publishes no partial categories after a failed or out-of-batch result', async () => {
    for (const foreign of [false, true]) {
      const { client, inner } = setup({ gmail: true });
      inner.search.mockImplementation(async () => {
        if (foreign) return [384];
        throw new Error('temporary failure');
      });
      expect(await client.fetchAllFlags('INBOX')).toEqual([expect.objectContaining({ uid: 1, gmailCategoriesKnown: false })]);
      expect((await client.fetchAllFlags('INBOX'))[0].categories).toBeUndefined();
    }
  });

  // A reset during discovery invalidates every UID, rather than applying another message's category.
  it('rejects mailbox identity changes during native discovery', async () => {
    const { client, inner } = setup({ gmail: true });
    inner.search.mockImplementation(async () => { inner.mailbox.uidValidity = 8n; return []; });
    await expect(client.fetchAllFlags('INBOX')).rejects.toMatchObject({ code: 'UIDVALIDITY_MISMATCH' });
  });

  // The REST category API is tied to the same OAuth account and exact uint64 message identity.
  it('modifies native categories from decimal X-GM-MSGID and preserves other labels', async () => {
    const { client, inner } = setup({ gmail: true });
    const resolveBearer = vi.fn(async () => 'test-token');
    (client as unknown as { gmailResolveBearer: typeof resolveBearer }).gmailResolveBearer = resolveBearer;
    inner.fetchAll.mockResolvedValue([{ uid: 1, flags: new Set(), labels: new Set(), emailId: '18446744073709551615' }] as any);
    const request = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', request);
    try {
      await client.modifyGmailCategories([1], ['promotions'], ['social'], 7);
      expect(inner.fetchAll).toHaveBeenCalledWith('1', { uid: true }, { uid: true });
      expect(request).toHaveBeenCalledWith('https://gmail.googleapis.com/gmail/v1/users/me/messages/ffffffffffffffff/modify', expect.objectContaining({ body: JSON.stringify({ addLabelIds: ['CATEGORY_PROMOTIONS'], removeLabelIds: ['CATEGORY_SOCIAL'] }) }));
      expect(inner.messageFlagsAdd).not.toHaveBeenCalled();
      expect(inner.messageFlagsRemove).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });

  // Unsupported credentials, missing IDs and reused UIDs must cause no remote mutation.
  it('fails safely before HTTP when OAuth or an exact message identity is unavailable', async () => {
    const { client, inner } = setup({ gmail: true });
    await expect(client.modifyGmailCategories([1], ['promotions'], [], 7)).rejects.toMatchObject({ code: 'GMAIL_CATEGORY_OAUTH_REQUIRED' });
    (client as unknown as { gmailResolveBearer: () => Promise<string> }).gmailResolveBearer = async () => 'test-token';
    const request = vi.fn(); vi.stubGlobal('fetch', request);
    try {
      await expect(client.modifyGmailCategories([1], ['promotions'], [], 8)).rejects.toMatchObject({ code: 'UIDVALIDITY_MISMATCH' });
      expect(inner.fetchAll).not.toHaveBeenCalled();
      await expect(client.modifyGmailCategories([1], ['promotions'], [], 7)).rejects.toMatchObject({ code: 'GMAIL_MESSAGE_ID_MISSING' });
      expect(request).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });
});


describe('Gmail category safety boundaries', () => {
  // Unknown UID namespace does not authorize a discovery query or automatic AI categorization.
  it('returns unknown metadata without issuing a search when UIDVALIDITY is unavailable', async () => {
    const { client, inner } = setup({ gmail: true, validity: 0 });
    expect((await client.fetchAllFlags('INBOX'))[0].gmailCategoriesKnown).toBe(false);
    expect(inner.search).not.toHaveBeenCalled();
  });

  // Label repair runs the same native discovery as ordinary flag reconciliation.
  it('includes category metadata in label-only repair rows', async () => {
    const { client, inner } = setup({ gmail: true });
    inner.search.mockImplementation(async (query) => query.gmraw === 'category:promotions' ? [1] : []);
    expect((await client.fetchAllLabels('INBOX'))[0]).toMatchObject({ categories: ['promotions'], gmailCategoriesKnown: true });
    expect(await setup().client.fetchAllLabels('INBOX')).toEqual([]);
  });

  // Read-only mailboxes and invalid native categories cannot invoke the Gmail mutation API.
  it('rejects read-only and invalid native category changes before fetching identities', async () => {
    for (const readOnly of [false, true]) {
      const { client, inner } = setup({ gmail: true, readOnly });
      (client as unknown as { gmailResolveBearer: () => Promise<string> }).gmailResolveBearer = async () => 'token';
      await expect(client.modifyGmailCategories([1], readOnly ? ['social'] : ['other'], [], 7)).rejects.toMatchObject({ code: readOnly ? 'READ_ONLY_MAILBOX' : 'GMAIL_CATEGORY_INVALID' });
      expect(inner.fetchAll).not.toHaveBeenCalled();
    }
  });

  // A changed connection during OAuth refresh must never authorize an HTTP mutation from old UIDs.
  it('stops before HTTP when token resolution changes the mailbox identity', async () => {
    const { client, inner } = setup({ gmail: true });
    (client as unknown as { gmailResolveBearer: () => Promise<string> }).gmailResolveBearer = async () => { inner.mailbox.uidValidity = 8n; return 'token'; };
    inner.fetchAll.mockResolvedValue([{ uid: 1, flags: new Set(), labels: new Set(), emailId: '123' }] as any);
    const request = vi.fn(); vi.stubGlobal('fetch', request);
    try {
      await expect(client.modifyGmailCategories([1], ['social'], [], 7)).rejects.toMatchObject({ code: 'GMAIL_CATEGORY_TOKEN_UNAVAILABLE' });
      expect(request).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });
});


describe('native category failure paths and read discovery variants', () => {
  // Flags from all reconciliation variants must contain the same native category authority.
  it('discovers categories in CONDSTORE and message fetches without requiring labels', async () => {
    for (const gmail of [false, true]) {
      const { client, inner } = setup({ gmail });
      (client as unknown as { capabilities: string[] }).capabilities = [...(gmail ? ['X-GM-EXT-1'] : []), 'CONDSTORE'];
      inner.fetchAll.mockResolvedValue([{ uid: 1, flags: new Set(), labels: new Set() }]);
      inner.search.mockImplementation(async (q) => q.gmraw === 'category:promotions' ? [1] : []);
      expect((await client.fetchFlagsChangedSince(1))[0]).toMatchObject(gmail ? { categories: ['promotions'], gmailCategoriesKnown: true } : { flags: [] });
      expect((await client.fetchMessagesByUID([1], { fetchBody: false }))[0]).toMatchObject(gmail ? { categories: ['promotions'], gmailCategoriesKnown: true } : { flags: [] });
      const calls = inner.search.mock.calls.length;
      await client.fetchMessagesByUID([1], { discoverCategories: false });
      expect(inner.search).toHaveBeenCalledTimes(calls);
    }
  });

  // False SEARCH replies and a disconnected socket remain unknown, with no partial category publication.
  it('keeps failed, disconnected and invalid UID discovery unknown', async () => {
    const bad = setup({ gmail: true });
    bad.inner.search.mockResolvedValue(false as never);
    expect((await bad.client.fetchAllFlags('INBOX'))[0].gmailCategoriesKnown).toBe(false);
    const offline = setup({ gmail: true });
    offline.inner.search.mockImplementation(async () => { offline.inner.usable = false; throw new Error('lost socket'); });
    expect((await offline.client.fetchAllFlags('INBOX'))[0].gmailCategoriesKnown).toBe(false);
    const invalid = setup({ gmail: true });
    invalid.inner.fetchAll.mockResolvedValue([{ uid: 0, flags: new Set(), labels: new Set() }]);
    expect((await invalid.client.fetchMessagesByUID([0]))[0].gmailCategoriesKnown).toBe(false);
    expect(invalid.inner.search).not.toHaveBeenCalled();
  });

  // A re-selected/reset mailbox cannot authorize even the first bounded category SEARCH.
  it('refuses a reset before the category discovery section', async () => {
    const { client, inner } = setup({ gmail: true });
    vi.spyOn(client, 'withFolder').mockImplementation(async (_path, fn) => { inner.mailbox.uidValidity = 8n; return fn(); });
    await expect(client.fetchAllFlags('INBOX')).rejects.toMatchObject({ code: 'UIDVALIDITY_MISMATCH' });
    expect(inner.search).not.toHaveBeenCalled();
  });

  // A full Gmail native mutation validates identity again before and after FETCH, not just in preflight.
  it('rejects namespace changes at lock entry or during identity FETCH', async () => {
    for (const phase of ['lock', 'fetch']) {
      const { client, inner } = setup({ gmail: true });
      (client as unknown as { gmailResolveBearer: () => Promise<string> }).gmailResolveBearer = async () => 'token';
      if (phase === 'lock') vi.spyOn(client, 'withFolder').mockImplementation(async (_path, fn) => { inner.mailbox.uidValidity = 8n; return fn(); });
      else inner.fetchAll.mockImplementation(async () => { inner.mailbox.uidValidity = 8n; return [{ uid: 1, flags: new Set(), labels: new Set(), emailId: '123' }]; });
      await expect(client.modifyGmailCategories([1], ['social'], [], 7)).rejects.toMatchObject({ code: 'UIDVALIDITY_MISMATCH' });
    }
  });

  // Empty changes are harmless; missing requested UID identities must never mutate a partial subset.
  it('handles empty intent and refuses an incomplete UID identity batch', async () => {
    const { client, inner } = setup({ gmail: true });
    (client as unknown as { gmailResolveBearer: () => Promise<string> }).gmailResolveBearer = async () => 'token';
    await client.modifyGmailCategories([], ['social'], [], 7);
    await client.modifyGmailCategories([1], [], [], 7);
    expect(inner.fetchAll).not.toHaveBeenCalled();
    inner.fetchAll.mockResolvedValue([]);
    await expect(client.modifyGmailCategories([1], ['social'], [], 7)).rejects.toMatchObject({ code: 'GMAIL_MESSAGE_ID_MISSING' });
  });

  // Account identity must remain stable while getting a token, including reconnects to the same folder name.
  it('prevents an account replacement before or after OAuth resolution', async () => {
    for (const phase of ['before', 'after']) {
      const { client, inner } = setup({ gmail: true });
      const state = client as unknown as { gmailResolveBearer: () => Promise<string>; client: typeof inner };
      state.gmailResolveBearer = async () => { if (phase === 'after') state.client = { ...inner }; return 'token'; };
      inner.fetchAll.mockImplementation(async () => { if (phase === 'before') state.client = { ...inner }; return [{ uid: 1, flags: new Set(), labels: new Set(), emailId: '123' }]; });
      const request = vi.fn(); vi.stubGlobal('fetch', request);
      try {
        await expect(client.modifyGmailCategories([1], ['social'], [], 7)).rejects.toMatchObject({ code: 'GMAIL_CATEGORY_TOKEN_UNAVAILABLE' });
        expect(request).not.toHaveBeenCalled();
      } finally { vi.unstubAllGlobals(); }
    }
  });

  // Permanent bare Important advertised by a generic server is distinct from a star or arbitrary keyword.
  it('uses explicit bare Important support on generic servers', async () => {
    const { client, inner } = setup({ host: 'imap.example.test', permanentFlags: ['Important'] });
    await client.setImportance([1], true, 7);
    expect(inner.messageFlagsAdd).toHaveBeenCalledWith([1], ['Important'], { uid: true });
  });
});


// Ignoring native tab classifications must not restrict explicit manual Gmail API capabilities.
it('retains native Social/Updates/Forums/Primary manual API writes while reading Promotions only', async () => {
  const { client, inner } = setup({ gmail: true });
  (client as unknown as { gmailResolveBearer: () => Promise<string> }).gmailResolveBearer = async () => 'test-token';
  inner.fetchAll.mockResolvedValue([{ uid: 1, flags: new Set(), labels: new Set(), emailId: '123' }] as any);
  const request = vi.fn(async () => new Response(null, { status: 200 })); vi.stubGlobal('fetch', request);
  try {
    await client.modifyGmailCategories([1], ['social', 'updates', 'forums', 'personal'], [], 7);
    expect(request).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ body: JSON.stringify({ addLabelIds: ['CATEGORY_SOCIAL', 'CATEGORY_UPDATES', 'CATEGORY_FORUMS', 'CATEGORY_PERSONAL'], removeLabelIds: [] }) }));
    await client.fetchAllFlags('INBOX');
    expect(inner.search.mock.calls.map(([query]) => query.gmraw)).toEqual(['category:promotions']);
  } finally { vi.unstubAllGlobals(); }
});
