// @vitest-environment happy-dom
import { useState, StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AddAccountModal } from '../../../../../src/components/AddAccountModal';
import { EmailSetupStep, type EmailSetupResult } from '../../../../../src/components/onboarding/EmailSetupStep';
import { EMAIL_PROVIDERS } from '../../../../../src/config/email-providers';
import { saveOnboardingEmailProgress } from '../../../../../src/services/onboarding-progress';
import type { EmailStore, StoredAccount } from '../../../../../src/store/types';
import { act, cleanup, fire, render, settle, toggle, typeInto, type Mounted } from '../../../../helpers/render';

const mocks = vi.hoisted(() => ({ getState: vi.fn(), confirm: vi.fn() }));
vi.mock('../../../../../src/store/email-store', () => ({ useEmailStore: { getState: mocks.getState } }));
vi.mock('../../../../../src/store/confirm-service', () => ({ requestConfirm: mocks.confirm }));

const listProviders = vi.fn();
const listAccounts = vi.fn();
const startFlow = vi.fn();
const cancel = vi.fn(async () => ({ success: true }));
const addAccount = vi.fn();
const connectSmtp = vi.fn();
const markSmtpConfigured = vi.fn();
const selectAccount = vi.fn();
const connect = vi.fn();
const probeCredentials = vi.fn();
const onClose = vi.fn();
const onConnected = vi.fn<(result: EmailSetupResult) => void>();
const onStageChange = vi.fn();
let state: EmailStore;

function Wizard({ active = true }: { active?: boolean }) {
  const [stage, setStage] = useState<'provider' | 'connection'>('provider');
  return <EmailSetupStep active={active} stage={stage} onStageChange={(next) => { setStage(next); onStageChange(next); }} onConnected={onConnected} />;
}

const button = (view: Mounted, label: string) => view.all('button').find((item) => item.textContent?.includes(label)) ?? null;
const choose = async (view: Mounted, provider: string) => { fire(button(view, provider), 'click'); await settle(); };
const setSelect = (element: HTMLElement | null, value: string) => {
  if (!element) throw new Error('missing select');
  act(() => { (element as HTMLSelectElement).value = value; element.dispatchEvent(new Event('change', { bubbles: true })); });
};
const enterManual = (view: Mounted, email = 'person@example.com', password = ' a secret password ') => {
  if (button(view, 'Manual setup')) fire(button(view, 'Manual setup'), 'click');
  typeInto(view.byLabel('Email address'), email);
  typeInto(view.byLabel('Password or app password'), password);
};
const submit = (view: Mounted) => fire(view.find('form'), 'submit');
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function oauthResult(provider: 'gmail' | 'sarv' = 'sarv') {
  const preset = EMAIL_PROVIDERS.find((item) => item.id === provider)!;
  return { success: true, data: { provider, email: `person@${provider}.example`, purpose: 'both',
    imap: { host: preset.imapHost, port: preset.imapPort, secure: true },
    smtp: { host: preset.smtpHost, port: preset.smtpPort, secure: true }, scopes: [], displayName: 'Person' } };
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  listProviders.mockResolvedValue({ success: true, data: [
    { id: 'sarv', configured: true, purpose: 'both' }, { id: 'gmail', configured: true, purpose: 'email' },
    { id: 'microsoft', configured: true, purpose: 'email' }, { id: 'yahoo', configured: true, purpose: 'email' },
  ] });
  listAccounts.mockResolvedValue({ success: true, data: [] });
  startFlow.mockResolvedValue(oauthResult());
  state = { accounts: [], activeAccountId: null, connected: false, smtpConnected: false,
    addAccount, connectSmtp, markSmtpConfigured, selectAccount, connect,
  } as unknown as EmailStore;
  mocks.getState.mockImplementation(() => state);
  addAccount.mockImplementation(async (config) => {
    const existing = state.accounts.find((item) => item.email === config.username && item.imapConfig.host === config.host);
    const saved: StoredAccount = existing ?? { id: `account-${state.accounts.length + 1}`, email: config.username,
      imapConfig: config, smtpConfig: null, smtpConfigured: false };
    state.accounts = [...state.accounts.filter((item) => item.id !== saved.id), saved];
    state.activeAccountId = saved.id;
    state.connected = true;
  });
  connectSmtp.mockResolvedValue(undefined);
  probeCredentials.mockResolvedValue({ success: true });
  mocks.confirm.mockResolvedValue(true);
  connect.mockImplementation(async () => { state.connected = true; });
  selectAccount.mockImplementation(async (id: string) => { state.activeAccountId = id; });
  window.electronAPI = { oauth: { listProviders, listAccounts, startFlow, cancel }, imap: { probeCredentials } } as unknown as typeof window.electronAPI;
});

afterEach(() => { cleanup(); document.body.innerHTML = ''; vi.restoreAllMocks(); });

