import { createHash, randomUUID } from 'node:crypto';

import type { AntivirusScanJob, AntivirusScanTarget, AntivirusSetupStatus, ExtensionSecurityBackend } from '@sarvinbox/core';

import { consentFingerprint, hasControlCharacters, object, opaqueId, ScannerTransport, scannerOrigin, timestamp, validateEngine,
  type ScannerCapabilities } from './antivirus-transport';

export interface ScanSource {
  accountId: string;
  messageId: string;
  kind: 'attachment' | 'email-body';
  displayName: string;
  byteLength: number | null;
  partId?: string;
  partFilename?: string;
  folderPath?: string;
  uid?: number;
  unavailableReason?: string;
}

export interface ScannerConfiguration {
  endpoint: string;
  credential: string;
  allowedAccountIds: string[];
  allowBody: boolean;
  capabilities: ScannerCapabilities;
  fingerprint: string;
}

export interface AntivirusDependencies {
  readConfiguration(extensionId: string): Promise<ScannerConfiguration | undefined>;
  writeConfiguration(extensionId: string, config: ScannerConfiguration | undefined): Promise<void>;
  accounts(): Array<{ id: string; name: string; email: string }>;
  sources(messageId: string, accountId: string): Promise<ScanSource[]>;
  read(source: ScanSource, maxBytes: number, signal?: AbortSignal): Promise<Buffer>;
  openSetup(extensionId: string): void;
  allowDevelopmentLoopback: boolean;
  requestFetch?: typeof fetch;
  now?: () => number;
  pollMs?: number;
}

interface Target extends ScanSource { targetId: string; extensionId: string; generation: number }
interface Work {
  job: AntivirusScanJob;
  extensionId: string;
  config: ScannerConfiguration;
  generation: number;
  targets: Target[];
  abort: AbortController;
  transport: ScannerTransport;
  ticketId?: string;
  finishedAt?: number;
}
const terminal = new Set(['completed', 'cancelled', 'error', 'expired']);
const safeError = (error: unknown): string => error instanceof Error ? error.message : 'The scan could not be completed.';

/** Content/credentials remain in main. The extension receives opaque handles and verdicts only. */
export class AntivirusScanService implements ExtensionSecurityBackend {
  private contexts = new Map<string, { messageId?: string; accountId?: string; targets: Target[]; generation: number }>();
  private generations = new Map<string, number>();
  private jobs = new Map<string, Work>();
  private probes = new Map<string, { extensionId: string; config: ScannerConfiguration; expires: number }>();
  private sweep: ReturnType<typeof setInterval>;
  constructor(private deps: AntivirusDependencies) {
    this.sweep = setInterval(() => this.prune(), 5000);
    this.sweep.unref();
  }
  private now(): number { return this.deps.now?.() ?? Date.now(); }
  private iso(): string { return new Date(this.now()).toISOString(); }
  private generation(id: string): number { return this.generations.get(id) ?? 0; }
  private transport(config: Pick<ScannerConfiguration, 'endpoint' | 'credential'>): ScannerTransport {
    return new ScannerTransport(config.endpoint, config.credential, this.deps.requestFetch);
  }
  private publicSetup(config?: ScannerConfiguration): AntivirusSetupStatus {
    const accounts = this.deps.accounts();
    return { endpoint: config?.endpoint ?? '', configured: !!config, enabled: !!config,
      allowedAccountIds: config?.allowedAccountIds.filter(id => accounts.some(a => a.id === id)) ?? [],
      allowBody: config?.allowBody ?? false, accounts,
      operator: config?.capabilities.operator.name, region: config?.capabilities.operator.region,
      privacyPolicyUrl: config?.capabilities.operator.privacyPolicyUrl,
      privacyTermsVersion: config?.capabilities.operator.privacyTermsVersion,
      scanPolicyVersion: config?.capabilities.engine.scanPolicyVersion,
      metadataRetentionSeconds: config?.capabilities.authenticationRetentionSeconds,
      contentLifetimeSeconds: config?.capabilities.contentLifetimeSeconds,
      resultLifetimeSeconds: config?.capabilities.resultLifetimeSeconds,
      developmentOnly: !!config && config.endpoint.startsWith('http:') };
  }
  async getSetup(extensionId: string): Promise<AntivirusSetupStatus> {
    const { accounts: _accounts, ...setup } = await this.getTrustedSetup(extensionId);
    return setup;
  }
  async getTrustedSetup(extensionId: string): Promise<AntivirusSetupStatus> {
    return this.publicSetup(await this.deps.readConfiguration(extensionId));
  }
  async openSetup(extensionId: string): Promise<void> { this.deps.openSetup(extensionId); }

