import { ArrowLeft, Download, ExternalLink, Loader2, Puzzle, Shield, Star } from 'lucide-react';

import {
  categoryChipLabel,
  describeInstallAction,
  describePermission,
  formatCompactCount,
  formatDownloadSize,
  sortPermissionsByRisk,
} from '../../utils/extension-marketplace-display';
import { Tooltip } from '../Tooltip';

import type { CatalogItem } from './catalog-item';
import { ExtensionScreenshots, ExtensionSurfaces } from './ExtensionSurfaces';
import { RegistryImage } from './RegistryImage';

/**
 * One extension, opened from the Browse list.
 *
 * The list is for scanning and deliberately says almost nothing — an icon, a
 * name, a clipped line. Everything a person actually needs before agreeing to
 * run someone else's code lives here instead: the whole description, pictures
 * of it running, what it will do and where that will show up, and the full
 * permission list. Splitting the two is what keeps the list scannable; putting
 * all of it on every row was what made the catalogue unreadable.
 *
 * Install still goes through the consent dialog. This page is the sales pitch;
 * the dialog is the contract, and it shows the checksum the archive is verified
 * against, which nothing here does.
 */
interface ExtensionDetailProps {
  item: CatalogItem;
  /** True while this extension's detail record is still being fetched. */
  loading: boolean;
  /** True while the install button is waiting on the registry. */
  preparing: boolean;
  onBack: () => void;
  onInstall: () => void;
}

export function ExtensionDetail({
  item,
  loading,
  preparing,
  onBack,
  onInstall,
}: ExtensionDetailProps) {
  const action = describeInstallAction(item.state, item.incompatibleReason);

  return (
    <div>
      <Tooltip content="Back to the list" delayMs={40}>
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to the list"
          className="flex items-center gap-1.5 mb-4 px-2 py-1 -ml-2 text-sm text-muted-foreground hover:text-foreground hover:bg-muted rounded-lg transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          All extensions
        </button>
      </Tooltip>

      <div className="bg-card border border-border rounded-lg p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3 min-w-0">
            <div className="p-2.5 rounded-lg bg-muted shrink-0">
              {item.iconUrl ? (
                <RegistryImage src={item.iconUrl} alt="" className="h-8 w-8" />
              ) : (
                <Puzzle className="h-8 w-8 text-muted-foreground" />
              )}
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="text-lg font-medium">{item.name}</h3>
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
              <div className="text-xs text-muted-foreground mt-1">by {item.author}</div>
            </div>
          </div>

          <div className="shrink-0">
            {action.disabled ? (
              <Tooltip content={action.reason ?? action.label} delayMs={40}>
                <span className="inline-block px-4 py-2 text-sm rounded-lg bg-muted text-muted-foreground cursor-default">
                  {action.label}
                </span>
              </Tooltip>
            ) : (
              <Tooltip content={`Review what ${item.name} can do, then install`} delayMs={40}>
                <button
                  type="button"
                  onClick={onInstall}
                  disabled={preparing}
                  className="px-4 py-2 text-sm rounded-lg bg-purple-500 text-white hover:bg-purple-600 transition-colors disabled:opacity-50"
                >
                  {preparing ? (
                    <Loader2 className="h-4 w-4 animate-spin" aria-label="Loading details" />
                  ) : (
                    action.label
                  )}
                </button>
              </Tooltip>
            )}
          </div>
        </div>

        <p className="text-sm text-muted-foreground mt-4">{item.description}</p>

        {/* The pictures come from the detail document, so on a thin registry
            they arrive a moment after the page does. */}
        <ExtensionScreenshots screenshots={item.screenshots} className="mt-4" />
        {loading && !item.screenshots && (
          <div className="flex items-center gap-2 mt-4 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Loading the rest of this extension&apos;s record
          </div>
        )}

        <ExtensionSurfaces
          source={{ permissions: item.permissions, contributes: item.contributes }}
          heading="What it does, and where you will see it"
          className="mt-5"
        />

        {item.permissions.length > 0 && (
          <div className="mt-5">
            <div className="flex items-center gap-1.5 text-sm font-medium mb-2">
              <Shield className="h-4 w-4" />
              Permissions
            </div>
            <div className="flex flex-wrap gap-2">
              {sortPermissionsByRisk(item.permissions).map((permission) => {
                const display = describePermission(permission);
                return (
                  <Tooltip key={permission} content={display.description} delayMs={40}>
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

        <div className="flex items-center gap-3 mt-5 pt-4 border-t border-border text-xs text-muted-foreground flex-wrap">
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
          {item.keywords.length > 0 && <span>{item.keywords.join(', ')}</span>}
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
  );
}
