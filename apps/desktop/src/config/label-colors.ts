// Shared preset palette for labels — used by the color picker, Settings Labels
// tab and the sidebar quick-create. One source avoids drift between them. The
// first eight are the original palette (kept first so existing labels and the
// default color are unchanged); the rest broaden the range. All are medium/dark
// enough to read as text on the chip's light tint (chips use `${color}22` bg).
export const LABEL_COLORS = [
  '#2563eb', '#059669', '#d97706', '#dc2626',
  '#7c3aed', '#db2777', '#0891b2', '#4b5563',
  '#ea580c', '#ca8a04', '#65a30d', '#16a34a',
  '#0d9488', '#0284c7', '#4f46e5', '#9333ea',
  '#c026d3', '#e11d48', '#78716c', '#475569',
  '#334155', '#b45309', '#15803d', '#57534e',
];

/**
 * Pick a readable text color (near-black or white) for text drawn ON a solid
 * fill of `hex`. Uses WCAG relative luminance so pale label colors (e.g. a light
 * pink/lime) get dark text and dark colors get white text — used by the solid
 * label chips in the email list. Falls back to white for an unparseable color.
 * Accepts `#rgb` or `#rrggbb`.
 */
export function readableTextColor(hex: string): string {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec((hex || '').trim());
  if (!m) return '#ffffff';
  let h = m[1];
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  // Relative luminance (sRGB → linear), per WCAG 2.x.
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  const luminance = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  // Threshold ~0.5 balances contrast against both text colors across the palette.
  return luminance > 0.5 ? '#111827' : '#ffffff';
}

/** Human-readable names for the palette — used as accessible labels on swatches. */
export const LABEL_COLOR_NAMES: Record<string, string> = {
  '#2563eb': 'Blue',
  '#059669': 'Emerald',
  '#d97706': 'Amber',
  '#dc2626': 'Red',
  '#7c3aed': 'Violet',
  '#db2777': 'Pink',
  '#0891b2': 'Cyan',
  '#4b5563': 'Gray',
  '#ea580c': 'Orange',
  '#ca8a04': 'Yellow',
  '#65a30d': 'Lime',
  '#16a34a': 'Green',
  '#0d9488': 'Teal',
  '#0284c7': 'Sky',
  '#4f46e5': 'Indigo',
  '#9333ea': 'Purple',
  '#c026d3': 'Fuchsia',
  '#e11d48': 'Rose',
  '#78716c': 'Stone',
  '#475569': 'Slate',
  '#334155': 'Dark Slate',
  '#b45309': 'Bronze',
  '#15803d': 'Forest',
  '#57534e': 'Taupe',
};
