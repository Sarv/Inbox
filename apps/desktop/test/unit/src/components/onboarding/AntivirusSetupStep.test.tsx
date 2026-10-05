// @vitest-environment happy-dom
import type { AntivirusSetupStatus } from '@sarvinbox/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AntivirusSetupStep, type AntivirusSetupStepProps } from '../../../../../src/components/onboarding/AntivirusSetupStep';
import { cleanup, fire, render, settle, toggle, type Mounted } from '../../../../helpers/render';

const EMPTY: AntivirusSetupStatus = { configured: false, enabled: false, endpoint: '', allowedAccountIds: [], allowBody: false,
  accounts: [{ id: 'account-a', email: 'a@example.test', name: 'Account A' }, { id: 'account-b', email: 'b@example.test', name: 'Account B' }] };
const VERIFIED: AntivirusSetupStatus = { ...EMPTY, endpoint: 'https://av.sarv.com', operator: 'Sarv', region: 'India', privacyPolicyUrl: 'https://av.sarv.com/privacy',
  privacyTermsVersion: 'privacy-v1', contentLifetimeSeconds: 300, resultLifetimeSeconds: 900, metadataRetentionSeconds: 2592000 };
const ENABLED = { ...VERIFIED, configured: true, enabled: true, allowedAccountIds: ['account-a'] };
const api = { getOnboardingSetup: vi.fn(), connectSarvOAuth: vi.fn(), completeSarvOAuth: vi.fn(), cancelSarvOAuth: vi.fn(), disable: vi.fn() };
const openExternal = vi.fn();
const button = (view: Mounted, label: string) => view.all('button').find(element => element.textContent?.includes(label)) ?? null;
const props = (changes: Partial<AntivirusSetupStepProps> = {}): AntivirusSetupStepProps => ({ stage: 'connection', active: true, accountId: 'account-a', onStageChange: vi.fn(), onBack: vi.fn(), onComplete: vi.fn(), ...changes });

beforeEach(() => {
  vi.resetAllMocks();
  api.getOnboardingSetup.mockResolvedValue({ success: true, data: EMPTY });
  api.connectSarvOAuth.mockResolvedValue({ success: true, data: { challenge: 'opaque-host-challenge', setup: VERIFIED } });
  api.completeSarvOAuth.mockResolvedValue({ success: true, data: ENABLED });
  api.cancelSarvOAuth.mockResolvedValue({ success: true });
  window.electronAPI = { antivirus: api, app: { openExternal } } as unknown as typeof window.electronAPI;
});
afterEach(() => { cleanup(); document.body.innerHTML = ''; });

