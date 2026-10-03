// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';

import type { AntivirusScanJob, AntivirusScanTarget, AntivirusSetupStatus } from '@sarvinbox/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { validateManifest } from '../../../../../packages/core/src/extensions/extension-loader';

const extensionDir = resolve(__dirname, '../../../../../extensions/clamav-scan');
const html = readFileSync(resolve(extensionDir, 'panel/index.html'), 'utf8');
const source = readFileSync(resolve(extensionDir, 'panel/panel.js'), 'utf8');
const targets: AntivirusScanTarget[] = [
  { targetId: 'attachment-id', kind: 'attachment', displayName: 'synthetic.pdf', byteLength: 12 },
  { targetId: 'body-id', kind: 'email-body', displayName: 'Email body', byteLength: null },
  { targetId: 'encrypted-id', kind: 'attachment', displayName: 'encrypted.pgp', byteLength: 20, unavailableReason: 'Encrypted target is unavailable' },
];
const setup: AntivirusSetupStatus = {
  endpoint: 'https://scanner.example.test', enabled: true, configured: true,
  operator: 'Example operator', region: 'Test region', allowedAccountIds: ['work'], allowBody: true,
};
const queued: AntivirusScanJob = {
  id: 'synthetic-job', state: 'queued', createdAt: '2026-10-02T00:00:00Z', updatedAt: '2026-10-02T00:00:00Z',
  items: [{ targetId: 'attachment-id', kind: 'attachment', displayName: 'synthetic.pdf', status: 'pending' }],
};
const byId = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const settle = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); };
const select = (id: string) => {
  const input = document.querySelector<HTMLInputElement>(`#targets input[value="${id}"]`)!;
  input.checked = true; input.dispatchEvent(new Event('change', { bubbles: true }));
};

async function mount(options: { setup?: AntivirusSetupStatus; job?: AntivirusScanJob; clock?: { now: number } } = {}) {
  document.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>'));
  const result = options.job ?? queued;
  const security = {
    getSetup: vi.fn(async () => options.setup ?? setup), getTargets: vi.fn(async () => targets),
    openSetup: vi.fn(async () => undefined), submit: vi.fn(async () => result),
    get: vi.fn(async () => result), cancel: vi.fn(async () => ({ ...result, state: 'cancelled' as const })),
  };
  const events = new Map<string, () => void>();
  const timers = new Map<number, () => void>();
  let timerId = 0;
  runInNewContext(source, {
    document, console, Date: class extends Date { static now() { return options.clock?.now ?? Date.now(); } },
    window: { sarv: { security, on: (name: string, handler: () => void) => events.set(name, handler) }, addEventListener: (name: string, handler: () => void) => events.set(name, handler) },
    setTimeout: (callback: () => void) => { timers.set(++timerId, callback); return timerId; },
    clearTimeout: (id: number) => timers.delete(id),
  });
  await settle();
  return { security, events, timers };
}
afterEach(() => { document.body.innerHTML = ''; });

