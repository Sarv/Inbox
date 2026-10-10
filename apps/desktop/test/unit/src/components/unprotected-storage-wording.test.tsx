// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Security } from '../../../../src/components/security/Security';
import { SecurityStatusBanner } from '../../../../src/components/SecurityStatusBanner';
import { VaultPasswordField } from '../../../../src/components/VaultPasswordField';
import { act, render, settle, type Mounted } from '../../../helpers/render';

/**
 * Linux without a system keyring: Chromium's `basic_text` backend "encrypts"
 * with a key published in its source, so saved secrets are only obfuscated
 * (CASA M-1). Main reports that as `secureCreds.available` = false.
 *
 * What breaks if this file goes red: on such a device the app tells the user a
 * secret is protected when anyone who copies the profile can read it — the
 * banner goes missing or leaves something out, the Security overview says the
 * mail key "lives in the operating system keychain", or a saved password is
 * labelled "Saved securely". On macOS/Windows (or when the check can't run) a
 * false alarm would teach users to ignore the real one.
 */
type Available = { success: boolean; data?: boolean } | Error;

let mounted: Mounted | null = null;

const setApi = (available: Available, extra: Record<string, unknown> = {}) => {
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    secureCreds: {
      available: vi.fn(async () => {
        if (available instanceof Error) throw available;
        return available;
      }),
      hasPassword: vi.fn(async () => ({ success: true, data: true })),
    },
    security: { getHeaderBackfillState: async () => ({ success: false }), onHeaderBackfillProgress: () => () => {} },
    spam: {
      getReputationState: async () => ({ success: false }),
      onReputationProgress: () => () => {},
      kickReputation: async () => ({ success: true }),
    },
    ...extra,
  };
};
const text = () => mounted!.container.textContent ?? '';

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  document.body.innerHTML = '';
});

describe('SecurityStatusBanner', () => {
  it('warns on a device with no keyring, naming everything exposed, and can be dismissed', async () => {
    setApi({ success: true, data: false });
    mounted = render(<SecurityStatusBanner />);
    await settle();
    expect(text()).toContain("Saved sign-ins aren't protected on this device.");
    expect(text()).toContain('passwords, sign-in tokens, AI keys, OpenPGP keys kept without a passphrase and the key to your stored mail');
    await act(async () => { (mounted!.byLabel('Dismiss') as HTMLButtonElement).click(); });
    expect(text()).toBe('');
  });

  it.each<[string, Available]>([
    ['protected', { success: true, data: true }],
    ['a failed check', { success: false }],
    ['a check that throws', new Error('ipc down')],
  ])('shows nothing for %s', async (_name, available) => {
    setApi(available);
    mounted = render(<SecurityStatusBanner />);
    await settle();
    expect(text()).toBe('');
  });
});

describe('Security overview — Encrypted mail cache', () => {
  const card = () => mounted!.find('[data-protection="Encrypted mail cache"]')?.textContent ?? '';

  it('says the mail key is only obfuscated where there is no keyring', async () => {
    setApi({ success: true, data: false });
    mounted = render(<Security initialTab="overview" />);
    await settle();
    expect(card()).toContain('this system has no keyring');
    expect(card()).not.toContain('lives in the operating system keychain');
  });

  it('keeps the keychain wording where the key store protects it', async () => {
    setApi({ success: true, data: true });
    mounted = render(<Security initialTab="overview" />);
    await settle();
    expect(card()).toContain('the key lives in the operating system keychain');
  });
});

describe('VaultPasswordField — a saved password', () => {
  const field = () => <VaultPasswordField accountId="acct-1" kind="imap" value="" onChange={() => {}} />;

  it('is not called "Saved securely" where there is no keyring', async () => {
    setApi({ success: true, data: false });
    mounted = render(field());
    await settle();
    expect(text()).toContain('Saved, but not protected on this device (no system keyring)');
    expect(text()).not.toContain('Saved securely');
  });

  it('is "Saved securely" where the key store protects it', async () => {
    setApi({ success: true, data: true });
    mounted = render(field());
    await settle();
    expect(text()).toContain('Saved securely — click the eye');
  });
});
