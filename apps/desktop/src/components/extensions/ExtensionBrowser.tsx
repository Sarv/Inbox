import {
  AlertTriangle,
  Download,
  ExternalLink,
  Loader2,
  Puzzle,
  RefreshCw,
  Star,
  WifiOff,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import {
  describeInstallAction,
  formatCompactCount,
  formatDownloadSize,
  type SurfaceSource,
} from '../../utils/extension-marketplace-display';
import { Tooltip } from '../Tooltip';

import {
  ExtensionPermissionPrompt,
  type PermissionPromptExtension,
} from './ExtensionPermissionPrompt';
import { ExtensionScreenshots, ExtensionSurfaces, type ScreenshotItem } from './ExtensionSurfaces';

/**
 * The Browse tab: extensions published to the GitHub registry.
 *
 * Nothing here is bundled with the app. The main process fetches the registry
 * this build is configured to read, checks each entry against the running app
 * version, and marks what is already installed — so this component only has to
 * render a decision that was already made and take the user through the
 * permission prompt.
 *
 * A registry that could not be refreshed is called out rather than silently
 * showing stale results: the panel falls back to its cached copy so an offline
 * user still sees the catalogue, and the banner says that is what happened.
 */
interface CatalogItem {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  keywords: string[];
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
type PendingInstall = CatalogItem & { download: NonNullable<CatalogItem['download']> };

interface RegistryStatus {
  url: string;
  source: string | null;
  stars: number;
  generatedAt: string | null;
  ok: boolean;
  error?: string;
  fromCache: boolean;
}

interface ExtensionBrowserProps {
  /** Called after a successful install so the Installed tab picks it up. */
  onInstalled: () => void;
}

export function ExtensionBrowser({ onInstalled }: ExtensionBrowserProps) {
  const [items, setItems] = useState<CatalogItem[]>([]);
  const [registries, setRegistries] = useState<RegistryStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingInstall | null>(null);
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  /** The extension whose detail record is being fetched, so its button can wait. */
  const [preparing, setPreparing] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);

  const load = useCallback(async (force = false) => {
    setLoading(true);
    setError(null);
    try {
      const result = await window.electronAPI?.extensions?.browse({ force });
      if (!result?.success || !result.data) {
        throw new Error(result?.error ?? 'Could not read the extension registry');
      }
      setItems(result.data.items as CatalogItem[]);
      setRegistries(result.data.registries as RegistryStatus[]);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Read the rest of an extension's record, then open the consent dialog.
   *
   * The prompt shows the checksum the archive will be verified against, and a
   * thin registry index does not carry it - so the dialog cannot open until this
   * one extra request comes back. On failure nothing opens: consenting to an
   * install whose digest we could not read is exactly what must not happen.
   */
  const openPrompt = useCallback(async (item: CatalogItem) => {
    setInstallError(null);
    setDetailError(null);
    if (item.download) {
      setPending({ ...item, download: item.download });
      return;
    }
    setPreparing(item.id);
    try {
      const result = await window.electronAPI?.extensions?.registryDetail(item.id);
      if (!result?.success || !result.data?.download) {
        throw new Error(result?.error ?? 'The registry did not return a download for this extension');
      }
      const detail = result.data;
      setPending({ ...item, ...detail, download: detail.download });
    } catch (err) {
      setDetailError(`${item.name}: ${(err as Error).message}`);
    } finally {
      setPreparing(null);
    }
  }, []);

  const confirmInstall = useCallback(
    async (permissions: string[]) => {
      if (!pending) return;
      setInstalling(true);
      setInstallError(null);
      try {
        const result = await window.electronAPI?.extensions?.installFromRegistry(
          pending.id,
          permissions
        );
        if (!result?.success) throw new Error(result?.error ?? 'The install did not complete');
        setPending(null);
        onInstalled();
        // Re-read so the card flips to Installed without a full-page refresh.
        await load();
      } catch (err) {
        setInstallError((err as Error).message);
      } finally {
        setInstalling(false);
      }
    },
    [load, onInstalled, pending]
  );

  const stale = registries.filter((registry) => !registry.ok);

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
          Available Extensions {items.length > 0 && `(${items.length})`}
        </h2>
        <Tooltip content="Fetch the latest list from the registry" delayMs={40}>
          <button
            type="button"
            onClick={() => void load(true)}
            disabled={loading}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm hover:bg-muted rounded-lg transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </Tooltip>
      </div>

      {stale.length > 0 && (
        <div className="mb-4 p-3 rounded-lg bg-amber-500/10 border border-amber-500/20 flex items-start gap-2.5">
          <WifiOff className="h-4 w-4 text-amber-500 shrink-0 mt-0.5" />
          <div className="text-xs text-muted-foreground min-w-0">
            <div className="font-medium text-amber-500">Showing a cached list</div>
            {stale.map((registry) => (
              <div key={registry.url} className="truncate">
                {registry.url} — {registry.error}
              </div>
            ))}
          </div>
        </div>
      )}

      {error && (
        <div className="mb-4 p-4 bg-red-500/10 border border-red-500/20 rounded-lg flex items-start gap-3">
          <AlertTriangle className="h-5 w-5 text-red-500 shrink-0 mt-0.5" />
          <div>
            <div className="font-medium text-red-500">Could not load the registry</div>
            <div className="text-sm text-muted-foreground">{error}</div>
          </div>
        </div>
      )}

      {detailError && (
        <div className="mb-4 p-4 bg-red-500/10 border border-red-500/20 rounded-lg flex items-start gap-3">
          <AlertTriangle className="h-5 w-5 text-red-500 shrink-0 mt-0.5" />
          <div>
            <div className="font-medium text-red-500">Could not read the extension&apos;s details</div>
            <div className="text-sm text-muted-foreground">{detailError}</div>
          </div>
        </div>
      )}

      {loading && items.length === 0 && (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      )}

      {!loading && items.length === 0 && !error && (
        <div className="text-center py-12">
          <Puzzle className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
          <h3 className="font-medium mb-2">Nothing published yet</h3>
          <p className="text-sm text-muted-foreground">
            The registry this build reads has no extensions in it.
          </p>
        </div>
      )}

      <div className="space-y-3">
        {items.map((item) => {
          const action = describeInstallAction(item.state, item.incompatibleReason);
          return (
            <div key={item.id} className="bg-card border border-border rounded-lg p-4">
              <div className="flex items-start justify-between gap-4">
                <div className="flex items-start gap-3 min-w-0">
                  <div className="p-2 rounded-lg bg-muted shrink-0">
                    {item.iconUrl ? (
                      <img src={item.iconUrl} alt="" className="h-5 w-5" />
                    ) : (
                      <Puzzle className="h-5 w-5 text-muted-foreground" />
                    )}
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className="font-medium">{item.name}</h3>
                      <span className="text-xs text-muted-foreground">v{item.version}</span>
                      {item.state === 'update-available' && (
                        <span className="text-xs px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-500">
                          v{item.installedVersion} installed
                        </span>
                      )}
                    </div>
                    <p className="text-sm text-muted-foreground mt-0.5">{item.description}</p>
                    {/* The card's whole job: someone scrolling the catalogue can
                        tell these apart without installing one to find out. */}
                    <ExtensionSurfaces
                      source={{ permissions: item.permissions, contributes: item.contributes }}
                      heading={null}
                      className="mt-2"
                    />
                    <ExtensionScreenshots screenshots={item.screenshots} className="mt-2" />
                    <div className="flex items-center gap-3 mt-2 text-xs text-muted-foreground flex-wrap">
                      <span>by {item.author}</span>
                      <span className="flex items-center gap-1">
                        <Download className="h-3 w-3" />
                        {formatCompactCount(item.stats.downloads)}
                      </span>
                      {typeof item.stats.rating === 'number' && (
                        <span className="flex items-center gap-1">
                          <Star className="h-3 w-3" />
                          {item.stats.rating.toFixed(1)}
                          {item.stats.ratingCount ? ` (${formatCompactCount(item.stats.ratingCount)})` : ''}
                        </span>
                      )}
                      <span>{formatDownloadSize(item.size)}</span>
                      <span>
                        {item.permissions.length} permission
                        {item.permissions.length === 1 ? '' : 's'}
                      </span>
                      {item.homepage && (
                        <Tooltip content="Open the extension page" delayMs={40}>
                          <a
                            href={item.homepage}
                            target="_blank"
                            rel="noreferrer"
                            aria-label="Open the extension page"
                            className="inline-flex items-center gap-1 hover:text-foreground"
                          >
                            <ExternalLink className="h-3 w-3" />
                          </a>
                        </Tooltip>
                      )}
                    </div>
                  </div>
                </div>

                <div className="shrink-0">
                  {action.disabled ? (
                    <Tooltip content={action.reason ?? action.label} delayMs={40}>
                      <span className="inline-block px-3 py-1.5 text-sm rounded-lg bg-muted text-muted-foreground cursor-default">
                        {action.label}
                      </span>
                    </Tooltip>
                  ) : (
                    <Tooltip content={`Review what ${item.name} can do, then install`} delayMs={40}>
                      <button
                        type="button"
                        onClick={() => void openPrompt(item)}
                        disabled={preparing !== null}
                        className="px-3 py-1.5 text-sm rounded-lg bg-purple-500 text-white hover:bg-purple-600 transition-colors disabled:opacity-50"
                      >
                        {preparing === item.id ? (
                          <Loader2 className="h-4 w-4 animate-spin" aria-label="Loading details" />
                        ) : (
                          action.label
                        )}
                      </button>
                    </Tooltip>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {pending && (
        <ExtensionPermissionPrompt
          extension={pending satisfies PermissionPromptExtension}
          installing={installing}
          error={installError}
          onConfirm={(permissions) => void confirmInstall(permissions)}
          onCancel={() => {
            if (!installing) setPending(null);
          }}
        />
      )}
    </div>
  );
}
