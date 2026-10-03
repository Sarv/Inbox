import { createHash } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { AntivirusScanService, type AntivirusDependencies, type ScannerConfiguration, type ScanSource } from '../../../../electron/services/antivirus-scan-service';
import { consentFingerprint, type ScannerCapabilities } from '../../../../electron/services/antivirus-transport';

const services: AntivirusScanService[] = [];
afterEach(async () => { for (const service of services.splice(0)) await service.dispose(); });

/** A faithful ticket peer with synthetic bytes only. No Electron, profile, socket, or SQLite is used. */
function fixture(options: { allowBody?: boolean; configured?: boolean; changeTicket?: (value: any) => void; changeCreated?: (value: any) => void } = {}) {
  let now = Date.now();
  const cap: ScannerCapabilities = {
    protocolVersion: 1,
    engine: { name: 'ClamAV', version: '1.5.4', signatureVersion: '123', signaturesUpdatedAt: new Date(now).toISOString(), scanPolicyVersion: 'policy-1' },
    operator: { name: 'Synthetic test scanner', region: 'Local test', privacyPolicyUrl: 'https://scanner.test/privacy', privacyTermsVersion: 'privacy-1' },
    maxItemBytes: 128, maxTotalBytes: 256, maxItems: 10, contentLifetimeSeconds: 300, resultLifetimeSeconds: 900,
    contentStorage: { mode: 'ephemeral', noPersistentRetention: true }, authenticationRetentionSeconds: 86400,
  };
  let config: ScannerConfiguration | undefined = options.configured === false ? undefined : {
    endpoint: 'https://scanner.test', credential: 'synthetic-test-key', allowedAccountIds: ['account-b'],
    allowBody: options.allowBody ?? false, capabilities: structuredClone(cap), fingerprint: consentFingerprint(cap),
  };
  let accounts = [{ id: 'account-a', name: 'Account A', email: 'a@example.test' }, { id: 'account-b', name: 'Account B', email: 'b@example.test' }];
  let sources: ScanSource[] = [
    { accountId: 'account-b', messageId: 'message-b', kind: 'attachment', displayName: 'sample.txt', byteLength: null, partId: '2', partFilename: 'sample.txt', uid: 42, folderPath: 'INBOX' },
    { accountId: 'account-b', messageId: 'message-b', kind: 'email-body', displayName: 'Message text', byteLength: 14 },
  ];
  const readBuffers: Buffer[] = [];
  const read = vi.fn(async (_source: ScanSource, _limit: number) => { const buffer = Buffer.from('synthetic scan fixture'); readBuffers.push(buffer); return buffer; });
  const sourceRead = vi.fn(async (_message: string, _account: string) => structuredClone(sources));
  const uploaded = new Map<string, Buffer>();
  const ticketId = 'T'.repeat(43);
  let created: any;
  const request = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(typeof url === 'string' ? url : url instanceof URL ? url : url.url).pathname;
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    if (path === '/v1/scanner-capabilities') return json(cap);
    if (path === '/v1/scan-tickets' && init?.method === 'POST') {
      const metadata = JSON.parse(init.body as string).items;
      created = { ticketId, status: 'awaiting_upload', createdAt: new Date(now).toISOString(), contentDeadlineAt: new Date(now + 300_000).toISOString(), resultExpiresAt: null,
        items: metadata.map((item: any, index: number) => ({ ...item, itemId: `${index}`.repeat(43), uploadPath: `/v1/scan-tickets/${ticketId}/items/${`${index}`.repeat(43)}` })) };
      const response = structuredClone(created);
      options.changeCreated?.(response);
      return json(response, 201);
    }
    if (init?.method === 'PUT') { uploaded.set(path.split('/').pop()!, Buffer.from(init.body as Uint8Array)); return new Response(null, { status: 204 }); }
    if (path.endsWith('/submit')) return json({ ticketId, status: 'queued', contentDeadlineAt: created.contentDeadlineAt, resultExpiresAt: null }, 202);
    if (init?.method === 'DELETE') return new Response(null, { status: 204 });
    const ticket = { ticketId, status: 'completed', createdAt: created.createdAt, terminalAt: new Date(now).toISOString(), contentDeadlineAt: created.contentDeadlineAt, resultExpiresAt: new Date(now + 900_000).toISOString(),
      items: created.items.map((item: any) => ({ itemId: item.itemId, clientItemId: item.clientItemId, kind: item.kind, byteLength: item.byteLength, status: 'completed',
        result: { verdict: 'no_threat_detected', sha256: createHash('sha256').update(uploaded.get(item.itemId)!).digest('hex'), fullCoverage: true,
          reason: { code: 'scan_completed', retryable: false }, signatures: [], limitations: [], engine: cap.engine, completedAt: new Date(now).toISOString() } })) };
    options.changeTicket?.(ticket);
    return json(ticket);
  });
  const writeConfiguration = vi.fn(async (_id: string, value: ScannerConfiguration | undefined) => { config = value; });
  const deps: AntivirusDependencies = {
    readConfiguration: async () => config, writeConfiguration, accounts: () => accounts, sources: sourceRead, read,
    allowDevelopmentLoopback: false, requestFetch: request as typeof fetch, now: () => now, pollMs: 1, openSetup: vi.fn(),
  };
  const service = new AntivirusScanService(deps); services.push(service);
  service.setMessageContext('clamav-scan', 'message-b', 'account-b');
  return { service, deps, cap, read, sourceRead, request, uploaded, readBuffers, writeConfiguration,
    config: () => config, sources: (value: ScanSource[]) => { sources = value; }, accountRemove: () => { accounts = accounts.filter(a => a.id !== 'account-b'); },
    advance: (ms: number) => { now += ms; }, ticketId };
}

