// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';

import {
  ExtensionScreenshots,
  ExtensionSurfaces,
} from '../../../../../src/components/extensions/ExtensionSurfaces';
import { act, fire, render } from '../../../../helpers/render';

/**
 * The "what is this thing" section, shown in the catalogue, the install prompt
 * and the installed list.
 *
 * What breaks if this file goes red: people are back to guessing what an
 * extension is for from a permission list that describes every extension the
 * same way. The screenshot half carries a second risk — a picture that fails to
 * load must leave nothing behind, because a torn image frame sitting next to an
 * Install button reads as a broken extension and stops the install.
 */

let mounted: ReturnType<typeof render> | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  document.body.innerHTML = '';
});

describe('ExtensionSurfaces', () => {
  it('renders a line per surface under its heading', () => {
    mounted = render(
      <ExtensionSurfaces
        source={{
          permissions: ['ui:notify'],
          contributes: { panels: [{ title: 'Passcodes', surface: 'sidebar' }] },
        }}
      />
    );

    expect(mounted.container.textContent).toContain('What it does');
    expect(mounted.container.textContent).toContain('Passcodes');
    expect(mounted.container.textContent).toContain('Shows cards in the corner');
  });

  // An extension that declares nothing must not leave a heading over empty
  // space — an empty "What it does" reads as a failure to load.
  it('renders nothing at all when there is nothing to say', () => {
    mounted = render(<ExtensionSurfaces source={{}} />);

    expect(mounted.container.textContent).toBe('');
  });

  it('can drop the heading for a card that already has one', () => {
    mounted = render(
      <ExtensionSurfaces source={{ permissions: ['ai:use'] }} heading={null} />
    );

    expect(mounted.container.textContent).not.toContain('What it does');
    expect(mounted.container.textContent).toContain('Uses the AI model');
  });
});

describe('ExtensionScreenshots', () => {
  const shot = {
    url: 'https://raw.githubusercontent.com/Sarv/x/main/one.png',
    caption: 'A code in the sidebar',
  };
  const MIRRORED_SHOT = 'https://cdn.jsdelivr.net/gh/Sarv/x@main/one.png';

  /** One failed load. Both hosts have to fail before a picture is given up on. */
  const failToLoad = async (image: Element) => {
    await act(async () => {
      image.dispatchEvent(new Event('error'));
    });
  };

  it('renders each picture with its caption as the alt text', () => {
    mounted = render(<ExtensionScreenshots screenshots={[shot]} />);
    const image = mounted.find('img');

    // Served through the CDN mirror, like every other registry picture; the
    // canonical URL is still what the screenshot was published under.
    expect(image!.getAttribute('src')).toBe(MIRRORED_SHOT);
    expect(image!.getAttribute('alt')).toBe(shot.caption);
    expect(mounted.container.textContent).toContain(shot.caption);
  });

  // Regression: a thumbnail is 224px of a picture whose content is text, so the
  // catalogue is only readable if clicking one opens it at full size - and it
  // has to open the one that was clicked.
  it('opens the clicked picture full size', () => {
    const second = { url: 'https://raw.githubusercontent.com/Sarv/x/main/two.png', caption: 'Two' };
    mounted = render(<ExtensionScreenshots screenshots={[shot, second]} />);

    fire(mounted.byLabel('View larger: Two'), 'click');

    const dialog = mounted.find('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog!.querySelector('img')!.getAttribute('src')).toBe(
      'https://cdn.jsdelivr.net/gh/Sarv/x@main/two.png'
    );
  });

  it('renders nothing when an extension published none', () => {
    mounted = render(<ExtensionScreenshots screenshots={undefined} />);

    expect(mounted.container.textContent).toBe('');
    expect(mounted.find('img')).toBeNull();
  });

  // Regression: the image is fetched from a remote host at draw time, so a
  // moved or deleted file is ordinary, not exceptional.
  it('removes a picture that fails to load on both hosts', async () => {
    mounted = render(<ExtensionScreenshots screenshots={[shot]} />);

    await failToLoad(mounted.find('img')!);

    // A mirror that cannot serve one file must cost a retry against the
    // canonical host, not a picture the extension actually published.
    expect(mounted.find('img')!.getAttribute('src')).toBe(shot.url);

    await failToLoad(mounted.find('img')!);

    expect(mounted.find('img')).toBeNull();
  });

  it('keeps the pictures that do load when one fails', async () => {
    const second = { url: 'https://raw.githubusercontent.com/Sarv/x/main/two.png' };
    mounted = render(<ExtensionScreenshots screenshots={[shot, second]} />);

    await failToLoad(mounted.container.querySelectorAll('img')[0]);
    await failToLoad(mounted.container.querySelectorAll('img')[0]);

    const remaining = mounted.container.querySelectorAll('img');
    expect(remaining).toHaveLength(1);
    expect(remaining[0].getAttribute('src')).toBe('https://cdn.jsdelivr.net/gh/Sarv/x@main/two.png');
  });
});
