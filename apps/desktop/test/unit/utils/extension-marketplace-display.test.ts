import { describe, expect, it } from 'vitest';

import {
  PERMISSION_DISPLAY,
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
