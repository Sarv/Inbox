import {
  Puzzle,
  Power,
  PowerOff,
  Trash2,
  Download,
  RefreshCw,
  AlertTriangle,
  CheckCircle,
  ChevronDown,
  ChevronUp,
  Shield,
  Loader2,
  FolderOpen,
  ArrowUpCircle,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  describePermission,
  findAvailableUpdates,
  sortPermissionsByRisk,
  type AvailableUpdate,
  type CatalogOffer,
  type SurfaceSource,
} from '../utils/extension-marketplace-display';

import { ExtensionBrowser } from './extensions/ExtensionBrowser';
import {
  ExtensionScreenshots,
  ExtensionSurfaces,
  type ScreenshotItem,
} from './extensions/ExtensionSurfaces';
import { Tooltip } from './Tooltip';

// Extension types matching the core extension system
interface InstalledExtension {
  id: string;
  source: 'builtin' | 'local' | 'marketplace';
  path: string;
  version: string;
  installedAt: number;
  enabled: boolean;
  grantedPermissions: string[];
  settings: Record<string, unknown>;
}

interface ExtensionManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  permissions: string[];
  /** The manifest arrives whole from main, so what it contributes comes with it. */
  contributes?: SurfaceSource['contributes'];
  screenshots?: ScreenshotItem[];
}

interface ExtensionInfo {
  manifest: ExtensionManifest | null;
  state: string;
  enabled: boolean;
  path: string;
  error?: string;
  activatedAt?: number;
  workflowIds: string[];
}

interface ExtensionCardProps {
  extension: InstalledExtension;
  info?: ExtensionInfo;
  onEnable: () => void;
  onDisable: () => void;
  onUninstall?: () => void;
  /** Set when the registry is offering a newer release this build can run. */
  update?: AvailableUpdate;
  onUpdate?: () => void;
  isLoading?: boolean;
  /** True while this extension's own update is being applied. */
  isUpdating?: boolean;
}

