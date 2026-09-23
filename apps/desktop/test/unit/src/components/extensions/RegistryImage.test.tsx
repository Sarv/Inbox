// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RegistryImage } from '../../../../../src/components/extensions/RegistryImage';
import { fire, render } from '../../../../helpers/render';

/**
 * Every icon and screenshot in the extensions panel.
 *
 * What breaks if this file goes red: the panel goes back to fetching each
 * picture from `raw.githubusercontent.com`, which has no edge in much of the
 * world - a panel of icons that each take seconds reads as a broken panel. The
 * other half is the failure path. A mirror that cannot serve one file must cost
 * a single retry against the canonical host, not a missing icon; and the
 * "picture is unavailable" callback, which callers use to hide a broken image,
 * must not fire until BOTH hosts have failed.
 */

const ICON_URL =
  'https://raw.githubusercontent.com/Sarv/SarvInbox-extensions/main/registry/icons/otp-code.png';
const MIRROR_ICON_URL =
  'https://cdn.jsdelivr.net/gh/Sarv/SarvInbox-extensions@main/registry/icons/otp-code.png';

let mounted: ReturnType<typeof render> | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  document.body.innerHTML = '';
});

const image = () => mounted!.find('img') as HTMLImageElement;

describe('RegistryImage', () => {
  it('asks the CDN mirror first', () => {
    mounted = render(<RegistryImage src={ICON_URL} alt="OTP Code" className="h-8 w-8" />);

    expect(image().getAttribute('src')).toBe(MIRROR_ICON_URL);
    // The rest of the props still reach the <img>, or swapping it in silently
    // dropped the sizing and the alt text at five call sites.
    expect(image().getAttribute('alt')).toBe('OTP Code');
    expect(image().className).toBe('h-8 w-8');
  });

  it('retries the canonical URL when the mirror does not serve the file', () => {
    const onUnavailable = vi.fn();
    mounted = render(<RegistryImage src={ICON_URL} alt="" onUnavailable={onUnavailable} />);

    fire(image(), 'error');

    expect(image().getAttribute('src')).toBe(ICON_URL);
    expect(onUnavailable).not.toHaveBeenCalled();
  });

  it('reports the picture unavailable only once both hosts have failed', () => {
    const onUnavailable = vi.fn();
    mounted = render(<RegistryImage src={ICON_URL} alt="" onUnavailable={onUnavailable} />);

    fire(image(), 'error');
    fire(image(), 'error');

    expect(onUnavailable).toHaveBeenCalledTimes(1);
  });

  it('fetches a URL the mirror cannot serve from its own host', () => {
    const onUnavailable = vi.fn();
    const elsewhere = 'https://example.com/icon.png';
    mounted = render(<RegistryImage src={elsewhere} alt="" onUnavailable={onUnavailable} />);

    expect(image().getAttribute('src')).toBe(elsewhere);

    // Nothing to fall back to, so the first failure is the final one - waiting
    // for a second would leave a broken image showing forever.
    fire(image(), 'error');
    expect(onUnavailable).toHaveBeenCalledTimes(1);
  });

  it('starts again at the mirror when the same element is reused for another extension', () => {
    const other =
      'https://raw.githubusercontent.com/Sarv/SarvInbox-extensions/main/registry/icons/quick-reply.png';
    mounted = render(<RegistryImage src={ICON_URL} alt="" />);
    fire(image(), 'error');
    expect(image().getAttribute('src')).toBe(ICON_URL);

    // A list that rebuilds on every keystroke reuses these, so a fallback that
    // stuck would push the whole panel onto the slow host after one bad icon.
    mounted.rerender(<RegistryImage src={other} alt="" />);

    expect(image().getAttribute('src')).toBe(
      'https://cdn.jsdelivr.net/gh/Sarv/SarvInbox-extensions@main/registry/icons/quick-reply.png'
    );
  });
});
