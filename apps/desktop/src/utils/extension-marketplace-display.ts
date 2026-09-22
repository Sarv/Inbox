/**
 * Presentation rules for the extensions panel.
 *
 * Pure, so the interesting decisions — what a permission is called, how
 * dangerous it is, whether the Install button is even clickable — are unit
 * tested rather than only visible by opening the panel. Shared by the installed
 * list, the Browse tab and the permission prompt so all three describe the same
 * permission the same way.
 */

/** How much damage a permission can do if the extension turns out to be hostile. */
export type PermissionRisk = 'high' | 'medium' | 'low';

export interface PermissionDisplay {
  name: string;
  description: string;
  icon: string;
  risk: PermissionRisk;
}

export const PERMISSION_DISPLAY: Record<string, PermissionDisplay> = {
  'email:read': {
    name: 'Read Emails',
    description: 'Read the subject, sender and body of your messages',
    icon: '📧',
    risk: 'high',
  },
  'email:delete': {
    name: 'Delete Emails',
    description: 'Permanently delete messages',
    icon: '🗑️',
    risk: 'high',
  },
  'network:fetch': {
    name: 'Network Access',
    description: 'Send and receive data over the internet',
    icon: '🌐',
    risk: 'high',
  },
  'email:move': {
    name: 'Move Emails',
    description: 'Move messages between folders',
    icon: '📁',
    risk: 'medium',
  },
  'email:flag': {
    name: 'Modify Flags',
    description: 'Change read and starred status',
    icon: '⚑',
    risk: 'medium',
  },
  'settings:write': {
    name: 'Write Settings',
    description: 'Change your preferences',
    icon: '✏️',
    risk: 'medium',
  },
  'ai:use': {
    name: 'Use AI',
    description: 'Send message content to the AI service you configured',
    icon: '🤖',
    risk: 'medium',
  },
  'email:label': {
    name: 'Modify Labels',
    description: 'Add and remove labels',
    icon: '🏷️',
    risk: 'low',
  },
  'storage:local': {
    name: 'Local Storage',
    description: 'Store its own data on this device',
    icon: '💾',
    risk: 'low',
  },
  'settings:read': {
    name: 'Read Settings',
    description: 'Read your preferences',
    icon: '⚙️',
    risk: 'low',
  },
  'ui:notify': {
    name: 'Show Notifications',
    description: 'Surface a card in the app window',
    icon: '🔔',
    risk: 'low',
  },
};

const RISK_ORDER: Record<PermissionRisk, number> = { high: 0, medium: 1, low: 2 };

/**
 * A permission the app does not recognise is shown, never hidden.
 *
 * The registry already refuses an entry asking for an unknown permission, so
 * this only fires for something already installed — and the honest thing to
 * show then is the raw id, treated as dangerous, rather than a blank row.
 */
export function describePermission(permission: string): PermissionDisplay {
  return (
    PERMISSION_DISPLAY[permission] ?? {
      name: permission,
      description: 'This version of Sarv Inbox does not recognise this permission',
      icon: '❓',
      risk: 'high',
    }
  );
}

/**
 * Riskiest first.
 *
 * A prompt is only meaningful if the thing worth refusing over is the first
 * line read, not the ninth. Ties keep a stable alphabetical order so the list
 * does not reshuffle between renders.
 */
export function sortPermissionsByRisk(permissions: readonly string[]): string[] {
  return [...permissions].sort((left, right) => {
    const byRisk = RISK_ORDER[describePermission(left).risk] - RISK_ORDER[describePermission(right).risk];
    return byRisk !== 0 ? byRisk : left.localeCompare(right);
  });
}

/** True when any requested permission can read or destroy mail, or reach the network. */
export function hasHighRiskPermission(permissions: readonly string[]): boolean {
  return permissions.some((permission) => describePermission(permission).risk === 'high');
}

export type CatalogItemState = 'available' | 'installed' | 'update-available' | 'incompatible';

export interface InstallAction {
  label: string;
  disabled: boolean;
  /** Set when the button is disabled, so the card can say why. */
  reason?: string;
}

/**
 * What the button on a catalogue card says and whether it does anything.
 *
 * `incompatible` stays visible rather than being filtered out of the list: an
 * extension that needs a newer app is useful information, and silently omitting
 * it looks like the extension does not exist.
 */
export function describeInstallAction(
  state: CatalogItemState,
  incompatibleReason?: string
): InstallAction {
  switch (state) {
    case 'installed':
      return { label: 'Installed', disabled: true };
    case 'update-available':
      return { label: 'Update', disabled: false };
    case 'incompatible':
      return {
        label: 'Unavailable',
        disabled: true,
        reason: incompatibleReason ?? 'Not compatible with this version of Sarv Inbox',
      };
    default:
      return { label: 'Install', disabled: false };
  }
}

/**
 * Download and star counts, shortened.
 *
 * `Intl.NumberFormat` does the abbreviation and the locale's own separators, so
 * a German reader sees "1234" the way they expect rather than an English
 * hand-rolled "1.2k".
 */
export function formatCompactCount(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '0';
  return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(
    Math.floor(value)
  );
}

/** Bytes as the download size shown under an extension. */
export function formatDownloadSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  const units = ['B', 'KB', 'MB'];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size >= 10 || unit === 0 ? Math.round(size) : size.toFixed(1)} ${units[unit]}`;
}