function ExtensionCard({
  extension,
  info,
  onEnable,
  onDisable,
  onUninstall,
  update,
  onUpdate,
  isLoading,
  isUpdating,
}: ExtensionCardProps) {
  const [expanded, setExpanded] = useState(false);
  const manifest = info?.manifest;
  const isBuiltin = extension.source === 'builtin';
  const isActive = info?.state === 'active';
  const hasError = info?.state === 'error';

  return (
    <div className="bg-card border border-border rounded-lg overflow-hidden">
      {/* Header */}
      <div className="p-4">
        <div className="flex items-start justify-between">
          <div className="flex items-start gap-3">
            <div className={`p-2 rounded-lg ${
              isActive ? 'bg-green-500/10' : hasError ? 'bg-red-500/10' : 'bg-muted'
            }`}>
              <Puzzle className={`h-5 w-5 ${
                isActive ? 'text-green-500' : hasError ? 'text-red-500' : 'text-muted-foreground'
              }`} />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="font-medium">{manifest?.name || extension.id}</h3>
                <span className="text-xs text-muted-foreground">v{extension.version}</span>
                {isBuiltin && (
                  <span className="text-xs px-1.5 py-0.5 bg-blue-500/10 text-blue-500 rounded">
                    Builtin
                  </span>
                )}
                {update && (
                  <span className="text-xs px-1.5 py-0.5 bg-blue-500/10 text-blue-500 rounded">
                    v{update.version} available
                  </span>
                )}
              </div>
              <p className="text-sm text-muted-foreground mt-0.5">
                {manifest?.description || 'No description'}
              </p>
              {manifest?.author && (
                <p className="text-xs text-muted-foreground mt-1">
                  by {manifest.author}
                </p>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2">
            {/* Status indicator */}
            {isLoading ? (
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            ) : hasError ? (
              <AlertTriangle className="h-4 w-4 text-red-500" />
            ) : isActive ? (
              <CheckCircle className="h-4 w-4 text-green-500" />
            ) : null}

            {/* Update, when the registry is offering a newer release. It sits
                ahead of the toggle because it is the only control here that is
                about to replace what is running. */}
            {update && onUpdate && (
              <Tooltip
                content={
                  update.newPermissions.length > 0
                    ? `Version ${update.version} asks for something new - review it first`
                    : `Update to version ${update.version}`
                }
                delayMs={40}
              >
                <button
                  onClick={onUpdate}
                  disabled={isLoading || isUpdating}
                  aria-label={`Update ${manifest?.name || extension.id} to version ${update.version}`}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-lg bg-blue-500/10 hover:bg-blue-500/20 text-blue-500 transition-colors disabled:opacity-50"
                >
                  {isUpdating ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <ArrowUpCircle className="h-3.5 w-3.5" />
                  )}
                  {update.newPermissions.length > 0 ? 'Review' : 'Update'}
                </button>
              </Tooltip>
            )}

            {/* Enable/Disable toggle */}
            <Tooltip
              content={extension.enabled ? 'Turn this extension off' : 'Turn this extension on'}
              delayMs={40}
            >
              <button
                onClick={extension.enabled ? onDisable : onEnable}
                disabled={isLoading}
                aria-label={extension.enabled ? 'Disable extension' : 'Enable extension'}
                className={`p-2 rounded-lg transition-colors ${
                  extension.enabled
                    ? 'bg-green-500/10 hover:bg-green-500/20 text-green-500'
                    : 'bg-muted hover:bg-muted/80 text-muted-foreground'
                }`}
              >
                {extension.enabled ? <Power className="h-4 w-4" /> : <PowerOff className="h-4 w-4" />}
              </button>
            </Tooltip>

            {/* Expand/collapse */}
            <Tooltip content={expanded ? 'Hide details' : 'Show details'} delayMs={40}>
              <button
                onClick={() => setExpanded(!expanded)}
                aria-label={expanded ? 'Hide details' : 'Show details'}
                className="p-2 hover:bg-muted rounded-lg transition-colors"
              >
                {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
              </button>
            </Tooltip>
          </div>
        </div>

        {/* Error message */}
        {hasError && info?.error && (
          <div className="mt-3 p-2 bg-red-500/10 border border-red-500/20 rounded text-sm text-red-500">
            {info.error}
          </div>
        )}
      </div>

      {/* Expanded details */}
      {expanded && (
        <div className="border-t border-border px-4 py-3 bg-muted/30">
          {/* What it does — first, because after install the question is no
              longer "may I trust this" but "what is this one for". */}
          {manifest && (
            <ExtensionSurfaces
              source={{ permissions: manifest.permissions, contributes: manifest.contributes }}
              heading="What it does"
              className="mb-3"
            />
          )}

          {manifest?.screenshots && (
            <ExtensionScreenshots screenshots={manifest.screenshots} className="mb-3" />
          )}

          {/* Permissions */}
          {manifest?.permissions && manifest.permissions.length > 0 && (
            <div className="mb-3">
              <div className="flex items-center gap-1.5 text-sm font-medium mb-2">
                <Shield className="h-4 w-4" />
                Permissions
              </div>
              <div className="flex flex-wrap gap-2">
                {sortPermissionsByRisk(manifest.permissions).map((perm) => {
                  const display = describePermission(perm);
                  return (
                    <Tooltip key={perm} content={display.description} delayMs={40}>
                      <span className="inline-flex items-center gap-1 px-2 py-1 bg-muted rounded text-xs">
                        <span aria-hidden="true">{display.icon}</span>
                        {display.name}
                      </span>
                    </Tooltip>
                  );
                })}
              </div>
            </div>
          )}

          {/* Workflows */}
          {info?.workflowIds && info.workflowIds.length > 0 && (
            <div className="mb-3">
              <div className="text-sm font-medium mb-2">Registered Workflows</div>
              <div className="flex flex-wrap gap-2">
                {info.workflowIds.map((id) => (
                  <span
                    key={id}
                    className="inline-flex items-center gap-1 px-2 py-1 bg-purple-500/10 text-purple-500 rounded text-xs"
                  >
                    {id}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Info */}
          <div className="text-xs text-muted-foreground space-y-1">
            <div>Installed: {new Date(extension.installedAt).toLocaleDateString()}</div>
            {info?.activatedAt && (
              <div>Last activated: {new Date(info.activatedAt).toLocaleString()}</div>
            )}
            <div className="truncate">Path: {extension.path}</div>
          </div>

          {/* Actions */}
          {!isBuiltin && onUninstall && (
            <div className="mt-3 pt-3 border-t border-border flex justify-end">
              <Tooltip content="Remove this extension and its permissions" delayMs={40}>
                <button
                  onClick={onUninstall}
                  disabled={isLoading}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-red-500 hover:bg-red-500/10 rounded transition-colors"
                >
                  <Trash2 className="h-4 w-4" />
                  Uninstall
                </button>
              </Tooltip>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function ExtensionManager() {
  const [extensions, setExtensions] = useState<InstalledExtension[]>([]);
  const [extensionInfo, setExtensionInfo] = useState<Map<string, ExtensionInfo>>(new Map());
  const [loading, setLoading] = useState(true);
  const [loadingIds, setLoadingIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  // Installed is the default tab: the panel's first job is telling the user
  // what is already running, not offering them something else.
  const [tab, setTab] = useState<'installed' | 'browse'>('installed');
  const [updates, setUpdates] = useState<AvailableUpdate[]>([]);
  const [updatingIds, setUpdatingIds] = useState<Set<string>>(new Set());
  const [updateError, setUpdateError] = useState<string | null>(null);
  /** An update handed over to Browse because it needs a fresh consent. */
  const [browseExtensionId, setBrowseExtensionId] = useState<string | null>(null);

  /**
   * Ask the catalogue what it is offering for what is already installed.
   *
   * Whether an update exists is the host's answer, not a version comparison
   * made here: the host also knows whether the newer release will run on this
   * build at all, and an Update button that installs something incompatible is
   * worse than no button.
   *
   * A registry that cannot be reached costs the update badges and nothing else.
   * The installed list is local and has to keep drawing offline.
   */
  const loadUpdates = useCallback(async (installed: InstalledExtension[]) => {
    try {
      const result = await window.electronAPI?.extensions?.browse({ force: false });
      if (!result?.success || !result.data) return;
      setUpdates(findAvailableUpdates(installed, result.data.items as CatalogOffer[]));
    } catch (err) {
      console.warn('Could not check for extension updates:', err);
    }
  }, []);

  // Load extensions
  const loadExtensions = async () => {
    try {
      setLoading(true);
      setError(null);

      // Check if extension API is available
      if (!window.electronAPI?.extensions) {
        // Extensions not available yet - show placeholder
        setExtensions([]);
        setError('Extension system is not yet initialized. Please restart the application.');
        return;
      }

      const result = await window.electronAPI.extensions.list();
      if (result.success && result.data) {
        setExtensions(result.data);
        void loadUpdates(result.data);

        // Load info for each extension
        const infoMap = new Map<string, ExtensionInfo>();
        for (const ext of result.data) {
          const infoResult = await window.electronAPI.extensions.getInfo(ext.id);
          if (infoResult.success && infoResult.data) {
            infoMap.set(ext.id, infoResult.data);
          }
        }
        setExtensionInfo(infoMap);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadExtensions();
  }, []);

  const handleEnable = async (extensionId: string) => {
    setLoadingIds((prev) => new Set(prev).add(extensionId));
    try {
      await window.electronAPI?.extensions?.enable(extensionId);
      await loadExtensions();
    } catch (err) {
      console.error('Failed to enable extension:', err);
    } finally {
      setLoadingIds((prev) => {
        const next = new Set(prev);
        next.delete(extensionId);
        return next;
      });
    }
  };

  const handleDisable = async (extensionId: string) => {
    setLoadingIds((prev) => new Set(prev).add(extensionId));
    try {
      await window.electronAPI?.extensions?.disable(extensionId);
      await loadExtensions();
    } catch (err) {
      console.error('Failed to disable extension:', err);
    } finally {
      setLoadingIds((prev) => {
        const next = new Set(prev);
        next.delete(extensionId);
        return next;
      });
    }
  };

  const handleUninstall = async (extensionId: string) => {
    if (!confirm(`Are you sure you want to uninstall this extension?`)) {
      return;
    }

    setLoadingIds((prev) => new Set(prev).add(extensionId));
    try {
      await window.electronAPI?.extensions?.uninstall(extensionId);
      await loadExtensions();
    } catch (err) {
      console.error('Failed to uninstall extension:', err);
    } finally {
      setLoadingIds((prev) => {
        const next = new Set(prev);
        next.delete(extensionId);
        return next;
      });
    }
  };

  const handleInstall = async () => {
    try {
      const result = await window.electronAPI?.extensions?.selectAndInstall();
      if (result?.success) {
        await loadExtensions();
      }
    } catch (err) {
      console.error('Failed to install extension:', err);
    }
  };

  const updateById = useMemo(
    () => new Map(updates.map((update) => [update.id, update])),
    [updates]
  );
  /** Updates that can be applied without asking for anything new. */
  const readyUpdates = updates.filter((update) => update.newPermissions.length === 0);
  const reviewUpdates = updates.filter((update) => update.newPermissions.length > 0);

  /**
   * Replace one installed extension with the version the registry is offering.
   *
   * The host keeps the reader's settings and whether the extension was turned
   * on across the swap, so this only has to hand over the permission list the
   * new version asks for - an install grants exactly what it is given.
   *
   * Returns the failure rather than showing it, so updating several can report
   * them together instead of each one wiping the last one's message.
   */
  const applyUpdate = async (update: AvailableUpdate): Promise<string | null> => {
    setUpdatingIds((prev) => new Set(prev).add(update.id));
    try {
      const result = await window.electronAPI?.extensions?.installFromRegistry(
        update.id,
        update.permissions
      );
      if (!result?.success) throw new Error(result?.error ?? 'The update did not complete');
      return null;
    } catch (err) {
      return `${update.id}: ${(err as Error).message}`;
    } finally {
      setUpdatingIds((prev) => {
        const next = new Set(prev);
        next.delete(update.id);
        return next;
      });
    }
  };

  const handleUpdate = async (update: AvailableUpdate) => {
    // An update that wants a permission it was never given has to be agreed to
    // again, and the dialog that does that lives in Browse together with the
    // checksum it shows. Handing it over is what keeps one consent screen in
    // the app rather than two that have to stay honest independently.
    if (update.newPermissions.length > 0) {
      setBrowseExtensionId(update.id);
      setTab('browse');
      return;
    }

    setUpdateError(null);
    const failure = await applyUpdate(update);
    setUpdateError(failure);
    await loadExtensions();
  };

  const handleUpdateAll = async () => {
    setUpdateError(null);
    // One at a time, never in parallel: each update deletes and rewrites an
    // install folder and re-activates the extension in the host, and two of
    // those at once race over the same registry file.
    const failures: string[] = [];
    for (const update of readyUpdates) {
      const failure = await applyUpdate(update);
      if (failure) failures.push(failure);
    }
    setUpdateError(failures.length > 0 ? failures.join('; ') : null);
    await loadExtensions();
  };

  /** Switching tab by hand means the catalogue list, not a handed-over update. */
  const showTab = (value: 'installed' | 'browse') => {
    setBrowseExtensionId(null);
    setTab(value);
  };

  // Separate builtin and user extensions
  const builtinExtensions = extensions.filter((e) => e.source === 'builtin');
  const userExtensions = extensions.filter((e) => e.source !== 'builtin');


  return (
    <div className="p-6 max-w-4xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Puzzle className="h-6 w-6 text-purple-500" />
          <div>
            <h1 className="text-xl font-semibold">Extensions</h1>
            <p className="text-sm text-muted-foreground">
              Manage and configure Sarv Inbox extensions
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Tooltip content="Re-read the installed extensions" delayMs={40}>
            <button
              onClick={loadExtensions}
              disabled={loading}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm hover:bg-muted rounded-lg transition-colors"
            >
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </button>
          </Tooltip>
          <Tooltip content="See extensions you can install" delayMs={40}>
            <button
              onClick={() => showTab('browse')}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-purple-500 text-white hover:bg-purple-600 rounded-lg transition-colors"
            >
              <Download className="h-4 w-4" />
              Browse Extensions
            </button>
          </Tooltip>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 border-b border-border mb-6">
        {([
          [
            'installed',
            `Installed${extensions.length > 0 ? ` (${extensions.length})` : ''}`,
            'Extensions already installed on this computer',
          ],
          [
            'browse',
            `Browse${updates.length > 0 ? ` (${updates.length} update${updates.length === 1 ? '' : 's'})` : ''}`,
            'Extensions available to install',
          ],
        ] as const).map(([value, label, hint]) => (
          <Tooltip key={value} content={hint} delayMs={40}>
            <button
              type="button"
              onClick={() => showTab(value)}
              aria-current={tab === value ? 'page' : undefined}
              className={`px-3 py-2 text-sm -mb-px border-b-2 transition-colors ${
                tab === value
                  ? 'border-purple-500 text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              {label}
            </button>
          </Tooltip>
        ))}
      </div>

      {tab === 'browse' && (
        <ExtensionBrowser onInstalled={loadExtensions} initialExtensionId={browseExtensionId} />
      )}

      {tab === 'installed' && (
        <>
        {/* Error message */}
        {error && (
          <div className="mb-6 p-4 bg-red-500/10 border border-red-500/20 rounded-lg flex items-start gap-3">
            <AlertTriangle className="h-5 w-5 text-red-500 flex-shrink-0 mt-0.5" />
            <div>
              <div className="font-medium text-red-500">Error loading extensions</div>
              <div className="text-sm text-muted-foreground">{error}</div>
            </div>
          </div>
        )}

        {/* Updates. The Installed tab is where someone goes to see what is
            running, so it is also where they have to be told that what is
            running is out of date - the catalogue is not a place people
            re-visit on the off-chance. */}
        {updates.length > 0 && (
          <div className="mb-6 p-4 bg-blue-500/10 border border-blue-500/20 rounded-lg flex items-start justify-between gap-4">
            <div className="flex items-start gap-3 min-w-0">
              <ArrowUpCircle className="h-5 w-5 text-blue-500 flex-shrink-0 mt-0.5" />
              <div className="min-w-0">
                <div className="font-medium text-blue-500">
                  {updates.length === 1
                    ? 'An update is available'
                    : `${updates.length} updates are available`}
                </div>
                <div className="text-sm text-muted-foreground">
                  {reviewUpdates.length > 0
                    ? `${reviewUpdates.length} of them ask for something new, so they open for review first.`
                    : 'Your settings, and whether each one is turned on, are kept.'}
                </div>
              </div>
            </div>
            {readyUpdates.length > 0 && (
              <Tooltip content="Update everything that asks for nothing new" delayMs={40}>
                <button
                  onClick={() => void handleUpdateAll()}
                  disabled={updatingIds.size > 0}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-blue-500 text-white hover:bg-blue-600 rounded-lg transition-colors disabled:opacity-50 flex-shrink-0"
                >
                  {updatingIds.size > 0 ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <ArrowUpCircle className="h-4 w-4" />
                  )}
                  Update all ({readyUpdates.length})
                </button>
              </Tooltip>
            )}
          </div>
        )}

        {updateError && (
          <div className="mb-6 p-4 bg-red-500/10 border border-red-500/20 rounded-lg flex items-start gap-3">
            <AlertTriangle className="h-5 w-5 text-red-500 flex-shrink-0 mt-0.5" />
            <div>
              <div className="font-medium text-red-500">Could not finish updating</div>
              <div className="text-sm text-muted-foreground">{updateError}</div>
            </div>
          </div>
        )}

        {/* Loading state */}
        {loading && extensions.length === 0 && (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        )}

        {/* Extensions list */}
        {!loading && extensions.length === 0 && !error && (
          <div className="text-center py-12">
            <Puzzle className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
            <h3 className="font-medium mb-2">No extensions installed</h3>
            <p className="text-sm text-muted-foreground mb-4">
              Install extensions to add new features to Sarv Inbox
            </p>
            <Tooltip content="See extensions you can install" delayMs={40}>
              <button
                onClick={() => showTab('browse')}
                className="inline-flex items-center gap-1.5 px-4 py-2 bg-purple-500 text-white hover:bg-purple-600 rounded-lg transition-colors"
              >
                <Download className="h-4 w-4" />
                Browse Extensions
              </button>
            </Tooltip>
          </div>
        )}

        {/* Builtin extensions */}
        {builtinExtensions.length > 0 && (
          <div className="mb-8">
            <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide mb-3">
              Built-in Extensions ({builtinExtensions.length})
            </h2>
            <div className="space-y-3">
              {builtinExtensions.map((ext) => (
                <ExtensionCard
                  key={ext.id}
                  extension={ext}
                  info={extensionInfo.get(ext.id)}
                  onEnable={() => handleEnable(ext.id)}
                  onDisable={() => handleDisable(ext.id)}
                  isLoading={loadingIds.has(ext.id)}
                />
              ))}
            </div>
          </div>
        )}

        {/* User extensions */}
        {userExtensions.length > 0 && (
          <div>
            <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide mb-3">
              Installed Extensions ({userExtensions.length})
            </h2>
            <div className="space-y-3">
              {userExtensions.map((ext) => (
                <ExtensionCard
                  key={ext.id}
                  extension={ext}
                  info={extensionInfo.get(ext.id)}
                  onEnable={() => handleEnable(ext.id)}
                  onDisable={() => handleDisable(ext.id)}
                  onUninstall={() => handleUninstall(ext.id)}
                  update={updateById.get(ext.id)}
                  onUpdate={() => {
                    const update = updateById.get(ext.id);
                    if (update) void handleUpdate(update);
                  }}
                  isLoading={loadingIds.has(ext.id)}
                  isUpdating={updatingIds.has(ext.id)}
                />
              ))}
            </div>
          </div>
        )}

        {/* Help text */}
        <div className="mt-8 p-4 bg-muted/50 rounded-lg">
          <h3 className="font-medium mb-2 flex items-center gap-2">
            <FolderOpen className="h-4 w-4" />
            Where extensions come from
          </h3>
          <p className="text-sm text-muted-foreground">
            Published extensions live in their own repository and are installed from the Browse
            tab. Each download is checked against a published SHA-256 before anything runs, and
            you are shown exactly what it can do first.
          </p>
          <p className="text-sm text-muted-foreground mt-2">
            To try one you are writing yourself, install it from a local folder containing a{' '}
            <code className="px-1 py-0.5 bg-muted rounded">sarvinbox-extension.json</code> manifest.
          </p>
          <Tooltip content="Load an extension you are developing from a local folder" delayMs={40}>
            <button
              onClick={handleInstall}
              className="mt-3 inline-flex items-center gap-1.5 px-3 py-1.5 text-sm hover:bg-muted rounded-lg transition-colors border border-border"
            >
              <FolderOpen className="h-4 w-4" />
              Install from folder
            </button>
          </Tooltip>
        </div>
        </>
      )}
    </div>
  );
}
