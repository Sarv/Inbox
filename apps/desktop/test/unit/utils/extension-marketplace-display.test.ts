import { describe, expect, it } from 'vitest';

import {
  PERMISSION_DISPLAY,
  describeExtensionSurfaces,
  describeInstallAction,
  describePermission,
  formatCompactCount,
  formatDownloadSize,
  hasHighRiskPermission,
  sortPermissionsByRisk,
} from '../../../src/utils/extension-marketplace-display';

/**
 * How the extensions panel describes what it is about to run.
 *
 * What this protects: this table is the entire basis on which a user decides
 * whether to trust a stranger's extension. A permission that renders blank, or
 * one that sorts below a harmless one, means the thing worth refusing over is
 * not the thing they read.
 */
describe('describePermission', () => {
  // A permission missing from the table would otherwise render as an empty row,
  // which reads as "this extension asks for nothing".
  it('falls back to the raw id, marked dangerous, for an unknown permission', () => {
    const unknown = describePermission('mail:exfiltrate');
    expect(unknown.name).toBe('mail:exfiltrate');
    expect(unknown.risk).toBe('high');
    expect(unknown.description).toMatch(/does not recognise/i);
  });

  it('describes every permission the app actually defines', () => {
    for (const [permission, info] of Object.entries(PERMISSION_DISPLAY)) {
      expect(describePermission(permission)).toBe(info);
      expect(info.name).not.toBe('');
      expect(info.description).not.toBe('');
    }
  });

  // Reading mail, deleting it, and calling out to the network are the three
  // that can do real damage; nothing else may be ranked above them.
  it.each(['email:read', 'email:delete', 'network:fetch'])('ranks %s as high risk', (permission) => {
    expect(describePermission(permission).risk).toBe('high');
  });
});

describe('sortPermissionsByRisk', () => {
  // The prompt is only meaningful if the scariest line is the first one read.
  it('puts the riskiest permission first and keeps ties alphabetical', () => {
    expect(
      sortPermissionsByRisk(['ui:notify', 'storage:local', 'email:read', 'network:fetch', 'email:move'])
    ).toEqual(['email:read', 'network:fetch', 'email:move', 'storage:local', 'ui:notify']);
  });

  it('does not mutate its input', () => {
    const input = ['ui:notify', 'email:read'];
    sortPermissionsByRisk(input);
    expect(input).toEqual(['ui:notify', 'email:read']);
  });

  it('sorts an unknown permission to the top rather than hiding it', () => {
    expect(sortPermissionsByRisk(['ui:notify', 'mystery:thing'])[0]).toBe('mystery:thing');
  });

  it('handles an extension that asks for nothing', () => {
    expect(sortPermissionsByRisk([])).toEqual([]);
  });
});

describe('hasHighRiskPermission', () => {
  it('is true when any one permission is sensitive', () => {
    expect(hasHighRiskPermission(['ui:notify', 'email:read'])).toBe(true);
  });

  it('is false for a set that can only label and notify', () => {
    expect(hasHighRiskPermission(['ui:notify', 'email:label', 'storage:local'])).toBe(false);
  });

  it('is false for no permissions at all', () => {
    expect(hasHighRiskPermission([])).toBe(false);
  });
});

describe('describeInstallAction', () => {
  it('offers an install for something not yet on disk', () => {
    expect(describeInstallAction('available')).toEqual({ label: 'Install', disabled: false });
  });

  it('offers an update when a newer version is published', () => {
    expect(describeInstallAction('update-available')).toEqual({ label: 'Update', disabled: false });
  });

  it('locks the button for something already installed', () => {
    expect(describeInstallAction('installed').disabled).toBe(true);
  });

  // An extension that needs a newer app stays listed with the reason attached;
  // filtering it out looks to the user like the extension does not exist.
  it('explains why an incompatible extension cannot be installed', () => {
    const action = describeInstallAction('incompatible', 'Requires Sarv Inbox 2.0.0 or newer');
    expect(action.disabled).toBe(true);
    expect(action.reason).toBe('Requires Sarv Inbox 2.0.0 or newer');
  });

  it('still gives a reason when the registry supplied none', () => {
    expect(describeInstallAction('incompatible').reason).toMatch(/not compatible/i);
  });
});

describe('formatCompactCount', () => {
  it('shortens large counts', () => {
    expect(formatCompactCount(1500)).toMatch(/1\.5\s*K/i);
    expect(formatCompactCount(12)).toBe('12');
  });

  // A registry that has never been generated reports no downloads at all; the
  // card must show "0", not "NaN".
  it.each([Number.NaN, Number.POSITIVE_INFINITY, -5])('renders %s as 0', (value) => {
    expect(formatCompactCount(value)).toBe('0');
  });
});

describe('formatDownloadSize', () => {
  it('scales through the units', () => {
    expect(formatDownloadSize(900)).toBe('900 B');
    expect(formatDownloadSize(7_104)).toBe('6.9 KB');
    expect(formatDownloadSize(102_235)).toBe('100 KB');
    expect(formatDownloadSize(5 * 1024 * 1024)).toBe('5.0 MB');
  });

  it('renders nothing for a missing or nonsense size', () => {
    expect(formatDownloadSize(0)).toBe('');
    expect(formatDownloadSize(Number.NaN)).toBe('');
  });
});

/**
 * What an extension DOES, as opposed to what it may touch.
 *
 * What this protects: the permission list above describes a passcode reader, a
 * spam filter and a translator in exactly the same words, so people install one
 * to find out what it is and then cannot tell what changed. These lines are the
 * only place the app answers "what will this do, and where will I see it", and
 * every one of them is derived from the manifest — if a line stops matching
 * what the extension declared, the answer is confidently wrong, which is worse
 * than absent.
 */
