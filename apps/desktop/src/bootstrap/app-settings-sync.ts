/**
 * App-settings durability bootstrap — MUST be the very first import in main.tsx,
 * before the store/App (and every synchronous `localStorage` settings reader)
 * loads.
 *
 * Common app-level settings (the `sarvinbox-settings` blob incl. signatures,
 * view mode, AI config, UI prefs) historically lived ONLY in localStorage, so a
 * cleared/corrupt profile silently wiped them — "my signature is gone". This
 * module makes the core DB (`sarvinbox-core.db`, main-owned) the durable source
 * of truth for those settings while keeping localStorage as the fast, synchronous
 * read cache the rest of the app already uses:
 *
 *   1. RESTORE  — on boot, any managed key missing from localStorage but present
 *      in the DB is written back into localStorage (byte-for-byte), so the
 *      existing sync readers just work.
 *   2. MIGRATE  — any managed key present in localStorage but not yet in the DB
 *      is pushed to the DB (first-run migration for existing users).
 *   3. SEED     — on a truly fresh profile (no settings anywhere) the default
 *      settings blob is written to BOTH, so the DB is created with sane defaults.
 *   4. MIRROR   — `localStorage.setItem`/`removeItem` are wrapped so every future
 *      write to a managed key is mirrored to the DB automatically (single point,
 *      covers every writer without touching call sites).
 *
 * Secrets and the account registry are handled elsewhere (vault / account_registry)
 * and are deliberately NOT managed here.
 */
import { defaultSettings } from '../components/settings/types';

// localStorage keys whose values are durable app settings. Deliberately EXCLUDED:
//   - secrets: 'sarvinbox-credentials', 'sarvinbox-smtp-credentials' (→ vault)
//   - account registry: 'sarvinbox-accounts', 'sarvinbox-active-account',
//     'sarvinbox-smtp-configured' (→ account_registry table / per-account)
const MANAGED_KEYS = [
  'sarvinbox-settings',              // the big blob: signatures, inbox, images, profile…
  'sarvinbox-appearance',            // theme, accent, font, density, zoom (src/appearance/)
  'sarvinbox-view-mode',
  'sarvinbox-agent-config',          // AI Assist / agent runtime config
  'sarvinbox-agent-config-version',
  'sarvinbox-ai-settings',           // AI provider settings (API keys stripped → vault)
  'sarvinbox-ai-features',           // AI feature toggles
  'sarvinbox-categorization-prompts',// user's custom AI categorization prompts
  'sarvinbox-keyboard-shortcuts',    // custom keyboard shortcut overrides
  'sarvinbox-collapsed-sections',
  'sarvinbox-skip-discard-confirm',
  'sarvinbox-onboarding-complete',
  'sarvinbox-user-email',
] as const;

const MANAGED = new Set<string>(MANAGED_KEYS);

type SettingsApi = {
  getAllSync: () => Record<string, string>;
  set: (key: string, value: string) => Promise<unknown>;
  delete: (key: string) => Promise<unknown>;
};

function getApi(): SettingsApi | null {
  const api = (window as any)?.electronAPI?.appSettings;
  return api && typeof api.getAllSync === 'function' ? (api as SettingsApi) : null;
}