describe('provider-first onboarding email', () => {
  // Regression: provider selection must advance without an extra Continue action.
  it('opens Sarv connection immediately and defaults to browser sign-in', async () => {
    const view = render(<Wizard />);
    await settle();
    await choose(view, 'Sarv');
    expect(onStageChange).toHaveBeenCalledWith('connection');
    expect(view.container.textContent).toContain('Sign in with Sarv');
    expect(view.container.textContent).toContain('choose a model and approve AI processing');
    expect(view.find('form')).toBeNull();
    expect(startFlow).not.toHaveBeenCalled();
  });

  // Regression: OAuth options for other providers violate the approved manual-only scope.
  it.each(['Outlook', 'Yahoo', 'Other email'])('uses manual setup for %s even when OAuth is configured', async (name) => {
    const view = render(<Wizard />);
    await settle();
    await choose(view, name);
    expect(view.find('form')).not.toBeNull();
    expect(button(view, 'Browser sign-in')).toBeNull();
    expect(startFlow).not.toHaveBeenCalled();
  });

  // Regression: moving away and back must not discard typed connection details.
  it('preserves per-provider drafts when returning to the provider picker', async () => {
    const view = render(<Wizard />);
    await choose(view, 'Gmail');
    enterManual(view);
    fire(button(view, 'Back'), 'click');
    await choose(view, 'Yahoo');
    expect((view.byLabel('IMAP server') as HTMLInputElement).value).toBe('imap.mail.yahoo.com');
    fire(button(view, 'Back'), 'click');
    await choose(view, 'Gmail');
    expect((view.byLabel('Email address') as HTMLInputElement).value).toBe('person@example.com');
    expect((view.byLabel('Password or app password') as HTMLInputElement).value).toBe(' a secret password ');
  });

  // Regression: silently stripping spaces changes valid passwords and breaks sign-in.
  it('verifies receiving then sending with the exact password and shared provider presets', async () => {
    const view = render(<Wizard />);
    await choose(view, 'Outlook');
    enterManual(view);
    submit(view);
    await settle();
    expect(addAccount).toHaveBeenCalledWith({ host: 'outlook.office365.com', port: 993,
      security: 'ssl', secure: true, username: 'person@example.com', password: ' a secret password ',
      authMethod: 'password', allowInsecureTLS: undefined });
    expect(connectSmtp).toHaveBeenCalledWith({ host: 'smtp.office365.com', port: 587, secure: false,
      username: 'person@example.com', from: 'person@example.com', password: ' a secret password ',
      authMethod: 'password', allowInsecureTLS: undefined });
    expect(addAccount.mock.invocationCallOrder[0]).toBeLessThan(connectSmtp.mock.invocationCallOrder[0]);
    expect(markSmtpConfigured).toHaveBeenCalledWith(true);
    expect(onConnected).toHaveBeenCalledWith({ accountId: 'account-1', email: 'person@example.com',
      providerId: 'outlook', authMethod: 'password', sendingConnected: true, sarvConnected: false });
    expect(localStorage.length).toBe(0);
  });

  // Regression: a receiving failure cannot advance, mark sending ready or discard retry details.
  it.each(['Network connection timed out', 'Authentication rejected'])('keeps a receiving failure retryable: %s', async (message) => {
    addAccount.mockRejectedValueOnce(new Error(message));
    const view = render(<Wizard />);
    await choose(view, 'Outlook');
    enterManual(view);
    submit(view);
    await settle();
    expect(view.container.textContent).toContain(message);
    expect(onConnected).not.toHaveBeenCalled();
    expect(connectSmtp).not.toHaveBeenCalled();
    submit(view);
    await settle();
    expect(onConnected).toHaveBeenCalledOnce();
    expect(state.accounts).toHaveLength(1);
  });

  // Regression: an SMTP failure must preserve the connected mailbox and not add it again on retry.
  it('retries sending independently after a partial connection', async () => {
    connectSmtp.mockRejectedValueOnce(new Error('SMTP timed out'));
    const view = render(<Wizard />);
    await choose(view, 'Yahoo');
    enterManual(view);
    submit(view);
    await settle();
    expect(view.container.textContent).toContain('Receiving works. Sending needs attention: SMTP timed out');
    expect(view.container.textContent).toContain('Receiving connected');
    expect(onConnected).not.toHaveBeenCalled();
    fire(button(view, 'Retry sending check'), 'click');
    await settle();
    expect(addAccount).toHaveBeenCalledOnce();
    expect(connectSmtp).toHaveBeenCalledTimes(2);
    expect(onConnected.mock.calls[0][0].sendingConnected).toBe(true);
  });

  // Regression: optional sending setup must stay explicit and not claim SMTP succeeded.
  it('allows explicit receiving-only continuation after sending fails', async () => {
    connectSmtp.mockRejectedValueOnce(new Error('Sending credentials rejected'));
    const view = render(<Wizard />);
    await choose(view, 'Yahoo');
    enterManual(view);
    submit(view);
    await settle();
    fire(button(view, 'Continue with receiving only'), 'click');
    expect(onConnected.mock.calls[0][0].sendingConnected).toBe(false);
    expect(state.accounts).toHaveLength(1);
    expect(markSmtpConfigured).not.toHaveBeenCalled();
  });

  // Regression: deliberately skipping sending must not require an SMTP host or run an SMTP check.
  it('supports receiving-only manual setup before the initial connection', async () => {
    const view = render(<Wizard />);
    await choose(view, 'Other email');
    enterManual(view);
    typeInto(view.byLabel('IMAP server'), 'imap.private.example');
    toggle(view.byLabel('Set up sending later'));
    submit(view);
    await settle();
    expect(connectSmtp).not.toHaveBeenCalled();
    expect(onConnected.mock.calls[0][0].sendingConnected).toBe(false);
    expect((view.byLabel('Password or app password') as HTMLInputElement | null)).toBeNull();
  });

  // Regression: invalid numeric server ports must not reach native network calls.
  it('rejects invalid ports and missing server settings before account creation', async () => {
    const view = render(<Wizard />);
    await choose(view, 'Other email');
    enterManual(view);
    submit(view);
    await settle();
    expect(view.container.textContent).toContain('incoming server');
    typeInto(view.byLabel('IMAP server'), 'imap.private.example');
    submit(view);
    await settle();
    expect(view.container.textContent).toContain('sending server');
    typeInto(view.byLabel('SMTP server'), 'smtp.private.example');
    typeInto(view.byLabel('SMTP port'), '70000');
    submit(view);
    await settle();
    expect(view.container.textContent).toContain('between 1 and 65535');
    typeInto(view.byLabel('SMTP port'), '587');
    typeInto(view.byLabel('IMAP port'), '1.5');
    submit(view);
    await settle();
    expect(addAccount).not.toHaveBeenCalled();
  });

  // Regression: changing security must update ports and preserve first-class IMAP security.
  it('uses chosen STARTTLS and explicit certificate settings', async () => {
    const view = render(<Wizard />);
    await choose(view, 'Other email');
    enterManual(view);
    typeInto(view.byLabel('IMAP server'), 'imap.private.example');
    typeInto(view.byLabel('SMTP server'), 'smtp.private.example');
    setSelect(view.byLabel('IMAP security'), 'starttls');
    setSelect(view.byLabel('SMTP security'), 'starttls');
    toggle(view.find('details input[type="checkbox"]'));
    submit(view);
    await settle();
    expect(addAccount.mock.calls[0][0]).toMatchObject({ port: 143, secure: false, security: 'starttls', allowInsecureTLS: true });
    expect(connectSmtp.mock.calls[0][0]).toMatchObject({ port: 587, secure: false, allowInsecureTLS: true });
  });

  // Regression: returning to a connected account must not duplicate the account or erase its sync.
  it('reuses the connected account summary when Back returns to the same provider', async () => {
    const view = render(<Wizard />);
    await choose(view, 'Yahoo');
    enterManual(view);
    submit(view);
    await settle();
    fire(button(view, 'Back'), 'click');
    await choose(view, 'Yahoo');
    expect(view.container.textContent).toContain('Receiving connected');
    expect(view.find('form')).toBeNull();
    fire(button(view, 'Continue'), 'click');
    expect(addAccount).toHaveBeenCalledOnce();
    expect(state.accounts).toHaveLength(1);
  });

  // Regression: deliberate reconnect must reuse account identity while an auth failure preserves it.
  it('requires an explicit change action and preserves the previous account on failed reconnect', async () => {
    const view = render(<Wizard />);
    await choose(view, 'Yahoo');
    enterManual(view);
    submit(view);
    await settle();
    fire(button(view, 'Change connection'), 'click');
    expect((view.byLabel('Password or app password') as HTMLInputElement).value).toBe('');
    typeInto(view.byLabel('Password or app password'), 'new secret');
    addAccount.mockRejectedValueOnce(new Error('Invalid new credentials'));
    submit(view);
    await settle();
    expect(state.accounts).toHaveLength(1);
    fire(button(view, 'Back'), 'click');
    await choose(view, 'Yahoo');
    expect(view.container.textContent).toContain('Receiving connected');
    fire(button(view, 'Change connection'), 'click');
    submit(view);
    await settle();
    expect(state.accounts).toHaveLength(1);
    expect(onConnected.mock.lastCall?.[0].accountId).toBe('account-1');
  });

  // Regression: one provider's retained result must never be shown for another account.
  it('keeps independent accounts when connecting a second email provider', async () => {
    const view = render(<Wizard />);
    await choose(view, 'Yahoo'); enterManual(view); submit(view); await settle();
    fire(button(view, 'Back'), 'click');
    await choose(view, 'Outlook'); enterManual(view, 'second@example.com'); submit(view); await settle();
    expect(state.accounts).toHaveLength(2);
    fire(button(view, 'Back'), 'click');
    await choose(view, 'Yahoo');
    expect(view.container.textContent).toContain('person@example.com');
    expect(view.container.textContent).not.toContain('second@example.com');
    fire(button(view, 'Continue'), 'click'); await settle();
    expect(selectAccount).toHaveBeenCalledWith('account-1');
    expect(state.activeAccountId).toBe('account-1');
  });
});

