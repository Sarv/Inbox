import { describe, it, expect } from 'vitest';

import { isTrustedRegistryUrl } from '../../../src/extensions/marketplace';
import {
  REGISTRY_MIRROR_HOST,
  registryMirrorUrl,
} from '../../../src/extensions/registry-mirror';

/**
 * The mirror is only useful if the app is allowed to accept what it serves, and
 * only safe if it never rewrites a URL to a DIFFERENT file. Both halves are
 * here: get the rewrite wrong and the fallback hides it as a slow install; get
 * the allowlist wrong and every mirrored fetch is rejected as untrusted.
 */
describe('registryMirrorUrl', () => {
  it('rewrites a raw.githubusercontent.com file to its jsDelivr equivalent', () => {
    expect(
      registryMirrorUrl(
        'https://raw.githubusercontent.com/Sarv/SarvInbox-extensions/main/registry/index.json'
      )
    ).toBe(
      'https://cdn.jsdelivr.net/gh/Sarv/SarvInbox-extensions@main/registry/index.json'
    );
  });

  it('keeps a deep path intact', () => {
    // Regression: joining the path back with the wrong separator, or dropping a
    // segment, would silently point at a file that does not exist - which the
    // fallback would paper over as "the mirror was down" on every single fetch.
    expect(
      registryMirrorUrl(
        'https://raw.githubusercontent.com/Sarv/SarvInbox-extensions/main/extensions/otp-code/icon.svg'
      )
    ).toBe(
      'https://cdn.jsdelivr.net/gh/Sarv/SarvInbox-extensions@main/extensions/otp-code/icon.svg'
    );
  });

  it('has no mirror for a host it does not serve', () => {
    expect(
      registryMirrorUrl(
        'https://github.com/Sarv/SarvInbox-extensions/releases/download/otp-code-v1.2.0/otp-code-1.2.0.tgz'
      )
    ).toBeNull();
    expect(registryMirrorUrl('https://api.github.com/repos/Sarv/SarvInbox-extensions')).toBeNull();
  });

  it('has no mirror for a URL already on the mirror', () => {
    // Otherwise a retry would rewrite the rewrite and ask for /gh/gh/...
    expect(
      registryMirrorUrl('https://cdn.jsdelivr.net/gh/Sarv/x@main/registry/index.json')
    ).toBeNull();
  });

  it('refuses plain http even on the mirrored host', () => {
    // A downgrade must not become a way to reach the CDN at all.
    expect(
      registryMirrorUrl('http://raw.githubusercontent.com/Sarv/x/main/registry/index.json')
    ).toBeNull();
  });

  it('has no mirror for a URL with nothing to fetch', () => {
    expect(registryMirrorUrl('https://raw.githubusercontent.com/Sarv/x/main')).toBeNull();
    expect(registryMirrorUrl('https://raw.githubusercontent.com/Sarv/x')).toBeNull();
    expect(registryMirrorUrl('https://raw.githubusercontent.com/')).toBeNull();
  });

  it('has no mirror for something that is not a URL', () => {
    expect(registryMirrorUrl('not a url')).toBeNull();
    expect(registryMirrorUrl('')).toBeNull();
  });

  it('is a host the registry is allowed to be served from', () => {
    // Regression: rewriting to a host the allowlist rejects would turn every
    // mirrored document into "untrusted registry" instead of a faster fetch.
    expect(isTrustedRegistryUrl(`https://${REGISTRY_MIRROR_HOST}/gh/Sarv/x@main/a.json`)).toBe(
      true
    );
  });
});
