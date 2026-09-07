import { describe, expect, it } from 'vitest';

import { shouldShowOnboarding, shouldShowNoAccountEmptyState, type AppGateState } from '../../../../src/utils/app-gates';

// These pin the fix for the startup "No account connected" flash: the gates must
// key on whether an account EXISTS (hasAccounts), never on the transient
// imapConfig, which is null for the ~2s between DB hydration and auto-connect and
// again on every disconnect blip. If any of these regress, a returning user sees
// the onboarding/empty screen flash over their cached mailbox on launch/reconnect.

// A returning user, mid-boot: account hydrated from the DB but not yet connected
// (imapConfig still null). This is the exact window that used to flash.
const bootingWithAccount: AppGateState = {
  checkingConnection: false,
  onboardingComplete: true,
  hasAccounts: true,
  needsReauth: false,
  activeSection: 'mail',
};

describe('shouldShowNoAccountEmptyState', () => {
  it('does NOT show while an account exists but is still (re)connecting', () => {
    // The regression this guards: empty state flashing over a hydrated account
    // during the boot/reconnect window when imapConfig is transiently null.
    expect(shouldShowNoAccountEmptyState(bootingWithAccount)).toBe(false);
  });

  it('shows once the registry is genuinely empty (last account removed)', () => {
    // The legitimate no-account state for a returning user, on the mail view.
    expect(shouldShowNoAccountEmptyState({ ...bootingWithAccount, hasAccounts: false })).toBe(true);
  });

  it('stays hidden while the initial connection check is still running', () => {
    // checkingConnection suppresses the gate so nothing flashes before we know.
    expect(
      shouldShowNoAccountEmptyState({ ...bootingWithAccount, hasAccounts: false, checkingConnection: true }),
    ).toBe(false);
  });

  it('defers to the ReauthBanner when an account needs re-auth', () => {
    // needsReauth means an account exists but was rejected — show the banner over
    // the cached mailbox, never the empty state.
    expect(
      shouldShowNoAccountEmptyState({ ...bootingWithAccount, hasAccounts: false, needsReauth: true }),
    ).toBe(false);
  });

  it('only overrides the mail section (Settings etc. stay reachable)', () => {
    // With no account the user must still reach Settings → Accounts to add one.
    expect(
      shouldShowNoAccountEmptyState({ ...bootingWithAccount, hasAccounts: false, activeSection: 'settings' }),
    ).toBe(false);
  });
});

describe('shouldShowOnboarding', () => {
  it('shows for a brand-new user with no account and no prior onboarding', () => {
    expect(
      shouldShowOnboarding({
        checkingConnection: false,
        onboardingComplete: false,
        hasAccounts: false,
        needsReauth: false,
        activeSection: 'mail',
      }),
    ).toBe(true);
  });

  it('does NOT show for a returning user mid-boot with a hydrated account', () => {
    // The same flash, but for the onboarding screen: a user who never flipped the
    // onboarding-complete flag must not be dropped back into onboarding just
    // because imapConfig is momentarily null while the account reconnects.
    expect(shouldShowOnboarding({ ...bootingWithAccount, onboardingComplete: false })).toBe(false);
  });

  it('stays hidden once onboarding has been completed', () => {
    expect(shouldShowOnboarding({ ...bootingWithAccount, hasAccounts: false })).toBe(false);
  });

  it('stays hidden during the initial connection check', () => {
    expect(
      shouldShowOnboarding({
        checkingConnection: true,
        onboardingComplete: false,
        hasAccounts: false,
        needsReauth: false,
        activeSection: 'mail',
      }),
    ).toBe(false);
  });
});