async function completed(service: AntivirusScanService, id: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const job = await service.get('clamav-scan', id);
    if (['completed', 'cancelled', 'error', 'expired'].includes(job.state)) return job;
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  throw new Error('Synthetic scan did not finish');
}

async function flush() { await new Promise(resolve => setTimeout(resolve, 5)); }

describe('antivirus host consent and mailbox boundaries', () => {
  it('does not discover or read any mailbox content before setup consent', async () => {
    const f = fixture({ configured: false });
    expect(await f.service.getTargets('clamav-scan')).toEqual([]);
    await expect(f.service.submit('clamav-scan', ['invented-target'])).rejects.toThrow(/valid set/);
    expect(f.sourceRead).not.toHaveBeenCalled(); expect(f.read).not.toHaveBeenCalled(); expect(f.request).not.toHaveBeenCalled();
    const probe = await f.service.probe('clamav-scan', 'https://scanner.test', 'synthetic-test-key');
    await expect(f.service.configure('clamav-scan', { challenge: probe.challenge, allowedAccountIds: ['account-b'], allowBody: false, attachmentConsent: false, bodyConsent: false })).rejects.toThrow(/Explicit consent/);
    expect(f.writeConfiguration).not.toHaveBeenCalled(); expect(f.read).not.toHaveBeenCalled();
    expect(f.request.mock.calls.every(([url]) => String(url).endsWith('/v1/scanner-capabilities'))).toBe(true);
  });

  it('only returns opaque targets from the specified, consented account in All Inboxes', async () => {
    const f = fixture(); const targets = await f.service.getTargets('clamav-scan');
    expect(f.sourceRead).toHaveBeenCalledWith('message-b', 'account-b');
    expect(targets).toHaveLength(1); expect(targets[0]?.kind).toBe('attachment');
    expect(JSON.stringify(targets)).not.toMatch(/account-b|message-b|INBOX|synthetic-test-key/);
    expect(f.read).not.toHaveBeenCalled();
    f.service.setMessageContext('clamav-scan', 'message-a', 'account-a');
    await expect(f.service.getTargets('clamav-scan')).rejects.toThrow(/consented/);
    expect(f.sourceRead).toHaveBeenCalledTimes(1);
  });

  it('rejects cross-account source metadata and stale message handles before reading', async () => {
    const f = fixture(); const [target] = await f.service.getTargets('clamav-scan');
    f.service.setMessageContext('clamav-scan', 'next-message', 'account-b');
    await expect(f.service.submit('clamav-scan', [target!.targetId])).rejects.toThrow(/unavailable or changed/);
    f.sources([{ accountId: 'account-a', messageId: 'next-message', kind: 'attachment', displayName: 'sample.txt', byteLength: null }]);
    await expect(f.service.getTargets('clamav-scan')).rejects.toThrow(/another message/);
    expect(f.read).not.toHaveBeenCalled();
  });

  it('refreshes attachment availability without changing the same MIME part handle', async () => {
    const f = fixture();
    const base: ScanSource = { accountId: 'account-b', messageId: 'message-b', kind: 'attachment', displayName: 'sample.txt', byteLength: null, partId: '2', partFilename: 'sample.txt', uid: 42, folderPath: 'INBOX' };
    f.sources([{ ...base, unavailableReason: 'Downloading' }]);
    const [pending] = await f.service.getTargets('clamav-scan');
    f.sources([base]); const [ready] = await f.service.getTargets('clamav-scan');
    expect(ready?.targetId).toBe(pending?.targetId); expect(ready?.unavailableReason).toBeUndefined();
  });

  it('requires separate global and per-scan body consent', async () => {
    const f = fixture({ allowBody: true });
    const body = (await f.service.getTargets('clamav-scan')).find(target => target.kind === 'email-body')!;
    await expect(f.service.submit('clamav-scan', [body.targetId])).rejects.toThrow(/Confirm message text/);
    expect(f.read).not.toHaveBeenCalled();
    const job = await f.service.submit('clamav-scan', [body.targetId], { includeBodyConsent: true });
    expect((await completed(f.service, job.id)).state).toBe('completed');
    expect(f.read).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'account-b', kind: 'email-body' }), 128, expect.any(AbortSignal));
  });

  it('keeps credentials and other mailbox identities out of extension setup status', async () => {
    const f = fixture();
    const setup = await f.service.getSetup('clamav-scan');
    expect(setup.accounts).toBeUndefined(); expect(JSON.stringify(setup)).not.toContain('synthetic-test-key');
    expect((await f.service.getTrustedSetup('clamav-scan')).accounts).toHaveLength(2);
  });

  it('does not read content if the operator changes privacy terms after setup', async () => {
    const f = fixture(); const [target] = await f.service.getTargets('clamav-scan');
    f.cap.operator.privacyTermsVersion = 'changed';
    const job = await f.service.submit('clamav-scan', [target!.targetId]);
    expect((await completed(f.service, job.id)).error).toMatch(/policy changed/);
    expect(f.read).not.toHaveBeenCalled(); expect(f.uploaded.size).toBe(0);
  });
});