  async probe(extensionId: string, endpoint: string, credential?: string): Promise<{ challenge: string; setup: AntivirusSetupStatus }> {
    const origin = scannerOrigin(endpoint, this.deps.allowDevelopmentLoopback);
    const previous = await this.deps.readConfiguration(extensionId);
    const secret = credential?.trim() || (previous?.endpoint === origin ? previous.credential : '');
    const capabilities = await this.transport({ endpoint: origin, credential: secret }).capabilities();
    const config: ScannerConfiguration = { endpoint: origin, credential: secret, capabilities,
      allowedAccountIds: [], allowBody: false, fingerprint: consentFingerprint(capabilities) };
    for (const [id, p] of this.probes) if (p.expires <= this.now() || p.extensionId === extensionId) this.probes.delete(id);
    if (this.probes.size >= 20) throw new Error('Too many pending scanner setups. Try again later.');
    const challenge = randomUUID();
    this.probes.set(challenge, { extensionId, config, expires: this.now() + 300_000 });
    return { challenge, setup: { ...this.publicSetup(config), configured: false, enabled: false } };
  }

  async configure(extensionId: string, input: { challenge: string; allowedAccountIds: string[]; allowBody: boolean;
    attachmentConsent: boolean; bodyConsent: boolean }): Promise<AntivirusSetupStatus> {
    const probe = this.probes.get(input?.challenge);
    if (!probe || probe.extensionId !== extensionId || probe.expires <= this.now()) throw new Error('Check the scanner again before enabling it.');
    if (input.attachmentConsent !== true || (input.allowBody === true && input.bodyConsent !== true)) {
      throw new Error('Explicit consent is required for attachments and, separately, message text.');
    }
    if (!Array.isArray(input.allowedAccountIds) || !input.allowedAccountIds.length || input.allowedAccountIds.length > 100 ||
      new Set(input.allowedAccountIds).size !== input.allowedAccountIds.length ||
      input.allowedAccountIds.some(id => typeof id !== 'string' || !this.deps.accounts().some(a => a.id === id))) {
      throw new Error('Select existing accounts that may share selected content with this scanner.');
    }
    const fresh = await this.transport(probe.config).capabilities();
    if (consentFingerprint(fresh) !== probe.config.fingerprint) throw new Error('The scanner policy changed. Check it and review the disclosure again.');
    await this.cancelExtensionWork(extensionId);
    this.generations.set(extensionId, this.generation(extensionId) + 1);
    this.contexts.delete(extensionId);
    const config = { ...probe.config, capabilities: fresh, allowedAccountIds: [...input.allowedAccountIds], allowBody: input.allowBody === true };
    await this.deps.writeConfiguration(extensionId, config);
    this.probes.delete(input.challenge);
    return this.publicSetup(config);
  }

  setMessageContext(extensionId: string, messageId?: string, accountId?: string): void {
    const previous = this.contexts.get(extensionId);
    if (previous?.messageId === messageId && previous?.accountId === accountId) return;
    this.contexts.set(extensionId, { messageId, accountId, targets: [], generation: this.generation(extensionId) });
  }

  async getTargets(extensionId: string): Promise<AntivirusScanTarget[]> {
    const context = this.contexts.get(extensionId);
    const config = await this.deps.readConfiguration(extensionId);
    if (!context?.messageId || !context.accountId || !config) return [];
    this.checkAccounts(config, [context.accountId]);
    {
      const sources = await this.deps.sources(context.messageId, context.accountId);
      if (this.contexts.get(extensionId) !== context) throw new Error('The selected message changed.');
      const descriptor = (s: ScanSource) => JSON.stringify([s.kind, s.partId, s.uid, s.folderPath, s.partFilename, s.displayName]);
      const previous = new Map(context.targets.map(t => [descriptor(t), t]));
      context.targets = sources.filter(s => s.kind === 'attachment' || config.allowBody).map(source => {
        if (source.accountId !== context.accountId || source.messageId !== context.messageId) throw new Error('The scan target belongs to another message.');
        return { ...source, extensionId, targetId: previous.get(descriptor(source))?.targetId ?? randomUUID(), generation: this.generation(extensionId) };
      });
    }
    return context.targets.map(({ targetId, kind, displayName, byteLength, unavailableReason }) =>
      ({ targetId, kind, displayName, byteLength, unavailableReason }));
  }

