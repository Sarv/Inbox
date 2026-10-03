import { createHash } from 'node:crypto';

export interface ScannerCapabilities {
  protocolVersion: 1;
  engine: { name: 'ClamAV'; version: string; signatureVersion: string; signaturesUpdatedAt: string; scanPolicyVersion: string };
  operator: { name: string; region: string; privacyPolicyUrl: string; privacyTermsVersion: string };
  maxItemBytes: number;
  maxTotalBytes: number;
  maxItems: number;
  contentLifetimeSeconds: number;
  resultLifetimeSeconds: number;
  contentStorage: { mode: 'ephemeral'; noPersistentRetention: true };
  authenticationRetentionSeconds?: number;
}

export function scannerOrigin(value: string, allowDevelopmentLoopback = false): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Enter a valid scanner HTTPS URL.'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(allowDevelopmentLoopback && loopback && url.protocol === 'http:')) {
    throw new Error('Scanner connections require HTTPS. HTTP loopback is available only in the development app.');
  }
  if (url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    throw new Error('Use the scanner origin without credentials, a path, query, or fragment.');
  }
  return url.origin;
}

export function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('The scanner returned an invalid response.');
  return value as Record<string, any>;
}

export function hasControlCharacters(value: string): boolean {
  return Array.from(value).some(character => { const code = character.charCodeAt(0); return code < 32 || code === 127; });
}

function text(value: unknown, max = 128): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || hasControlCharacters(value)) {
    throw new Error('The scanner returned invalid metadata.');
  }
  return value;
}

function positive(value: unknown, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > max) {
    throw new Error('The scanner declared unsupported limits.');
  }
  return value as number;
}

export function timestamp(value: unknown): number {
  if (typeof value !== 'string' || value.length > 40 || !Number.isFinite(Date.parse(value))) {
    throw new Error('The scanner returned an invalid deadline.');
  }
  return Date.parse(value);
}

export function validateEngine(value: unknown, policy?: string, now = Date.now()): ScannerCapabilities['engine'] {
  const engine = object(value);
  if (engine.name !== 'ClamAV') throw new Error('This extension requires a ClamAV scanner.');
  const result = { name: 'ClamAV' as const, version: text(engine.version, 64), signatureVersion: text(engine.signatureVersion, 64),
    signaturesUpdatedAt: text(engine.signaturesUpdatedAt, 40), scanPolicyVersion: text(engine.scanPolicyVersion) };
  const updated = timestamp(result.signaturesUpdatedAt);
  if (updated > now + 300_000 || now - updated > 48 * 60 * 60 * 1000) {
    throw new Error('Scanner definitions are stale or their update time is invalid.');
  }
  if (policy && result.scanPolicyVersion !== policy) throw new Error('The scan policy changed. Review scanner setup again.');
  return result;
}

export function validateCapabilities(value: unknown, now = Date.now()): ScannerCapabilities {
  const input = object(value);
  if (input.protocolVersion !== 1) throw new Error('The scanner ticket protocol is not supported.');
  const operator = object(input.operator);
  const privacyPolicyUrl = text(operator.privacyPolicyUrl, 2048);
  const privacy = new URL(privacyPolicyUrl);
  if (privacy.protocol !== 'https:' || privacy.username || privacy.password) throw new Error('The scanner must disclose an HTTPS privacy policy.');
  const storage = object(input.contentStorage);
  if (storage.mode !== 'ephemeral' || storage.noPersistentRetention !== true) {
    throw new Error('The scanner does not declare memory based temporary content storage.');
  }
  return {
    protocolVersion: 1, engine: validateEngine(input.engine, undefined, now),
    operator: { name: text(operator.name, 160), region: text(operator.region, 128), privacyPolicyUrl,
      privacyTermsVersion: text(operator.privacyTermsVersion) },
    maxItemBytes: positive(input.maxItemBytes, 25 * 1024 * 1024), maxTotalBytes: positive(input.maxTotalBytes, 50 * 1024 * 1024),
    maxItems: positive(input.maxItems, 10), contentLifetimeSeconds: positive(input.contentLifetimeSeconds, 300),
    resultLifetimeSeconds: positive(input.resultLifetimeSeconds, 900), contentStorage: { mode: 'ephemeral', noPersistentRetention: true },
    authenticationRetentionSeconds: input.authenticationRetentionSeconds === undefined ? undefined :
      positive(input.authenticationRetentionSeconds, 365 * 86400),
  };
}

