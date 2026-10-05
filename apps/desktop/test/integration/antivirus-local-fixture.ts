/** Credentials for the opt-in, local, synthetic scanner integration only. */
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

const localHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
const fixtureMarker = 'inbox-av-ci-only-v1';

function jsonObject(text: string): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw new Error('Synthetic scanner credential or authentication metadata is invalid.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Synthetic scanner credential or authentication metadata is invalid.');
  }
  return value as Record<string, unknown>;
}

function localOrigin(value: string, dockerHost = false): string {
  const url = new URL(value);
  if (url.protocol !== 'http:' || (!localHosts.has(url.hostname) && !(dockerHost && url.hostname === 'host.docker.internal')) ||
    url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    throw new Error('Synthetic scanner tests require an explicit local HTTP origin.');
  }
  return url.origin;
}

async function privateText(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error('Supply an absolute path to the private synthetic credential file.');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size > 65_536 || (metadata.mode & 0o077) !== 0) {
      throw new Error('Synthetic credential files must be regular, private files of at most 64 KiB.');
    }
    return await file.readFile('utf8');
  } finally {
    await file.close();
  }
}

async function request(origin: string, path: string, credential: string, method = 'GET', body?: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(origin + path, {
    method, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15_000),
    headers: { Authorization: 'Bearer ' + credential, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error('Synthetic scanner authentication or credential cleanup failed.');
  }
  if (response.status === 204) return {};
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Synthetic scanner returned no authentication metadata.');
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    length += part.value.length;
    if (length > 16_384) {
      await reader.cancel();
      throw new Error('Synthetic scanner authentication metadata exceeded the limit.');
    }
    chunks.push(part.value);
  }
  return jsonObject(Buffer.concat(chunks).toString('utf8'));
}

function scanKey(value: unknown): string {
  if (typeof value !== 'string' || !/^iv_[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new Error('Supply a private iv_ scanning key for the synthetic local account.');
  }
  return value;
}

async function assertSyntheticAccount(origin: string, credential: string): Promise<void> {
  const profile = await request(origin, '/api/v1/users/me', credential);
  if (typeof profile.email !== 'string' || !/^[^\s@]+@[^\s@]+\.invalid$/i.test(profile.email)) {
    throw new Error('Synthetic scanner integration refuses credentials belonging to a real user.');
  }
}

export interface LocalScannerFixture {
  origin: string;
  credential: string;
  cleanup(): Promise<void>;
}

/** No profile files, mailbox state, real Sarv login, or normal server .env is read. */
export async function localScannerFixture(env: NodeJS.ProcessEnv = process.env): Promise<LocalScannerFixture> {
  if (env.INBOX_AV_SYNTHETIC !== '1') throw new Error('Enable the synthetic integration explicitly.');
  const origin = localOrigin(env.INBOX_AV_TEST_ORIGIN || 'http://127.0.0.1:' + (env.API_PORT || '8080'));
  const configured = [env.INBOX_AV_SCAN_KEY_FILE, env.INBOX_AV_SCAN_KEY, env.INBOX_AV_SYNTHETIC_TOKENS_FILE]
    .filter(value => value !== undefined && value !== '').length;
  if (configured > 1) throw new Error('Supply exactly one synthetic scanning credential source.');

  if (env.INBOX_AV_SCAN_KEY_FILE || env.INBOX_AV_SCAN_KEY) {
    const credential = scanKey((env.INBOX_AV_SCAN_KEY_FILE ? await privateText(env.INBOX_AV_SCAN_KEY_FILE) : env.INBOX_AV_SCAN_KEY)?.trim());
    await assertSyntheticAccount(origin, credential);
    return { origin, credential, cleanup: async () => {} };
  }

  if (env.INBOX_AV_SYNTHETIC_TOKENS_FILE) {
    const tokens = jsonObject(await privateText(env.INBOX_AV_SYNTHETIC_TOKENS_FILE));
    if (tokens.fixture !== fixtureMarker || typeof tokens.issuer !== 'string' || typeof tokens.scanner !== 'string') {
      throw new Error('Only the isolated CI Sarv fixture token file is supported.');
    }
    const issuer = localOrigin(tokens.issuer, true);
    const components = tokens.scanner.split('.');
    if (components.length !== 3) throw new Error('Synthetic fixture access token is invalid.');
    const header = jsonObject(Buffer.from(components[0], 'base64url').toString('utf8'));
    const claims = jsonObject(Buffer.from(components[1], 'base64url').toString('utf8'));
    if (header.alg !== 'RS256' || header.typ !== 'at+jwt' || claims.iss !== issuer ||
      typeof claims.sub !== 'string' || !claims.sub.startsWith('ci-') ||
      typeof claims.email !== 'string' || !claims.email.endsWith('.invalid')) {
      throw new Error('Synthetic fixture token must contain only local CI identities.');
    }
    // The scanner verifies the signature, issuer and exact client binding. The
    // checks above only prevent accidentally sending a real user credential.
    await assertSyntheticAccount(origin, tokens.scanner);
    const issued = await request(origin, '/api/v1/tokens', tokens.scanner, 'POST', {
      name: 'extension-synthetic-download-test', expiresInDays: 1,
    });
    if (typeof issued.id !== 'string' || !/^[a-f0-9-]{36}$/.test(issued.id)) throw new Error('Synthetic scanner returned an invalid key identifier.');
    const cleanup = async () => { await request(origin, '/api/v1/tokens/' + issued.id, tokens.scanner as string, 'DELETE'); };
    try {
      const credential = scanKey(issued.token);
      await assertSyntheticAccount(origin, credential);
      return { origin, credential, cleanup };
    } catch (error) {
      await cleanup();
      throw error;
    }
  }

  // Optional compatibility with the scanner-only Keycloak test profile. It is
  // never inferred merely from a normal server environment being present.
  if (env.INBOX_AV_TEST_AUTH === 'keycloak') {
    const issuer = new URL(env.OIDC_ISSUER_URI || 'http://localhost:18081/realms/inbox');
    if (issuer.protocol !== 'http:' || !localHosts.has(issuer.hostname) || issuer.username || issuer.password || issuer.search || issuer.hash ||
      !/^\/realms\/[A-Za-z0-9_-]+\/?$/.test(issuer.pathname)) throw new Error('Synthetic Keycloak test requires a local realm.');
    const secret = env.INBOX_SERVICE_CLIENT_SECRET;
    if (!secret) throw new Error('Supply the private synthetic Keycloak service credential.');
    const response = await fetch(issuer.href.replace(/\/$/, '') + '/protocol/openid-connect/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, redirect: 'error', signal: AbortSignal.timeout(15_000),
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: 'inbox-service', client_secret: secret }),
    });
    if (!response.ok) throw new Error('Synthetic Keycloak authentication failed.');
    const value = await response.json() as Record<string, unknown>;
    if (typeof value.access_token !== 'string' || value.access_token.length > 8192 || /\s/.test(value.access_token)) {
      throw new Error('Synthetic Keycloak returned an invalid credential.');
    }
    return { origin, credential: value.access_token, cleanup: async () => {} };
  }
  throw new Error('Supply a private synthetic iv_ key file or isolated Sarv CI token file.');
}
