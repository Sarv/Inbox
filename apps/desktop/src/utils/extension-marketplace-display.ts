/**
 * Presentation rules for the extensions panel.
 *
 * Pure, so the interesting decisions — what a permission is called, how
 * dangerous it is, whether the Install button is even clickable — are unit
 * tested rather than only visible by opening the panel. Shared by the installed
 * list, the Browse tab and the permission prompt so all three describe the same
 * permission the same way.
 */

import { DEFAULT_EXTENSION_CATEGORY } from '@sarvinbox/core/extension-categories';

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

/**
 * What an extension will actually do, and where the reader will see it.
 *
 * A permission list answers "what is it allowed to touch", which is the
 * question a reviewer asks. It does not answer the question a reader asks
 * before installing: what does this thing DO, and where does it show up? "Read
 * Emails, Modify Labels, Show Notifications" describes a passcode reader, a
 * spam filter and a translator equally well, so people install and then go
 * looking for something that changed.
 *
 * Every line here is DERIVED from the manifest — from what the extension
 * declared it contributes, and from permissions it cannot use without asking
 * for. Nothing is author-written prose, so nothing can overstate: an extension
 * that says it shows a panel really does have a panel the app will render.
 */
export interface ExtensionSurface {
  icon: string;
  title: string;
  detail: string;
}

/**
 * The manifest fields this reads.
 *
 * Deliberately the narrowest shape that works, with the rest of each object
 * left open: a whole `ExtensionManifest`, a registry entry's trimmed summary
 * and a hand-written test fixture all fit without any of them being converted
 * first. Nothing outside these fields is read, so nothing outside them can
 * change what the reader is told.
 */
export interface SurfaceSource {
  permissions?: readonly string[];
  contributes?: {
    panels?: readonly { title?: string; surface?: string; autoOpen?: boolean; [extra: string]: unknown }[];
    workflows?: readonly { name?: string; requiresAI?: boolean; [extra: string]: unknown }[];
    settings?: readonly unknown[];
    capabilities?: readonly { id?: string; description?: string; [extra: string]: unknown }[];
  };
}

/** Capability ids the app itself asks for, said in words a reader knows. */
const CAPABILITY_NAMES: Record<string, string> = {
  'thread.summarize': 'summarises a conversation when you ask for it',
  'email.summarize': 'summarises a single message when you ask for it',
};

const listOf = (names: string[], limit = 2): string => {
  const kept = names.filter(Boolean).slice(0, limit);
  const rest = names.filter(Boolean).length - kept.length;
  if (kept.length === 0) return '';
  return rest > 0 ? `${kept.join(', ')} and ${rest} more` : kept.join(', ');
};

