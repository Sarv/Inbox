import { readFileSync } from 'fs';
import { join } from 'path';

import { describe, expect, it } from 'vitest';

import { appearanceCssVars, defaultAppearance } from '../../../../src/appearance/appearance';

/**
 * The CSS half of the appearance feature.
 *
 * What breaks if this file goes red: density silently stops working. The
 * appearance module keeps writing `--row-h` onto <html>, nothing throws, and
 * every message row just ignores it — because the class that reads it was
 * renamed, or the component stopped using the class. The variable and its
 * consumer live in two different languages, so neither a compiler nor a lint
 * rule can notice.
 */
const read = (...parts: string[]) => readFileSync(join(__dirname, '../../../../', ...parts), 'utf8');

const CSS = read('src/index.css');

describe('index.css appearance defaults', () => {
  // Regression: the app must be fully styled on the FIRST paint, before the
  // appearance bootstrap runs — and in any context that never runs it. Every
  // property the module can write needs a default declared here.
  it('declares a default for every custom property the appearance module emits', () => {
    for (const property of Object.keys(appearanceCssVars(defaultAppearance, 'light'))) {
      expect(CSS, `${property} has no default in index.css`).toMatch(
        new RegExp(`^\\s*${property}:`, 'm'),
      );
    }
  });

  it('routes the body font through --app-font', () => {
    expect(CSS).toMatch(/body\s*\{[^}]*font-family:\s*var\(--app-font\)/);
  });

  it('sizes a list row from the density variables', () => {
    expect(CSS).toMatch(/\.list-row\s*\{[^}]*height:\s*var\(--row-h\)/);
    expect(CSS).toMatch(/\.list-row\s*\{[^}]*var\(--row-px\)/);
    expect(CSS).toMatch(/\.list-card\s*\{[^}]*var\(--card-py\)/);
    expect(CSS).toMatch(/\.nav-row\s*\{[^}]*var\(--nav-py\)/);
  });

  // Regression: a gradient is a background IMAGE. Written as `background-color`
  // the flat accent still works and the gradient option does nothing at all.
  it('paints the primary fill with `background`, not `background-color`', () => {
    const rule = CSS.slice(CSS.indexOf('.brand-fill {'));
    expect(rule).toMatch(/^\.brand-fill\s*\{\s*\n\s*background:\s*var\(--brand-fill\)/);
  });
});

describe('the components that consume the density classes', () => {
  // Regression: these four are the entire surface density controls. A refactor
  // that reinstates the old Tailwind spacing classes leaves the Density setting
  // visibly doing nothing.
  it('uses .list-row for the compact message row', () => {
    expect(read('src/components/email-list/CompactThreadRow.tsx')).toContain('list-row');
  });

  it('uses .list-card for the thread card', () => {
    expect(read('src/components/email-list/ThreadCard.tsx')).toContain('list-card');
  });

  it('uses .nav-row for the sidebar navigation rows', () => {
    expect(read('src/components/Sidebar.tsx')).toContain('nav-row');
  });

  it('uses .brand-fill for the Compose button', () => {
    expect(read('src/components/Sidebar.tsx')).toContain('brand-fill');
  });
});
