import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { useEffect } from 'react';

import { useGalleryNavigation } from '../../hooks/useGalleryNavigation';
import { Tooltip } from '../Tooltip';

import { RegistryImage } from './RegistryImage';

export interface LightboxScreenshot {
  url: string;
  caption?: string;
}

/**
 * The extension screenshots, one at a time and as large as the window allows.
 *
 * The thumbnails in the catalogue are 224px wide, which is enough to tell two
 * screenshots apart and not enough to read one: the whole point of a picture
 * of a panel is the text in it. This is where that picture is actually legible,
 * so a reader can see what they are about to install before they install it.
 */
export function ScreenshotLightbox({
  screenshots,
  initialIndex,
  onClose,
}: {
  screenshots: readonly LightboxScreenshot[];
  initialIndex: number;
  onClose: () => void;
}) {
  const { index, goTo } = useGalleryNavigation({
    count: screenshots.length,
    initialIndex,
    onClose,
  });

  // A picture can fail while it is the one on screen, and the caller drops it
  // from the list when that happens. Closing beats holding an empty frame open.
  useEffect(() => {
    if (screenshots.length === 0) onClose();
  }, [screenshots.length, onClose]);

  const current = screenshots[Math.min(index, screenshots.length - 1)];
  if (!current) return null;

  return (
    <div
      className="fixed inset-0 z-[200] flex flex-col bg-black/70 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Extension screenshots"
    >
      <div
        className="flex h-full w-full flex-col overflow-hidden rounded-lg border border-border bg-card shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-border px-4 py-2.5">
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">{current.caption ?? 'Screenshot'}</div>
            {screenshots.length > 1 && (
              <div className="text-xs text-muted-foreground">
                {index + 1} of {screenshots.length}
              </div>
            )}
          </div>

          {screenshots.length > 1 && (
            <div className="flex items-center gap-1">
              <Tooltip content="Previous screenshot" delayMs={40}>
                <button
                  onClick={() => goTo(index - 1)}
                  aria-label="Previous screenshot"
                  className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
              </Tooltip>
              <Tooltip content="Next screenshot" delayMs={40}>
                <button
                  onClick={() => goTo(index + 1)}
                  aria-label="Next screenshot"
                  className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  <ChevronRight className="h-4 w-4" />
                </button>
              </Tooltip>
            </div>
          )}

          <Tooltip content="Close" shortcut="Esc" delayMs={40}>
            <button
              onClick={onClose}
              aria-label="Close screenshots"
              className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          </Tooltip>
        </div>

        <div className="flex flex-1 items-center justify-center overflow-auto bg-muted/30 p-4">
          <RegistryImage
            src={current.url}
            alt={current.caption ?? ''}
            className="max-h-full max-w-full rounded-lg border border-border object-contain"
          />
        </div>
      </div>
    </div>
  );
}
