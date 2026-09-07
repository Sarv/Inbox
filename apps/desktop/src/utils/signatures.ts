import type { AppSettings, EmailSignature } from '../components/settings/types';

const SETTINGS_KEY = 'sarvinbox-settings';

/**
 * Fill `signatures`/defaults from a legacy single `signature` string when the
 * new multi-signature fields are absent, so users upgrading keep their existing
 * signature. Pure — returns the (possibly augmented) pieces; the caller decides
 * whether to persist. Idempotent: a no-op once `signatures` is populated.
 */
export function migrateSignatures(s: Partial<AppSettings>): Pick<
  AppSettings,
  'signatures' | 'defaultSignatureNew' | 'defaultSignatureReply'
> {
  let signatures: EmailSignature[] = Array.isArray(s.signatures) ? s.signatures : [];
  let defaultSignatureNew = s.defaultSignatureNew || '';
  let defaultSignatureReply = s.defaultSignatureReply || '';
  if (signatures.length === 0 && s.signature && s.signature.trim()) {
    const id = 'sig-legacy';
    signatures = [{ id, name: 'My signature', html: s.signature }];
    defaultSignatureNew = defaultSignatureNew || id;
    defaultSignatureReply = defaultSignatureReply || id;
  }
  return { signatures, defaultSignatureNew, defaultSignatureReply };
}

interface SignatureState {
  enabled: boolean;
  signatures: EmailSignature[];
  defaultNew: string;
  defaultReply: string;
  /** Per-account overrides of the default signature: accountId -> {new, reply}
   *  signature ids. Lets a reply from Gmail use a different signature than one
   *  from another account. Falls back to the global defaults above. */
  accountSignatures: Record<string, { new?: string; reply?: string }>;
}

/** Read the signature settings from localStorage, applying the legacy migration.
 *  Pure read — does not persist. */
export function loadSignatureState(): SignatureState {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    const s: Partial<AppSettings> = raw ? JSON.parse(raw) : {};
    const migrated = migrateSignatures(s);
    return {
      enabled: !!s.signatureEnabled,
      signatures: migrated.signatures,
      defaultNew: migrated.defaultSignatureNew,
      defaultReply: migrated.defaultSignatureReply,
      accountSignatures: (s.accountSignatures && typeof s.accountSignatures === 'object') ? s.accountSignatures : {},
    };
  } catch {
    return { enabled: false, signatures: [], defaultNew: '', defaultReply: '', accountSignatures: {} };
  }
}

/**
 * Raw HTML of the signature to use for the given compose context, or '' when
 * signatures are disabled / none is set. The single source every compose
 * surface reads. Returned VERBATIM — callers must not run it through the
 * TipTap/convertToEmailHtml path, or the pasted layout is destroyed.
 */
/**
 * Complete malformed CSS border declarations in a signature.
 *
 * Pasted corporate signatures often carry a border via width+color WITHOUT a
 * `border-*-style` (e.g. the Sarv signature's divider bar:
 * `border-right-width: 2px; border-right-color: rgb(48,105,176)` with no style).
 * Per CSS, border-style defaults to `none`, so width+color alone render NOTHING —
 * the divider shows only in the paste editor's live DOM and vanishes when the
 * stored HTML is re-rendered in the compose preview, the sent mail, and the
 * recipient's client. Add `border-<side>-style: solid` wherever a side has a
 * width or color but no style. DOM-based (uses the browser's real CSS parser),
 * idempotent, and a no-op if parsing fails.
 */
export function normalizeSignatureHtml(html: string): string {
  if (!html || typeof DOMParser === 'undefined') return html;
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    let changed = false;
    doc.querySelectorAll<HTMLElement>('[style]').forEach((el) => {
      const style = el.getAttribute('style') || '';
      let patched = style;
      for (const side of ['top', 'right', 'bottom', 'left'] as const) {
        const hasWidth = new RegExp(`border-${side}-width\\s*:`, 'i').test(patched);
        const hasColor = new RegExp(`border-${side}-color\\s*:`, 'i').test(patched);
        const hasStyle = new RegExp(`border-${side}-style\\s*:`, 'i').test(patched);
        if ((hasWidth || hasColor) && !hasStyle) {
          patched = `${patched.replace(/;\s*$/, '')}; border-${side}-style: solid;`;
        }
      }
      // Also the all-sides form: border-width/border-color without border-style.
      const hasAllWidth = /(?:^|;)\s*border-width\s*:/i.test(patched);
      const hasAllColor = /(?:^|;)\s*border-color\s*:/i.test(patched);
      const hasAllStyle = /(?:^|;)\s*border-style\s*:/i.test(patched);
      if ((hasAllWidth || hasAllColor) && !hasAllStyle) {
        patched = `${patched.replace(/;\s*$/, '')}; border-style: solid;`;
      }
      if (patched !== style) { el.setAttribute('style', patched); changed = true; }
    });
    return changed ? doc.body.innerHTML : html;
  } catch {
    return html;
  }
}

export function getSignatureHtml(context: 'new' | 'reply', accountId?: string): string {
  const { enabled, signatures, defaultNew, defaultReply, accountSignatures } = loadSignatureState();
  if (!enabled || signatures.length === 0) return '';
  // Per-account override first (reply from Gmail → Gmail's signature), then the
  // global default for the context.
  const perAccount = accountId ? accountSignatures[accountId]?.[context] : undefined;
  const globalId = context === 'reply' ? defaultReply : defaultNew;
  const id = perAccount || globalId;
  const sig = signatures.find((x) => x.id === id) || (id ? undefined : signatures[0]);
  return normalizeSignatureHtml(sig?.html || '');
}