describe('describeExtensionSurfaces', () => {
  // Nothing declared means nothing claimed: a blank section beats an invented
  // sentence about an extension whose manifest says nothing.
  it('says nothing about an extension that declares nothing', () => {
    expect(describeExtensionSurfaces({})).toEqual([]);
    expect(describeExtensionSurfaces({ permissions: [], contributes: {} })).toEqual([]);
  });

  it('leads with a sidebar panel, naming it', () => {
    const [first] = describeExtensionSurfaces({
      contributes: { panels: [{ id: 'codes', title: 'Passcodes', surface: 'sidebar' }] },
    });

    expect(first.title).toContain('panel');
    expect(first.detail).toContain('Passcodes');
  });

  // autoOpen is the difference between something appearing on its own and
  // something the reader has to go and open — the reader should know which.
  it('distinguishes a panel that opens itself from one you open', () => {
    const auto = describeExtensionSurfaces({
      contributes: { panels: [{ title: 'Passcodes', surface: 'sidebar', autoOpen: true }] },
    });
    const manual = describeExtensionSurfaces({
      contributes: { panels: [{ title: 'Passcodes', surface: 'sidebar' }] },
    });

    expect(auto[0].detail).toContain('opens on its own');
    expect(manual[0].detail).toContain('you open it');
  });

  it('reports a modal panel as its own window', () => {
    const surfaces = describeExtensionSurfaces({
      contributes: { panels: [{ title: 'Setup', surface: 'modal' }] },
    });

    expect(surfaces.map((surface) => surface.title)).toContain('Opens its own window');
  });

  // The order is the order of prominence on screen: a panel occupies space, a
  // card interrupts, a background workflow is invisible. Scrambling it buries
  // the thing the reader will actually notice.
  it('orders panels before notifications before background work', () => {
    const titles = describeExtensionSurfaces({
      permissions: ['ui:notify'],
      contributes: {
        panels: [{ title: 'Passcodes', surface: 'sidebar' }],
        workflows: [{ name: 'Find codes' }],
      },
    }).map((surface) => surface.title);

    expect(titles.indexOf('Adds a panel beside your mail')).toBeLessThan(
      titles.indexOf('Shows cards in the corner of the window')
    );
    expect(titles.indexOf('Shows cards in the corner of the window')).toBeLessThan(
      titles.indexOf('Runs in the background on new mail')
    );
  });

  // A capability id is machine-facing; the reader gets the sentence instead.
  it('says what a known capability actually does', () => {
    const surfaces = describeExtensionSurfaces({
      contributes: { capabilities: [{ id: 'thread.summarize', export: 'summarize' }] },
    });

    expect(surfaces[0].detail).toContain('summarises a conversation');
  });

  it('falls back to a capability description, then its id', () => {
    const described = describeExtensionSurfaces({
      contributes: { capabilities: [{ id: 'invoice.extract', description: 'Pulls out invoices' }] },
    });
    const bare = describeExtensionSurfaces({
      contributes: { capabilities: [{ id: 'invoice.extract' }] },
    });

    expect(described[0].detail).toBe('Pulls out invoices');
    expect(bare[0].detail).toBe('invoice.extract');
  });

  // Regression: this is the line that stops someone installing a thing that
  // silently files their mail. "Modify Labels" in a permission table does not
  // say that it WILL, and a reader who skims permissions reads this instead.
  it('spells out that it can change your mail', () => {
    const surfaces = describeExtensionSurfaces({
      permissions: ['email:read', 'email:label', 'email:flag'],
    });
    const changes = surfaces.find((surface) => surface.title === 'Changes your mail');

    expect(changes?.detail).toContain('add and remove labels');
    expect(changes?.detail).toContain('mark messages read or starred');
  });

  it('says nothing about changing mail when it can only read', () => {
    const titles = describeExtensionSurfaces({ permissions: ['email:read'] }).map(
      (surface) => surface.title
    );

    expect(titles).not.toContain('Changes your mail');
  });

  it('names the two loudest permissions in their own words', () => {
    const titles = describeExtensionSurfaces({
      permissions: ['network:fetch', 'ai:use'],
    }).map((surface) => surface.title);

    expect(titles).toContain('Talks to the internet');
    expect(titles).toContain('Uses the AI model you configured');
  });

  it('mentions its settings section only when it adds one', () => {
    const withSettings = describeExtensionSurfaces({
      contributes: { settings: [{ key: 'minConfidence' }] },
    }).map((surface) => surface.title);
    const without = describeExtensionSurfaces({ contributes: { settings: [] } }).map(
      (surface) => surface.title
    );

    expect(withSettings).toContain('Adds its own settings');
    expect(without).not.toContain('Adds its own settings');
  });

  // A manifest with twelve workflows must not render a paragraph in a dialog
  // whose whole point is being readable at a glance.
  it('summarises a long list rather than printing all of it', () => {
    const surfaces = describeExtensionSurfaces({
      contributes: {
        workflows: [{ name: 'One' }, { name: 'Two' }, { name: 'Three' }, { name: 'Four' }],
      },
    });

    expect(surfaces[0].detail).toBe('One, Two and 2 more');
  });

  // Registry data is third-party input; a missing title must not render the
  // word "undefined" into a dialog about trust.
  it('survives a contribution with fields missing', () => {
    const surfaces = describeExtensionSurfaces({
      contributes: { panels: [{ surface: 'sidebar' }], workflows: [{}] },
    });

    expect(JSON.stringify(surfaces)).not.toContain('undefined');
  });
});
