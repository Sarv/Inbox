// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IMAPStep } from '../../../../../src/components/onboarding/IMAPStep';
import { useEmailStore } from '../../../../../src/store/email-store';
import { cleanup, fire, render, settle, typeInto } from '../../../../helpers/render';

vi.mock('../../../../../src/store/email-store', () => ({ useEmailStore: vi.fn() }));

const addAccount = vi.fn(async () => {});
const connect = vi.fn(async () => {});
const startFlow = vi.fn();
const listProviders = vi.fn();

const button = (view: { all: (selector: string) => HTMLElement[] }, label: string) =>
  view.all('button').find((el) => el.textContent?.includes(label)) ?? null;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useEmailStore).mockReturnValue({ addAccount, connect } as unknown as ReturnType<typeof useEmailStore>);
  window.electronAPI = { oauth: { listProviders, startFlow } } as unknown as typeof window.electronAPI;
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

describe('first-run email connection', () => {
  // Regression: direct connect bypassed runtime creation and failed on a fresh install.
  it('activates a new Gmail account before the onboarding step advances', async () => {
    listProviders.mockResolvedValue({
      success: true,
      data: [{ id: 'gmail', label: 'Gmail / Google Workspace', purpose: 'email', configured: true }],
    });
    startFlow.mockResolvedValue({
      success: true,
      data: { email: 'demo@example.com', imap: { host: 'imap.gmail.com', port: 993, secure: true } },
    });
    const onNext = vi.fn();
    const onSyncStarted = vi.fn();
    const view = render(<IMAPStep onNext={onNext} onBack={vi.fn()} onSyncStarted={onSyncStarted} />);
    await settle();

    fire(button(view, 'Sign in with Gmail'), 'click');
    await settle();

    expect(addAccount).toHaveBeenCalledWith({
      host: 'imap.gmail.com',
      port: 993,
      secure: true,
      username: 'demo@example.com',
      password: '',
      authMethod: 'oauth2',
      oauthProvider: 'gmail',
    });
    expect(connect).not.toHaveBeenCalled();
    expect(onSyncStarted).toHaveBeenCalledOnce();
    expect(onNext).toHaveBeenCalledOnce();
  });

  // Regression: manual IMAP took the same direct-connect path with no sync engine.
  it('activates a new manual IMAP account on a fresh install', async () => {
    listProviders.mockResolvedValue({ success: true, data: [] });
    const onNext = vi.fn();
    const view = render(<IMAPStep onNext={onNext} onBack={vi.fn()} onSyncStarted={vi.fn()} />);
    await settle();

    typeInto(view.find('input[type="email"]'), 'demo@example.com');
    typeInto(view.find('input[type="password"]'), 'test password');
    fire(button(view, 'Connect & Continue'), 'click');
    await settle();

    expect(addAccount).toHaveBeenCalledWith({
      host: 'imap.sarv.com',
      port: 9993,
      username: 'demo@example.com',
      password: 'testpassword',
      secure: true,
      allowInsecureTLS: undefined,
    });
    expect(connect).not.toHaveBeenCalled();
    expect(onNext).toHaveBeenCalledOnce();
  });

  // A failed account activation must leave onboarding open with its error visible.
  it('does not advance when creating the Gmail account fails', async () => {
    listProviders.mockResolvedValue({
      success: true,
      data: [{ id: 'gmail', label: 'Gmail / Google Workspace', purpose: 'email', configured: true }],
    });
    startFlow.mockResolvedValue({
      success: true,
      data: { email: 'demo@example.com', imap: { host: 'imap.gmail.com', port: 993, secure: true } },
    });
    addAccount.mockRejectedValueOnce(new Error('Could not initialize mailbox'));
    const onNext = vi.fn();
    const onSyncStarted = vi.fn();
    const view = render(<IMAPStep onNext={onNext} onBack={vi.fn()} onSyncStarted={onSyncStarted} />);
    await settle();

    fire(button(view, 'Sign in with Gmail'), 'click');
    await settle();

    expect(view.container.textContent).toContain('Could not initialize mailbox');
    expect(onSyncStarted).not.toHaveBeenCalled();
    expect(onNext).not.toHaveBeenCalled();
  });
});
