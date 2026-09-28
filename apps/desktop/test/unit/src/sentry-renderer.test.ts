import { describe, expect, it } from 'vitest';

import { crashReportsAllowed } from '../../../src/sentry';

// The renderer gates its own Sentry events on the saved setting. Breaks if an
// opted-out user's renderer errors are still captured, or a corrupt settings
// blob silently opts everyone out.
const store = (v: string | null) => ({ getItem: () => v });

describe('crashReportsAllowed', () => {
  it('is false only for an explicit crashReports: false', () => {
    expect(crashReportsAllowed(store(JSON.stringify({ crashReports: false })))).toBe(false);
    expect(crashReportsAllowed(store(JSON.stringify({ crashReports: true })))).toBe(true);
    expect(crashReportsAllowed(store(JSON.stringify({})))).toBe(true);
    expect(crashReportsAllowed(store(null))).toBe(true);
    expect(crashReportsAllowed(store('{broken'))).toBe(true);
    expect(crashReportsAllowed(undefined)).toBe(true);
  });
});
