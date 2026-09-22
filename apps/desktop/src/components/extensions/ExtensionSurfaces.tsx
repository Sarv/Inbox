import { useState } from 'react';

import {
  describeExtensionSurfaces,
  type SurfaceSource,
} from '../../utils/extension-marketplace-display';

/**
 * "What this does, and where you will see it."
 *
 * The one answer to the question people actually have in front of an extension
 * — in the catalogue, in the install prompt, and in the installed list — so all
 * three say the same thing in the same words. Permissions say what it MAY
 * touch; this says what it will DO and where the result shows up.
 *
 * Everything rendered is derived from the manifest by
 * `describeExtensionSurfaces`, never author-written prose, so an extension
 * cannot claim here to do something the app will not let it do.
 */
export function ExtensionSurfaces({
  source,
  heading = 'What it does',
  className = '',
}: {
  source: SurfaceSource;
  /** Null hides the heading, for a card that already has one above it. */
  heading?: string | null;
  className?: string;
}) {
  const surfaces = describeExtensionSurfaces(source);
  if (surfaces.length === 0) return null;

  return (
    <div className={className}>
      {heading && <h3 className="text-sm font-medium mb-2">{heading}</h3>}
      <ul className="space-y-2">
        {surfaces.map((surface) => (
          <li key={surface.title} className="flex items-start gap-2.5">
            <span aria-hidden="true" className="text-base leading-5 shrink-0">
              {surface.icon}
            </span>
            <div className="min-w-0">
              <div className="text-sm">{surface.title}</div>
              <div className="text-xs text-muted-foreground">{surface.detail}</div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

export interface ScreenshotItem {
  url: string;
  caption?: string;
}

/**
 * Pictures of the extension in use.
 *
 * Remote images from the registry's own hosts — the URLs were checked against
 * the host allowlist when the registry was parsed, so nothing here can reach
 * an arbitrary server. A picture that fails to load is removed rather than
 * left as a broken frame: a torn image next to an Install button reads as a
 * broken extension.
 */
export function ExtensionScreenshots({
  screenshots,
  className = '',
}: {
  screenshots: readonly ScreenshotItem[] | undefined;
  className?: string;
}) {
  const [broken, setBroken] = useState<Record<string, true>>({});
  const usable = (screenshots ?? []).filter((shot) => !broken[shot.url]);
  if (usable.length === 0) return null;

  return (
    <div className={className}>
      <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1">
        {usable.map((shot) => (
          <figure key={shot.url} className="shrink-0 w-56">
            <img
              src={shot.url}
              alt={shot.caption ?? ''}
              loading="lazy"
              onError={() => setBroken((current) => ({ ...current, [shot.url]: true }))}
              className="w-56 rounded-lg border border-border bg-muted object-cover"
            />
            {shot.caption && (
              <figcaption className="text-[11px] text-muted-foreground mt-1">
                {shot.caption}
              </figcaption>
            )}
          </figure>
        ))}
      </div>
    </div>
  );
}
