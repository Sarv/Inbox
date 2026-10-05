const PENDING_KEY = 'sarvinbox-onboarding-pending';
const COMPLETE_KEY = 'sarvinbox-onboarding-complete';
const EMAIL_KEY = 'sarvinbox-onboarding-email';

/** Only progress flags are stored here; connections and secrets have their own stores. */
export function isOnboardingPending(): boolean {
  try {
    return localStorage.getItem(COMPLETE_KEY) !== 'true' && localStorage.getItem(PENDING_KEY) === 'true';
  } catch { return false; }
}

export function saveOnboardingEmailProgress(accountId: string, sendingConnected: boolean): void {
  localStorage.setItem(EMAIL_KEY, JSON.stringify({ accountId, sendingConnected }));
}

export function getOnboardingEmailProgress(accountId: string): { sendingConnected: boolean } | null {
  try {
    const saved = JSON.parse(localStorage.getItem(EMAIL_KEY) || 'null');
    return saved?.accountId === accountId && typeof saved.sendingConnected === 'boolean'
      ? { sendingConnected: saved.sendingConnected } : null;
  } catch { return null; }
}

export function beginOnboarding(): void {
  localStorage.setItem(PENDING_KEY, 'true');
}

export function completeOnboarding(): void {
  // Completion wins if a crash interrupts clearing the pending marker.
  localStorage.setItem(COMPLETE_KEY, 'true');
  localStorage.removeItem(PENDING_KEY);
  localStorage.removeItem(EMAIL_KEY);
}