describe('portable ClamAV extension', () => {
  it('declares the scan capability and runs as a dependency free CJS package', () => {
    const manifest = JSON.parse(readFileSync(resolve(extensionDir, 'sarvinbox-extension.json'), 'utf8'));
    expect(validateManifest(manifest).errors).toEqual([]);
    expect(manifest.permissions).toEqual(['ui:panel', 'security:scan-attachments', 'security:scan-body']);
    expect(manifest.contributes.capabilities[0]).toMatchObject({ id: 'attachment.scan', export: 'scanAttachments' });
    const exported: { activate?: (context: unknown) => void } = {};
    runInNewContext(readFileSync(resolve(extensionDir, 'index.js'), 'utf8'), { exports: exported });
    const openPanel = vi.fn();
    const context = { ui: { openPanel }, exports: {} as { scanAttachments?: () => unknown } };
    exported.activate!(context); context.exports.scanAttachments!();
    expect(openPanel).toHaveBeenCalledWith('scan');
  });

  it('forbids network connections and loads scripts and styles only from external assets', () => {
    expect(html).toContain("connect-src 'none'");
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i);
    expect(html).not.toMatch(/<style[\s>]/i);
    expect(source).not.toMatch(/\b(fetch|XMLHttpRequest|WebSocket)\s*\(/);
    expect(html).not.toMatch(/credential|password|api.?key/i);
  });

  it('loads opaque targets without selecting or submitting anything automatically', async () => {
    const { security } = await mount();
    expect(document.querySelectorAll('#targets input:checked')).toHaveLength(0);
    expect(security.submit).not.toHaveBeenCalled();
    expect(byId<HTMLButtonElement>('scan').disabled).toBe(true);
    expect(document.querySelector<HTMLInputElement>('#targets input[value="encrypted-id"]')?.disabled).toBe(true);
    expect(byId('targets').textContent).toContain('Encrypted target is unavailable');
  });

  it('submits only selected attachment ids and supports cancellation', async () => {
    const { security } = await mount();
    select('attachment-id'); byId('scan').click(); await settle();
    expect(security.submit).toHaveBeenCalledWith(['attachment-id'], { includeBodyConsent: false });
    expect(byId('job-state').textContent).toBe('Queued');
    byId('cancel').click(); await settle();
    expect(security.cancel).toHaveBeenCalledWith('synthetic-job');
    expect(byId('job-state').textContent).toBe('Cancelled');
    expect(byId('cancel').hidden).toBe(true);
  });

  it('requires the per-message body checkbox and clears it on message changes', async () => {
    const { security, events } = await mount({ job: { ...queued, state: 'completed' } });
    select('body-id');
    expect(byId('body-consent-row').hidden).toBe(false);
    expect(byId<HTMLButtonElement>('scan').disabled).toBe(true);
    const consent = byId<HTMLInputElement>('body-consent');
    consent.checked = true; consent.dispatchEvent(new Event('change'));
    byId('scan').click(); await settle();
    expect(security.submit).toHaveBeenCalledWith(['body-id'], { includeBodyConsent: true });
    expect(consent.checked).toBe(false);
    expect(byId<HTMLButtonElement>('scan').disabled).toBe(true);
    byId('scan').click(); await settle();
    expect(security.submit).toHaveBeenCalledOnce();
    events.get('message-changed')!(); await settle();
    expect(consent.checked).toBe(false);
    expect(document.querySelectorAll('#targets input:checked')).toHaveLength(0);
  });

  it('ignores progress replies that arrive after cancellation', async () => {
    const { security, timers } = await mount();
    let release!: (value: AntivirusScanJob) => void;
    security.get.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    select('attachment-id'); byId('scan').click(); await settle();
    byId('cancel').click(); await settle();
    release({ ...queued, state: 'completed', items: [{ ...queued.items[0], status: 'no-threat-detected' }] });
    await settle();
    expect(byId('job-state').textContent).toBe('Cancelled');
    expect(byId('results').textContent).not.toContain('No threat detected');
    expect(timers.size).toBe(0);
  });

  it('expires a completed visible verdict and removes its no-threat status', async () => {
    const clock = { now: Date.now() };
    const completed: AntivirusScanJob = { ...queued, state: 'completed', expiresAt: new Date(clock.now + 1000).toISOString(),
      items: [{ ...queued.items[0], status: 'no-threat-detected' }] };
    const { timers } = await mount({ job: completed, clock });
    select('attachment-id'); byId('scan').click(); await settle();
    expect(byId('results').textContent).toContain('No threat detected');
    const expire = [...timers.values()][0];
    clock.now += 1001; expire();
    expect(byId('job-state').textContent).toBe('Expired');
    expect(byId('results').textContent).not.toContain('No threat detected');
    expect(byId('results').textContent).toContain('no current verdict');
  });

  it('recovers selection after a missing or revoked active job is refused', async () => {
    const { security } = await mount();
    security.get.mockRejectedValueOnce(new Error('Scan is unavailable or expired'));
    select('attachment-id'); byId('scan').click(); await settle();
    expect(byId('job-state').textContent).toBe('Error');
    expect(byId('results').textContent).toContain('no usable verdict');
    expect(byId<HTMLButtonElement>('scan').disabled).toBe(false);
    security.get.mockRejectedValueOnce(new Error('Scan is unavailable or expired'));
    byId('refresh').click(); await settle();
    select('attachment-id');
    expect(byId<HTMLButtonElement>('scan').disabled).toBe(false);
  });

  it.each([
    ['no-threat-detected', 'No threat detected'], ['threat-detected', 'Threat detected'],
    ['incomplete', 'Incomplete scan'], ['error', 'Scan error'],
  ] as const)('renders %s distinctly and treats filenames as text', async (status, label) => {
    const completed: AntivirusScanJob = {
      ...queued, state: 'completed', items: [{ ...queued.items[0], status, displayName: '<img src=x onerror=alert(1)>', reason: 'Synthetic fixture reason' }],
    };
    await mount({ job: completed }); select('attachment-id'); byId('scan').click(); await settle();
    expect(byId('results').textContent).toContain(label);
    expect(byId('results').textContent).toContain('<img src=x onerror=alert(1)>');
    expect(byId('results').querySelector('img')).toBeNull();
    expect(byId('results').textContent).toContain('Synthetic fixture reason');
  });

  it('opens host setup and prevents submission while sharing is disabled', async () => {
    const { security } = await mount({ setup: { ...setup, enabled: false, allowBody: false } });
    select('attachment-id'); expect(byId<HTMLButtonElement>('scan').disabled).toBe(true);
    byId('configure').click(); await settle();
    expect(security.openSetup).toHaveBeenCalled();
    expect(security.submit).not.toHaveBeenCalled();
    expect(document.querySelector<HTMLInputElement>('#targets input[value="body-id"]')?.disabled).toBe(true);
  });

  it('shows validated engine, definitions, scan date and exact byte fingerprint', async () => {
    const completed: AntivirusScanJob = { ...queued, state: 'completed', items: [{
      ...queued.items[0], status: 'no-threat-detected', completedAt: '2026-10-02T00:01:00Z',
      bytes: 12, sha256: 'a'.repeat(64), engine: { name: 'ClamAV', version: '1.4.3',
        signatureVersion: 'synthetic-definitions', signaturesUpdatedAt: '2026-10-01T00:00:00Z', scanPolicyVersion: 'policy-v1' },
    }] };
    await mount({ job: completed }); select('attachment-id'); byId('scan').click(); await settle();
    expect(byId('results').textContent).toContain('ClamAV 1.4.3');
    expect(byId('results').textContent).toContain('Definitions synthetic-definitions');
    expect(byId('results').textContent).toContain('Scanned ');
    expect(byId('results').textContent).toContain('Scanned bytes: 12');
    expect(byId('results').textContent).toContain('SHA-256: ' + 'a'.repeat(64));
    expect(byId('results').textContent).toContain('Scan policy: policy-v1');
  });
});