/** Reconcile localStorage <-> DB once, then install the write mirror. */
function initAppSettingsSync(): void {
  const api = getApi();
  if (!api) return; // web build / API unavailable → localStorage-only, as before.

  // Native setters, captured BEFORE we wrap them, so restore/migrate below don't
  // recurse through the mirror.
  const nativeSet = localStorage.setItem.bind(localStorage);
  const nativeRemove = localStorage.removeItem.bind(localStorage);

  let dbValues: Record<string, string> = {};
  try { dbValues = api.getAllSync() || {}; } catch { dbValues = {}; }

  for (const key of MANAGED_KEYS) {
    const lsVal = localStorage.getItem(key);
    const dbVal = dbValues[key];

    if (lsVal == null && dbVal != null) {
      // RESTORE: localStorage lost it, the DB still has it.
      try { nativeSet(key, dbVal); } catch { /* ignore */ }
    } else if (lsVal != null && dbVal == null) {
      // MIGRATE: existing user's localStorage value → durable DB.
      void api.set(key, lsVal);
    } else if (lsVal != null && dbVal != null && lsVal !== dbVal) {
      // Both present but diverged (e.g. a DB write failed on a prior run).
      // localStorage is what the user last saw at runtime — treat it as
      // authoritative and re-push so the DB catches up.
      void api.set(key, lsVal);
    }
  }

  // SEED defaults on a fresh profile: no settings blob anywhere → create it in
  // both, so the core DB is created with sane defaults.
  if (localStorage.getItem('sarvinbox-settings') == null && dbValues['sarvinbox-settings'] == null) {
    try {
      const raw = JSON.stringify(defaultSettings);
      nativeSet('sarvinbox-settings', raw);
      void api.set('sarvinbox-settings', raw);
    } catch { /* ignore */ }
  }

  // MIRROR every future write to a managed key into the DB. One interception
  // point covers all writers (Settings tabs, EmailList, onboarding, …).
  localStorage.setItem = function patchedSetItem(key: string, value: string): void {
    nativeSet(key, value);
    if (MANAGED.has(key)) { try { void api.set(key, value); } catch { /* ignore */ } }
    if (key === 'sarvinbox-settings') { pushBacklogCap(value); pushSenderIdentityPolicy(value); }
  };
  localStorage.removeItem = function patchedRemoveItem(key: string): void {
    nativeRemove(key);
    if (MANAGED.has(key)) { try { void api.delete(key); } catch { /* ignore */ } }
  };
}

/**
 * Mirror the user's "AI Processing Limit" into the main process.
 *
 * The background AI poll runs in main and needs this number to size its
 * newest-N window, but the setting lives here in localStorage. Without this
 * push the window stayed at its hardcoded default: a user who raised the limit
 * to "All" saw the manual run's batch size change and nothing else, while
 * hundreds of fully-eligible older emails stayed outside a window their setting
 * could not move.
 *
 * Fired from the setItem mirror (so every writer is covered) and once at boot.
 * Best-effort — a failed push just leaves the last persisted value in place.
 */
function pushBacklogCap(rawSettings: string | null): void {
  try {
    const cap = rawSettings ? JSON.parse(rawSettings)?.maxAIProcessingEmails : undefined;
    if (typeof cap !== 'number') return;
    void (window as any)?.electronAPI?.ai?.setBacklogCap?.(cap);
  } catch { /* a malformed settings blob must not break boot */ }
}

/**
 * Mirror the sender-identity toggles (BIMI logos, domain favicons) into main,
 * which owns the lookups and the cache. Off must mean off — no fetch, and
 * nothing cached shown — so main has to know, and the renderer's own identity
 * cache is cleared once main has acknowledged the change.
 */
function pushSenderIdentityPolicy(rawSettings: string | null): void {
  try {
    const parsed = rawSettings ? JSON.parse(rawSettings) : null;
    if (!parsed || typeof parsed !== 'object') return;
    const logos = typeof parsed.senderLogos === 'boolean' ? parsed.senderLogos : true;
    const favicons = typeof parsed.senderFavicons === 'boolean' ? parsed.senderFavicons : true;
    const api = (window as any)?.electronAPI?.identity;
    if (!api?.setPolicy) return;
    void Promise.resolve(api.setPolicy({ logos, favicons })).then(() => {
      window.dispatchEvent(new Event('sarvinbox:identity-policy-changed'));
    }).catch(() => { /* best-effort */ });
  } catch { /* a malformed settings blob must not break boot */ }
}

initAppSettingsSync();
// Boot push: main persists the cap, but a profile restored from the DB (or a
// value changed while main was down) would otherwise not reach it until the
// next time the user opened Settings.
try { pushBacklogCap(localStorage.getItem('sarvinbox-settings')); } catch { /* ignore */ }
try { pushSenderIdentityPolicy(localStorage.getItem('sarvinbox-settings')); } catch { /* ignore */ }
