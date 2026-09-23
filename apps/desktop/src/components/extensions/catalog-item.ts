import type { SurfaceSource } from '../../utils/extension-marketplace-display';

import type { ScreenshotItem } from './ExtensionSurfaces';

/**
 * One row of the Browse catalogue.
 *
 * Shared between the list and the detail view rather than declared twice: the
 * two are one record seen at two levels of zoom, and a field that drifts
 * between them shows up as something visible in the list and missing when you
 * open it.
 *
 * Structurally what core's marketplace returns, restated here for the same
 * reason the preload restates it - the renderer must not import core.
 */
export interface CatalogItem {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  keywords: string[];
  /** Catalogue shelf, already folded onto the app's known list by the host. */
  category?: string;
  homepage?: string;
  iconUrl?: string;
  permissions: string[];
  /** What it contributes, so the card can say what the extension actually does. */
  contributes?: SurfaceSource['contributes'];
  screenshots?: ScreenshotItem[];
  /** Bytes of the release archive, carried by the list itself. */
  size: number;
  /** Only present once the extension's detail record has been fetched. */
  download?: { url: string; sha256: string; size: number };
  stats: { downloads: number; rating?: number; ratingCount?: number };
  sourceUrl: string;
  state: 'available' | 'installed' | 'update-available' | 'incompatible';
  installedVersion?: string;
  incompatibleReason?: string;
}

/** A catalogue item whose detail record has been read, so it can be installed. */
export type PendingInstall = CatalogItem & { download: NonNullable<CatalogItem['download']> };
