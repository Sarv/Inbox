// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';

import {
  ExtensionPermissionPrompt,
  type PermissionPromptExtension,
} from '../../../../../src/components/extensions/ExtensionPermissionPrompt';
import { cleanup, render } from '../../../../helpers/render';

/**
 * The registry install prompt tells the user what an extension IS, not only
 * what it asks for (CASA audit L-9).
 *
 * What breaks if this file goes red: the consent screen goes back to implying a
 * sandbox. An extension's code runs with full Node in the extension process —
 * it can read the app's database key, mail databases and logs whatever its
 * manifest says — and its permissions only gate the app APIs it can call. A
 * prompt that shows the trust warning only for "sensitive" permissions, or says
 * an extension with none can do "Nothing", tells the user the opposite.
 */

const extension = (permissions: string[]): PermissionPromptExtension => ({
  id: 'com.example.otp',
  name: 'OTP Finder',
  version: '1.2.0',
  author: 'Example',
  description: 'Surfaces verification codes',
  permissions,
  sourceUrl: 'https://example.test/otp',
  download: { url: 'https://example.test/otp.zip', sha256: 'a'.repeat(64), size: 2048 },
});

const mount = (permissions: string[]) =>
  render(<ExtensionPermissionPrompt extension={extension(permissions)} onConfirm={() => {}} onCancel={() => {}} />);

/** The always-on trust notice, as rendered. */
const notice = (view: ReturnType<typeof mount>) => view.find('[role="note"]')?.textContent ?? '';

afterEach(() => cleanup());

describe('ExtensionPermissionPrompt trust notice', () => {
  // Regression (L-9): the warning lived behind `sensitive &&`, so an extension
  // asking for nothing got no warning at all — exactly the one a user would
  // assume is harmless.
  it('says it runs as full code with the app’s access even when it asks for no permissions', () => {
    const view = mount([]);

    expect(notice(view)).toContain('runs as full code on your computer');
    expect(notice(view)).toContain('same access to your files and mail data as Sarv Inbox itself');
    expect(notice(view)).toContain('whatever permissions it asks for');
    expect(notice(view)).toContain('Only install extensions you trust');
  });

  // Regression (L-9): "Nothing — it asks for no permissions at all." and a
  // "will be able to" heading presented the permission list as everything the
  // extension can do.
  it('frames the list as what it asks the app for, not as everything it can do', () => {
    const view = mount([]);
    const text = view.container.textContent ?? '';

    expect(text).toContain('What it asks the app for:');
    expect(text).toContain('No app permissions.');
    expect(text).not.toContain('will be able to');
    expect(text).not.toMatch(/Nothing/);
  });

  // Regression: the notice must not depend on which permissions are present —
  // a low-risk list is no safer than an empty one.
  it('shows the notice for a low-risk list too, without the sensitive line', () => {
    const view = mount(['ui:notify']);

    expect(notice(view)).toContain('runs as full code on your computer');
    expect(notice(view)).not.toContain('sensitive permissions');
  });

  // Regression: a sensitive permission still gets called out on top of the
  // notice, so the riskiest grants are not lost in the general warning.
  it('adds the sensitive-permission line when one is asked for', () => {
    const view = mount(['email:read', 'ui:notify']);

    expect(notice(view)).toContain('runs as full code on your computer');
    expect(notice(view)).toContain('It also asks for sensitive permissions, marked above.');
  });

  // L-9: the checksum comes from the same registry as the package, so it is
  // not a publisher check. Breaks: a green "Verified download" shield tells
  // the user the extension itself was vetted.
  it('presents the checksum as damage detection, not as verification of the author', () => {
    const view = mount([]);
    const text = view.container.textContent ?? '';

    expect(text).toContain('Download checksum');
    expect(text).toContain('catches a damaged download, not a malicious author');
    expect(text).not.toContain('Verified');
  });

  // L-9: network:fetch is not enforced. Breaks: the prompt implies that
  // without it an extension cannot reach the network.
  it('describes network access as a declaration, not a grant', () => {
    const view = mount(['network:fetch']);
    expect(view.container.textContent).toContain('Says it will send and receive data over the internet');
  });
});