  private checkAccounts(config: ScannerConfiguration, accountIds: string[]): void {
    const existing = new Set(this.deps.accounts().map(a => a.id));
    if (accountIds.some(id => !existing.has(id) || !config.allowedAccountIds.includes(id))) {
      throw new Error('This account is removed or has not consented to scanner uploads.');
    }
  }
  private async assertCurrent(work: Work, ignoreAbort = false): Promise<void> {
    const current = await this.deps.readConfiguration(work.extensionId);
    if ((!ignoreAbort && work.abort.signal.aborted) || !current || work.generation !== this.generation(work.extensionId) ||
      current.endpoint !== work.config.endpoint || current.fingerprint !== work.config.fingerprint ||
      current.credential !== work.config.credential) throw new Error('Scanner consent was revoked or changed.');
    this.checkAccounts(current, work.targets.map(t => t.accountId));
    if (work.targets.some(t => t.kind === 'email-body') && !current.allowBody) throw new Error('Message text sharing is not enabled.');
  }
  private prune(): void {
    for (const [id, probe] of this.probes) if (probe.expires <= this.now()) this.probes.delete(id);
    for (const [id, work] of this.jobs) if (work.finishedAt !== undefined &&
      this.now() >= Math.min(work.finishedAt + 900_000, work.job.expiresAt ? timestamp(work.job.expiresAt) : Infinity)) this.jobs.delete(id);
  }

  async submit(extensionId: string, targetIds: string[], options?: { includeBodyConsent?: boolean }): Promise<AntivirusScanJob> {
    this.prune();
    const context = this.contexts.get(extensionId);
    const config = await this.deps.readConfiguration(extensionId);
    if (!config || !context || !Array.isArray(targetIds) || !targetIds.length || targetIds.length > config.capabilities.maxItems ||
      new Set(targetIds).size !== targetIds.length) throw new Error('Select a valid set of attachments to scan.');
    const targets = targetIds.map(id => context.targets.find(t => t.targetId === id && t.extensionId === extensionId));
    if (targets.some(t => !t || t.unavailableReason || t.generation !== this.generation(extensionId))) throw new Error('A scan target is unavailable or changed. Select it again.');
    const selected = targets as Target[];
    this.checkAccounts(config, selected.map(t => t.accountId));
    if (selected.some(t => t.kind === 'email-body') && (!config.allowBody || options?.includeBodyConsent !== true)) {
      throw new Error('Confirm message text sharing for this scan.');
    }
    const running = [...this.jobs.values()].filter(w => !terminal.has(w.job.state));
    if (running.length >= 4 || running.filter(w => w.extensionId === extensionId).length >= 2 || this.jobs.size >= 100) {
      throw new Error('The scan queue is full. Wait for a scan to finish.');
    }
    const job: AntivirusScanJob = { id: randomUUID(), state: 'preparing', createdAt: this.iso(), updatedAt: this.iso(),
      items: selected.map(t => ({ targetId: t.targetId, kind: t.kind, displayName: t.displayName, status: 'pending' })) };
    const work: Work = { job, extensionId, config, generation: this.generation(extensionId), targets: selected,
      abort: new AbortController(), transport: this.transport(config) };
    this.jobs.set(job.id, work);
    void this.run(work);
    return structuredClone(job);
  }

