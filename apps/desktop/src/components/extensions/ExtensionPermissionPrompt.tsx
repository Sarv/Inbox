import { AlertTriangle, ShieldCheck, X } from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';

import {
  describePermission,
  formatDownloadSize,
  hasHighRiskPermission,
  sortPermissionsByRisk,
  type SurfaceSource,
} from '../../utils/extension-marketplace-display';
import { Tooltip } from '../Tooltip';

import { ExtensionScreenshots, ExtensionSurfaces, type ScreenshotItem } from './ExtensionSurfaces';

/**
 * The consent step before anything from the registry is installed.
 *
 * An extension runs in the main process with whatever its manifest asks for, so
 * the only thing standing between "a stranger published this" and "it can read
 * every message you have" is this dialog. It therefore states the permissions
 * in plain language, riskiest first, and never pre-selects or collapses them.
 *
 * What the user sees here is sent back to the main process on confirm and
 * re-checked against the registry: if the extension's permissions changed
 * between this dialog opening and Install being clicked, the install is refused
 * rather than quietly granted the new set.
 *
 * The checksum is shown, not hidden behind a disclosure, because it is the
 * other half of the trust story — the app refuses the download outright if the
 * bytes do not hash to this value.
 */
export interface PermissionPromptExtension {
  id: string;
  name: string;
  version: string;
  author: string;
  description: string;
  permissions: string[];
  sourceUrl: string;
  homepage?: string;
  download: { url: string; sha256: string; size: number };
  /** What it contributes, for the "what it does" section. Absent on an older registry. */
  contributes?: SurfaceSource['contributes'];
  screenshots?: ScreenshotItem[];
}

interface ExtensionPermissionPromptProps {
  extension: PermissionPromptExtension;
  /** Set while the install is running, so the dialog can show progress and lock. */
  installing?: boolean;
  error?: string | null;
  onConfirm: (permissions: string[]) => void;
  onCancel: () => void;
}

export function ExtensionPermissionPrompt({
  extension,
  installing = false,
  error,
  onConfirm,
  onCancel,
}: ExtensionPermissionPromptProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const permissions = useMemo(
    () => sortPermissionsByRisk(extension.permissions),
    [extension.permissions]
  );
  const sensitive = hasHighRiskPermission(extension.permissions);

  // Focus lands on Cancel, not Install: the safe choice should be the one a
  // stray Enter takes.
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !installing) onCancel();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [installing, onCancel]);

  return (
    <div
      className="fixed inset-0 z-[260] flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="extension-permission-title"
    >
      <div className="bg-card border border-border rounded-lg shadow-2xl w-full max-w-lg max-h-[85vh] flex flex-col">
        <div className="flex items-start justify-between gap-3 p-4 border-b border-border">
          <div className="min-w-0">
            <h2 id="extension-permission-title" className="font-semibold truncate">
              Install {extension.name}?
            </h2>
            <p className="text-xs text-muted-foreground mt-0.5 truncate">
              v{extension.version} by {extension.author}
            </p>
          </div>
          <Tooltip content="Cancel" delayMs={40}>
            <button
              type="button"
              onClick={onCancel}
              disabled={installing}
              aria-label="Cancel"
              className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted/60 shrink-0 disabled:opacity-50"
            >
              <X className="h-4 w-4" />
            </button>
          </Tooltip>
        </div>

        <div className="p-4 overflow-y-auto flex-1">
          <p className="text-sm text-muted-foreground">{extension.description}</p>

          <ExtensionScreenshots screenshots={extension.screenshots} className="mt-3" />

          {/* Before the permissions, deliberately: "what will this do and where
              will I see it" is the question being asked, and a permission list
              on its own has never answered it. */}
          <ExtensionSurfaces
            source={{ permissions: extension.permissions, contributes: extension.contributes }}
            heading="What it does, and where you will see it"
            className="mt-4"
          />

          <h3 className="text-sm font-medium mt-4 mb-2">
            This extension will be able to:
          </h3>
          {permissions.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing — it asks for no permissions at all.
            </p>
          ) : (
            <ul className="space-y-2">
              {permissions.map((permission) => {
                const info = describePermission(permission);
                return (
                  <li key={permission} className="flex items-start gap-2.5">
                    <span aria-hidden="true" className="text-base leading-5 shrink-0">
                      {info.icon}
                    </span>
                    <div className="min-w-0">
                      <div className="text-sm flex items-center gap-2">
                        {info.name}
                        {info.risk === 'high' && (
                          <span className="text-[11px] px-1.5 py-0.5 rounded bg-red-500/10 text-red-500">
                            Sensitive
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground">{info.description}</div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          {sensitive && (
            <div className="mt-4 p-3 rounded-lg bg-amber-500/10 border border-amber-500/20 flex items-start gap-2.5">
              <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0 mt-0.5" />
              <p className="text-xs text-muted-foreground">
                Only install extensions from an author you trust. This one can reach your
                messages or the internet, and it runs with the same access the app has.
              </p>
            </div>
          )}

          <div className="mt-4 p-3 rounded-lg bg-muted/50">
            <div className="flex items-center gap-2 text-xs font-medium mb-1.5">
              <ShieldCheck className="h-3.5 w-3.5 text-green-500" />
              Verified download
            </div>
            <dl className="text-xs text-muted-foreground space-y-1">
              <div className="flex gap-2">
                <dt className="shrink-0 w-16">Source</dt>
                <dd className="truncate">{extension.sourceUrl}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="shrink-0 w-16">Size</dt>
                <dd>{formatDownloadSize(extension.download.size)}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="shrink-0 w-16">SHA-256</dt>
                <dd className="font-mono break-all">{extension.download.sha256}</dd>
              </div>
            </dl>
            <p className="text-[11px] text-muted-foreground mt-2">
              The download is rejected if it does not match this checksum.
            </p>
          </div>

          {error && (
            <div className="mt-4 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-sm text-red-500">
              {error}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 p-4 border-t border-border">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            disabled={installing}
            className="px-3 py-1.5 text-sm rounded-lg hover:bg-muted transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onConfirm(extension.permissions)}
            disabled={installing}
            className="px-3 py-1.5 text-sm rounded-lg bg-purple-500 text-white hover:bg-purple-600 transition-colors disabled:opacity-50"
          >
            {installing ? 'Installing...' : 'Install'}
          </button>
        </div>
      </div>
    </div>
  );
}
