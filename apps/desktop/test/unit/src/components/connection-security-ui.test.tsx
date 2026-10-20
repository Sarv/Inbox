// @vitest-environment happy-dom
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConnectionDialog } from '../../../../src/components/ConnectionDialog';
import { ConnectionSecurityBanner } from '../../../../src/components/ConnectionSecurityBanner';
import { ConnectionSecuritySelect } from '../../../../src/components/ConnectionSecuritySelect';
import { SmtpConfigForm } from '../../../../src/components/SmtpConfigForm';
import { fire, render, settle, typeInto, type Mounted } from '../../../helpers/render';

// The account forms for connection security (CASA M-5). STARTTLS now REQUIRES
// encryption, so a server without it only works with an explicit None — which
// therefore has to be offered, stored and kept everywhere. What breaks if this
// file fails: a user's None (or STARTTLS) is lost on save or re-auth, so the
// account stops connecting; None is chosen without being told what it means;
// or a refused STARTTLS is never explained.

const state: Record<string, unknown> = {};
vi.mock('../../../../src/store/email-store', () => ({
  useEmailStore: (select?: (s: Record<string, unknown>) => unknown) => (select ? select(state) : state),
}));

let mounted: Mounted | null = null;
const text = () => mounted!.container.textContent ?? '';
const setSelect = (element: Element | null, value: string) => {
  if (!element) throw new Error('missing select');
  act(() => {
    (element as HTMLSelectElement).value = value;
    element.dispatchEvent(new Event('change', { bubbles: true }));
  });
};
const submitForm = async () => {
  const form = mounted!.find('form');
  await act(async () => { form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
  await settle();
};

beforeEach(() => {
  for (const key of Object.keys(state)) delete state[key];
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    secureCreds: { hasPassword: vi.fn(async () => ({ success: true, data: false })), available: vi.fn(async () => ({ success: true, data: true })) },
  };
});
afterEach(() => {
  mounted?.unmount();
  mounted = null;
  document.body.innerHTML = '';
});

describe('ConnectionSecuritySelect', () => {
  // Breaks: switching security leaves the port of the old mode (993 with
  // STARTTLS), so the connect fails for a reason the user cannot see.
  it('reports the choice with the matching default port for each server', () => {
    const onChange = vi.fn();
    mounted = render(<ConnectionSecuritySelect server="imap" value="ssl" onChange={onChange} />);
    setSelect(mounted.byLabel('Incoming connection security'), 'starttls');
    expect(onChange).toHaveBeenLastCalledWith('starttls', 143);
    mounted.rerender(<ConnectionSecuritySelect server="smtp" value="ssl" onChange={onChange} />);
    setSelect(mounted.byLabel('Sending connection security'), 'none');
    expect(onChange).toHaveBeenLastCalledWith('none', 25);
  });

  // Breaks: None is picked without being told the password can go unencrypted.
  it('says what None means, and only for None', () => {
    mounted = render(<ConnectionSecuritySelect server="imap" value="starttls" onChange={vi.fn()} />);
    expect(text()).not.toContain('sent unencrypted');
    mounted.rerender(<ConnectionSecuritySelect server="imap" value="none" onChange={vi.fn()} />);
    expect(text()).toContain('Your password and mail are sent unencrypted unless the server offers encryption');
  });
});

describe('SmtpConfigForm', () => {
  const connectSmtp = vi.fn(async () => {});
  beforeEach(() => {
    connectSmtp.mockClear();
    Object.assign(state, { imapConfig: { host: 'imap.x.com', username: 'me@x.com' }, connectSmtp, markSmtpConfigured: vi.fn(), activeAccountId: 'acct-1' });
  });

  // Breaks: a saved None reads back as STARTTLS (it was read from `secure`
  // alone) and the next save turns it into a required upgrade.
  it('shows the saved choice, None included, and a legacy secure:false as STARTTLS', () => {
    state.smtpConfig = { host: 'smtp.x.com', port: 25, secure: false, security: 'none', username: 'me@x.com' };
    mounted = render(<SmtpConfigForm onVerified={vi.fn()} />);
    expect((mounted.byLabel('Sending connection security') as HTMLSelectElement).value).toBe('none');
    mounted.unmount();
    state.smtpConfig = { host: 'smtp.x.com', port: 587, secure: false, username: 'me@x.com' };
    mounted = render(<SmtpConfigForm onVerified={vi.fn()} />);
    expect((mounted.byLabel('Sending connection security') as HTMLSelectElement).value).toBe('starttls');
  });

  it('sends the choice itself, not just `secure`', async () => {
    state.smtpConfig = { host: 'smtp.x.com', port: 465, secure: true, username: 'me@x.com' };
    mounted = render(<SmtpConfigForm onVerified={vi.fn()} />);
    setSelect(mounted.byLabel('Sending connection security'), 'none');
    typeInto(mounted.find('input[type="password"]'), 'pw');
    await submitForm();
    expect(connectSmtp).toHaveBeenCalledWith(expect.objectContaining({ security: 'none', secure: false, port: 25 }));
  });

  // An OAuth connection always checks the certificate (core resolveTlsOptions),
  // so the box would do nothing. Breaks: an OAuth user ticks a box that is
  // silently ignored, or a saved stale opt-in rides along on every send.
  it('offers "allow self-signed" for a password account only, and never sends it for OAuth', async () => {
    state.smtpConfig = { host: 'smtp.x.com', port: 465, secure: true, username: 'me@x.com', allowInsecureTLS: true };
    mounted = render(<SmtpConfigForm onVerified={vi.fn()} />);
    expect(text()).toContain('Allow self-signed');
    mounted.unmount();
    state.imapConfig = { host: 'imap.gmail.com', username: 'me@gmail.com', authMethod: 'oauth2', oauthProvider: 'gmail' };
    state.smtpConfig = { host: 'smtp.gmail.com', port: 465, secure: true, username: 'me@gmail.com', authMethod: 'oauth2', allowInsecureTLS: true };
    mounted = render(<SmtpConfigForm onVerified={vi.fn()} />);
    expect(text()).not.toContain('Allow self-signed');
    await submitForm();
    expect(connectSmtp).toHaveBeenCalledWith(expect.objectContaining({ authMethod: 'oauth2', allowInsecureTLS: undefined }));
  });
});

describe('ConnectionDialog (re-auth)', () => {
  const connect = vi.fn(async () => {});
  beforeEach(() => { connect.mockClear(); Object.assign(state, { connect, accounts: [], activeAccountId: null }); });

  // Breaks: re-entering a password turns a STARTTLS or None account into
  // implicit TLS on its old port (it sent `secure: true`), so it cannot
  // reconnect, and drops the self-signed choice.
  it('keeps the account\'s connection security and self-signed choice', async () => {
    state.imapConfig = { host: 'mail.x.com', port: 143, username: 'me@x.com', secure: false, security: 'none', allowInsecureTLS: true };
    mounted = render(<ConnectionDialog />);
    typeInto(mounted.find('input[type="password"]'), 'new-pw');
    await submitForm();
    expect(connect).toHaveBeenCalledWith(expect.objectContaining({ host: 'mail.x.com', port: 143, security: 'none', secure: false, allowInsecureTLS: true }));
  });

  it('resolves a legacy account from `secure`', async () => {
    state.imapConfig = { host: 'imap.x.com', port: 993, username: 'me@x.com', secure: true };
    mounted = render(<ConnectionDialog />);
    typeInto(mounted.find('input[type="password"]'), 'new-pw');
    await submitForm();
    expect(connect).toHaveBeenCalledWith(expect.objectContaining({ security: 'ssl', secure: true }));
  });
});

describe('ConnectionSecurityBanner', () => {
  // Breaks: a refused STARTTLS leaves the user with "Disconnected" and no idea
  // why, or the banner lingers after the account reconnects.
  it('explains a refused STARTTLS and links to account settings until it connects', () => {
    const onFix = vi.fn();
    Object.assign(state, { connectionSecurityIssue: 'The incoming mail server x did not agree to encrypt this session (STARTTLS).', connected: false });
    mounted = render(<ConnectionSecurityBanner onFix={onFix} />);
    expect(text()).toContain('the mail server would not use encryption');
    expect(text()).toContain('did not agree to encrypt');
    fire([...mounted.container.querySelectorAll('button')].find((b) => b.textContent?.includes('Account settings'))!, 'click');
    expect(onFix).toHaveBeenCalledOnce();

    state.connected = true;
    mounted.rerender(<ConnectionSecurityBanner onFix={onFix} />);
    expect(text()).toBe('');
  });

  it('shows nothing without an issue', () => {
    Object.assign(state, { connectionSecurityIssue: null, smtpSecurityIssue: null, connected: false });
    mounted = render(<ConnectionSecurityBanner onFix={vi.fn()} />);
    expect(text()).toBe('');
  });

  // The sending server refused STARTTLS. Every caller but the settings form
  // swallows that error. Breaks: mail waits in the Outbox forever while the
  // account looks fine.
  it('explains a refused sending server even while incoming mail is connected', () => {
    Object.assign(state, { connectionSecurityIssue: null, smtpSecurityIssue: 'The outgoing mail server smtp.x did not agree to encrypt this session (STARTTLS).', connected: true });
    mounted = render(<ConnectionSecurityBanner onFix={vi.fn()} />);
    expect(text()).toContain("Can't send: the outgoing mail server would not use encryption.");
    expect(text()).toContain('smtp.x did not agree');
    expect(text()).toContain('wait in the Outbox');

    state.smtpSecurityIssue = null;
    mounted.rerender(<ConnectionSecurityBanner onFix={vi.fn()} />);
    expect(text()).toBe('');
  });

  it('leads with the incoming refusal and mentions sending when both are refused', () => {
    Object.assign(state, { connectionSecurityIssue: 'The incoming mail server x did not agree.', smtpSecurityIssue: 'The outgoing mail server y did not agree.', connected: false });
    mounted = render(<ConnectionSecurityBanner onFix={vi.fn()} />);
    expect(text()).toContain('Not connected: the mail server would not use encryption.');
    expect(text()).toContain('Sending is refused the same way.');
  });

  // Breaks: dismissing one refusal hides a later, different one.
  it('comes back for a new refusal after being dismissed', () => {
    Object.assign(state, { connectionSecurityIssue: 'The incoming mail server x did not agree.', smtpSecurityIssue: null, connected: false });
    mounted = render(<ConnectionSecurityBanner onFix={vi.fn()} />);
    fire(mounted.container.querySelector('button[aria-label^="Dismiss"], button[title^="Dismiss"]') ?? [...mounted.container.querySelectorAll('button')].find((b) => !b.textContent?.includes('Account settings'))!, 'click');
    expect(text()).toBe('');
    state.smtpSecurityIssue = 'The outgoing mail server y did not agree.';
    mounted.rerender(<ConnectionSecurityBanner onFix={vi.fn()} />);
    expect(text()).toContain('Not connected');
  });
});