export function consentFingerprint(cap: ScannerCapabilities): string {
  return createHash('sha256').update(JSON.stringify({ operator: cap.operator, policy: cap.engine.scanPolicyVersion,
    maxItemBytes: cap.maxItemBytes, maxTotalBytes: cap.maxTotalBytes, maxItems: cap.maxItems,
    contentLifetimeSeconds: cap.contentLifetimeSeconds, resultLifetimeSeconds: cap.resultLifetimeSeconds,
    contentStorage: cap.contentStorage, authenticationRetentionSeconds: cap.authenticationRetentionSeconds })).digest('hex');
}

export function opaqueId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(value)) throw new Error('The scanner returned an invalid ticket identifier.');
  return value;
}

/** No redirects, custom TLS bypass, arbitrary returned URLs, or unbounded responses. */
export class ScannerTransport {
  constructor(readonly origin: string, private credential: string, private requestFetch: typeof fetch = fetch) {
    if (!credential || credential.length > 8192 || /\s/.test(credential) || hasControlCharacters(credential)) throw new Error('Enter a valid scanner API credential.');
  }

  async request(path: string, method = 'GET', body?: string | Uint8Array, signal?: AbortSignal,
    accepted: number[] = [200], timeoutMs = 15_000, idempotencyKey?: string): Promise<any> {
    if (!/^\/v1\/(scanner-capabilities|scan-tickets(?:\/[A-Za-z0-9_-]{32,128}(?:\/(?:submit|items\/[A-Za-z0-9_-]{32,128}))?)?)$/.test(path)) {
      throw new Error('The scanner returned an unsafe request path.');
    }
    const timeout = AbortSignal.timeout(Math.max(1, Math.min(timeoutMs, 90_000)));
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await this.requestFetch(this.origin + path, { method, body: body as BodyInit | undefined,
        headers: { Authorization: 'Bearer ' + this.credential,
          ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
          ...(body === undefined ? {} : { 'Content-Type': typeof body === 'string' ? 'application/json' : 'application/octet-stream' }) },
        redirect: 'error', signal: combined, cache: 'no-store' });
    } catch {
      throw new Error(signal?.aborted ? 'Scan cancelled.' : 'The scanner connection failed or timed out.');
    }
    if (!accepted.includes(response.status)) {
      await response.body?.cancel().catch(() => {});
      const messages: Record<number, string> = { 401: 'Scanner credential is invalid or expired.', 403: 'Scanner permission denied.',
        404: 'Scan ticket expired or is unavailable.', 408: 'Scanner upload timed out.', 410: 'Scan ticket expired.',
        413: 'Selected content exceeds the scanner limit.', 429: 'Scanner quota reached. Try again later.', 503: 'Scanner is busy or unavailable.' };
      throw new Error(messages[response.status] ?? 'The scanner could not complete this request.');
    }
    if (response.status === 204) return null;
    const reader = response.body?.getReader();
    if (!reader) throw new Error('The scanner returned no result.');
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) {
        const part = await reader.read(); if (part.done) break;
        size += part.value.length;
        if (size > 256 * 1024) { await reader.cancel(); throw new Error('The scanner response exceeded the limit.'); }
        chunks.push(part.value);
      }
    } catch { throw new Error('The scanner response was incomplete or exceeded the limit.'); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new Error('The scanner returned no usable result.'); }
  }

  async capabilities(signal?: AbortSignal): Promise<ScannerCapabilities> {
    return validateCapabilities(await this.request('/v1/scanner-capabilities', 'GET', undefined, signal));
  }
}
