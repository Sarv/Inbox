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

// Breaks: a one-file warning bypass is offered for an unreadable, removed or already configured scanner account.
describe('trusted missing attachment setup snapshots', () => {
  it('returns no missing-setup proof for a configured, approved account without contacting the scanner', async () => {
    const f = fixture();
    expect(await f.service.getAttachmentSetupRequirement('clamav-scan', 'account-b')).toBeUndefined();
    expect(f.request).not.toHaveBeenCalled(); expect(f.sourceRead).not.toHaveBeenCalled();
  });

  it.each([true, false])('proves missing setup when configured=%s without uploading, changing consent or opening setup', async configured => {
    const f = fixture({ configured });
    const accountId = configured ? 'account-a' : 'account-b';
    const first = await f.service.getAttachmentSetupRequirement('clamav-scan', accountId);
    const next = await f.service.getAttachmentSetupRequirement('clamav-scan', accountId);
    expect(first).toBeDefined(); expect(next).toBeDefined(); expect(first).not.toBe(next);
    await first!.assertCurrent(); await next!.assertCurrent();
    expect(f.request).not.toHaveBeenCalled(); expect(f.sourceRead).not.toHaveBeenCalled(); expect(f.read).not.toHaveBeenCalled();
    expect(f.writeConfiguration).not.toHaveBeenCalled(); expect(f.deps.openSetup).not.toHaveBeenCalled();
  });

  it('propagates unreadable configuration on initial and repeated checks', async () => {
    const f = fixture({ configured: false });
    const proof = await f.service.getAttachmentSetupRequirement('clamav-scan', 'account-b');
    f.deps.readConfiguration = vi.fn().mockRejectedValue(new Error('Secure storage is unavailable'));
    await expect(f.service.getAttachmentSetupRequirement('clamav-scan', 'account-b')).rejects.toThrow('Secure storage is unavailable');
    await expect(proof!.assertCurrent()).rejects.toThrow('Secure storage is unavailable');
  });

  it.each(['credential', 'endpoint', 'allowedAccountIds', 'allowBody', 'fingerprint', 'capabilities'] as const)(
    'invalidates an unapproved-account proof when %s changes', async field => {
      const f = fixture(); const proof = await f.service.getAttachmentSetupRequirement('clamav-scan', 'account-a');
      const config = f.config()!;
      if (field === 'allowedAccountIds') config.allowedAccountIds.push('account-a');
      else if (field === 'allowBody') config.allowBody = true;
      else if (field === 'capabilities') config.capabilities.operator.privacyTermsVersion = 'changed';
      else config[field] += '-changed';
      await expect(proof!.assertCurrent()).rejects.toThrow(/Antivirus setup changed|configuration cannot be securely read/);
      expect(f.sourceRead).not.toHaveBeenCalled(); expect(f.request).not.toHaveBeenCalled();
    });

  it('invalidates absent setup once configuration appears, and an unapproved config once removed', async () => {
    const missing = fixture({ configured: false }); const proof = await missing.service.getAttachmentSetupRequirement('clamav-scan', 'account-b');
    const configured = fixture().config();
    missing.deps.readConfiguration = async () => configured;
    await expect(proof!.assertCurrent()).rejects.toThrow('Antivirus setup changed');
    const f = fixture(); const unapproved = await f.service.getAttachmentSetupRequirement('clamav-scan', 'account-a');
    f.deps.readConfiguration = async () => undefined;
    await expect(unapproved!.assertCurrent()).rejects.toThrow('Antivirus setup changed');
  });

  it.each(['disable', 'remove', 'remove-not-yet-persisted', 'dispose'] as const)('invalidates a missing setup proof on %s', async action => {
    const f = fixture({ configured: false }); const proof = await f.service.getAttachmentSetupRequirement('clamav-scan', 'account-b');
    if (action === 'disable') await f.service.onExtensionDisabled('clamav-scan');
    if (action === 'remove') f.accountRemove();
    if (action === 'remove-not-yet-persisted') await f.service.onAccountRemoved('account-b');
    if (action === 'dispose') await f.service.dispose();
    await expect(proof!.assertCurrent()).rejects.toThrow(/unavailable|changed/);
  });

  it('refuses an unavailable account or service before reading configuration', async () => {
    const f = fixture({ configured: false }); const read = vi.spyOn(f.deps, 'readConfiguration');
    await expect(f.service.getAttachmentSetupRequirement('clamav-scan', 'removed')).rejects.toThrow('unavailable');
    await f.service.dispose();
    await expect(f.service.getAttachmentSetupRequirement('clamav-scan', 'account-b')).rejects.toThrow('unavailable');
    expect(read).not.toHaveBeenCalled();
  });

  it.each(['disable', 'remove', 'removed-in-registry'] as const)('rechecks %s during an asynchronous setup read', async action => {
    const f = fixture({ configured: false });
    f.deps.readConfiguration = async () => {
      if (action === 'disable') await f.service.onExtensionDisabled('clamav-scan');
      if (action === 'remove') await f.service.onAccountRemoved('account-b');
      if (action === 'removed-in-registry') f.accountRemove();
      return undefined;
    };
    await expect(f.service.getAttachmentSetupRequirement('clamav-scan', 'account-b')).rejects.toThrow(/unavailable|changed/);
  });

  it.each(['disable', 'remove', 'removed-in-registry'] as const)('rechecks %s during an asynchronous missing-setup snapshot assertion', async action => {
    const f = fixture({ configured: false }); const proof = await f.service.getAttachmentSetupRequirement('clamav-scan', 'account-b');
    f.deps.readConfiguration = async () => {
      if (action === 'disable') await f.service.onExtensionDisabled('clamav-scan');
      if (action === 'remove') await f.service.onAccountRemoved('account-b');
      if (action === 'removed-in-registry') f.accountRemove();
      return undefined;
    };
    await expect(proof!.assertCurrent()).rejects.toThrow(/unavailable|changed/);
  });

  it.each([
    ['null', () => null], ['array', () => []], ['boolean', () => false],
    ['account ids missing', () => ({ allowedAccountIds: undefined })], ['account ids invalid', () => ({ allowedAccountIds: [1] })],
    ['empty account id', () => ({ allowedAccountIds: [''] })], ['body flag invalid', () => ({ allowBody: 'false' })],
    ['fingerprint invalid type', () => ({ fingerprint: null })], ['endpoint invalid type', () => ({ endpoint: null })],
    ['endpoint insecure', () => ({ endpoint: 'http://scanner.test' })], ['credential invalid type', () => ({ credential: 1 })],
    ['credential invalid', () => ({ credential: 'invalid credential' })], ['capabilities absent', () => ({ capabilities: null })],
    ['capabilities corrupt', () => ({ capabilities: { engine: { signaturesUpdatedAt: new Date().toISOString() } } })],
    ['fingerprint mismatched', () => ({ fingerprint: 'corrupt' })],
  ])('rejects present unreadable %s config initially and while a missing setup proof is retained', async (_name, malformed) => {
    const f = fixture(); const proof = await f.service.getAttachmentSetupRequirement('clamav-scan', 'account-a');
    const changed = malformed();
    f.deps.readConfiguration = async () => (changed !== null && typeof changed === 'object' && !Array.isArray(changed)
      ? { ...f.config(), ...changed } : changed) as ScannerConfiguration;
    await expect(f.service.getAttachmentSetupRequirement('clamav-scan', 'account-a')).rejects.toThrow('configuration cannot be securely read');
    await expect(proof!.assertCurrent()).rejects.toThrow('configuration cannot be securely read');
    expect(f.request).not.toHaveBeenCalled(); expect(f.read).not.toHaveBeenCalled(); expect(f.deps.openSetup).not.toHaveBeenCalled();
  });

  it('validates stored capability shape without treating old saved engine metadata as missing setup', async () => {
    const f = fixture(); f.advance(49 * 60 * 60 * 1000);
    expect(await f.service.getAttachmentSetupRequirement('clamav-scan', 'account-b')).toBeUndefined();
    expect(f.request).not.toHaveBeenCalled();
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

describe('trusted scan before attachment download', () => {
  // Breaks: saving fetches a second attachment after scanning, or returns the upload buffer after it was erased.
  it('retains the exact clean bytes, independent of the panel context, until the save is disposed', async () => {
    const f = fixture(); const onProgress = vi.fn();
    f.service.setMessageContext('clamav-scan', 'another-message', 'account-a');
    const receipt = await f.service.scanAttachmentForDownload('clamav-scan', 'message-b', 'account-b', 'sample.txt', { onProgress });
    expect(f.sourceRead).toHaveBeenCalledWith('message-b', 'account-b');
    expect(f.read).toHaveBeenCalledTimes(1);
    expect(receipt.content.toString()).toBe('synthetic scan fixture');
    expect(receipt.content).not.toBe(f.readBuffers[0]);
    expect(f.readBuffers[0]?.every(byte => byte === 0)).toBe(true);
    expect([...f.uploaded.values()][0]).toEqual(receipt.content);
    expect(onProgress.mock.calls).toEqual([['downloading'], ['scanning']]);
    await receipt.assertCurrent();
    receipt.dispose(); receipt.dispose();
    expect(receipt.content.every(byte => byte === 0)).toBe(true);
    await expect(receipt.assertCurrent()).rejects.toThrow(/could not be fully scanned/);
  });

  // Breaks: installing the extension shares content before a scanner/account has been explicitly approved.
  it('opens setup and blocks unconfigured or unapproved accounts before mailbox reads', async () => {
    const absent = fixture({ configured: false });
    await expect(absent.service.scanAttachmentForDownload('clamav-scan', 'message-b', 'account-b', 'sample.txt')).rejects.toThrow(/Configure/);
    expect(absent.deps.openSetup).toHaveBeenCalledWith('clamav-scan');
    expect(absent.sourceRead).not.toHaveBeenCalled(); expect(absent.read).not.toHaveBeenCalled();
    const denied = fixture();
    await expect(denied.service.scanAttachmentForDownload('clamav-scan', 'message-b', 'account-a', 'sample.txt')).rejects.toThrow(/not approved/);
    expect(denied.deps.openSetup).toHaveBeenCalled(); expect(denied.sourceRead).not.toHaveBeenCalled();
  });

  // Breaks: filename ambiguity or a foreign MIME descriptor saves different bytes from the user's selected attachment.
  it.each(['missing', 'duplicate', 'foreign', 'unavailable'] as const)('refuses %s attachment metadata before content retrieval', async kind => {
    const f = fixture();
    const source: ScanSource = { accountId: kind === 'foreign' ? 'account-a' : 'account-b', messageId: 'message-b', kind: 'attachment',
      displayName: 'sample.txt', partFilename: 'sample.txt', partId: '2', byteLength: null,
      ...(kind === 'unavailable' ? { unavailableReason: 'Encrypted message' } : {}) };
    f.sources(kind === 'missing' ? [] : kind === 'duplicate' ? [source, { ...source, partId: '3' }] : [source]);
    await expect(f.service.scanAttachmentForDownload('clamav-scan', 'message-b', 'account-b', 'sample.txt')).rejects.toThrow(/unavailable/);
    expect(f.read).not.toHaveBeenCalled(); expect(f.uploaded.size).toBe(0);
  });

  // Breaks: a threat, incomplete scan or malformed verdict is mistaken for permission to save.
  it.each([
    ['virus', (ticket: any) => { const r = ticket.items[0].result; r.verdict = 'threat_detected'; r.reason.code = 'signature_match'; r.signatures = ['Eicar-Test']; }, /detected a threat/],
    ['encrypted archive', (ticket: any) => { const r = ticket.items[0].result; r.verdict = 'incomplete'; r.fullCoverage = false; r.reason.code = 'encrypted_archive'; r.limitations = ['encrypted_archive']; }, /fully scanned/],
    ['scan error', (ticket: any) => { const r = ticket.items[0].result; r.verdict = 'error'; r.fullCoverage = false; r.reason.code = 'scan_failed'; }, /fully scanned/],
    ['wrong digest', (ticket: any) => { ticket.items[0].result.sha256 = '0'.repeat(64); }, /scanning failed/],
    ['false coverage', (ticket: any) => { ticket.items[0].result.fullCoverage = false; }, /scanning failed/],
  ])('blocks saving after %s', async (_reason, changeTicket, error) => {
    const f = fixture({ changeTicket });
    await expect(f.service.scanAttachmentForDownload('clamav-scan', 'message-b', 'account-b', 'sample.txt')).rejects.toThrow(error);
    expect(f.readBuffers.every(buffer => buffer.every(byte => byte === 0))).toBe(true);
    expect(f.request.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(true);
  });

  // Breaks: a once-clean receipt remains usable after consent revocation, account removal, expiration or content mutation.
  it.each(['disable', 'remove-account', 'expire', 'mutate'] as const)('rechecks %s immediately before save', async action => {
    const f = fixture();
    const receipt = await f.service.scanAttachmentForDownload('clamav-scan', 'message-b', 'account-b', 'sample.txt');
    if (action === 'disable') await f.service.onExtensionDisabled('clamav-scan');
    if (action === 'remove-account') { await f.service.onAccountRemoved('account-b'); f.accountRemove(); }
    if (action === 'expire') f.advance(900_001);
    if (action === 'mutate') receipt.content[0] = 0;
    await expect(receipt.assertCurrent()).rejects.toThrow(/Download blocked/);
    receipt.dispose(); expect(receipt.content.every(byte => byte === 0)).toBe(true);
  });

  // Breaks: cancelling a pending IMAP read still uploads its late result and permits a save.
  it('stops a delayed read after cancellation and erases its bytes without upload', async () => {
    const f = fixture(); const abort = new AbortController();
    let release!: (content: Buffer<ArrayBuffer>) => void;
    f.read.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const pending = f.service.scanAttachmentForDownload('clamav-scan', 'message-b', 'account-b', 'sample.txt', { signal: abort.signal });
    const rejected = expect(pending).rejects.toThrow(/Download cancelled/);
    await vi.waitFor(() => expect(f.read).toHaveBeenCalled());
    abort.abort(); const content = Buffer.from('late content'); release(content); await rejected;
    expect(f.uploaded.size).toBe(0); expect(content.every(byte => byte === 0)).toBe(true);
  });

  // Breaks: a pre-cancelled click fetches mail, or a changed scanner policy uploads before fresh consent.
  it('rejects pre-cancelled downloads and scanner policy changes before retrieval', async () => {
    const f = fixture(); const abort = new AbortController(); abort.abort();
    await expect(f.service.scanAttachmentForDownload('clamav-scan', 'message-b', 'account-b', 'sample.txt', { signal: abort.signal })).rejects.toThrow(/cancelled/);
    expect(f.sourceRead).not.toHaveBeenCalled();
    f.cap.engine.scanPolicyVersion = 'new-policy';
    await expect(f.service.scanAttachmentForDownload('clamav-scan', 'message-b', 'account-b', 'sample.txt')).rejects.toThrow(/scanning failed/);
    expect(f.read).not.toHaveBeenCalled(); expect(f.uploaded.size).toBe(0);
  });

  // Breaks: cancelling stalled MIME metadata keeps the button busy and lets late lookup results start an upload.
  it('cancels a stalled metadata lookup immediately and ignores its late result', async () => {
    const f = fixture(); const abort = new AbortController();
    let release!: (value: ScanSource[]) => void;
    f.sourceRead.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const pending = f.service.scanAttachmentForDownload('clamav-scan', 'message-b', 'account-b', 'sample.txt', { signal: abort.signal });
    const rejected = expect(pending).rejects.toThrow(/Download cancelled/);
    await vi.waitFor(() => expect(f.sourceRead).toHaveBeenCalled());
    abort.abort(new Error('Download cancelled.')); await rejected;
    release([{ accountId: 'account-b', messageId: 'message-b', kind: 'attachment', displayName: 'sample.txt', byteLength: 1 }]);
    await flush(); expect(f.read).not.toHaveBeenCalled(); expect(f.request).not.toHaveBeenCalled();
  });

  // Breaks: Download bypasses the queue limit shared with manual scans and starts unbounded mail reads.
  it('shares running scan limits and frees capacity after cancellation', async () => {
    const f = fixture();
    f.read.mockImplementation((_source, _limit, signal?: AbortSignal) => new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(new Error('Download cancelled.')), { once: true });
    }));
    const [target] = await f.service.getTargets('clamav-scan');
    const first = await f.service.submit('clamav-scan', [target!.targetId]);
    const second = await f.service.submit('clamav-scan', [target!.targetId]);
    await vi.waitFor(() => expect(f.read).toHaveBeenCalledTimes(2));
    await expect(f.service.scanAttachmentForDownload('clamav-scan', 'message-b', 'account-b', 'sample.txt')).rejects.toThrow(/scanning failed/);
    expect(f.read).toHaveBeenCalledTimes(2);
    await f.service.cancel('clamav-scan', first.id);
    await f.service.cancel('clamav-scan', second.id);
    f.read.mockImplementation(async () => Buffer.from('synthetic retry fixture'));
    const receipt = await f.service.scanAttachmentForDownload('clamav-scan', 'message-b', 'account-b', 'sample.txt');
    expect(receipt.content.toString()).toBe('synthetic retry fixture'); receipt.dispose();
  });

  // Breaks: cancelling after a clean verdict still permits a destination write with its retained bytes.
  it('rejects a clean receipt after cancellation and after disposal', async () => {
    const f = fixture(); const abort = new AbortController();
    const receipt = await f.service.scanAttachmentForDownload('clamav-scan', 'message-b', 'account-b', 'sample.txt', { signal: abort.signal });
    abort.abort();
    await expect(receipt.assertCurrent()).rejects.toThrow(/Download cancelled/);
    receipt.dispose();
    expect(receipt.content.every(byte => byte === 0)).toBe(true);
    const fresh = await f.service.scanAttachmentForDownload('clamav-scan', 'message-b', 'account-b', 'sample.txt');
    fresh.dispose();
    await expect(fresh.assertCurrent()).rejects.toThrow(/fully scanned/);
  });

  // Breaks: a closed, revoked or removed account leaves clean attachment bytes retained while its save dialog is open.
  it.each(['disable', 'deactivate', 'remove-account', 'dispose'] as const)('erases retained clean bytes immediately on %s', async action => {
    const f = fixture();
    const receipt = await f.service.scanAttachmentForDownload('clamav-scan', 'message-b', 'account-b', 'sample.txt');
    if (action === 'disable') await f.service.onExtensionDisabled('clamav-scan');
    if (action === 'deactivate') await f.service.onExtensionDeactivated('clamav-scan');
    if (action === 'remove-account') { await f.service.onAccountRemoved('account-b'); f.accountRemove(); }
    if (action === 'dispose') await f.service.dispose();
    expect(receipt.content.every(byte => byte === 0)).toBe(true);
    await expect(receipt.assertCurrent()).rejects.toThrow(/Download (blocked|cancelled)/);
    receipt.dispose();
  });

  // Breaks: an attachment with a display alias cannot be downloaded using its actual MIME filename.
  it('matches the MIME filename rather than a display alias', async () => {
    const f = fixture();
    f.sources([{ accountId: 'account-b', messageId: 'message-b', kind: 'attachment', displayName: 'Friendly display name', partFilename: 'actual.txt', byteLength: 22, partId: '2' }]);
    const receipt = await f.service.scanAttachmentForDownload('clamav-scan', 'message-b', 'account-b', 'actual.txt');
    expect(receipt.content.toString()).toBe('synthetic scan fixture'); receipt.dispose();
    await expect(f.service.scanAttachmentForDownload('clamav-scan', 'message-b', 'account-b', 'Friendly display name')).rejects.toThrow(/unavailable/);
  });
});
