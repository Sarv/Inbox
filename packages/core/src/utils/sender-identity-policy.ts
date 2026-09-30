/**
 * The sender-identity policy: which background lookups may run to put a
 * picture beside a sender — the domain's BIMI brand logo, the domain's
 * favicon, and a contact's Gravatar photo.
 *
 * ONE module for both processes. The renderer reads the three switches out of
 * the settings blob (`senderLogos`, `senderFavicons`, `contactGravatar`) and
 * pushes the policy to main; main owns the lookups, normalises whatever
 * arrives, and falls back to the same defaults when nothing has arrived yet
 * (first launch, a settings blob that could not be read). When the default
 * lived in three places — the settings defaults, the renderer's push and
 * main's service — "on by default" could mean on in the checkbox and off in
 * the process that actually does the lookup.
 *
 * BIMI logos and domain favicons are on by default; Gravatar contact
 * photos are opt-in. Missing or malformed values read as those defaults.
 * An explicit `true`/`false` is always kept as it is.
 *
 * Pure (zero imports), so the renderer can deep-import it
 * (`@sarvinbox/core/sender-identity-policy`) without the core barrel.
 */

export interface SenderIdentityPolicy {
  /** Look up and show BIMI logos / verified marks. */
  logos: boolean;
  /** Look up and show domain favicons. */
  favicons: boolean;
  /**
   * Ask Gravatar for contacts' photos: a one-way hash of each contact's
   * address is sent to Gravatar (never the address itself). The privacy
   * policy (docs/legal/privacy-policy.md, "Sender pictures and logos")
   * describes this and must change with it.
   */
  gravatar: boolean;
}

export const DEFAULT_SENDER_IDENTITY_POLICY: Readonly<SenderIdentityPolicy> = Object.freeze({
  logos: true,
  favicons: true,
  gravatar: false,
});

const asRecord = (raw: unknown): Record<string, unknown> =>
  raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};

const flag = (value: unknown, fallback: boolean): boolean => (typeof value === 'boolean' ? value : fallback);

/** Coerce whatever was pushed or stored into a policy; anything that is not a boolean means the default. */
export function normalizeSenderIdentityPolicy(raw: unknown): SenderIdentityPolicy {
  const r = asRecord(raw);
  return {
    logos: flag(r.logos, DEFAULT_SENDER_IDENTITY_POLICY.logos),
    favicons: flag(r.favicons, DEFAULT_SENDER_IDENTITY_POLICY.favicons),
    gravatar: flag(r.gravatar, DEFAULT_SENDER_IDENTITY_POLICY.gravatar),
  };
}

/**
 * The policy the app settings blob asks for: `senderLogos`, `senderFavicons`
 * and `contactGravatar`, each an explicit boolean or else the default. What
 * the General tab's checkboxes show and what the renderer pushes to main are
 * both this, so the two cannot disagree.
 */
export function senderIdentityPolicyFromSettings(settings: unknown): SenderIdentityPolicy {
  const s = asRecord(settings);
  return normalizeSenderIdentityPolicy({
    logos: s.senderLogos,
    favicons: s.senderFavicons,
    gravatar: s.contactGravatar,
  });
}