describe('antivirus ticket results and cleanup', () => {
  it('uploads only exact selected bytes, verifies the digest, and erases local read buffers', async () => {
    const f = fixture(); const [target] = await f.service.getTargets('clamav-scan');
    const job = await f.service.submit('clamav-scan', [target!.targetId]); const result = await completed(f.service, job.id); await flush();
    expect(result.state).toBe('completed'); expect(result.items[0]?.status).toBe('no-threat-detected');
    expect([...f.uploaded.values()][0]?.toString()).toBe('synthetic scan fixture');
    expect(result.items[0]?.sha256).toBe(createHash('sha256').update('synthetic scan fixture').digest('hex'));
    expect(result.items[0]?.engine).toEqual(f.cap.engine); expect(result.items[0]?.completedAt).toEqual(expect.any(String));
    expect(f.readBuffers.every(buffer => buffer.every(byte => byte === 0))).toBe(true);
    const createCall = f.request.mock.calls.find(([url]) => String(url).endsWith('/v1/scan-tickets'))!;
    expect(new Headers(createCall[1]?.headers).get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);
    expect(createCall[1]?.body).not.toMatch(/sample.txt|account-b|message-b|synthetic scan fixture/);
    expect(f.request.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(true);
    await expect(f.service.get('another-extension', job.id)).rejects.toThrow(/unavailable/);
    f.advance(900_001); await expect(f.service.get('clamav-scan', job.id)).rejects.toThrow(/expired/);
  });

  it.each([
    ['digest mismatch', (ticket: any) => { ticket.items[0].result.sha256 = '0'.repeat(64); }],
    ['incomplete coverage falsely clean', (ticket: any) => { ticket.items[0].result.fullCoverage = false; }],
    ['unreported archive limitation', (ticket: any) => { ticket.items[0].result.limitations = ['encrypted_archive']; }],
    ['pending item falsely clean', (ticket: any) => { ticket.items[0].status = 'scanning'; }],
    ['expired result', (ticket: any) => { ticket.resultExpiresAt = new Date(Date.now() - 1000).toISOString(); }],
    ['missing detection signature', (ticket: any) => { ticket.items[0].result.verdict = 'threat_detected'; ticket.items[0].result.reason.code = 'signature_match'; }],
    ['invalid reason type', (ticket: any) => { ticket.items[0].result.reason.code = { toString: 'broken' }; }],
    ['invalid limitations metadata', (ticket: any) => { ticket.items[0].result.limitations = [{}]; }],
  ])('never reports clean for %s', async (_label, changeTicket) => {
    const f = fixture({ changeTicket }); const [target] = await f.service.getTargets('clamav-scan');
    const job = await f.service.submit('clamav-scan', [target!.targetId]); const result = await completed(f.service, job.id);
    expect(result.state).toBe('error'); expect(result.items[0]?.status).toBe('error');
  });

  it('preserves an incomplete encrypted-archive verdict as incomplete', async () => {
    const f = fixture({ changeTicket: ticket => {
      const result = ticket.items[0].result; result.verdict = 'incomplete'; result.fullCoverage = false;
      result.reason.code = 'encrypted_archive'; result.limitations = ['encrypted_archive'];
    } });
    const [target] = await f.service.getTargets('clamav-scan'); const job = await f.service.submit('clamav-scan', [target!.targetId]);
    const result = await completed(f.service, job.id);
    expect(result.state).toBe('completed'); expect(result.items[0]?.status).toBe('incomplete');
  });

  it('rejects a returned foreign upload URL before sending any content', async () => {
    const f = fixture({ changeCreated: ticket => { ticket.items[0].uploadPath = 'https://elsewhere.test/upload'; } });
    const [target] = await f.service.getTargets('clamav-scan'); const job = await f.service.submit('clamav-scan', [target!.targetId]);
    expect((await completed(f.service, job.id)).state).toBe('error'); expect(f.uploaded.size).toBe(0);
    expect(f.request.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false);
  });

  it.each(['cancel', 'disable', 'remove-account'] as const)('stops upload and clears held content when %s happens during a download', async action => {
    const f = fixture(); const [target] = await f.service.getTargets('clamav-scan');
    let release!: (value: Buffer<ArrayBuffer>) => void; f.read.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const job = await f.service.submit('clamav-scan', [target!.targetId]);
    await vi.waitFor(() => expect(f.read).toHaveBeenCalled(), { timeout: 500 });
    if (action === 'cancel') { await f.service.cancel('clamav-scan', job.id); expect((await f.service.get('clamav-scan', job.id)).state).toBe('cancelled'); }
    if (action === 'disable') await f.service.onExtensionDisabled('clamav-scan');
    if (action === 'remove-account') { await f.service.onAccountRemoved('account-b'); f.accountRemove(); }
    const held = Buffer.from('synthetic delayed fixture'); release(held); await flush();
    expect(f.uploaded.size).toBe(0); expect(held.every(byte => byte === 0)).toBe(true);
    expect(f.request.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false);
    if (action === 'disable') { expect(f.config()).toBeUndefined(); await expect(f.service.get('clamav-scan', job.id)).rejects.toThrow(/unavailable/); }
  });
});
