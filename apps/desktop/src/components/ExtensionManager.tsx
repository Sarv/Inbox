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
} from 'lucide-react';
import { useState, useEffect } from 'react';

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
  builtin?: boolean;
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

// Permission display info
const PERMISSION_DISPLAY: Record<string, { name: string; description: string; icon: string }> = {
  'email:read': { name: 'Read Emails', description: 'Read email content', icon: '📧' },
  'email:label': { name: 'Modify Labels', description: 'Add/remove labels', icon: '🏷️' },
  'email:flag': { name: 'Modify Flags', description: 'Change read/starred status', icon: '⚑' },
  'email:move': { name: 'Move Emails', description: 'Move between folders', icon: '📁' },
  'email:delete': { name: 'Delete Emails', description: 'Permanently delete emails', icon: '🗑️' },
  'ai:use': { name: 'Use AI', description: 'Access AI services', icon: '🤖' },
  'storage:local': { name: 'Local Storage', description: 'Store extension data', icon: '💾' },
  'network:fetch': { name: 'Network Access', description: 'Make HTTP requests', icon: '🌐' },
  'settings:read': { name: 'Read Settings', description: 'Read preferences', icon: '⚙️' },
  'settings:write': { name: 'Write Settings', description: 'Modify preferences', icon: '✏️' },
};

interface ExtensionCardProps {
  extension: InstalledExtension;
  info?: ExtensionInfo;
  onEnable: () => void;
  onDisable: () => void;
  onUninstall?: () => void;
  isLoading?: boolean;
}

function ExtensionCard({
  extension,
  info,
  onEnable,
  onDisable,
  onUninstall,
  isLoading,
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

            {/* Enable/Disable toggle */}
            <button
              onClick={extension.enabled ? onDisable : onEnable}
              disabled={isLoading}
              className={`p-2 rounded-lg transition-colors ${
                extension.enabled
                  ? 'bg-green-500/10 hover:bg-green-500/20 text-green-500'
                  : 'bg-muted hover:bg-muted/80 text-muted-foreground'
              }`}
              title={extension.enabled ? 'Disable extension' : 'Enable extension'}
            >
              {extension.enabled ? <Power className="h-4 w-4" /> : <PowerOff className="h-4 w-4" />}
            </button>

            {/* Expand/collapse */}
            <button
              onClick={() => setExpanded(!expanded)}
              className="p-2 hover:bg-muted rounded-lg transition-colors"
            >
              {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            </button>
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
          {/* Permissions */}
          {manifest?.permissions && manifest.permissions.length > 0 && (
            <div className="mb-3">
              <div className="flex items-center gap-1.5 text-sm font-medium mb-2">
                <Shield className="h-4 w-4" />
                Permissions
              </div>
              <div className="flex flex-wrap gap-2">
                {manifest.permissions.map((perm) => {
                  const display = PERMISSION_DISPLAY[perm];
                  return (
                    <span
                      key={perm}
                      className="inline-flex items-center gap-1 px-2 py-1 bg-muted rounded text-xs"
                      title={display?.description || perm}
                    >
                      <span>{display?.icon || '🔒'}</span>
                      {display?.name || perm}
                    </span>
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
              <button
                onClick={onUninstall}
                disabled={isLoading}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-red-500 hover:bg-red-500/10 rounded transition-colors"
              >
                <Trash2 className="h-4 w-4" />
                Uninstall
              </button>
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
          <button
            onClick={loadExtensions}
            disabled={loading}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm hover:bg-muted rounded-lg transition-colors"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
          <button
            onClick={handleInstall}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-purple-500 text-white hover:bg-purple-600 rounded-lg transition-colors"
          >
            <Download className="h-4 w-4" />
            Install Extension
          </button>
        </div>
      </div>

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
          <button
            onClick={handleInstall}
            className="inline-flex items-center gap-1.5 px-4 py-2 bg-purple-500 text-white hover:bg-purple-600 rounded-lg transition-colors"
          >
            <Download className="h-4 w-4" />
            Install Extension
          </button>
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
                isLoading={loadingIds.has(ext.id)}
              />
            ))}
          </div>
        </div>
      )}

      {/* Help text */}
      <div className="mt-8 p-4 bg-muted/50 rounded-lg">
        <h3 className="font-medium mb-2 flex items-center gap-2">
          <FolderOpen className="h-4 w-4" />
          Installing Extensions
        </h3>
        <p className="text-sm text-muted-foreground">
          Extensions are installed from local directories. Each extension should contain an{' '}
          <code className="px-1 py-0.5 bg-muted rounded">sarvinbox-extension.json</code> manifest file.
          Extensions can register workflows to process emails, subscribe to events, and store data locally.
        </p>
      </div>
    </div>
  );
}