  private touch(work: Work, state: AntivirusScanJob['state']): void { work.job.state = state; work.job.updatedAt = this.iso(); }
  private async run(work: Work): Promise<void> {
    const held: Buffer[] = [];
    try {
      await this.assertCurrent(work);
      const cap = await work.transport.capabilities(work.abort.signal);
      if (consentFingerprint(cap) !== work.config.fingerprint) throw new Error('The scanner policy changed. Review setup before uploading.');
      const items: Array<{ clientItemId: string; kind: string; byteLength: number; sha256: string; content: Buffer }> = [];
      let total = 0;
      for (const target of work.targets) {
        await this.assertCurrent(work);
        const content = await this.deps.read(target, cap.maxItemBytes, work.abort.signal);
        held.push(content);
        if (!content.length || content.length > cap.maxItemBytes || (total += content.length) > cap.maxTotalBytes) throw new Error('Selected content exceeds the scanner limits.');
        items.push({ clientItemId: randomUUID(), kind: target.kind, byteLength: content.length,
          sha256: createHash('sha256').update(content).digest('hex'), content });
      }
      await this.assertCurrent(work);
      const created = object(await work.transport.request('/v1/scan-tickets', 'POST', JSON.stringify({
        items: items.map(({ clientItemId, kind, byteLength }) => ({ clientItemId, kind, byteLength })) }), work.abort.signal, [201], 15_000, randomUUID()));
      const ticketId = opaqueId(created.ticketId); work.ticketId = ticketId;
      const deadline = timestamp(created.contentDeadlineAt);
      if (created.status !== 'awaiting_upload' || deadline <= this.now() || deadline > this.now() + cap.contentLifetimeSeconds * 1000 + 5000 ||
        !Array.isArray(created.items) || created.items.length !== items.length || created.resultExpiresAt !== null) throw new Error('The scanner returned an invalid ticket.');
      const bindings = items.map(item => {
        const matches = created.items.filter((entry: any) => entry.clientItemId === item.clientItemId);
        if (matches.length !== 1) throw new Error('The scanner returned mismatched upload items.');
        const uploaded = object(matches[0]); const itemId = opaqueId(uploaded.itemId);
        const path = `/v1/scan-tickets/${ticketId}/items/${itemId}`;
        if (uploaded.uploadPath !== path) throw new Error('The scanner returned an unsafe upload destination.');
        return { ...item, itemId, path };
      });
      if (new Set(bindings.map(b => b.itemId)).size !== bindings.length) throw new Error('The scanner returned duplicate item identifiers.');
      this.touch(work, 'uploading');
      for (const item of bindings) {
        await this.assertCurrent(work);
        if (this.now() >= deadline) throw new Error('The scan ticket expired before upload.');
        await work.transport.request(item.path, 'PUT', item.content, work.abort.signal, [200, 204], deadline - this.now());
        item.content.fill(0);
      }
      await this.assertCurrent(work);
      const submitted = object(await work.transport.request(`/v1/scan-tickets/${ticketId}/submit`, 'POST', undefined, work.abort.signal, [202]));
      if (submitted.ticketId !== ticketId || submitted.status !== 'queued' || submitted.resultExpiresAt !== null || timestamp(submitted.contentDeadlineAt) !== deadline) throw new Error('The scanner returned an invalid submission.');
      this.touch(work, 'queued');
      for (;;) {
        await this.assertCurrent(work);
        if (this.now() >= deadline) throw new Error('The scan ticket deadline expired.');
        const ticket = object(await work.transport.request(`/v1/scan-tickets/${ticketId}`, 'GET', undefined, work.abort.signal));
        if (ticket.ticketId !== ticketId || timestamp(ticket.contentDeadlineAt) !== deadline || !Array.isArray(ticket.items) ||
          ticket.items.length !== bindings.length || !['awaiting_upload', 'queued', 'scanning', 'completed', 'failed', 'cancelled', 'expired'].includes(ticket.status)) {
          throw new Error('The scanner returned a mismatched ticket.');
        }
        const mapped = bindings.map((binding, index) => {
          const matches = ticket.items.filter((entry: any) => entry.itemId === binding.itemId && entry.clientItemId === binding.clientItemId);
          if (matches.length !== 1) throw new Error('The scanner returned missing or duplicate results.');
          const item = object(matches[0]);
          if (item.byteLength !== binding.byteLength || item.kind !== binding.kind) throw new Error('The scanner returned a result for different content.');
          if (!['pending', 'awaiting_upload', 'uploaded', 'queued', 'scanning', 'completed', 'failed', 'cancelled', 'expired'].includes(item.status)) throw new Error('The scanner returned an invalid item state.');
          const local = { ...work.job.items[index] };
          if (item.result == null) {
            local.status = ['failed', 'cancelled', 'expired'].includes(item.status) ? 'error' : 'pending';
            local.reason = local.status === 'error' ? 'This item was not scanned completely.' : undefined;
            if (['completed', 'failed'].includes(ticket.status) && local.status === 'pending') throw new Error('The scanner omitted a terminal item result.');
            return local;
          }
          const result = object(item.result);
          if (!['completed', 'failed'].includes(item.status)) throw new Error('The scanner returned a result before completing the item.');
          if (result.sha256 !== binding.sha256 || !/^[a-f0-9]{64}$/.test(result.sha256) ||
            !['no_threat_detected', 'threat_detected', 'incomplete', 'error'].includes(result.verdict)) throw new Error('The scanner verdict does not match the selected bytes.');
          validateEngine(result.engine, cap.engine.scanPolicyVersion, this.now());
          if (timestamp(result.completedAt) > this.now() + 300_000 || !Array.isArray(result.signatures) || result.signatures.length > 32 ||
            result.signatures.some((s: unknown) => typeof s !== 'string' || s.length > 512 || hasControlCharacters(s)) ||
            !Array.isArray(result.limitations) || result.limitations.length > 32 ||
            result.limitations.some((limit: unknown) => typeof limit !== 'string' || !/^[a-z0-9_]{1,128}$/.test(limit))) throw new Error('The scanner returned invalid verdict metadata.');
          const reason = object(result.reason);
          if (typeof reason.code !== 'string' || !/^[a-z0-9_]{1,128}$/.test(reason.code) || typeof reason.retryable !== 'boolean') {
            throw new Error('The scanner returned invalid reason metadata.');
          }
          if (result.verdict === 'no_threat_detected' && (item.status !== 'completed' || result.fullCoverage !== true || result.signatures.length || result.limitations.length || reason.code !== 'scan_completed')) {
            throw new Error('The scanner did not establish complete scan coverage.');
          }
          if (result.verdict === 'threat_detected' && (!result.signatures.length || reason.code !== 'signature_match')) throw new Error('The scanner omitted its detection signature.');
          if (['incomplete', 'error'].includes(result.verdict) && result.fullCoverage !== false) throw new Error('The scanner returned inconsistent coverage.');
          local.status = ({ no_threat_detected: 'no-threat-detected', threat_detected: 'threat-detected', incomplete: 'incomplete', error: 'error' } as const)[result.verdict as 'no_threat_detected'];
          const reasons: Record<string, string> = { scan_completed: 'ClamAV found no threat within the evaluated scan limits.',
            signature_match: 'ClamAV detected a threat. Avoid opening this item.', encrypted_archive: 'An encrypted archive could not be fully inspected.',
            scan_limit: 'A scanner processing limit prevented a complete scan.', coverage_unknown: 'Full scanner coverage could not be established.',
            stale_definitions: 'Scanner definitions were not current.', scan_timeout: 'The scanner timed out before finishing this item.',
            invalid_content: 'The scanner could not inspect this content.', engine_unavailable: 'The antivirus engine was unavailable.',
            scan_failed: 'The scanner could not finish this item.', ticket_deadline_expired: 'The scan ticket expired.', cancelled: 'The scan was cancelled.' };
          local.reason = Object.prototype.hasOwnProperty.call(reasons, reason.code) ? reasons[reason.code] :
            (result.verdict === 'incomplete' ? 'ClamAV could not inspect the complete content.' : 'Scan finished; see the verdict above.');
          local.signatures = result.signatures; local.sha256 = binding.sha256; local.bytes = binding.byteLength;
          local.engine = validateEngine(result.engine, cap.engine.scanPolicyVersion, this.now()); local.completedAt = result.completedAt;
          return local;
        });
        work.job.items = mapped;
        if (['completed', 'failed', 'cancelled', 'expired'].includes(ticket.status)) {
          const expires = timestamp(ticket.resultExpiresAt);
          if (expires <= this.now() || expires > this.now() + cap.resultLifetimeSeconds * 1000 + 5000) throw new Error('The scanner returned an invalid result expiry.');
          work.job.expiresAt = ticket.resultExpiresAt;
          this.touch(work, ({ completed: 'completed', failed: 'error', cancelled: 'cancelled', expired: 'expired' } as const)[ticket.status as 'completed']);
          break;
        }
        this.touch(work, ticket.status === 'scanning' ? 'scanning' : 'queued');
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(done, this.deps.pollMs ?? 750);
          const abort = () => { clearTimeout(timer); work.abort.signal.removeEventListener('abort', abort); reject(new Error('Scan cancelled.')); };
          function done() { work.abort.signal.removeEventListener('abort', abort); resolve(); }
          work.abort.signal.addEventListener('abort', abort, { once: true });
          if (work.abort.signal.aborted) abort();
        });
      }
    } catch (error) {
      if (work.job.state !== 'cancelled') {
        this.touch(work, work.abort.signal.aborted ? 'cancelled' : 'error');
        work.job.error = safeError(error);
        work.job.items = work.job.items.map(item => ({ ...item, status: 'error', reason: 'No usable verdict is available.' }));
      }
    } finally {
      for (const buffer of held) buffer.fill(0);
      work.finishedAt = this.now();
      if (work.ticketId) await work.transport.request(`/v1/scan-tickets/${work.ticketId}`, 'DELETE', undefined, undefined, [202, 204], 10_000).catch(() => {});
    }
  }

  async get(extensionId: string, jobId: string): Promise<AntivirusScanJob> {
    this.prune(); const work = this.jobs.get(jobId);
    if (!work || work.extensionId !== extensionId) throw new Error('Scan is unavailable or expired.');
    await this.assertCurrent(work, terminal.has(work.job.state));
    return structuredClone(work.job);
  }
  async cancel(extensionId: string, jobId: string): Promise<AntivirusScanJob> {
    const work = this.jobs.get(jobId);
    if (!work || work.extensionId !== extensionId) throw new Error('Scan is unavailable or expired.');
    if (!terminal.has(work.job.state)) {
      work.abort.abort(); this.touch(work, 'cancelled');
      work.job.items = work.job.items.map(item => ({ ...item, status: 'error', reason: 'Scan cancelled; no verdict.' }));
    }
    return structuredClone(work.job);
  }
  private async cancelExtensionWork(extensionId: string): Promise<void> {
    for (const work of this.jobs.values()) if (work.extensionId === extensionId && !terminal.has(work.job.state)) await this.cancel(extensionId, work.job.id);
  }
  async onExtensionDisabled(extensionId: string): Promise<void> {
    await this.cancelExtensionWork(extensionId);
    this.generations.set(extensionId, this.generation(extensionId) + 1);
    this.contexts.delete(extensionId);
    for (const [id, p] of this.probes) if (p.extensionId === extensionId) this.probes.delete(id);
    for (const [id, work] of this.jobs) if (work.extensionId === extensionId) this.jobs.delete(id);
    await this.deps.writeConfiguration(extensionId, undefined);
  }
  async onExtensionDeactivated(extensionId: string): Promise<void> { await this.cancelExtensionWork(extensionId); this.contexts.delete(extensionId); }
  async dispose(): Promise<void> { clearInterval(this.sweep); for (const work of this.jobs.values()) work.abort.abort(); this.contexts.clear(); this.probes.clear(); this.jobs.clear(); }
  async onAccountRemoved(accountId: string): Promise<void> {
    for (const work of this.jobs.values()) if (work.targets.some(t => t.accountId === accountId)) await this.cancel(work.extensionId, work.job.id);
    for (const [id, ctx] of this.contexts) if (ctx.accountId === accountId) this.contexts.delete(id);
  }
}

let service: AntivirusScanService | undefined;
export function initializeAntivirusScanService(deps: AntivirusDependencies): AntivirusScanService { return (service = new AntivirusScanService(deps)); }
export function getAntivirusScanService(): AntivirusScanService {
  if (!service) throw new Error('The antivirus service is not initialized.');
  return service;
}
export function peekAntivirusScanService(): AntivirusScanService | undefined { return service; }