describe('optional antivirus onboarding', () => {
  // Regression: a provider picker required an unnecessary Continue click and could start OAuth before selection.
  it('opens connection immediately when Sarv is selected and never connects automatically', async () => {
    const p = props({ stage: 'provider' }); const view = render(<AntivirusSetupStep {...p} />); await settle();
    expect(view.find('img')?.getAttribute('src')).toBe('/provider-icons/sarv.png');
    fire(button(view, 'Sarv Antivirus'), 'click');
    expect(p.onStageChange).toHaveBeenCalledWith('connection'); expect(api.connectSarvOAuth).not.toHaveBeenCalled();
    expect(view.container.textContent).toContain('https://av.sarv.com');
    fire(button(view, 'Back'), 'click'); await settle(); expect(p.onBack).toHaveBeenCalledOnce();
  });

  // Regression: optional skip must not disable another account's protection or store credentials/consent in the renderer.
  it.each(['provider', 'connection'] as const)('lets users skip %s without configuring or disabling scanning', async stage => {
    const p = props({ stage }); const view = render(<AntivirusSetupStep {...p} />); await settle();
    fire(button(view, 'Skip for now'), 'click'); await settle();
    expect(p.onComplete).toHaveBeenCalledWith({ enabled: false });
    expect(api.cancelSarvOAuth).toHaveBeenCalled(); expect(api.completeSarvOAuth).not.toHaveBeenCalled(); expect(api.disable).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
  });

  // Regression: OAuth success must verify real scanner policy and obtain account-specific privacy consent before activation.
  it('reviews native verified disclosures, obtains consent and enables only the selected account', async () => {
    const p = props(); const view = render(<AntivirusSetupStep {...p} />); await settle();
    expect(view.container.textContent).toContain('90 days');
    fire(button(view, 'Connect with Sarv'), 'click'); await settle();
    expect(api.connectSarvOAuth).toHaveBeenCalledWith('account-a');
    expect(p.onComplete).not.toHaveBeenCalled(); expect(api.completeSarvOAuth).not.toHaveBeenCalled();
    expect(view.container.textContent).toContain('Scanner access verified');
    expect(view.container.textContent).toContain('a@example.test'); expect(view.container.textContent).toContain('2592000');
    expect(view.container.textContent).toContain('Email body scanning stays off');
    fire(button(view, 'Read scanner privacy policy'), 'click'); expect(openExternal).toHaveBeenCalledWith('https://av.sarv.com/privacy');
    expect(button(view, 'Enable antivirus')?.hasAttribute('disabled')).toBe(true);
    toggle(view.find('input[type="checkbox"]')); fire(button(view, 'Enable antivirus'), 'click'); await settle();
    expect(api.completeSarvOAuth).toHaveBeenCalledWith({ challenge: 'opaque-host-challenge', accountId: 'account-a', attachmentConsent: true });
    expect(p.onComplete).toHaveBeenCalledWith({ enabled: true, providerName: 'Sarv Antivirus' });
    expect(localStorage.length).toBe(0);
  });

  // Regression: a response or saved setup for another account must not be displayed as protection for this mailbox.
  it.each([ENABLED, { ...ENABLED, endpoint: 'https://private-scanner.test', operator: 'My scanner' }, { ...ENABLED, endpoint: 'https://private-scanner.test', operator: undefined }])('preserves already active current-account protection without another OAuth flow', async existing => {
    api.getOnboardingSetup.mockResolvedValue({ success: true, data: existing });
    const p = props(); const view = render(<AntivirusSetupStep {...p} />); await settle();
    expect(view.container.textContent).toContain('already protecting');
    fire(button(view, 'Continue'), 'click'); await settle();
    expect(p.onComplete).toHaveBeenCalledWith({ enabled: true, providerName: existing.endpoint === 'https://av.sarv.com' ? 'Sarv Antivirus' : existing.operator || 'Your scanner' });
    expect(api.connectSarvOAuth).not.toHaveBeenCalled(); expect(api.disable).not.toHaveBeenCalled();
  });

  // Regression: an existing scanner for another mailbox must retain its credential, scope and account consent.
  it.each([{ ...ENABLED, allowedAccountIds: ['account-b'] }, { ...ENABLED, enabled: false }])('does not claim protection or replace another/inactive connection', async existing => {
    api.getOnboardingSetup.mockResolvedValue({ success: true, data: existing });
    const p = props(); const view = render(<AntivirusSetupStep {...p} />); await settle();
    expect(view.container.textContent).toContain('existing scanner connection is kept');
    expect(button(view, 'Connect with Sarv')).toBeNull();
    fire(button(view, 'Skip for now'), 'click'); await settle();
    expect(p.onComplete).toHaveBeenCalledWith({ enabled: false }); expect(api.disable).not.toHaveBeenCalled();
  });

  // Regression: expired access, deployment failure or cancellation must offer retry/skip rather than fake completion.
  it('keeps a failed sign-in on connection and successfully retries', async () => {
    api.connectSarvOAuth.mockResolvedValueOnce({ success: false, error: 'Scanner unavailable. Retry or skip.' });
    const p = props(); const view = render(<AntivirusSetupStep {...p} />); await settle();
    fire(button(view, 'Connect with Sarv'), 'click'); await settle();
    expect(view.find('[role="alert"]')?.textContent).toContain('Scanner unavailable');
    expect(p.onComplete).not.toHaveBeenCalled();
    fire(button(view, 'Retry Sarv sign-in'), 'click'); await settle();
    expect(api.connectSarvOAuth).toHaveBeenCalledTimes(2); expect(view.container.textContent).toContain('Scanner access verified');
  });

  // Regression: a rejected native operation with no Error value must still show a usable retry message.
  it('handles non-Error native failures and incomplete optional metadata', async () => {
    api.connectSarvOAuth.mockRejectedValueOnce(null);
    const p = props(); const view = render(<AntivirusSetupStep {...p} />); await settle();
    fire(button(view, 'Connect with Sarv'), 'click'); await settle();
    expect(view.find('[role="alert"]')?.textContent).toContain('Scanner sign-in failed');
    api.connectSarvOAuth.mockResolvedValueOnce({ success: true, data: { challenge: 'new', setup: { ...VERIFIED, metadataRetentionSeconds: undefined,
      accounts: [{ id: 'account-a', name: 'Account A', email: '' }] } } });
    fire(button(view, 'Retry Sarv sign-in'), 'click'); await settle();
    expect(view.container.textContent).toContain('Not disclosed'); expect(view.container.textContent).toContain('account-a');
    toggle(view.find('input[type="checkbox"]')); api.completeSarvOAuth.mockRejectedValueOnce(null);
    fire(button(view, 'Enable antivirus'), 'click'); await settle();
    expect(view.find('[role="alert"]')?.textContent).toContain('Could not enable antivirus');
  });

  // Regression: stale completion from a browser callback could advance onboarding after Cancel, Back or Skip.
  it.each(['Cancel sign-in', 'Skip for now', 'Back'] as const)('ignores late OAuth success after %s', async action => {
    let finish!: (response: unknown) => void;
    api.connectSarvOAuth.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const p = props(); const view = render(<AntivirusSetupStep {...p} />); await settle();
    fire(button(view, 'Connect with Sarv'), 'click'); await settle();
    expect(view.container.textContent).toContain('Waiting for browser sign-in');
    fire(button(view, action), 'click'); await settle();
    finish({ success: true, data: { challenge: 'late', setup: VERIFIED } }); await settle();
    expect(view.container.textContent).not.toContain('Scanner access verified');
    expect(api.completeSarvOAuth).not.toHaveBeenCalled(); expect(api.cancelSarvOAuth).toHaveBeenCalled();
    if (action === 'Skip for now') expect(p.onComplete).toHaveBeenCalledWith({ enabled: false });
    else expect(p.onComplete).not.toHaveBeenCalled();
    if (action === 'Back') expect(p.onStageChange).toHaveBeenCalledWith('provider');
  });

  // Regression: a failed vault write could show successful protection or retain a consumed OAuth setup challenge.
  it.each([{ success: false, error: 'Vault save failed' }, { success: true }, { success: true, data: { ...ENABLED, allowedAccountIds: ['account-b'] } }])('requires valid account-bound activation and resets stale consent after failure', async response => {
    api.completeSarvOAuth.mockResolvedValueOnce(response);
    const p = props(); const view = render(<AntivirusSetupStep {...p} />); await settle();
    fire(button(view, 'Connect with Sarv'), 'click'); await settle(); toggle(view.find('input[type="checkbox"]'));
    fire(button(view, 'Enable antivirus'), 'click'); await settle();
    expect(p.onComplete).not.toHaveBeenCalled(); expect(view.find('[role="alert"]')).not.toBeNull();
    expect(view.find('input[type="checkbox"]')).toBeNull(); expect(button(view, 'Retry Sarv sign-in')).not.toBeNull();
  });

  // Regression: saving credentials must be a single atomic action that cannot race Skip or Back.
  it('disables navigation and duplicate saving while enabling antivirus', async () => {
    let finish!: (response: unknown) => void;
    api.completeSarvOAuth.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const p = props(); const view = render(<AntivirusSetupStep {...p} />); await settle();
    fire(button(view, 'Connect with Sarv'), 'click'); await settle(); toggle(view.find('input[type="checkbox"]'));
    fire(button(view, 'Enable antivirus'), 'click'); await settle();
    expect(button(view, 'Back')?.hasAttribute('disabled')).toBe(true); expect(button(view, 'Skip for now')?.hasAttribute('disabled')).toBe(true);
    finish({ success: true, data: ENABLED }); await settle(); expect(p.onComplete).toHaveBeenCalledOnce();
  });

  // Regression: missing native APIs, unreadable setup and a missing mailbox must preserve usable optional Skip.
  it.each(['missing-api', 'missing-account', 'load-error', 'missing-setup', 'transport-error'] as const)('allows skip when %s blocks scanner setup', async reason => {
    if (reason === 'missing-api') window.electronAPI = {} as typeof window.electronAPI;
    if (reason === 'load-error') api.getOnboardingSetup.mockResolvedValue({ success: false, error: 'Scanner store unreadable' });
    if (reason === 'missing-setup') api.getOnboardingSetup.mockResolvedValue({ success: true });
    if (reason === 'transport-error') api.getOnboardingSetup.mockRejectedValue(null);
    const p = props({ accountId: reason === 'missing-account' ? null : 'account-a' }); const view = render(<AntivirusSetupStep {...p} />); await settle();
    if (reason === 'missing-account') expect(button(view, 'Connect with Sarv')?.hasAttribute('disabled')).toBe(true);
    else expect(view.find('[role="alert"]')).not.toBeNull();
    fire(button(view, 'Skip for now'), 'click'); await settle(); expect(p.onComplete).toHaveBeenCalledWith({ enabled: false });
  });

  // Regression: account changes and hidden wizard stages must invalidate native OAuth consent rather than activate the old account.
  it('clears pending consent when the mailbox changes or the step becomes hidden', async () => {
    const p = props(); const view = render(<AntivirusSetupStep {...p} />); await settle();
    fire(button(view, 'Connect with Sarv'), 'click'); await settle(); toggle(view.find('input[type="checkbox"]'));
    view.rerender(<AntivirusSetupStep {...p} accountId="account-b" />); await settle();
    expect(view.find('input[type="checkbox"]')).toBeNull(); expect(api.cancelSarvOAuth).toHaveBeenCalled();
    fire(button(view, 'Connect with Sarv'), 'click'); await settle(); expect(api.connectSarvOAuth).toHaveBeenLastCalledWith('account-b');
    view.rerender(<AntivirusSetupStep {...p} active={false} accountId="account-b" />); await settle();
    expect(view.find('input[type="checkbox"]')).toBeNull(); expect(api.completeSarvOAuth).not.toHaveBeenCalled();
  });

  // Regression: a pending OAuth result after unmount must not update state or finish a different onboarding session.
  it('ignores late results after unmount', async () => {
    let finish!: (response: unknown) => void;
    api.connectSarvOAuth.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const p = props(); const view = render(<AntivirusSetupStep {...p} />); await settle();
    fire(button(view, 'Connect with Sarv'), 'click'); await settle(); view.unmount();
    finish({ success: true, data: { challenge: 'late', setup: VERIFIED } }); await settle();
    expect(p.onComplete).not.toHaveBeenCalled(); expect(api.cancelSarvOAuth).toHaveBeenCalled();
  });

  // Regression: an unrelated/malformed scanner success must not enter the trusted privacy-confirmation screen.
  it.each([{ success: true }, { success: true, data: { challenge: 'wrong', setup: { ...VERIFIED, endpoint: 'https://evil.test' } } },
    { success: true, data: { challenge: 'wrong', setup: { ...VERIFIED, accounts: [] } } }])('rejects incomplete or mismatched sign-in results', async response => {
    api.connectSarvOAuth.mockResolvedValueOnce(response);
    const p = props(); const view = render(<AntivirusSetupStep {...p} />); await settle(); fire(button(view, 'Connect with Sarv'), 'click'); await settle();
    expect(view.find('[role="alert"]')).not.toBeNull(); expect(view.find('input[type="checkbox"]')).toBeNull(); expect(p.onComplete).not.toHaveBeenCalled();
  });
});