describe('browser sign-in', () => {
  // Regression: successful Sarv OAuth connects email and exposes AI access without an AI provider side effect.
  it('connects Sarv email and reports the combined sign-in shortcut', async () => {
    const view = render(<Wizard />);
    await choose(view, 'Sarv');
    fire(button(view, 'Sign in with Sarv'), 'click');
    await settle();
    expect(startFlow).toHaveBeenCalledWith('sarv');
    expect(addAccount.mock.calls[0][0]).toMatchObject({ authMethod: 'oauth2', oauthProvider: 'sarv', password: '' });
    expect(connectSmtp.mock.calls[0][0]).toMatchObject({ authMethod: 'oauth2', oauthProvider: 'sarv' });
    expect(onConnected.mock.calls[0][0]).toMatchObject({ providerId: 'sarv', sarvConnected: true, sendingConnected: true });
    expect(localStorage.length).toBe(0);
  });

  // Regression: Gmail must default to OAuth while retaining its provider-specific privacy notice.
  it('connects Gmail by OAuth with sending preset fallback and its privacy notice', async () => {
    const response = oauthResult('gmail');
    startFlow.mockResolvedValue({ ...response, data: { ...response.data, smtp: null } });
    const view = render(<Wizard />);
    await choose(view, 'Gmail');
    expect(view.container.textContent).toContain('read, send, organize and delete Gmail');
    fire(button(view, 'Sign in with Gmail'), 'click');
    await settle();
    expect(startFlow).toHaveBeenCalledWith('gmail');
    expect(connectSmtp.mock.calls[0][0].host).toBe('smtp.gmail.com');
    expect(onConnected.mock.calls[0][0].sarvConnected).toBe(false);
  });

  // Regression: users already signed into Sarv must not need a second OAuth round-trip.
  it('reuses an existing Sarv session without opening another OAuth flow', async () => {
    listAccounts.mockResolvedValue({ success: true, data: [{ provider: 'sarv', email: 'signed-in@example.com' }] });
    const view = render(<Wizard />);
    await choose(view, 'Sarv');
    expect(view.container.textContent).toContain('Already signed in as');
    fire(button(view, 'Connect as signed-in@example.com'), 'click');
    await settle();
    expect(startFlow).not.toHaveBeenCalled();
    expect(addAccount.mock.calls[0][0].username).toBe('signed-in@example.com');
    expect(onConnected.mock.calls[0][0].sarvConnected).toBe(true);
  });

  // Regression: an existing session must not prevent a deliberate different-account sign-in.
  it('lets users deliberately sign in with a different Sarv account', async () => {
    listAccounts.mockResolvedValue({ success: true, data: [{ provider: 'sarv', email: 'signed-in@example.com' }] });
    const view = render(<Wizard />);
    await choose(view, 'Sarv');
    fire(button(view, 'Use a different Sarv account'), 'click');
    await settle();
    expect(startFlow).toHaveBeenCalledWith('sarv');
    expect(onConnected.mock.calls[0][0].email).toBe('person@sarv.example');
    fire(button(view, 'Change connection'), 'click');
    expect(view.container.textContent).toContain('Already signed in as person@sarv.example');
    expect(button(view, 'Connect as signed-in@example.com')).toBeNull();
  });

  // Regression: cancellation, native rejection and missing mailbox config must not create an account.
  it.each([
    { success: false, error: 'FLOW_CANCELLED' },
    { success: false },
    { success: true, data: { email: 'person@example.com', imap: null } },
  ])('keeps failed OAuth recoverable: %j', async (result) => {
    startFlow.mockResolvedValueOnce(result);
    const view = render(<Wizard />);
    await choose(view, 'Sarv');
    fire(button(view, 'Sign in with Sarv'), 'click');
    await settle();
    expect(view.find('[role="alert"]')).not.toBeNull();
    expect(addAccount).not.toHaveBeenCalled();
    expect(onConnected).not.toHaveBeenCalled();
    fire(button(view, 'Sign in with Sarv'), 'click');
    await settle();
    expect(onConnected).toHaveBeenCalledOnce();
  });

  // Regression: Back cancels the browser flow and late completion cannot connect an abandoned account.
  it('cancels OAuth on Back and ignores its stale success', async () => {
    const pending = deferred<ReturnType<typeof oauthResult>>();
    startFlow.mockReturnValueOnce(pending.promise);
    const view = render(<Wizard />);
    await choose(view, 'Sarv');
    fire(button(view, 'Sign in with Sarv'), 'click');
    fire(button(view, 'Cancel & Back'), 'click');
    expect(cancel).toHaveBeenCalledOnce();
    pending.resolve(oauthResult());
    await settle();
    expect(addAccount).not.toHaveBeenCalled();
    expect(onConnected).not.toHaveBeenCalled();
    expect(view.container.textContent).toContain('Where is your email?');
    await choose(view, 'Sarv');
    fire(button(view, 'Sign in with Sarv'), 'click');
    await settle();
    expect(onConnected).toHaveBeenCalledOnce();
  });

  // Regression: unmount must release the popup and a late response must not persist a mailbox.
  it('cancels an OAuth popup on unmount without applying a late result', async () => {
    const pending = deferred<ReturnType<typeof oauthResult>>();
    startFlow.mockReturnValueOnce(pending.promise);
    const view = render(<Wizard />);
    await choose(view, 'Sarv');
    fire(button(view, 'Sign in with Sarv'), 'click');
    view.unmount();
    expect(cancel).toHaveBeenCalledOnce();
    pending.resolve(oauthResult()); await settle();
    expect(addAccount).not.toHaveBeenCalled();
  });

  // Regression: leaving an active email panel invalidates in-flight OAuth even when it stays mounted.
  it('cancels a pending flow when a different onboarding stage becomes active', async () => {
    const pending = deferred<ReturnType<typeof oauthResult>>(); startFlow.mockReturnValueOnce(pending.promise);
    const view = render(<Wizard />); await choose(view, 'Sarv');
    fire(button(view, 'Sign in with Sarv'), 'click');
    view.rerender(<Wizard active={false} />);
    pending.resolve(oauthResult()); await settle();
    expect(cancel).toHaveBeenCalledOnce(); expect(addAccount).not.toHaveBeenCalled();
    expect(view.container.textContent).toBe('');
  });

  // Regression: failed provider discovery must still offer manual setup.
  it.each([false, true])('keeps manual setup available when provider discovery fails (throws=%s)', async (throws) => {
    if (throws) { listProviders.mockRejectedValue(new Error('Discovery offline')); listAccounts.mockRejectedValue(new Error('Offline')); }
    else { listProviders.mockResolvedValue({ success: false }); listAccounts.mockResolvedValue({ success: false }); }
    const view = render(<Wizard />); await choose(view, 'Sarv');
    expect(view.container.textContent).toContain('Browser sign-in is unavailable');
    expect((button(view, 'Sign in with Sarv') as HTMLButtonElement).disabled).toBe(true);
    fire(button(view, 'Manual setup'), 'click');
    expect(view.find('form')).not.toBeNull();
  });

  // Regression: development StrictMode remount must not leave provider discovery permanently loading.
  it('loads providers across StrictMode effect cleanup and remount', async () => {
    const view = render(<StrictMode><Wizard /></StrictMode>); await choose(view, 'Sarv');
    expect((button(view, 'Sign in with Sarv') as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('connected mailbox safety', () => {
  // Regression: a transient offline restart must retain the pending wizard's
  // email summary and credentials rather than showing a blank Other form.
  it('resumes a saved pending account while offline and reconnects without adding it again', async () => {
    localStorage.setItem('sarvinbox-onboarding-pending', 'true');
    state.accounts = [{ id: 'saved-mail', email: 'saved@example.com', imapConfig: {
      host: 'imap.sarv.com', port: 993, secure: true, authMethod: 'oauth2', oauthProvider: 'sarv', password: '',
    }, smtpConfig: null, smtpConfigured: true }];
    state.activeAccountId = 'saved-mail'; state.connected = false;
    saveOnboardingEmailProgress('saved-mail', true);
    connect.mockRejectedValueOnce(new Error('Network offline'));
    const view = render(<EmailSetupStep active stage="connection" onStageChange={onStageChange} onConnected={onConnected} />);
    await settle();
    expect(view.container.textContent).toContain('saved@example.com');
    expect(view.container.textContent).toContain('currently offline');
    expect(view.container.textContent).toContain('Sending connected');
    fire(button(view, 'Retry receiving connection'), 'click'); await settle();
    expect(view.container.textContent).toContain('Receiving is currently unavailable: Network offline');
    fire(button(view, 'Retry receiving connection'), 'click'); await settle();
    expect(view.container.textContent).toContain('Receiving connected');
    expect(addAccount).not.toHaveBeenCalled(); expect(connect).toHaveBeenCalledTimes(2);
    expect(state.accounts).toHaveLength(1);
  });

  // Regression: derived OAuth SMTP configuration must not be treated as a
  // successful sending verification after an interrupted first-run check.
  it('resumes sending as pending when no successful sending progress was saved', async () => {
    localStorage.setItem('sarvinbox-onboarding-pending', 'true');
    state.accounts = [{ id: 'saved-custom', email: 'saved@example.com', imapConfig: {
      host: 'imap.private.example', port: 1143, secure: false, security: 'starttls', allowInsecureTLS: true,
    }, smtpConfig: { host: 'smtp.private.example', port: 1587, secure: false, username: 'saved@example.com', password: '' }, smtpConfigured: true }];
    // Pending progress may be restored before the durable active pointer.
    state.activeAccountId = null; state.connected = false;
    const view = render(<EmailSetupStep active stage="connection" onStageChange={onStageChange} onConnected={onConnected} />);
    await settle(); expect(view.container.textContent).toContain('Sending pending');
    fire(button(view, 'Change connection'), 'click');
    expect((view.byLabel('Email address') as HTMLInputElement).value).toBe('saved@example.com');
    expect((view.byLabel('IMAP server') as HTMLInputElement).value).toBe('imap.private.example');
    expect((view.byLabel('IMAP port') as HTMLInputElement).value).toBe('1143');
    expect((view.byLabel('IMAP security') as HTMLSelectElement).value).toBe('starttls');
    expect((view.byLabel('SMTP server') as HTMLInputElement).value).toBe('smtp.private.example');
    expect((view.byLabel('SMTP port') as HTMLInputElement).value).toBe('1587');
    expect((view.byLabel('Password or app password') as HTMLInputElement).value).toBe('');
  });

  // Regression: a stale reconnect result after leaving setup must not mutate
  // the retained summary or complete a wizard the user has already left.
  it('ignores a pending receiving retry after the email panel becomes inactive', async () => {
    localStorage.setItem('sarvinbox-onboarding-pending', 'true');
    state.accounts = [{ id: 'saved-mail', email: 'saved@example.com', imapConfig: { host: 'imap.gmail.com' }, smtpConfig: null, smtpConfigured: false }];
    state.activeAccountId = 'saved-mail'; state.connected = false;
    const pending = deferred<void>(); connect.mockReturnValueOnce(pending.promise);
    const props = { stage: 'connection' as const, onStageChange, onConnected };
    const view = render(<EmailSetupStep {...props} active />); await settle();
    fire(button(view, 'Retry receiving connection'), 'click');
    expect(view.container.textContent).toContain('Reconnecting');
    view.rerender(<EmailSetupStep {...props} active={false} />);
    pending.resolve(); await settle();
    expect(view.container.textContent).toBe(''); expect(onConnected).not.toHaveBeenCalled();
  });
  // Regression: a resumed password mailbox with unverified sending must still
  // offer the pending check rather than accidentally enabling sending.
  it('resumes a manual mailbox with sending pending and a preset SMTP fallback', async () => {
    state.accounts = [{ id: 'saved-manual', email: 'saved@example.com', imapConfig: { host: 'imap.mail.yahoo.com' },
      smtpConfig: null, smtpConfigured: false }];
    state.activeAccountId = 'saved-manual'; state.connected = true;
    const view = render(<Wizard />); await choose(view, 'Yahoo');
    expect(view.container.textContent).toContain('Sending pending');
    fire(button(view, 'Retry sending check'), 'click'); await settle();
    expect(connectSmtp).toHaveBeenCalledWith(expect.objectContaining({ host: 'smtp.mail.yahoo.com', authMethod: 'password' }));
    expect(onConnected.mock.lastCall?.[0]).toMatchObject({ authMethod: 'password', sarvConnected: false });
  });

  // Regression: a custom-host resume must not be assigned the previous provider's settings.
  it('resumes a custom OAuth mailbox as Other without fabricating SMTP access', async () => {
    state.accounts = [{ id: 'saved-custom', email: 'saved@example.com', imapConfig: { host: 'imap.custom.example', authMethod: 'oauth2' },
      smtpConfig: null, smtpConfigured: false }];
    state.activeAccountId = 'saved-custom'; state.connected = true;
    const view = render(<Wizard />); await choose(view, 'Other email');
    fire(button(view, 'Continue with receiving only'), 'click');
    expect(onConnected.mock.lastCall?.[0]).toMatchObject({ providerId: 'other', sendingConnected: false });
    expect(connectSmtp).not.toHaveBeenCalled();
  });
  // Regression: pending onboarding after a restart must reuse the durable active account.
  it('resumes an active connected account without another mailbox creation', async () => {
    state.accounts = [{ id: 'saved-account', email: 'saved@example.com', imapConfig: { host: 'imap.sarv.com', authMethod: 'oauth2' },
      smtpConfig: { host: 'smtp.sarv.com', port: 465, secure: true, username: 'saved@example.com', password: '', authMethod: 'oauth2', oauthProvider: 'sarv' }, smtpConfigured: true }];
    state.activeAccountId = 'saved-account'; state.connected = true; state.smtpConnected = true;
    const view = render(<Wizard />); await choose(view, 'Sarv');
    expect(view.container.textContent).toContain('saved@example.com');
    expect(view.container.textContent).toContain('Sending connected');
    fire(button(view, 'Continue'), 'click');
    expect(addAccount).not.toHaveBeenCalled();
    expect(onConnected.mock.calls[0][0].accountId).toBe('saved-account');
  });

  // Regression: a pending sending retry must use the owning account, never whichever account is active now.
  it('selects the correct account before retrying its sending check', async () => {
    connectSmtp.mockRejectedValueOnce(new Error('SMTP offline'));
    const view = render(<Wizard />); await choose(view, 'Yahoo'); enterManual(view); submit(view); await settle();
    state.activeAccountId = 'another-account';
    fire(button(view, 'Retry sending check'), 'click'); await settle();
    expect(selectAccount).toHaveBeenCalledWith('account-1');
    expect(markSmtpConfigured).toHaveBeenCalledWith(true);
  });

  // Regression: failure to select the owning account must not route its credentials to another mailbox.
  it('keeps a failed account selection recoverable during a sending retry', async () => {
    connectSmtp.mockRejectedValueOnce(new Error('SMTP offline'));
    const view = render(<Wizard />); await choose(view, 'Yahoo'); enterManual(view); submit(view); await settle();
    state.activeAccountId = 'another-account'; selectAccount.mockRejectedValueOnce(new Error('Could not activate account'));
    fire(button(view, 'Retry sending check'), 'click'); await settle();
    expect(view.container.textContent).toContain('Could not activate account');
    expect(connectSmtp).toHaveBeenCalledOnce(); expect(onConnected).not.toHaveBeenCalled();
  });

  // Regression: returning to a saved result cannot advance when activating its
  // owning account fails; retry must keep the existing mailbox rather than add it.
  it('keeps failed summary continuation retryable without duplicating the saved account', async () => {
    const view = render(<Wizard />); await choose(view, 'Yahoo'); enterManual(view); submit(view); await settle();
    state.activeAccountId = 'another-account'; onConnected.mockClear();
    selectAccount.mockRejectedValueOnce(new Error('Account activation temporarily unavailable'));
    fire(button(view, 'Continue'), 'click'); await settle();
    expect(view.container.textContent).toContain('Account activation temporarily unavailable');
    expect(onConnected).not.toHaveBeenCalled();
    fire(button(view, 'Continue'), 'click'); await settle();
    expect(onConnected.mock.lastCall?.[0].accountId).toBe('account-1');
    expect(addAccount).toHaveBeenCalledOnce();
  });

  // Regression: a new active account must not inherit a stale SMTP result from another account.
  it('rejects a sending result after the active account changes mid-check', async () => {
    const pending = deferred<void>(); connectSmtp.mockReturnValueOnce(pending.promise);
    const view = render(<Wizard />); await choose(view, 'Yahoo'); enterManual(view); submit(view); await settle();
    state.activeAccountId = 'another-account'; pending.resolve(); await settle();
    expect(view.container.textContent).toContain('active email account changed');
    expect(markSmtpConfigured).not.toHaveBeenCalled(); expect(onConnected).not.toHaveBeenCalled();
  });

  // Regression: once native account activation starts, Back must not delete or unwind its sync.
  it('disables navigation during native activation and suppresses late completion on unmount', async () => {
    const pending = deferred<void>(); addAccount.mockReturnValueOnce(pending.promise);
    const view = render(<Wizard />); await choose(view, 'Yahoo'); enterManual(view); submit(view);
    expect((button(view, 'Back') as HTMLButtonElement).disabled).toBe(true);
    view.unmount(); pending.resolve(); await settle();
    expect(connectSmtp).not.toHaveBeenCalled(); expect(onConnected).not.toHaveBeenCalled();
  });

  // Regression: a native response without a saved registry row must never report a usable mailbox.
  it('does not advance when account activation returns without a saved account', async () => {
    addAccount.mockResolvedValueOnce(undefined);
    const view = render(<Wizard />); await choose(view, 'Yahoo'); enterManual(view); submit(view); await settle();
    expect(view.container.textContent).toContain('account was not saved');
    expect(connectSmtp).not.toHaveBeenCalled(); expect(onConnected).not.toHaveBeenCalled();
  });

  // Regression: abandoning a sending check must suppress late completion as well as late failure.
  it.each([false, true])('ignores a sending result after leaving the stage (reject=%s)', async (reject) => {
    let fail!: (reason: Error) => void;
    const pending = deferred<void>();
    const promise = new Promise<void>((resolve, rejectPromise) => { pending.promise.then(resolve); fail = rejectPromise; });
    connectSmtp.mockReturnValueOnce(promise);
    const view = render(<Wizard />); await choose(view, 'Yahoo'); enterManual(view); submit(view); await settle();
    expect(view.container.textContent).toContain('Checking sending');
    view.rerender(<Wizard active={false} />);
    if (reject) fail(new Error('Late sending failure')); else pending.resolve();
    await settle();
    expect(markSmtpConfigured).not.toHaveBeenCalled(); expect(onConnected).not.toHaveBeenCalled();
  });
});

describe('email setup form resilience', () => {
  // Regression: a password reveal must be deliberate and reset when the provider changes.
  it('lets users reveal and hide the password without altering its value', async () => {
    const view = render(<Wizard />); await choose(view, 'Gmail'); enterManual(view);
    fire(view.byLabel('Show password'), 'click');
    expect((view.byLabel('Password or app password') as HTMLInputElement).type).toBe('text');
    fire(view.byLabel('Hide password'), 'click');
    expect((view.byLabel('Password or app password') as HTMLInputElement).type).toBe('password');
    fire(button(view, 'Browser sign-in'), 'click');
    expect(view.find('form')).toBeNull();
  });

  // Regression: unexpected non-Error IPC rejection must remain retryable with a useful message.
  it('handles non-Error native failures and guards duplicate submissions while connecting', async () => {
    addAccount.mockRejectedValueOnce('offline');
    const view = render(<Wizard />); await choose(view, 'Yahoo'); enterManual(view); submit(view); await settle();
    expect(view.container.textContent).toContain('Check your settings and try again');
    const pending = deferred<void>(); addAccount.mockReturnValueOnce(pending.promise);
    submit(view); submit(view);
    expect(addAccount).toHaveBeenCalledTimes(2);
    expect(view.container.textContent).toContain('Checking receiving');
    view.unmount(); pending.resolve(); await settle();
  });

  // Regression: discovery success with no payload must remain a valid manual-only build state.
  it('handles missing discovery payloads and late discovery on an unmounted panel', async () => {
    listProviders.mockResolvedValue({ success: true }); listAccounts.mockResolvedValue({ success: true });
    const view = render(<Wizard />); await choose(view, 'Sarv');
    expect(view.container.textContent).toContain('Browser sign-in is unavailable');
    view.unmount();
    const pending = deferred<{ success: boolean; data: [] }>();
    listProviders.mockReturnValueOnce(pending.promise);
    const second = render(<Wizard />); second.unmount(); pending.resolve({ success: true, data: [] }); await settle();
    expect(startFlow).not.toHaveBeenCalled();
  });

  // Regression: a plain IMAP selection must round-trip its security choice and explicit sending skip.
  it('preserves the None IMAP setting when sending is explicitly deferred', async () => {
    const view = render(<Wizard />); await choose(view, 'Other email'); enterManual(view);
    typeInto(view.byLabel('IMAP server'), 'imap.private.example');
    setSelect(view.byLabel('IMAP security'), 'none'); toggle(view.byLabel('Set up sending later'));
    typeInto(view.byLabel('SMTP port'), ''); submit(view); await settle();
    expect(addAccount.mock.calls[0][0]).toMatchObject({ security: 'none', secure: false, port: 143 });
    expect(connectSmtp).not.toHaveBeenCalled();
  });
});

describe('adding another mailbox with the onboarding flow', () => {
  const savedAccount = (provider: 'sarv' | 'gmail' = 'sarv', authMethod = 'oauth2') => {
    const preset = EMAIL_PROVIDERS.find((item) => item.id === provider)!;
    state.accounts = [{ id: 'existing-mail', email: `person@${provider}.example`,
      imapConfig: { host: preset.imapHost, username: `person@${provider}.example`, authMethod },
      smtpConfig: null, smtpConfigured: false }];
    state.activeAccountId = 'existing-mail'; state.connected = true;
  };

  // Regression: adding an account must not resume onboarding or reuse an already linked mailbox's OAuth session.
  it.each(['sarv', 'gmail'] as const)('starts a fresh %s connection with provider cards and leaves onboarding and AI preferences intact', async (provider) => {
    savedAccount(provider);
    localStorage.setItem('sarvinbox-onboarding-pending', 'true');
    localStorage.setItem('sarvinbox-onboarding-complete', 'true');
    localStorage.setItem('sarvinbox-ai-enabled', 'true');
    const before = { ...localStorage };
    listAccounts.mockResolvedValue({ success: true, data: [{ provider, email: `person@${provider}.example` }] });
    const view = render(<AddAccountModal onClose={onClose} />);
    await settle();
    expect(view.find('[role="dialog"]')).not.toBeNull();
    expect(view.container.textContent).toContain('mailbox you want to add');
    expect(view.container.querySelectorAll('img').length).toBeGreaterThan(1);
    await choose(view, provider === 'sarv' ? 'Sarv' : 'Gmail');
    expect(view.container.textContent).toContain(`Connect ${provider === 'sarv' ? 'Sarv' : 'Gmail'}`);
    expect(view.container.textContent).not.toContain('Receiving connected');
    expect(view.container.textContent).not.toContain('Already signed in as');
    expect(button(view, `Sign in with ${provider === 'sarv' ? 'Sarv' : 'Gmail'}`)).not.toBeNull();
    expect(button(view, 'Manual setup')).not.toBeNull();
    expect(addAccount).not.toHaveBeenCalled();
    expect(startFlow).not.toHaveBeenCalled();
    expect({ ...localStorage }).toEqual(before);
  });

  // Regression: a saved but unlinked Sarv login should connect another mailbox without a redundant browser sign-in.
  it('reuses an unused Sarv session, verifies both connections and closes without changing existing accounts', async () => {
    savedAccount();
    listAccounts.mockResolvedValue({ success: true, data: [
      { provider: 'sarv', email: 'person@sarv.example' },
      { provider: 'sarv', email: 'second@sarv.example' },
    ] });
    const view = render(<AddAccountModal onClose={onClose} />); await choose(view, 'Sarv');
    expect(view.container.textContent).toContain('Already signed in as second@sarv.example');
    expect(view.container.textContent).toContain('configure in AI settings');
    fire(button(view, 'Connect as second@sarv.example'), 'click'); await settle();
    expect(startFlow).not.toHaveBeenCalled(); expect(mocks.confirm).not.toHaveBeenCalled();
    expect(probeCredentials).toHaveBeenCalledWith(expect.objectContaining({ username: 'second@sarv.example', authMethod: 'oauth2' }));
    expect(addAccount).toHaveBeenCalledWith(expect.objectContaining({ username: 'second@sarv.example' }), { alreadyVerified: true });
    expect(state.accounts).toHaveLength(2);
    expect(state.accounts.find((item) => item.id === 'existing-mail')?.email).toBe('person@sarv.example');
    expect(connectSmtp).toHaveBeenCalledOnce(); expect(onClose).toHaveBeenCalledOnce();
    expect(localStorage.length).toBe(0);
  });

  // Regression: an OAuth identity must not replace a working account if receiving rejects its token or times out.
  it.each([{ success: false, error: 'Connection timed out' }, { success: false, error: 'Access token rejected' }, { success: false }])('keeps the previous mailbox and permits retry when the isolated probe fails: %j', async (probe) => {
    savedAccount('sarv', 'password');
    probeCredentials.mockResolvedValueOnce(probe);
    const original = state.accounts[0];
    const view = render(<AddAccountModal onClose={onClose} />); await choose(view, 'Sarv');
    fire(button(view, 'Sign in with Sarv'), 'click'); await settle();
    expect(view.container.textContent).toContain(probe.error ?? 'Receiving authentication failed');
    expect(state.accounts[0]).toBe(original); expect(addAccount).not.toHaveBeenCalled();
    expect(mocks.confirm).not.toHaveBeenCalled(); expect(connectSmtp).not.toHaveBeenCalled(); expect(onClose).not.toHaveBeenCalled();
    expect((view.byLabel('Close setup') as HTMLButtonElement).disabled).toBe(false);
  });

  // Regression: password-to-OAuth replacement must require confirmation after proof and never silently overwrite a working mailbox.
  it('keeps a declined password connection and only replaces it after a verified, explicit retry', async () => {
    savedAccount('sarv', 'password'); mocks.confirm.mockResolvedValueOnce(false);
    const view = render(<AddAccountModal onClose={onClose} />); await choose(view, 'Sarv');
    fire(button(view, 'Sign in with Sarv'), 'click'); await settle();
    expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({ confirmLabel: 'Replace', destructive: true }));
    expect(probeCredentials.mock.invocationCallOrder[0]).toBeLessThan(mocks.confirm.mock.invocationCallOrder[0]);
    expect(addAccount).not.toHaveBeenCalled(); expect(onClose).not.toHaveBeenCalled(); expect(state.accounts).toHaveLength(1);
    fire(button(view, 'Sign in with Sarv'), 'click'); await settle();
    expect(addAccount).toHaveBeenCalledWith(expect.objectContaining({ authMethod: 'oauth2' }), { alreadyVerified: true });
    expect(state.accounts).toHaveLength(1); expect(onClose).toHaveBeenCalledOnce();
  });

  // Regression: reconnecting an OAuth mailbox must be intentional even though email+host deduplication prevents a duplicate row.
  it('confirms reconnecting an existing OAuth mailbox', async () => {
    savedAccount();
    const view = render(<AddAccountModal onClose={onClose} />); await choose(view, 'Sarv');
    fire(button(view, 'Sign in with Sarv'), 'click'); await settle();
    expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({ confirmLabel: 'Reconnect', destructive: false }));
    expect(state.accounts).toHaveLength(1); expect(onClose).toHaveBeenCalledOnce();
  });

  // Regression: closing the modal while an OAuth popup is pending must cancel it and suppress every late network/persistence step.
  it('cancels an unfinished browser sign-in when the modal unmounts', async () => {
    const pending = deferred<ReturnType<typeof oauthResult>>(); startFlow.mockReturnValueOnce(pending.promise);
    const view = render(<AddAccountModal onClose={onClose} />); await choose(view, 'Sarv');
    fire(button(view, 'Sign in with Sarv'), 'click');
    expect((view.byLabel('Close setup') as HTMLButtonElement).disabled).toBe(false);
    view.unmount(); pending.resolve(oauthResult()); await settle();
    expect(cancel).toHaveBeenCalledOnce(); expect(probeCredentials).not.toHaveBeenCalled(); expect(addAccount).not.toHaveBeenCalled(); expect(onClose).not.toHaveBeenCalled();
  });

  // Regression: an external unmount during a probe or confirmation must prevent stale replacement of another mailbox.
  it.each(['probe', 'confirmation'] as const)('ignores a stale %s result after the add-account modal unmounts', async (phase) => {
    savedAccount('sarv', 'password');
    const probe = deferred<{ success: boolean }>(); const confirm = deferred<boolean>();
    if (phase === 'probe') probeCredentials.mockReturnValueOnce(probe.promise);
    else mocks.confirm.mockReturnValueOnce(confirm.promise);
    const view = render(<AddAccountModal onClose={onClose} />); await choose(view, 'Sarv');
    fire(button(view, 'Sign in with Sarv'), 'click'); await settle();
    expect((view.byLabel('Close setup') as HTMLButtonElement).disabled).toBe(true);
    view.unmount(); probe.resolve({ success: true }); confirm.resolve(true); await settle();
    expect(addAccount).not.toHaveBeenCalled(); expect(connectSmtp).not.toHaveBeenCalled(); expect(onClose).not.toHaveBeenCalled();
  });

  // Regression: manual credentials must be preserved exactly, receiving-only must stay optional and two accounts must coexist.
  it('adds a manual mailbox with prefilled servers and explicit sending skip', async () => {
    savedAccount();
    const view = render(<AddAccountModal onClose={onClose} />); await choose(view, 'Outlook');
    enterManual(view, 'second@example.com'); toggle(view.byLabel('Set up sending later')); submit(view); await settle();
    expect(probeCredentials).toHaveBeenCalledWith(expect.objectContaining({ host: 'outlook.office365.com', password: ' a secret password ' }));
    expect(addAccount).toHaveBeenCalledWith(expect.objectContaining({ username: 'second@example.com', password: ' a secret password ' }), { alreadyVerified: true });
    expect(connectSmtp).not.toHaveBeenCalled(); expect(state.accounts).toHaveLength(2); expect(onClose).toHaveBeenCalledOnce();
  });

  // Regression: IMAP servers with a separate login must still receive that login without changing the SMTP sender address.
  it('supports an incoming username different from the sending address', async () => {
    const view = render(<AddAccountModal onClose={onClose} />); await choose(view, 'Outlook');
    enterManual(view, 'person@example.com'); typeInto(view.byLabel('Incoming login username'), ' mailbox-login ');
    submit(view); await settle();
    expect(addAccount).toHaveBeenCalledWith(expect.objectContaining({ username: 'mailbox-login' }), { alreadyVerified: true });
    expect(connectSmtp).toHaveBeenCalledWith(expect.objectContaining({ username: 'person@example.com', from: 'person@example.com' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  // Regression: a manual reconnect can replace saved secrets too, so declining it must preserve the old mailbox just like OAuth.
  it('requires confirmation before reconnecting the same mailbox manually', async () => {
    savedAccount('gmail', 'password'); mocks.confirm.mockResolvedValueOnce(false);
    const view = render(<AddAccountModal onClose={onClose} />); await choose(view, 'Gmail');
    enterManual(view, 'person@gmail.example'); submit(view); await settle();
    expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({ confirmLabel: 'Reconnect', destructive: false }));
    expect(addAccount).not.toHaveBeenCalled(); expect(connectSmtp).not.toHaveBeenCalled();
    submit(view); await settle();
    expect(addAccount).toHaveBeenCalledOnce(); expect(state.accounts).toHaveLength(1); expect(onClose).toHaveBeenCalledOnce();
  });

  // Regression: a sending outage must retain the newly added receiving account and offer a retry without creating it twice.
  it('keeps sending failure recoverable, locks closing during a retry and closes after recovery', async () => {
    connectSmtp.mockRejectedValueOnce(new Error('SMTP temporarily offline'));
    const view = render(<AddAccountModal onClose={onClose} />); await choose(view, 'Yahoo'); enterManual(view); submit(view); await settle();
    expect(view.container.textContent).toContain('Receiving works. Sending needs attention');
    expect((view.byLabel('Close setup') as HTMLButtonElement).disabled).toBe(false);
    const pending = deferred<void>(); connectSmtp.mockReturnValueOnce(pending.promise);
    fire(button(view, 'Retry sending check'), 'click');
    expect((view.byLabel('Close setup') as HTMLButtonElement).disabled).toBe(true);
    pending.resolve(); await settle();
    expect(addAccount).toHaveBeenCalledOnce(); expect(state.accounts).toHaveLength(1); expect(onClose).toHaveBeenCalledOnce();
  });
});
