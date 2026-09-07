// Sarv CAI catalog API — renderer-side.
//
// We deliberately DON'T runtime-import from `@sarvinbox/core` here: that
// package's barrel re-exports imapflow / nodemailer / agent pipeline
// code, which drags Node's `events` module into the renderer bundle and
// breaks Vite's ESM loader (see "Dynamic require of 'events' is not
// supported" errors).
//
// Types mirror `@sarvinbox/core/oauth/sarv-catalog` — if those drift, fix
// here. Fetch logic is small enough that duplicating it is cheaper than
// making core safe to import from the renderer.

// Normalized shapes the UI consumes. `code` maps to whatever the server
// calls the stable identifier (some endpoints use `id`, others `code`);
// the wrapper normalizes either into `code` so consumers don't care.
export interface SarvLLMProvider {
  code: string;
  name: string;
}

export interface SarvLLMModel {
  code: string;
  display_name?: string | null;
  provider_code: string;
  supports_streaming?: boolean;
}

export interface SarvZone {
  code: string;
  name?: string | null;
  country?: string | null;
  city?: string | null;
  /** Edge gateway base URL for LLM/TTS/STT calls in this zone. */
  api_domain?: string | null;
  is_default?: boolean;
}

// Raw wire shapes from `/api/v1/agent-models/llm/*` (what the dashboard
// currently uses). Older endpoint family, session- or Bearer-authenticated.
interface RawProvider {
  id?: string;
  code?: string;
  name?: string;
  display_name?: string;
}

interface RawModel {
  id?: string;
  code?: string;
  name?: string;
  display_name?: string;
  provider_id?: string;
  provider_code?: string;
  supports_streaming?: boolean;
}

interface RawZone {
  id?: string;
  code?: string;
  name?: string;
  country?: string;
  city?: string;
  api_domain?: string;
  is_default?: boolean;
}

export interface SarvApiErrorShape extends Error {
  status: number;
  code: string;
  retryAfterSec?: number;
  detail?: unknown;
}

async function freshBearer(email: string): Promise<string> {
  const res = await window.electronAPI.oauth.getAccessToken('sarv', email);
  if (!res.success || !res.data) {
    throw new Error(res.error || 'Failed to get Sarv access token');
  }
  return res.data.accessToken;
}

async function getJson<T>(url: string, accessToken: string): Promise<T> {
  console.log('[sarv-cai-api] GET', url);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      signal: controller.signal,
    });
  } catch (err) {
    const e = err as Error;
    // AbortController.abort(), CORS failures, and DNS/connection refused
    // all end up here. Make the message specific enough to diagnose.
    const hint = e.name === 'AbortError'
      ? ` (timed out after 15s — server unreachable or hung)`
      : e.message.includes('Failed to fetch')
        ? ` (CORS blocked or connection refused — check the API server is running and allows Origin ${window.location.origin})`
        : '';
    throw new Error(`${e.message}${hint} → ${url}`);
  } finally {
    clearTimeout(timeout);
  }
  console.log('[sarv-cai-api]', url, '→', res.status);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let code = String(res.status);
    let message = `Sarv API ${res.status}`;
    try {
      const body = JSON.parse(text);
      // FastAPI's `detail` can be three shapes:
      //   - "human string"                                            (most 4xx)
      //   - {error, error_description, message, required_scopes, ...} (oauth)
      //   - [{loc, msg, ...}, ...]                                    (422)
      // Pick the human string out of each so we don't end up with
      // "[object Object]" interpolated into the user-facing toast.
      const pickStr = (v: unknown): string | null => {
        if (typeof v === 'string' && v.trim()) return v;
        if (Array.isArray(v)) {
          const parts = v.map((d: any) => (typeof d === 'string' ? d : d?.msg)).filter(Boolean);
          return parts.length ? parts.join('; ') : null;
        }
        if (v && typeof v === 'object') {
          const o = v as any;
          return o.error_description || o.message || o.error || null;
        }
        return null;
      };
      // The machine-readable code sits INSIDE `detail` for the oauth shape
      // (`{detail: {error: 'insufficient_scope', …}}`) — reading only the top
      // level left every catalog 403 reported as the bare status, which is the
      // one thing that cannot tell a missing scope from a missing CAI account.
      const payload = (body && typeof body.detail === 'object' && body.detail) || body;
      code = payload?.error || payload?.code || body.error || body.code || code;
      message =
        pickStr(body.error_description) ||
        pickStr(body.message) ||
        pickStr(body.detail) ||
        message;
    } catch {
      // non-JSON body — keep defaults
    }
    const err: SarvApiErrorShape = Object.assign(
      new Error(`${message} → ${url}${text ? ` (${text.slice(0, 200)})` : ''}`),
      { status: res.status, code, detail: text },
    );
    // Log the REASON, not just the status. Only `→ 403` reached app.log before,
    // and a 403 here is three different problems with three different fixes:
    // `insufficient_scope` (the token was never granted llm:view — re-authorize),
    // `cai_account_required` (signed in, but no CAI account — onboarding), and
    // `invalid_token`. Without the code, "the AI stopped working" is
    // undiagnosable from the log, which is exactly where it was last time.
    console.warn('[sarv-cai-api]', url, '→', res.status, `code=${code}`, message);
    throw err;
  }
  return (await res.json()) as T;
}

