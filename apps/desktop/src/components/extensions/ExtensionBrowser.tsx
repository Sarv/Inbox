import { AlertTriangle, ChevronRight, Loader2, Puzzle, RefreshCw, WifiOff } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  availableCategories,
  categoryChipLabel,
  describeCategory,
  describeInstallAction,
  truncateDescription,
} from '../../utils/extension-marketplace-display';
import { Tooltip } from '../Tooltip';

import type { CatalogItem, PendingInstall } from './catalog-item';
import { ExtensionDetail } from './ExtensionDetail';
import {
  ExtensionPermissionPrompt,
  type PermissionPromptExtension,
} from './ExtensionPermissionPrompt';

/**
 * The Browse tab: extensions published to the GitHub registry.
 *
 * Nothing here is bundled with the app. The main process fetches the registry
 * this build is configured to read, checks each entry against the running app
 * version, and marks what is already installed — so this component only has to
 * render a decision that was already made and take the user through the
 * permission prompt.
 *
 * Two levels, deliberately. The list says only what is needed to pick one out:
 * icon, name, a clipped line of description, and the shelf it sits on. Opening
 * a row gives the full record — the pictures, what it will do, where it will
 * show up, every permission. Putting all of that on every row turned a
 * catalogue of three extensions into a page nobody could scan, and it only gets
 * worse as the registry grows.
 *
 * A registry that could not be refreshed is called out rather than silently
 * showing stale results: the panel falls back to its cached copy so an offline
 * user still sees the catalogue, and the banner says that is what happened.
 */
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

/** The filter value meaning "every shelf". */
const ALL_CATEGORIES = 'all';

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
  /** The extension whose page is open, or null while the list is showing. */
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [category, setCategory] = useState<string>(ALL_CATEGORIES);

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
   * Read the rest of an extension's record.
   *
   * The Browse list is drawn from a thin index that carries neither the digest
   * nor the screenshots, so both the detail page and the consent dialog need
   * this one extra request for the one extension the user picked. The result is
   * merged back into the list so opening the same extension twice, or opening
   * it and then installing it, costs one fetch rather than two.
   */
  const loadDetail = useCallback(async (item: CatalogItem): Promise<CatalogItem> => {
    if (item.download) return item;

    setPreparing(item.id);
    try {
      const result = await window.electronAPI?.extensions?.registryDetail(item.id);
      if (!result?.success || !result.data?.download) {
        throw new Error(result?.error ?? 'The registry did not return a download for this extension');
      }
      const detail = result.data;
      const merged = { ...item, ...detail, download: detail.download } as CatalogItem;
      setItems((current) => current.map((entry) => (entry.id === merged.id ? merged : entry)));
      return merged;
    } finally {
      setPreparing(null);
    }
  }, []);

  /**
   * Open an extension's page, and start reading its full record behind it.
   *
   * The page draws immediately from what the list already knows; a failure to
   * fetch the rest costs the pictures and the install button, not the page.
   */
  const openDetail = useCallback(
    (item: CatalogItem) => {
      setDetailError(null);
      setInstallError(null);
      setSelectedId(item.id);
      void loadDetail(item).catch((err: Error) => {
        setDetailError(`${item.name}: ${err.message}`);
      });
    },
    [loadDetail]
  );

  /**
   * Open the consent dialog.
   *
   * The prompt shows the checksum the archive will be verified against, so it
   * cannot open until the detail record is in hand. On failure nothing opens:
   * consenting to an install whose digest we could not read is exactly what
   * must not happen.
   */
  const openPrompt = useCallback(
    async (item: CatalogItem) => {
      setInstallError(null);
      setDetailError(null);
      try {
        const detailed = await loadDetail(item);
        if (!detailed.download) throw new Error('The registry did not return a download for this extension');
        setPending({ ...detailed, download: detailed.download });
      } catch (err) {
        setDetailError(`${item.name}: ${(err as Error).message}`);
      }
    },
    [loadDetail]
  );

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
  const selected = selectedId ? items.find((item) => item.id === selectedId) ?? null : null;
  const categories = useMemo(() => availableCategories(items), [items]);
  const visible = useMemo(
    () => (category === ALL_CATEGORIES ? items : items.filter((item) => item.category === category)),
    [category, items]
  );

  const problems = (
    <>
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
    </>
  );

  const prompt = pending && (
    <ExtensionPermissionPrompt
      extension={pending satisfies PermissionPromptExtension}
      installing={installing}
      error={installError}
      onConfirm={(permissions) => void confirmInstall(permissions)}
      onCancel={() => {
        if (!installing) setPending(null);
      }}
    />
  );

  if (selected) {
    return (
      <div>
        {problems}
        <ExtensionDetail
          item={selected}
          loading={preparing === selected.id}
          preparing={preparing === selected.id}
          onBack={() => setSelectedId(null)}
          onInstall={() => void openPrompt(selected)}
        />
        {prompt}
      </div>
    );
  }

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

      {problems}

      {/* Only worth drawing once there is more than one shelf to choose
          between — a filter with a single button filters nothing. */}
      {categories.length > 1 && (
        <div className="flex items-center gap-1.5 mb-3 flex-wrap">
          {[ALL_CATEGORIES, ...categories].map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setCategory(value)}
              aria-pressed={category === value}
              className={`px-2.5 py-1 text-xs rounded-full border transition-colors ${
                category === value
                  ? 'bg-purple-500 border-purple-500 text-white'
                  : 'bg-transparent border-border text-muted-foreground hover:bg-muted'
              }`}
            >
              {value === ALL_CATEGORIES ? 'All' : describeCategory(value)}
            </button>
          ))}
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

      {!loading && items.length > 0 && visible.length === 0 && (
        <div className="text-center py-8 text-sm text-muted-foreground">
          Nothing on that shelf yet.
        </div>
      )}

      <div className="space-y-2">
        {visible.map((item) => {
          const action = describeInstallAction(item.state, item.incompatibleReason);
          return (
            <div
              key={item.id}
              className="flex items-center gap-3 bg-card border border-border rounded-lg p-3"
            >
              {/* The row and the install button are siblings rather than nested:
                  a button inside a button is not something a browser or a
                  screen reader can make sense of. */}
              <button
                type="button"
                onClick={() => openDetail(item)}
                className="flex items-center gap-3 min-w-0 flex-1 text-left group"
              >
                <div className="p-2 rounded-lg bg-muted shrink-0">
                  {item.iconUrl ? (
                    <img src={item.iconUrl} alt="" className="h-5 w-5" />
                  ) : (
                    <Puzzle className="h-5 w-5 text-muted-foreground" />
                  )}
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="font-medium group-hover:text-purple-500 transition-colors">
                      {item.name}
                    </h3>
                    <span className="text-xs text-muted-foreground">v{item.version}</span>
                    {categoryChipLabel(item.category) && (
                      <span className="text-xs px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
                        {categoryChipLabel(item.category)}
                      </span>
                    )}
                    {item.state === 'update-available' && (
                      <span className="text-xs px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-500">
                        v{item.installedVersion} installed
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground mt-0.5 truncate">
                    {truncateDescription(item.description)}
                  </p>
                </div>
                <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0 ml-auto" />
              </button>

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
          );
        })}
      </div>

      {prompt}
    </div>
  );
}