export function describeExtensionSurfaces(source: SurfaceSource): ExtensionSurface[] {
  const permissions = new Set(source.permissions ?? []);
  const contributes = source.contributes ?? {};
  const surfaces: ExtensionSurface[] = [];

  // Ordered by how prominent the thing is on screen: a panel occupies real
  // estate, a card interrupts, a background workflow is invisible until it
  // changes something. That order is also the order someone scanning the
  // dialog wants it in.
  const panels = contributes.panels ?? [];
  const sidebar = panels.filter((panel) => panel.surface === 'sidebar');
  const elsewhere = panels.filter((panel) => panel.surface !== 'sidebar');

  if (sidebar.length > 0) {
    surfaces.push({
      icon: '🗂️',
      title: 'Adds a panel beside your mail',
      detail: sidebar.some((panel) => panel.autoOpen)
        ? `${listOf(sidebar.map((panel) => panel.title ?? 'Untitled'))} — opens on its own when you read a message`
        : `${listOf(sidebar.map((panel) => panel.title ?? 'Untitled'))} — you open it from the message`,
    });
  }

  if (elsewhere.length > 0) {
    surfaces.push({
      icon: '🪟',
      title: 'Opens its own window',
      detail: listOf(elsewhere.map((panel) => panel.title ?? 'Untitled')),
    });
  }

  if (permissions.has('ui:notify')) {
    surfaces.push({
      icon: '🔔',
      title: 'Shows cards in the corner of the window',
      detail: 'Appears when it has something for you, and goes away on its own',
    });
  }

  const capabilities = contributes.capabilities ?? [];
  if (capabilities.length > 0) {
    surfaces.push({
      icon: '✨',
      title: 'Answers on demand, when the app asks',
      detail: listOf(
        capabilities.map(
          (capability) =>
            CAPABILITY_NAMES[capability.id ?? ''] ?? capability.description ?? capability.id ?? ''
        )
      ),
    });
  }

  const workflows = contributes.workflows ?? [];
  if (workflows.length > 0) {
    surfaces.push({
      icon: '⚙️',
      title: 'Runs in the background on new mail',
      detail: listOf(workflows.map((workflow) => workflow.name ?? '')),
    });
  }

  // What it can CHANGE, rather than what it can see: a reader who installs
  // something that silently files their mail deserves that said plainly, and
  // "Modify Labels" in a permission list does not say it.
  const changes = [
    permissions.has('email:flag') ? 'mark messages read or starred' : '',
    permissions.has('email:label') ? 'add and remove labels' : '',
    permissions.has('email:move') ? 'move messages between folders' : '',
    permissions.has('email:delete') ? 'delete messages' : '',
  ].filter(Boolean);
  if (changes.length > 0) {
    surfaces.push({
      icon: '✏️',
      title: 'Changes your mail',
      detail: `It can ${listOf(changes, 3)}`,
    });
  }

  if ((contributes.settings ?? []).length > 0) {
    surfaces.push({
      icon: '🎛️',
      title: 'Adds its own settings',
      detail: 'Under Settings, Extensions — you can change how it behaves',
    });
  }

  if (permissions.has('network:fetch')) {
    surfaces.push({
      icon: '🌐',
      title: 'Talks to the internet',
      detail: 'It can send and receive data outside this app',
    });
  }

  if (permissions.has('ai:use')) {
    surfaces.push({
      icon: '🤖',
      title: 'Uses the AI model you configured',
      detail: 'Message text is sent to whichever provider you set up',
    });
  }

  // A line with nothing to say is dropped rather than printed headless: a
  // manifest whose workflow list has no names would otherwise render "Runs in
  // the background on new mail" followed by blank space.
  return surfaces.filter((surface) => surface.detail !== '');
}

/**
 * How long a description may run in the catalogue LIST.
 *
 * The list is for scanning: a row that is two lines for one extension and nine
 * for the next is not a list any more, and the full text is one click away in
 * the detail view. The cap is on characters rather than lines because a line is
 * a rendering accident - it moves with the window width, the font and the
 * user's zoom - and a row that reflows into a different height as the panel is
 * resized is exactly what this is avoiding.
 */
export const LIST_DESCRIPTION_LIMIT = 120;

/**
 * Shorten to at most `limit` characters, breaking at a word.
 *
 * Cuts at the last space inside the budget so a row never ends mid-word, and
 * appends a real ellipsis so it is visible that there is more to read. Text
 * already inside the budget is returned untouched - no ellipsis on a
 * description that is simply short.
 */
export function truncateDescription(text: string, limit: number = LIST_DESCRIPTION_LIMIT): string {
  const collapsed = text.trim().replace(/\s+/g, ' ');
  if (collapsed.length <= limit) return collapsed;

  const clipped = collapsed.slice(0, limit);
  const lastSpace = clipped.lastIndexOf(' ');
  // A single word longer than the whole budget has no space to break at; cut it
  // rather than returning the untruncated text and breaking the row.
  const body = lastSpace > limit * 0.6 ? clipped.slice(0, lastSpace) : clipped;
  return `${body.replace(/[\s,.;:—-]+$/, '')}…`;
}

