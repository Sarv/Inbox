// @vitest-environment happy-dom
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PgpViewResult } from '../../../../../electron/services/pgp-reader';
import { PgpMessageView } from '../../../../../src/components/email-detail/PgpMessageView';
import { render, settle, typeInto, type Mounted } from '../../../../helpers/render';

/**
 * The OpenPGP reader. What this protects: an encrypted message showing its
 * "Encrypted message" placeholder instead of the plaintext; a locked key with
 * no way to unlock from the message; a decrypted attachment that cannot be
 * saved; and a signed message losing the stored body it already had.
 */
vi.mock('../../../../../src/components/Tooltip', () => ({
  Tooltip: ({ children, content, delayMs }: { children: React.ReactNode; content: string; delayMs?: number }) => (
    <span data-tooltip={content} data-tooltip-delay={delayMs}>
      {children}
    </span>
  ),
}));
vi.mock('../../../../../src/components/SandboxedEmailBody', () => ({
  SandboxedEmailBody: ({ html, remoteImagesFrom }: { html: string; remoteImagesFrom?: { accountId?: string | null; authStatus?: string | null; tags?: string | null } }) => (
    <div data-sandboxed data-image-account={remoteImagesFrom?.accountId} data-image-auth={remoteImagesFrom?.authStatus} data-image-tags={remoteImagesFrom?.tags}>{html}</div>
  ),
}));
vi.mock('../../../../../src/components/attachment-viewer/AttachmentViewer', () => ({
  formatSize: (size: number) => `${size} B`,
}));

const opened = (over: Partial<Extract<PgpViewResult, { ok: true }>> = {}): PgpViewResult => ({
  ok: true,
  wasEncrypted: true,
  signature: { status: 'valid', signerEmails: ['gee@example.org'], fromMatches: true },
  contentType: 'html',
  body: '<p>the secret plan</p>',
  attachments: [{ index: 0, name: 'plan.pdf', contentType: 'application/pdf', size: 13 }],
  ...over,
});

const api = {
  open: vi.fn<(id: string, accountId?: string) => Promise<PgpViewResult>>(),
  saveAttachment: vi.fn(),
  listOwnKeys: vi.fn(),
  unlock: vi.fn(),
};

let mounted: Mounted | null = null;
const mount = async (pgpStatus: 'encrypted' | 'signed' | null) => {
  mounted = render(
    <PgpMessageView email={{ id: 'e1', accountId: 'acct', pgpStatus, fromAddress: 'gee@example.org' }}>
      <div data-stored>stored body</div>
    </PgpMessageView>,
  );
  await settle();
  return mounted;
};

beforeEach(() => {
  Object.values(api).forEach((fn) => fn.mockReset());
  (window as unknown as { electronAPI: unknown }).electronAPI = { pgp: api };
});
afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