function trimBase(u: string): string {
  return u.replace(/\/$/, '');
}

function normalizeProvider(p: RawProvider): SarvLLMProvider {
  return {
    code: p.code || p.id || '',
    name: p.name || p.display_name || p.code || p.id || '',
  };
}

function normalizeModel(m: RawModel): SarvLLMModel {
  return {
    code: m.code || m.id || '',
    display_name: m.display_name || m.name || null,
    provider_code: m.provider_code || m.provider_id || '',
    supports_streaming: m.supports_streaming,
  };
}

function unwrapArray<T>(body: unknown): T[] {
  if (Array.isArray(body)) return body as T[];
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>;
    for (const key of ['data', 'providers', 'models', 'zones', 'items', 'results']) {
      if (Array.isArray(b[key])) return b[key] as T[];
    }
  }
  return [];
}

// The Sarv CAI API exposes OAuth-JWT-authenticated catalog endpoints under
// `/oauth/v1/*`; our OAuth access_token is only accepted there (the routes
// require the `llm:view` scope), not on the session-authenticated paths the
// web dashboard uses.
//
// Zone-aware filtering: dashboard calls pass zone_id in the query string
// to scope the catalog to a specific region. The OAuth surface accepts
// zone_code the same way — server ignores it if zone-filtering isn't
// wired yet, which is a safe forward-compat posture.

function qsFrom(params: Record<string, string | undefined>): string {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== '');
  if (entries.length === 0) return '';
  const sp = new URLSearchParams();
  for (const [k, v] of entries) sp.set(k, String(v));
  return `?${sp.toString()}`;
}

export async function listCaiProviders(
  apiBaseUrl: string,
  email: string,
  zoneCode?: string,
): Promise<SarvLLMProvider[]> {
  const token = await freshBearer(email);
  const body = await getJson<unknown>(
    `${trimBase(apiBaseUrl)}/oauth/v1/llm/providers${qsFrom({ zone_code: zoneCode })}`,
    token,
  );
  return unwrapArray<RawProvider>(body).map(normalizeProvider);
}

export async function listCaiModels(
  apiBaseUrl: string,
  email: string,
  providerCode?: string,
  zoneCode?: string,
): Promise<SarvLLMModel[]> {
  const token = await freshBearer(email);
  const body = await getJson<unknown>(
    `${trimBase(apiBaseUrl)}/oauth/v1/llm/models${qsFrom({
      provider_code: providerCode,
      zone_code: zoneCode,
    })}`,
    token,
  );
  return unwrapArray<RawModel>(body).map(normalizeModel);
}

export async function listCaiZones(
  apiBaseUrl: string,
  email: string,
): Promise<SarvZone[]> {
  const token = await freshBearer(email);
  const body = await getJson<unknown>(
    `${trimBase(apiBaseUrl)}/oauth/v1/zones`,
    token,
  );
  return unwrapArray<RawZone>(body).map((z) => ({
    code: z.code || z.id || '',
    name: z.name || null,
    country: z.country || null,
    city: z.city || null,
    api_domain: z.api_domain || null,
    is_default: Boolean(z.is_default),
  }));
}

