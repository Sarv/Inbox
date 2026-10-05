// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';

import { beginOnboarding, completeOnboarding, getOnboardingEmailProgress, isOnboardingPending, saveOnboardingEmailProgress } from '../../../../src/services/onboarding-progress';

beforeEach(() => localStorage.clear());
describe('durable onboarding progress', () => {
  it('starts a pending flow and marks it complete only at the final action', () => {
    beginOnboarding(); expect(isOnboardingPending()).toBe(true);
    completeOnboarding(); expect(isOnboardingPending()).toBe(false);
    expect(localStorage.getItem('sarvinbox-onboarding-complete')).toBe('true');
  });
  it('completion wins when clearing the pending marker was interrupted', () => {
    beginOnboarding(); localStorage.setItem('sarvinbox-onboarding-complete', 'true');
    expect(isOnboardingPending()).toBe(false);
  });
  it('restores only explicitly verified or deferred sending for the same account', () => {
    expect(getOnboardingEmailProgress('a')).toBeNull();
    saveOnboardingEmailProgress('a', false); expect(getOnboardingEmailProgress('a')).toEqual({ sendingConnected: false });
    expect(getOnboardingEmailProgress('b')).toBeNull();
    saveOnboardingEmailProgress('a', true); expect(getOnboardingEmailProgress('a')).toEqual({ sendingConnected: true });
    completeOnboarding(); expect(getOnboardingEmailProgress('a')).toBeNull();
  });
  it('does not guess sending success from malformed progress', () => {
    localStorage.setItem('sarvinbox-onboarding-email', '{'); expect(getOnboardingEmailProgress('a')).toBeNull();
    localStorage.setItem('sarvinbox-onboarding-email', '{"accountId":"a","sendingConnected":"true"}');
    expect(getOnboardingEmailProgress('a')).toBeNull();
  });
});
