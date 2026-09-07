import { createLogger } from '@sarvinbox/core';
const logger = createLogger('gmail-label-api');
/**
 * Gmail label COLOR via the Gmail REST API. Used ONLY for Gmail accounts
 * connected over OAuth — the `mail.google.com` scope we already hold authorizes
 * `users.labels`. Everything else (app-password Gmail, and the IMAP keyword/
 * folder strategies on other providers) gets a plain, uncolored label; the
 * label itself is created over IMAP regardless. Entirely best-effort: any
 * failure (color rejected, network, quota) degrades to a plain label and never
 * throws into the caller — color is cosmetic, labels are the point.
 */

const API = 'https://gmail.googleapis.com/gmail/v1/users/me/labels';

// A broad, vibrant subset of Gmail's allowed label background colors (the API
// rejects any color outside its fixed palette) — several shades across every
// hue so distinct category colors snap to distinct Gmail colors (15+ variety).
const GMAIL_BG = [
  // reds
  '#fb4c2f', '#e66550', '#cc3a21', '#ac2b16',
  // oranges
  '#ffad47', '#ffbc6b', '#eaa041', '#cf8933',
  // yellows
  '#fad165', '#fcda83', '#f2c960', '#d5ae49',
  // greens
  '#16a766', '#43d692', '#44b984', '#149e60', '#68dfa9',
  // teals / cyans
  '#2da2bb', '#98d7e4', '#a2dcc1',
  // blues
  '#4a86e8', '#6d9eeb', '#3c78d8', '#a4c2f4',
  // purples / indigos
  '#a479e2', '#b694e8', '#8e63ce', '#653e9b', '#3d188e',
  // pinks / magentas
  '#f691b3', '#f7a7c0', '#e07798', '#b65775',
  // neutrals
  '#999999', '#cccccc', '#666666', '#434343',
];

function hexToRgb(h: string): [number, number, number] {
  const s = h.replace('#', '');
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
}

// Category colors are stored as NAMED colors (Tailwind-style), not hex — map
// them to a representative hex so we can snap to Gmail's palette. Accepts a hex
// directly too.
const NAMED_COLORS: Record<string, string> = {
  red: '#ef4444', orange: '#f97316', amber: '#f59e0b', yellow: '#eab308',
  lime: '#84cc16', green: '#22c55e', emerald: '#10b981', teal: '#14b8a6',
  cyan: '#06b6d4', sky: '#0ea5e9', blue: '#3b82f6', indigo: '#6366f1',
  violet: '#8b5cf6', purple: '#a855f7', fuchsia: '#d946ef', pink: '#ec4899',
  rose: '#f43f5e', gray: '#6b7280', grey: '#6b7280', slate: '#64748b', stone: '#78716c',
};

function resolveHex(color?: string): string | null {
  if (!color) return null;
  const c = color.trim().toLowerCase();
  if (/^#?[0-9a-f]{6}$/.test(c)) return c.startsWith('#') ? c : `#${c}`;
  return NAMED_COLORS[c] ?? null;
}

function nearestGmailBg(color?: string): string | null {
  const hex = resolveHex(color);
  if (!hex) return null;
  const [r, g, b] = hexToRgb(hex);
  let best = GMAIL_BG[0], bestD = Infinity;
  for (const c of GMAIL_BG) {
    const [cr, cg, cb] = hexToRgb(c);
    const d = (r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2;
    if (d < bestD) { bestD = d; best = c; }
  }
  return best;
}

// Readable text color on the chosen background (luminance threshold).
function textFor(bg: string): string {
  const [r, g, b] = hexToRgb(bg);
  return 0.299 * r + 0.587 * g + 0.114 * b > 140 ? '#000000' : '#ffffff';
}

async function api(token: string, method: string, path = '', body?: unknown): Promise<any> {
  const res = await fetch(API + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Gmail labels ${method} ${res.status}: ${t.slice(0, 200)}`);
  }
  if (res.status === 204) return null; // DELETE etc. — no body
  return res.json().catch(() => null);
}

/**
 * Ensure a Gmail label named `name` exists and carries `hex` (snapped to Gmail's
 * palette). Idempotent by name. On any color rejection it falls back to a plain
 * (uncolored) label so the label still exists. Never throws.
 */
export async function ensureGmailLabelColor(token: string, name: string, hex?: string): Promise<boolean> {
  try {
    const bg = nearestGmailBg(hex);
    const color = bg ? { backgroundColor: bg, textColor: textFor(bg) } : undefined;

    const { labels = [] } = await api(token, 'GET');
    const existing = labels.find((l: any) => (l.name || '').toLowerCase() === name.toLowerCase());

    if (existing) {
      if (!color) return false; // nothing to do — label exists, no color wanted
      // Already the right color → NO-OP. Avoids re-PATCHing (and re-logging)
      // the same label on every provisioning pass — the source of the repeated
      // Gmail API calls when provisioning runs more than once.
      const cur = existing.color || {};
      if (cur.backgroundColor === color.backgroundColor && cur.textColor === color.textColor) return false;
      try { await api(token, 'PATCH', `/${existing.id}`, { color }); logger.info(`[GmailLabels] colored "${name}"`); return true; }
      catch (e) { logger.warn(`[GmailLabels] color PATCH "${name}" failed:`, (e as Error).message); return false; }
    }

    const base = { name, labelListVisibility: 'labelShow', messageListVisibility: 'show' };
    try {
      await api(token, 'POST', '', color ? { ...base, color } : base);
      logger.info(`[GmailLabels] created "${name}"${color ? ' (colored)' : ''}`);
      return true;
    } catch (e) {
      logger.warn(`[GmailLabels] create "${name}" with color failed:`, (e as Error).message);
      try { await api(token, 'POST', '', base); logger.info(`[GmailLabels] created "${name}" (plain — color rejected)`); return true; }
      catch (e2) { logger.warn(`[GmailLabels] create "${name}" plain failed:`, (e2 as Error).message); return false; }
    }
  } catch (e) {
    logger.warn(`[GmailLabels] ensure "${name}" failed:`, (e as Error).message);
    return false;
  }
}

/** Rename a Gmail label in place (patch its name). Best-effort, never throws. */
export async function renameGmailLabel(token: string, oldName: string, newName: string): Promise<void> {
  try {
    if (oldName === newName) return;
    const { labels = [] } = await api(token, 'GET');
    const existing = labels.find((l: any) => (l.name || '').toLowerCase() === oldName.toLowerCase());
    if (!existing) return;
    await api(token, 'PATCH', `/${existing.id}`, { name: newName }).catch(() => { /* target may already exist */ });
  } catch (e) {
    logger.warn('[GmailLabels] rename best-effort failed:', (e as Error).message);
  }
}

/** Delete every Gmail label at or under `prefix` (e.g. "Sarv Inbox"). Returns
 *  the count deleted. Best-effort. */
export async function deleteGmailLabelsUnder(token: string, prefix: string): Promise<number> {
  try {
    const { labels = [] } = await api(token, 'GET');
    const lc = prefix.toLowerCase();
    const targets = labels.filter((l: any) => {
      const n = (l.name || '').toLowerCase();
      return n === lc || n.startsWith(`${lc}/`);
    });
    let n = 0;
    for (const l of targets) {
      await api(token, 'DELETE', `/${l.id}`).then(() => { n++; }).catch(() => { /* skip */ });
    }
    return n;
  } catch (e) {
    logger.warn('[GmailLabels] delete-under best-effort failed:', (e as Error).message);
    return 0;
  }
}
