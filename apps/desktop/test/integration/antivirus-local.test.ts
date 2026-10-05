/** Opt-in integration against the explicitly configured LOCAL synthetic scanner.
 * Never loads a profile/database, selects real messages, or prints credentials.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ExtensionContextImpl } from '../../../../packages/core/src/extensions/extension-api';
import { createEventBus } from '../../../../packages/core/src/pipeline/event-bus';
import { AntivirusScanService, type ScanSource, type ScannerConfiguration } from '../../electron/services/antivirus-scan-service';
import { AttachmentOperationProtection } from '../../electron/services/attachment-download-protection';
import { AttachmentPreviewProtection } from '../../electron/services/attachment-preview-protection';

import { localScannerFixture, type LocalScannerFixture } from './antivirus-local-fixture';

const enabled = process.env.INBOX_AV_SYNTHETIC === '1';
describe.skipIf(!enabled)('extension host → local Docker ClamAV (synthetic only)', () => {
  let service: AntivirusScanService;
  let context: ExtensionContextImpl;
  let fixture: LocalScannerFixture;
  let configuration: ScannerConfiguration | undefined;
  let attachmentReads = 0;
  const payloads: Buffer[] = [Buffer.from('Inbox synthetic extension attachment.\n'),
    Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$' + 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'),
    Buffer.from('UEsDBAoACQAAAJCWQl0xbb84NwAAACsAAAANABwAc3ludGhldGljLnR4dFVUCQADF7C/ahewv2p1eAsAAQT1AQAABBQAAACSSTfgA8jEEekC/yZGg0sb+SgQtlKwzKJ/Bt5hcgukbiQ8aRPAHkUzu5BWWgRxeAlwBnIP1CXpUEsHCDFtvzg3AAAAKwAAAFBLAQIeAwoACQAAAJCWQl0xbb84NwAAACsAAAANABgAAAAAAAEAAACkgQAAAABzeW50aGV0aWMudHh0VVQFAAMXsL9qdXgLAAEE9QEAAAQUAAAAUEsFBgAAAAABAAEAUwAAAI4AAAAAAA==', 'base64')];
  const sources: ScanSource[] = payloads.map((p, i) => ({ accountId: 'synthetic-account', messageId: 'synthetic-message',
    kind: 'attachment', displayName: ['clean.txt', 'eicar-test.txt', 'encrypted.zip'][i], partId: String(i + 1), byteLength: p.length }));

  beforeAll(async () => {
    fixture = await localScannerFixture();
    service = new AntivirusScanService({ readConfiguration: async () => configuration,
      writeConfiguration: async (_id, config) => { configuration = config; },
      accounts: () => [{ id: 'synthetic-account', name: 'Synthetic fixture', email: 'fixture@example.invalid' }],
      sources: async () => sources, read: async source => { attachmentReads++; return Buffer.from(payloads[Number(source.partId) - 1]); },
      openSetup: () => {}, allowDevelopmentLoopback: true, pollMs: 250 });
    const probe = await service.probe('clamav-scan', fixture.origin, fixture.credential);
    await service.configure('clamav-scan', { challenge: probe.challenge, allowedAccountIds: ['synthetic-account'],
      allowBody: false, attachmentConsent: true, bodyConsent: false });
    service.setMessageContext('clamav-scan', 'synthetic-message', 'synthetic-account');
    context = new ExtensionContextImpl({ manifest: { id: 'clamav-scan', name: 'ClamAV Scan', version: '1.0.0', author: 'Sarv',
      description: 'Synthetic extension test', main: 'index.js', engines: { sarvinbox: '>=1.3.1' }, permissions: ['security:scan-attachments'] },
      storagePath: '/tmp/inbox-av-synthetic', grantedPermissions: ['security:scan-attachments'], eventBus: createEventBus(), securityBackend: service,
      storageBackend: { get: async () => undefined, set: async () => {}, delete: async () => {}, keys: async () => [], clear: async () => {} },
      settingsBackend: { get: <T>() => undefined as T, update: async () => {}, has: () => false } });
  }, 30_000);
  afterAll(async () => {
    try { await service?.dispose(); }
    finally {
      configuration = undefined;
      payloads.forEach(p => p.fill(0));
      await fixture?.cleanup();
    }
  });

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

  it('releases the exact clean attachment bytes only after a complete live scan, then erases them', async () => {
    const readsBefore = attachmentReads;
    const progress: string[] = [];
    const receipt = await service.scanAttachmentForDownload('clamav-scan', 'synthetic-message', 'synthetic-account', 'clean.txt', {
      onProgress: phase => { progress.push(phase); },
    });
    try {
      expect(progress).toEqual(['downloading', 'scanning']);
      expect(attachmentReads).toBe(readsBefore + 1);
      expect(receipt.content.equals(payloads[0])).toBe(true);
      await expect(receipt.assertCurrent()).resolves.toBeUndefined();
    } finally { receipt.dispose(); }
    expect(receipt.content.every(byte => byte === 0)).toBe(true);
    await expect(receipt.assertCurrent()).rejects.toThrow('could not be fully scanned');
  }, 130_000);

  it('blocks an EICAR download instead of releasing its bytes', async () => {
    await expect(service.scanAttachmentForDownload('clamav-scan', 'synthetic-message', 'synthetic-account', 'eicar-test.txt'))
      .rejects.toThrow('detected a threat');
  }, 130_000);

  it('blocks encrypted archives with incomplete coverage', async () => {
    await expect(service.scanAttachmentForDownload('clamav-scan', 'synthetic-message', 'synthetic-account', 'encrypted.zip'))
      .rejects.toThrow('could not be fully scanned');
  }, 130_000);

  it('cancels a protected download while entering the live scanning stage', async () => {
    const abort = new AbortController();
    const progress: string[] = [];
    await expect(service.scanAttachmentForDownload('clamav-scan', 'synthetic-message', 'synthetic-account', 'clean.txt', {
      signal: abort.signal,
      onProgress: phase => { progress.push(phase); if (phase === 'scanning') abort.abort(); },
    })).rejects.toThrow('Download cancelled');
    expect(progress).toEqual(['downloading', 'scanning']);
  }, 130_000);

  it('refuses missing setup and unapproved accounts before retrieving an attachment', async () => {
    const readsBefore = attachmentReads;
    await expect(service.scanAttachmentForDownload('clamav-scan', 'synthetic-message', 'unapproved-account', 'clean.txt'))
      .rejects.toThrow('not approved');
    const saved = configuration;
    configuration = undefined;
    try {
      await expect(service.scanAttachmentForDownload('clamav-scan', 'synthetic-message', 'synthetic-account', 'clean.txt'))
        .rejects.toThrow('Configure ClamAV Scan');
    } finally { configuration = saved; }
    expect(attachmentReads).toBe(readsBefore);
  });

  it('rejects a clean receipt when configuration is removed before saving', async () => {
    const receipt = await service.scanAttachmentForDownload('clamav-scan', 'synthetic-message', 'synthetic-account', 'clean.txt');
    const saved = configuration;
    configuration = undefined;
    try { await expect(receipt.assertCurrent()).rejects.toThrow('scanner settings changed'); }
    finally { configuration = saved; receipt.dispose(); }
    expect(receipt.content.every(byte => byte === 0)).toBe(true);
  }, 130_000);

  describe('protected attachment viewing with real ClamAV', () => {
    let previews: AttachmentPreviewProtection;
    let temporaryRoot: string;
    const opened: Array<{ filePath: string; bytes: Buffer }> = [];
    const phases: string[] = [];
    const accountId = 'synthetic-account';
    const emailId = 'synthetic-message';
    let cleanPdf: Buffer;

    beforeAll(async () => {
      // A complete tiny PDF exercises the same byte gate as Chromium's PDF viewer.
      const objects = [
        '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
        '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
        '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 20 20] >>\nendobj\n',
      ];
      let pdf = '%PDF-1.4\n';
      const offsets = objects.map(object => { const offset = Buffer.byteLength(pdf); pdf += object; return offset; });
      const xref = Buffer.byteLength(pdf);
      pdf += `xref\n0 4\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
      cleanPdf = Buffer.from(pdf);
      for (const [name, bytes] of [
        ['clean.pdf', cleanPdf], ['eicar-test.pdf', Buffer.from(payloads[1])],
        ['encrypted.docx', Buffer.from(payloads[2])],
      ] as const) {
        payloads.push(bytes);
        sources.push({ accountId, messageId: emailId, kind: 'attachment', displayName: name,
          partId: String(payloads.length), byteLength: bytes.length });
      }
      temporaryRoot = await mkdtemp(path.join(tmpdir(), 'inbox-av-synthetic-preview-'));
      previews = new AttachmentPreviewProtection({
        operations: new AttachmentOperationProtection({
          scanners: () => [{ id: 'clamav-scan', enabled: true, active: true, scanner: true, granted: true }],
          scan: (...args) => service.scanAttachmentForDownload(...args),
          openSetup: () => {}, progress: (_requestId, phase) => { phases.push(phase); },
        }),
        resolveLegacy: async () => { throw new Error('Unchecked preview cache must not be used'); },
        temporaryRoot: () => temporaryRoot,
        openPath: async filePath => { opened.push({ filePath, bytes: await readFile(filePath) }); return ''; },
      });
    });

    afterAll(async () => {
      await previews?.dispose();
      if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
      opened.forEach(file => file.bytes.fill(0));
    });

    // Regression: a PDF view must receive only the exact clean bytes, never an unchecked re-fetch.
    it('prepares a clean PDF preview, binds its URL to scanned bytes and erases it on close', async () => {
      const readsBefore = attachmentReads;
      phases.length = 0;
      const url = await previews.preparePreview(emailId, accountId, 'clean.pdf');
      const ref = { emailId, accountId, filename: 'clean.pdf' };
      expect(new URL(url).searchParams.get('preview')).toBeTruthy();
      expect([...new Set(phases)]).toEqual(['downloading', 'scanning']);
      const bytes = await previews.contentForRequest(ref, url);
      expect(bytes?.equals(cleanPdf)).toBe(true);
      expect(await previews.contentForRequest(ref, url)).toBe(bytes);
      expect(attachmentReads).toBe(readsBefore + 1);
      expect(previews.releasePreview(url)).toBe(true);
      expect(bytes?.every(byte => byte === 0)).toBe(true);
      await expect(previews.contentForRequest(ref, url)).rejects.toThrow('Preview blocked');
    }, 130_000);

    // Regression: hiding EICAR behind a document suffix must not expose a viewer URL or start an OS app.
    it('blocks an infected PDF before any viewer or system application receives its bytes', async () => {
      const opensBefore = opened.length;
      await expect(previews.preparePreview(emailId, accountId, 'eicar-test.pdf')).rejects.toThrow('detected a threat');
      await expect(previews.openPreview(emailId, accountId, 'eicar-test.pdf')).rejects.toThrow('detected a threat');
      expect(opened).toHaveLength(opensBefore);
    }, 130_000);

    // Regression: incomplete encrypted document coverage cannot authorize opening Word or another OS viewer.
    it('blocks an encrypted Office document with incomplete coverage before opening it', async () => {
      const opensBefore = opened.length;
      await expect(previews.openPreview(emailId, accountId, 'encrypted.docx')).rejects.toThrow('could not be fully scanned');
      expect(opened).toHaveLength(opensBefore);
    }, 130_000);

    // Regression: revoked sharing consent invalidates an already-clean PDF URL before a later range or display read.
    it('refuses a clean PDF preview after consent is removed', async () => {
      const url = await previews.preparePreview(emailId, accountId, 'clean.pdf');
      const saved = configuration;
      configuration = undefined;
      try {
        await expect(previews.contentForRequest({ emailId, accountId, filename: 'clean.pdf' }, url))
          .rejects.toThrow('Preview blocked');
      } finally { configuration = saved; previews.releasePreview(url); }
    }, 130_000);

    // Regression: system viewers must open the exact clean scanned copy and the host must remove its temporary file.
    it('opens a private exact clean PDF copy and removes that copy on shutdown', async () => {
      const readsBefore = attachmentReads;
      await previews.openPreview(emailId, accountId, 'clean.pdf');
      const latest = opened.at(-1)!;
      expect(latest.bytes.equals(cleanPdf)).toBe(true);
      expect(path.relative(temporaryRoot, latest.filePath).startsWith('..')).toBe(false);
      expect(attachmentReads).toBe(readsBefore + 1);
      await previews.dispose();
      await expect(readFile(latest.filePath)).rejects.toMatchObject({ code: 'ENOENT' });
    }, 130_000);
  });
});