describe('PgpMessageView', () => {
  // Breaks: every ordinary message pays an IPC round trip, or loses its body.
  it('renders the stored body untouched for non-PGP mail', async () => {
    const view = await mount(null);
    expect(view.find('[data-stored]')).not.toBeNull();
    expect(api.open).not.toHaveBeenCalled();
  });

  // Breaks: the core of decrypt-on-view — the placeholder shows instead of the plaintext.
  it('shows the decrypted body, the badge and the attachments', async () => {
    api.open.mockResolvedValue(opened());
    const view = await mount('encrypted');
    expect(api.open).toHaveBeenCalledWith('e1', 'acct');
    expect(view.find('[data-sandboxed]')?.textContent).toBe('<p>the secret plan</p>');
    expect(view.find('[data-stored]')).toBeNull();
    expect(view.find('[data-pgp-badge]')?.textContent).toBe('Encrypted · Signed');
    expect(view.find('[data-tooltip="Save plan.pdf"]')?.getAttribute('data-tooltip-delay')).toBe('40');
  });

  // Breaks: decrypted HTML bypasses the reader's account, auth and category image policy.
  it('passes the encrypted message facts to the remote image policy', async () => {
    api.open.mockResolvedValue(opened());
    mounted = render(
      <PgpMessageView
        email={{ id: 'e1', pgpStatus: 'encrypted', fromAddress: 'gee@example.org', tags: 'Social', authStatus: '{"dmarc":"fail"}' }}
        paneAccountId="thread-account"
      >
        <div data-stored>stored body</div>
      </PgpMessageView>,
    );
    await settle();
    expect(api.open).toHaveBeenCalledWith('e1', 'thread-account');
    const body = mounted.find('[data-sandboxed]');
    expect(body?.getAttribute('data-image-account')).toBe('thread-account');
    expect(body?.getAttribute('data-image-auth')).toBe('{"dmarc":"fail"}');
    expect(body?.getAttribute('data-image-tags')).toBe('Social');
    api.saveAttachment.mockResolvedValue({ success: true });
    await act(async () => mounted!.byLabel('Save plan.pdf')!.click());
    expect(api.saveAttachment).toHaveBeenCalledWith('e1', 'thread-account', 0);
  });

  // Breaks: a text-only encrypted message shows as HTML (or not at all).
  it('shows a plain-text decrypted body as text', async () => {
    api.open.mockResolvedValue(opened({ contentType: 'text', body: 'plain secret', attachments: [] }));
    const view = await mount('encrypted');
    expect(view.container.textContent).toContain('plain secret');
    expect(view.find('[data-sandboxed]')).toBeNull();
  });

  // Breaks: saving a decrypted attachment does nothing, or fails silently.
  it('saves an attachment through main and shows a save error', async () => {
    api.open.mockResolvedValue(opened());
    api.saveAttachment.mockResolvedValue({ success: false, error: 'Open the message again' });
    const view = await mount('encrypted');
    await act(async () => view.byLabel('Save plan.pdf')!.click());
    await settle();
    expect(api.saveAttachment).toHaveBeenCalledWith('e1', 'acct', 0);
    expect(view.container.textContent).toContain('Open the message again');
  });

  // Breaks: accepting the missing-setup warning for a decrypted attachment
  // presents its saved plaintext as scanned, or labels a different attachment.
  it('marks only the successfully saved unscanned decrypted attachment', async () => {
    api.open.mockResolvedValue(opened({ attachments: [
      { index: 0, name: 'plan.pdf', contentType: 'application/pdf', size: 13 },
      { index: 1, name: 'notes.txt', contentType: 'text/plain', size: 8 },
    ] }));
    api.saveAttachment.mockResolvedValue({ success: true, data: { saved: true, notScanned: true } });
    const view = await mount('encrypted');
    await act(async () => view.byLabel('Save plan.pdf')!.click());
    expect(view.find('[role="status"]')?.textContent).toBe('Not scanned for viruses.');
    expect(view.byLabel('Save plan.pdf')!.parentElement!.parentElement!.textContent).toContain('Not scanned for viruses.');
    expect(view.byLabel('Save notes.txt')!.parentElement!.parentElement!.textContent).not.toContain('Not scanned for viruses.');
  });

  // Breaks: a cancelled save, ordinary local save, or unsuccessful scan reply
  // gets the same successful unscanned outcome as an accepted host warning.
  it.each([
    { success: true },
    { success: true, data: { saved: true } },
    { success: true, data: { saved: true, notScanned: 'true' } },
    { success: true, data: { saved: false, notScanned: true } },
    { success: false, error: 'Download blocked: encrypted OpenPGP attachments cannot be scanned.', data: { saved: true, notScanned: true } },
  ])('does not mark a failed, cancelled or unflagged save (%j)', async (reply) => {
    api.open.mockResolvedValue(opened());
    api.saveAttachment.mockResolvedValue(reply);
    const view = await mount('encrypted');
    await act(async () => view.byLabel('Save plan.pdf')!.click());
    expect(view.container.textContent).not.toContain('Not scanned for viruses.');
    if (!reply.success) expect(view.container.textContent).toContain(reply.error);
  });

  // Breaks: a stale unscanned outcome remains while a subsequent save is
  // pending, hiding that the new operation has not completed.
  it('clears the previous unscanned outcome when saving again', async () => {
    api.open.mockResolvedValue(opened());
    api.saveAttachment.mockResolvedValueOnce({ success: true, data: { saved: true, notScanned: true } });
    const view = await mount('encrypted');
    await act(async () => view.byLabel('Save plan.pdf')!.click());
    expect(view.container.textContent).toContain('Not scanned for viruses.');
    let finish!: (result: unknown) => void;
    api.saveAttachment.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    act(() => view.byLabel('Save plan.pdf')!.click());
    expect(view.container.textContent).not.toContain('Not scanned for viruses.');
    finish({ success: true, data: { saved: false } });
    await settle();
  });

  // Breaks: reusing the reader for another mailbox/message attributes an old
  // attachment's warning to the newly selected account, including late replies.
  it.each([
    { id: 'e2', accountId: 'acct' },
    { id: 'e1', accountId: 'other-account' },
  ])('binds a late unscanned save to its original message and account (%j)', async (target) => {
    api.open.mockResolvedValue(opened());
    let finish!: (result: unknown) => void;
    api.saveAttachment.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const view = await mount('encrypted');
    act(() => view.byLabel('Save plan.pdf')!.click());
    view.rerender(<PgpMessageView email={{ ...target, pgpStatus: 'encrypted' }}><div>stored</div></PgpMessageView>);
    await settle();
    finish({ success: true, data: { saved: true, notScanned: true } });
    await settle();
    expect(view.container.textContent).not.toContain('Not scanned for viruses.');
  });

  // Breaks: a signed message is replaced by nothing while its signature is checked.
  it('keeps the stored body for signed mail and adds the badge', async () => {
    api.open.mockResolvedValue(opened({ wasEncrypted: false }));
    const view = await mount('signed');
    expect(view.find('[data-stored]')).not.toBeNull();
    expect(view.find('[data-pgp-badge]')?.textContent).toBe('Signed');
  });

  // Breaks: the reader hangs on "Decrypting…" when the bridge rejects.
  it('turns a rejected open into a retryable failure, and retries', async () => {
    api.open.mockRejectedValueOnce(new Error('IPC gone')).mockResolvedValueOnce(opened());
    const view = await mount('encrypted');
    expect(view.container.textContent).toContain('could not be loaded');
    expect(view.container.textContent).toContain('IPC gone');
    const retry = [...view.container.querySelectorAll('button')].find((button) => button.textContent?.includes('Try again'));
    await act(async () => retry!.click());
    await settle();
    expect(api.open).toHaveBeenCalledTimes(2);
    expect(view.find('[data-sandboxed]')).not.toBeNull();
  });

  // Breaks: no key reads as a crash, with nothing telling the user where to go.
  it('explains a message none of the keys open', async () => {
    api.open.mockResolvedValue({ ok: false, code: 'no-key', error: 'no key' });
    const view = await mount('encrypted');
    expect(view.container.textContent).toContain('None of your keys can open this message');
    expect(view.byLabel('Key passphrase')).toBeNull();
  });

  // Breaks: a locked key cannot be unlocked from the message, or a wrong passphrase says nothing.
  it('unlocks with a passphrase and reopens the message', async () => {
    api.open.mockResolvedValueOnce({ ok: false, code: 'locked', error: 'locked' }).mockResolvedValue(opened());
    api.listOwnKeys.mockResolvedValue({ success: true, data: [{ fingerprint: 'A', unlocked: false }] });
    api.unlock.mockResolvedValueOnce({ success: false }).mockResolvedValueOnce({ success: true });
    const view = await mount('encrypted');
    const submit = () => act(async () => view.find('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));

    typeInto(view.byLabel('Key passphrase'), 'wrong');
    await submit();
    await settle();
    expect(view.container.textContent).toContain('did not unlock any of your keys');

    typeInto(view.byLabel('Key passphrase'), 'right');
    await submit();
    await settle();
    expect(api.unlock).toHaveBeenLastCalledWith('A', 'right');
    expect(view.find('[data-sandboxed]')).not.toBeNull();
  });

  // Breaks: a failing key list during unlock is swallowed with no feedback.
  it('shows an unlock error', async () => {
    api.open.mockResolvedValue({ ok: false, code: 'locked', error: 'locked' });
    api.listOwnKeys.mockRejectedValue(new Error('bridge down'));
    const view = await mount('encrypted');
    typeInto(view.byLabel('Key passphrase'), 'pass');
    await act(async () => view.find('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    await settle();
    expect(view.container.textContent).toContain('bridge down');
  });
});
