// Pure predicates for the two full-screen "you have no account" gates in App.tsx
// (first-run Onboarding and the returning-user NoAccountEmptyState).
//
// These used to key on `!imapConfig`, but imapConfig is a TRANSIENT runtime field:
// it is null at cold start (accounts now live in the main-owned DB, so
// hydrateAccountsFromDb restores `accounts` but not imapConfig) and it is nulled
// on disconnect. That made the app flash "No account connected" for the ~2s
// between account hydration and the auto-connect landing, and again on any
// disconnect blip. The durable truth of "does the user have an account" is the
// registry length — `hasAccounts` — so the gates key on that instead.
//
// Kept pure (no React/store deps) so the gating logic is unit-testable on its own.

export interface AppGateState {
  /** Still running the initial main-process connection check — suppress both gates. */
  checkingConnection: boolean;
  /** The user has completed first-run onboarding at least once. */
  onboardingComplete: boolean;
  /** At least one account exists in the registry (durable "has account" signal). */
  hasAccounts: boolean;
  /** An account exists but its credentials were rejected — the ReauthBanner owns this. */
  needsReauth: boolean;
  /** The currently visible app section (the empty state only overrides 'mail'). */
  activeSection: string;
}

/**
 * First-run onboarding: only for a brand-new user with genuinely no account —
 * never during the boot/reconnect window where imapConfig is transiently null.
 */
export const shouldShowOnboarding = (state: AppGateState): boolean =>
  !state.checkingConnection && !state.onboardingComplete && !state.hasAccounts && !state.needsReauth;

/**
 * Returning-user empty state: shown only on the mail view, once onboarding is
 * done and the registry is truly empty (e.g. the last account was removed).
 */
export const shouldShowNoAccountEmptyState = (state: AppGateState): boolean =>
  !state.checkingConnection &&
  state.onboardingComplete &&
  !state.hasAccounts &&
  !state.needsReauth &&
  state.activeSection === 'mail';
