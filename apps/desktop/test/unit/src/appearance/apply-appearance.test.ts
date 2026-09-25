import { describe, expect, it, vi } from 'vitest';

import { defaultAppearance, type Appearance } from '../../../../src/appearance/appearance';
import { applyAppearance, type AppearanceTarget } from '../../../../src/appearance/apply-appearance';

// What breaks if this suite goes red: the app renders in the wrong theme, at
// the wrong scale, or with light-coloured native scrollbars and <select> popups
// on a dark page. All of it is silent — nothing throws, it just looks wrong.

/** A recording stand-in for `document.documentElement`. */
const makeTarget = () => {
  const classes = new Set<string>();
  const properties = new Map<string, string>();
  const attributes = new Map<string, string>();
  const target: AppearanceTarget = {
    classList: {
      toggle: (token: string, force: boolean) => (force ? classes.add(token) : classes.delete(token)),
    },
    style: { setProperty: (property: string, value: string) => properties.set(property, value) },
    setAttribute: (name: string, value: string) => attributes.set(name, value),
  };
  return { target, classes, properties, attributes };
};

describe('applyAppearance', () => {
  // Regression: Tailwind's dark variants are class-based (darkMode: ['class']),
  // so without this class nothing in the app turns dark no matter what the
  // setting says.
  it('adds the .dark class for a dark theme and removes it for a light one', () => {
    const dark = makeTarget();
    applyAppearance(defaultAppearance, 'dark', dark.target);
    expect(dark.classes.has('dark')).toBe(true);

    const light = makeTarget();
    light.classes.add('dark');
    applyAppearance(defaultAppearance, 'light', light.target);
    expect(light.classes.has('dark')).toBe(false);
  });

  // Regression: without color-scheme, Chromium keeps painting scrollbars,
  // <select> popups and form controls light on a dark page.
  it('sets color-scheme to match the resolved theme', () => {
    const dark = makeTarget();
    applyAppearance(defaultAppearance, 'dark', dark.target);
    expect(dark.properties.get('color-scheme')).toBe('dark');
  });

  it('writes every appearance custom property onto the root', () => {
    const { target, properties } = makeTarget();
    const appearance: Appearance = { ...defaultAppearance, accent: 'emerald', density: 'compact', font: 'serif' };
    applyAppearance(appearance, 'light', target);
    expect(properties.get('--primary')).toBe('160 84% 32%');
    expect(properties.get('--row-h')).toBe('2.125rem');
    expect(properties.get('--app-font')).toContain('Georgia');
    expect(properties.get('--brand-fill')).toBe('hsl(160 84% 32%)');
  });

  it('exposes the density as an attribute for CSS and debugging', () => {
    const { target, attributes } = makeTarget();
    applyAppearance({ ...defaultAppearance, density: 'comfortable' }, 'light', target);
    expect(attributes.get('data-density')).toBe('comfortable');
  });

  // Regression: Electron wants a factor. Handing it the percentage renders the
  // window at 9000% — the bug this conversion exists to prevent.
  it('drives the zoom setter with a factor, not a percentage', () => {
    const { target } = makeTarget();
    const setZoomFactor = vi.fn();
    applyAppearance({ ...defaultAppearance, zoom: 90 }, 'light', target, setZoomFactor);
    expect(setZoomFactor).toHaveBeenCalledWith(0.9);
  });

  // Outside Electron (tests, a browser preview) there is no zoom setter at all.
  // Everything else must still apply rather than throwing partway through.
  it('applies the rest when no zoom setter is available', () => {
    const { target, classes } = makeTarget();
    expect(() => applyAppearance(defaultAppearance, 'dark', target)).not.toThrow();
    expect(classes.has('dark')).toBe(true);
  });

  // Regression: appearance is re-applied on every change and on every OS theme
  // flip. Applying twice must land in exactly the same place.
  it('is idempotent', () => {
    const first = makeTarget();
    const second = makeTarget();
    applyAppearance(defaultAppearance, 'dark', first.target);
    applyAppearance(defaultAppearance, 'dark', second.target);
    applyAppearance(defaultAppearance, 'dark', second.target);
    expect([...second.properties.entries()]).toEqual([...first.properties.entries()]);
    expect([...second.classes]).toEqual([...first.classes]);
  });
});