/**
 * What each catalogue shelf is called on screen.
 *
 * The stored value is a lowercase slug so it can be compared and filtered; this
 * is the only place it becomes something to read. A shelf with no entry here
 * falls back to its own slug capitalised, so adding one to the core vocabulary
 * cannot produce a blank chip.
 */
const CATEGORY_LABELS: Record<string, string> = {
  productivity: 'Productivity',
  security: 'Security',
  organisation: 'Organisation',
  communication: 'Communication',
  office: 'Office',
  ai: 'AI',
  tools: 'Tools',
  other: 'Other',
};

/** The shelf's name, for a chip or a filter button. */
export function describeCategory(category: string): string {
  return CATEGORY_LABELS[category] ?? category.charAt(0).toUpperCase() + category.slice(1);
}

/**
 * The shelves worth offering as filters, in a stable order.
 *
 * Derived from what is actually in the catalogue rather than from the full
 * vocabulary: a filter button that always returns nothing is worse than no
 * button. Ordered by how many extensions sit on each shelf, then by name, so
 * the useful filters come first and the order does not jitter between loads.
 */
export function availableCategories(items: readonly { category?: string }[]): string[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    const category = item.category;
    if (!category) continue;
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([category]) => category);
}

/**
 * The chip text for an extension's shelf, or `null` when there is nothing worth
 * saying.
 *
 * `other` is what an extension gets when its author wrote no category, or wrote
 * one the app does not recognise — it is the absence of an answer, not an
 * answer. Drawing it would put an identical "Other" pill on every row of an
 * uncategorised catalogue, which is noise that reads like information.
 * Filtering still offers it: once some extensions ARE categorised, "Other" is a
 * useful place to find the ones that are not.
 */
export function categoryChipLabel(category?: string): string | null {
  if (!category || category === DEFAULT_EXTENSION_CATEGORY) return null;
  return describeCategory(category);
}

/** An installed extension, seen from the catalogue's point of view. */
export interface UpdateCandidate {
  id: string;
  /** Everything this extension has already been allowed to do. */
  grantedPermissions: readonly string[];
}

/** One catalogue entry, reduced to what deciding an update needs. */
export interface CatalogOffer {
  id: string;
  version: string;
  permissions: readonly string[];
  state: CatalogItemState;
}

export interface AvailableUpdate {
  id: string;
  /** The version the registry is offering. */
  version: string;
  /**
   * Everything the new version asks for, which is what the install has to be
   * handed: an install grants exactly the list it is given, so passing only the
   * difference would revoke every permission the extension already relies on.
   */
  permissions: string[];
  /**
   * Permissions the new version asks for that were never granted. Empty means
   * the update can be applied without asking again.
   */
  newPermissions: string[];
}

/**
 * Which installed extensions have a newer release waiting, and which of those
 * cannot be applied without asking first.
 *
 * `state` is the host's answer rather than a version comparison done here: the
 * host also knows whether the offered release will run on this build at all,
 * and an Update button that installs something incompatible is worse than no
 * button.
 *
 * The permission diff is what separates a one-click update from one that has to
 * go back through the consent dialog. A new version is allowed to ask for more
 * than the old one did, and the reader must see that before it runs — but
 * re-asking for permissions they already granted would turn "Update all" into a
 * stack of identical dialogs, which is how people learn to click through
 * consent without reading it.
 */
export function findAvailableUpdates(
  installed: readonly UpdateCandidate[],
  catalog: readonly CatalogOffer[]
): AvailableUpdate[] {
  const offers = new Map(catalog.map((item) => [item.id, item]));

  return installed.flatMap((extension) => {
    const offer = offers.get(extension.id);
    if (!offer || offer.state !== 'update-available') return [];

    const granted = new Set(extension.grantedPermissions);
    return [
      {
        id: extension.id,
        version: offer.version,
        permissions: [...offer.permissions],
        newPermissions: offer.permissions.filter((permission) => !granted.has(permission)),
      },
    ];
  });
}
