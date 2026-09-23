// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ScreenshotLightbox } from '../../../../../src/components/extensions/ScreenshotLightbox';
import { fire, render } from '../../../../helpers/render';

/**
 * The full-size view of an extension's screenshots.
 *
 * What breaks if this file goes red: the catalogue is back to 224px thumbnails
 * of a panel whose whole point is the text inside it - people install without
 * being able to see what they are installing. The navigation half matters as
 * much: an overlay that cannot be closed, or that swallows Escape from the page
 * underneath, is worse than no overlay.
 */

const SHOTS = [
  { url: 'https://raw.githubusercontent.com/Sarv/x/main/one.png', caption: 'The panel' },
  { url: 'https://raw.githubusercontent.com/Sarv/x/main/two.png', caption: 'The warning' },
  { url: 'https://raw.githubusercontent.com/Sarv/x/main/three.png' },
];
const mirrored = (n: string) => `https://cdn.jsdelivr.net/gh/Sarv/x@main/${n}`;

let mounted: ReturnType<typeof render> | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  document.body.innerHTML = '';
});

const shown = () => mounted!.find('img')!.getAttribute('src');

describe('ScreenshotLightbox', () => {
  it('opens on the picture that was clicked, not the first one', () => {
    mounted = render(
      <ScreenshotLightbox screenshots={SHOTS} initialIndex={1} onClose={() => {}} />
    );

    expect(shown()).toBe(mirrored('two.png'));
    expect(mounted.container.textContent).toContain('The warning');
    expect(mounted.container.textContent).toContain('2 of 3');
  });

  it('wraps at both ends, so neither arrow reaches a blank frame', () => {
    mounted = render(
      <ScreenshotLightbox screenshots={SHOTS} initialIndex={0} onClose={() => {}} />
    );

    fire(mounted.byLabel('Previous screenshot'), 'click');
    expect(shown()).toBe(mirrored('three.png'));

    fire(mounted.byLabel('Next screenshot'), 'click');
    expect(shown()).toBe(mirrored('one.png'));
  });

  // Regression: the app's global shortcut handler has its own Escape branch, so
  // an overlay that doesn't take the key first closes itself AND whatever
  // Escape means on the page underneath.
  it('closes on Escape and stops the key reaching the page underneath', () => {
    const onClose = vi.fn();
    const underneath = vi.fn();
    document.addEventListener('keydown', underneath);
    mounted = render(
      <ScreenshotLightbox screenshots={SHOTS} initialIndex={0} onClose={onClose} />
    );

    fire(mounted.find('img'), 'keydown', { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(underneath).not.toHaveBeenCalled();
    document.removeEventListener('keydown', underneath);
  });

  it('moves with the arrow keys', () => {
    mounted = render(
      <ScreenshotLightbox screenshots={SHOTS} initialIndex={0} onClose={() => {}} />
    );

    fire(mounted.find('img'), 'keydown', { key: 'ArrowRight' });
    expect(shown()).toBe(mirrored('two.png'));

    fire(mounted.find('img'), 'keydown', { key: 'ArrowLeft' });
    expect(shown()).toBe(mirrored('one.png'));
  });

  it('closes from the button and from the backdrop, but not from the picture', () => {
    const onClose = vi.fn();
    mounted = render(
      <ScreenshotLightbox screenshots={SHOTS} initialIndex={0} onClose={onClose} />
    );

    fire(mounted.find('img'), 'click');
    expect(onClose).not.toHaveBeenCalled();

    fire(mounted.find('[role="dialog"]'), 'click');
    fire(mounted.byLabel('Close screenshots'), 'click');
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('offers no navigation for a single picture', () => {
    mounted = render(
      <ScreenshotLightbox screenshots={[SHOTS[0]]} initialIndex={0} onClose={() => {}} />
    );

    expect(mounted.byLabel('Next screenshot')).toBeNull();
    expect(mounted.container.textContent).not.toContain('1 of 1');
  });

  // Regression: the caller drops a picture that fails to load, and the one it
  // dropped can be the one on screen - an empty frame with no picture in it
  // gives the reader nothing to close.
  it('closes itself when the last picture it was showing is dropped', () => {
    const onClose = vi.fn();
    mounted = render(
      <ScreenshotLightbox screenshots={[SHOTS[0]]} initialIndex={0} onClose={onClose} />
    );

    mounted.rerender(<ScreenshotLightbox screenshots={[]} initialIndex={0} onClose={onClose} />);

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mounted.find('img')).toBeNull();
  });
});
