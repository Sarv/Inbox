/** Opt-in integration against the explicitly configured LOCAL synthetic scanner.
 * Never loads a profile/database, selects real messages, or prints credentials.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ExtensionContextImpl } from '../../../../packages/core/src/extensions/extension-api';
import { createEventBus } from '../../../../packages/core/src/pipeline/event-bus';
import { AntivirusScanService, type ScanSource, type ScannerConfiguration } from '../../electron/services/antivirus-scan-service';

const enabled = process.env.INBOX_AV_SYNTHETIC === '1';
describe.skipIf(!enabled)('extension host → local Docker ClamAV (synthetic only)', () => {
  let service: AntivirusScanService;
  let context: ExtensionContextImpl;
  let configuration: ScannerConfiguration | undefined;
  const payloads = [Buffer.from('Inbox synthetic extension attachment.\n'),
    Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$' + 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'),
    Buffer.from('UEsDBAoACQAAAJCWQl0xbb84NwAAACsAAAANABwAc3ludGhldGljLnR4dFVUCQADF7C/ahewv2p1eAsAAQT1AQAABBQAAACSSTfgA8jEEekC/yZGg0sb+SgQtlKwzKJ/Bt5hcgukbiQ8aRPAHkUzu5BWWgRxeAlwBnIP1CXpUEsHCDFtvzg3AAAAKwAAAFBLAQIeAwoACQAAAJCWQl0xbb84NwAAACsAAAANABgAAAAAAAEAAACkgQAAAABzeW50aGV0aWMudHh0VVQFAAMXsL9qdXgLAAEE9QEAAAQUAAAAUEsFBgAAAAABAAEAUwAAAI4AAAAAAA==', 'base64')];
  const sources: ScanSource[] = payloads.map((p, i) => ({ accountId: 'synthetic-account', messageId: 'synthetic-message',
    kind: 'attachment', displayName: ['clean.txt', 'eicar-test.txt', 'encrypted.zip'][i], partId: String(i + 1), byteLength: p.length }));

  beforeAll(async () => {
    const origin = 'http://127.0.0.1:' + (process.env.API_PORT || '8080');
    const issuer = new URL(process.env.OIDC_ISSUER_URI || 'http://localhost:18081/realms/inbox');
    if (!['localhost', '127.0.0.1'].includes(issuer.hostname) || issuer.protocol !== 'http:') throw new Error('Synthetic test requires a loopback issuer.');
    const secret = process.env.INBOX_SERVICE_CLIENT_SECRET;
    if (!secret) throw new Error('Load the local scanner environment privately before this opt-in test.');
    const response = await fetch(issuer.href.replace(/\/$/, '') + '/protocol/openid-connect/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, redirect: 'error', signal: AbortSignal.timeout(15_000),
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: 'inbox-service', client_secret: secret }),
    });
    if (!response.ok) throw new Error('Synthetic scanner authentication failed.');
    const credential = (await response.json()).access_token as string;
    service = new AntivirusScanService({ readConfiguration: async () => configuration,
      writeConfiguration: async (_id, config) => { configuration = config; },
      accounts: () => [{ id: 'synthetic-account', name: 'Synthetic fixture', email: 'fixture@example.invalid' }],
      sources: async () => sources, read: async source => Buffer.from(payloads[Number(source.partId) - 1]),
      openSetup: () => {}, allowDevelopmentLoopback: true, pollMs: 250 });
    const probe = await service.probe('clamav-scan', origin, credential);
    await service.configure('clamav-scan', { challenge: probe.challenge, allowedAccountIds: ['synthetic-account'],
      allowBody: false, attachmentConsent: true, bodyConsent: false });
    service.setMessageContext('clamav-scan', 'synthetic-message', 'synthetic-account');
    context = new ExtensionContextImpl({ manifest: { id: 'clamav-scan', name: 'ClamAV Scan', version: '1.0.0', author: 'Sarv',
      description: 'Synthetic extension test', main: 'index.js', engines: { sarvinbox: '>=1.3.1' }, permissions: ['security:scan-attachments'] },
      storagePath: '/tmp/inbox-av-synthetic', grantedPermissions: ['security:scan-attachments'], eventBus: createEventBus(), securityBackend: service,
      storageBackend: { get: async () => undefined, set: async () => {}, delete: async () => {}, keys: async () => [], clear: async () => {} },
      settingsBackend: { get: <T>() => undefined as T, update: async () => {}, has: () => false } });
  }, 30_000);
  afterAll(async () => { await service?.dispose(); configuration = undefined; payloads.forEach(p => p.fill(0)); });

  it('returns exact per-item clean, EICAR and incomplete verdicts through the real extension API', async () => {
    const targets = await context.security.getTargets();
    expect(targets).toHaveLength(3);
    expect(await context.security.getSetup()).not.toHaveProperty('accounts');
    const created = await context.security.submit(targets.map(t => t.targetId));
    let job = created;
    const end = Date.now() + 120_000;
    while (!['completed', 'error', 'expired', 'cancelled'].includes(job.state) && Date.now() < end) {
      await new Promise(resolve => setTimeout(resolve, 250));
      job = await context.security.get(created.id);
    }
    expect(job.error).toBeUndefined();
    expect(job.state).toBe('completed');
    expect(job.items.map(i => i.status)).toEqual(['no-threat-detected', 'threat-detected', 'incomplete']);
    expect(job.items[1].signatures?.some(s => s.includes('Eicar'))).toBe(true);
    expect(job.items.every(i => /^[a-f0-9]{64}$/.test(i.sha256 || '') && i.engine?.name === 'ClamAV' && !!i.completedAt)).toBe(true);
  }, 130_000);
});
