import { describe, expect, it, vi } from 'vitest';

import { ScannerTransport, consentFingerprint, scannerOrigin, validateCapabilities, validateEngine } from '../../../../electron/services/antivirus-transport';

const now = Date.now();
const capabilities = () => ({
  protocolVersion: 1,
  engine: { name: 'ClamAV', version: '1.5.4', signatureVersion: '123', signaturesUpdatedAt: new Date(now).toISOString(), scanPolicyVersion: 'policy-1' },
  operator: { name: 'Synthetic test scanner', region: 'Local machine', privacyPolicyUrl: 'https://scanner.test/privacy', privacyTermsVersion: 'privacy-1' },
  maxItemBytes: 25 * 1024 * 1024, maxTotalBytes: 50 * 1024 * 1024, maxItems: 10,
  contentLifetimeSeconds: 300, resultLifetimeSeconds: 900,
  contentStorage: { mode: 'ephemeral', noPersistentRetention: true }, authenticationRetentionSeconds: 86400,
});

describe('scanner endpoint and disclosure validation', () => {
  it('permits HTTP loopback only when the development host opts in', () => {
    expect(scannerOrigin('http://127.0.0.1:8080', true)).toBe('http://127.0.0.1:8080');
    expect(scannerOrigin('http://[::1]:8080/', true)).toBe('http://[::1]:8080');
    expect(() => scannerOrigin('http://127.0.0.1:8080')).toThrow(/HTTPS/);
    expect(() => scannerOrigin('http://scanner.test', true)).toThrow(/HTTPS/);
    expect(scannerOrigin('https://scanner.test/')).toBe('https://scanner.test');
  });

  it.each(['https://user:secret@scanner.test', 'https://scanner.test/v1', 'https://scanner.test/?key=x', 'https://scanner.test/#x'])('rejects embedded credentials and arbitrary address components: %s', endpoint => {
    expect(() => scannerOrigin(endpoint)).toThrow(/origin/);
  });

  it('requires explicit ephemeral storage, bounded limits, current definitions, and an HTTPS privacy policy', () => {
    expect(validateCapabilities(capabilities(), now).contentStorage.noPersistentRetention).toBe(true);
    expect(() => validateCapabilities({ ...capabilities(), contentStorage: { mode: 'disk', noPersistentRetention: false } }, now)).toThrow(/storage/);
    expect(() => validateCapabilities({ ...capabilities(), maxItemBytes: 25 * 1024 * 1024 + 1 }, now)).toThrow(/limits/);
    expect(() => validateCapabilities({ ...capabilities(), operator: { ...capabilities().operator, privacyPolicyUrl: 'http://scanner.test/privacy' } }, now)).toThrow(/HTTPS/);
    expect(() => validateEngine({ ...capabilities().engine, signaturesUpdatedAt: new Date(now - 49 * 3600_000).toISOString() }, undefined, now)).toThrow(/stale/);
    expect(() => validateEngine({ ...capabilities().engine, scanPolicyVersion: 'changed' }, 'policy-1', now)).toThrow(/policy/);
  });

  it('refreshing definitions preserves consent, while privacy, retention, and policy changes invalidate it', () => {
    const initial = validateCapabilities(capabilities(), now);
    expect(consentFingerprint({ ...initial, engine: { ...initial.engine, signatureVersion: '124' } })).toBe(consentFingerprint(initial));
    expect(consentFingerprint({ ...initial, authenticationRetentionSeconds: 172800 })).not.toBe(consentFingerprint(initial));
    expect(consentFingerprint({ ...initial, operator: { ...initial.operator, privacyTermsVersion: 'privacy-2' } })).not.toBe(consentFingerprint(initial));
    expect(consentFingerprint({ ...initial, engine: { ...initial.engine, scanPolicyVersion: 'policy-2' } })).not.toBe(consentFingerprint(initial));
  });
});

describe('scanner transport', () => {
  it('keeps the credential in the authorization header and rejects redirects', async () => {
    const request = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ okay: true })));
    const transport = new ScannerTransport('https://scanner.test', 'synthetic-test-key', request as typeof fetch);
    await expect(transport.request('/v1/scanner-capabilities')).resolves.toEqual({ okay: true });
    expect(request).toHaveBeenCalledWith('https://scanner.test/v1/scanner-capabilities', expect.objectContaining({
      redirect: 'error', cache: 'no-store', headers: { Authorization: 'Bearer synthetic-test-key' },
    }));
    expect(request.mock.calls[0]?.[0]).not.toContain('synthetic-test-key');
    await expect(transport.request('https://elsewhere.test/upload')).rejects.toThrow(/unsafe/);
    await expect(transport.request('/v1/scan-tickets/../secret')).rejects.toThrow(/unsafe/);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('never exposes server error bodies or underlying request details', async () => {
    const transport = new ScannerTransport('https://scanner.test', 'synthetic-test-key', vi.fn(async () => new Response('private body and token', { status: 401 })) as typeof fetch);
    await expect(transport.request('/v1/scanner-capabilities')).rejects.toThrow('Scanner credential is invalid or expired.');
    const failing = new ScannerTransport('https://scanner.test', 'synthetic-test-key', vi.fn(async () => { throw new Error('authorization synthetic-test-key'); }) as typeof fetch);
    await expect(failing.request('/v1/scanner-capabilities')).rejects.toThrow('The scanner connection failed or timed out.');
  });

  it('rejects oversized or truncated JSON and accepts a bodyless 204', async () => {
    const large = new ScannerTransport('https://scanner.test', 'synthetic-test-key', vi.fn(async () => new Response('x'.repeat(256 * 1024 + 1))) as typeof fetch);
    await expect(large.request('/v1/scanner-capabilities')).rejects.toThrow(/exceeded/);
    const invalid = new ScannerTransport('https://scanner.test', 'synthetic-test-key', vi.fn(async () => new Response('{')) as typeof fetch);
    await expect(invalid.request('/v1/scanner-capabilities')).rejects.toThrow(/usable/);
    const empty = new ScannerTransport('https://scanner.test', 'synthetic-test-key', vi.fn(async () => new Response(null, { status: 204 })) as typeof fetch);
    await expect(empty.request('/v1/scanner-capabilities', 'DELETE', undefined, undefined, [204])).resolves.toBeNull();
  });
});