/**
 * Pick the zone Sarv Inbox should use by default: the one flagged
 * `is_default`, falling back to the first zone. Returns `null` if the
 * user has no zones at all.
 *
 * A `null` here is NORMAL, not a failure — zones are organization-scoped on
 * the Sarv side, so a personal CAI account (credits, no org) legitimately
 * has none and `/oauth/v1/zones` answers 403. See `buildSarvEdgeBaseUrl`.
 */
export function pickDefaultZone(zones: SarvZone[]): SarvZone | null {
  if (zones.length === 0) return null;
  return zones.find((z) => z.is_default) || zones[0];
}

export interface SarvZoneSelection {
  zones: SarvZone[];
  /** '' when the account has no zones — a normal state, not a failure. */
  zoneCode: string;
}

/**
 * Best-effort zone lookup for an account. NEVER rejects.
 *
 * `/oauth/v1/zones` is the one org-gated endpoint in the CAI catalog, so an
 * account with credits but no organization membership gets a 403 here. That
 * must not stop the LLM catalog from loading: the zone only ever supplied
 * `api_domain` (which has an env fallback) and `zone_code` is an optional
 * filter on the providers/models endpoints. Treating this failure as fatal
 * is what left such accounts signed in with zero AI providers.
 *
 * Both the onboarding step and Settings go through here, so they cannot
 * drift on which failures are fatal.
 */
export async function loadZoneSelection(
  apiBaseUrl: string,
  email: string,
): Promise<SarvZoneSelection> {
  try {
    const zones = await listCaiZones(apiBaseUrl, email);
    return { zones, zoneCode: pickDefaultZone(zones)?.code ?? '' };
  } catch (err) {
    // Still non-fatal (see above), but no longer INVISIBLE. A 403 with
    // `insufficient_scope` here means the token lacks llm:view, which will also
    // fail providers/models — i.e. the whole AI catalog, not just zones. That is
    // worth one line in the log to tell apart from the ordinary org-scoped 403.
    console.warn('[sarv-cai-api] zone lookup failed (non-fatal):', (err as Error).message);
    return { zones: [], zoneCode: '' };
  }
}

/**
 * Sarv's recommended default: `sarv_partners` (Sarv's hosting of
 * GPT-OSS-120B, fine-tuned for this product). Onboarding and Settings must
 * default to the SAME thing, so the codes live here rather than in either
 * component — they had drifted already (Settings defaulted to whatever the
 * catalog happened to list first).
 */
export const RECOMMENDED_SARV_PROVIDER = 'sarv_partners';
export const RECOMMENDED_SARV_MODEL = 'gpt-oss-120b';

/** The entry with this `code`, else the first one, else `undefined`. */
function preferByCode<T extends { code: string }>(list: T[], code: string): T | undefined {
  return list.find((entry) => entry.code === code) ?? list[0];
}

export function pickRecommendedProvider(
  providers: SarvLLMProvider[],
): SarvLLMProvider | undefined {
  return preferByCode(providers, RECOMMENDED_SARV_PROVIDER);
}

export function pickRecommendedModel(
  models: SarvLLMModel[],
  providerCode: string,
): SarvLLMModel | undefined {
  // Only sarv_partners has a fine-tuned model worth preferring; every other
  // provider gets whatever the catalog listed first.
  return providerCode === RECOMMENDED_SARV_PROVIDER
    ? preferByCode(models, RECOMMENDED_SARV_MODEL)
    : models[0];
}

/**
 * The edge-gateway base URL to register a Sarv LLM provider against.
 *
 * A zone's `api_domain` is the preferred source, but zones are
 * ORGANIZATION-scoped: an account with CAI credits but no org membership
 * gets a 403 from `/oauth/v1/zones` and so has no zone at all. The
 * env-configured fallback is therefore a REAL code path that has to keep
 * such an account working end to end — not a mid-upgrade safety net.
 *
 * Returns '' when neither source is available; callers must treat that as
 * "cannot register a provider" rather than building a broken URL.
 */
export function buildSarvEdgeBaseUrl(
  zoneApiDomain: string | null | undefined,
  fallbackEdgeBaseUrl: string | null | undefined,
): string {
  const root = zoneApiDomain || (fallbackEdgeBaseUrl ?? '').replace(/\/edge\/v1\/llm\/?$/, '');
  const trimmed = root.replace(/\/+$/, '');
  return trimmed ? `${trimmed}/edge/v1/llm` : '';
}
