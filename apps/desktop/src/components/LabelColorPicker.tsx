import { Check, ChevronDown, Plus } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { LABEL_COLORS, LABEL_COLOR_NAMES } from '../config/label-colors';

interface LabelColorPickerProps {
  value: string;
  onChange: (color: string) => void;
  /** Letter previewed inside each swatch (the label's initial), Gmail-style. */
  initial?: string;
}

/**
 * Shared Gmail-style label color picker used everywhere a label color is chosen
 * (new-label dialog, settings edit). The trigger is a color circle showing the
 * label's initial; the dropdown is a compact grid of color circles plus a
 * custom-color swatch (native OS picker). Rendered in a portal so it never clips
 * inside a modal or a scroll container.
 */
export function LabelColorPicker({ value, onChange, initial = '' }: LabelColorPickerProps) {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  useLayoutEffect(() => {
    if (!open || !btnRef.current || !menuRef.current) return;
    const b = btnRef.current.getBoundingClientRect();
    const m = menuRef.current.getBoundingClientRect();
    const pad = 8;
    let left = Math.min(b.left, window.innerWidth - m.width - pad);
    left = Math.max(pad, left);
    let top = b.bottom + 4;
    if (top + m.height > window.innerHeight - pad) top = Math.max(pad, b.top - m.height - 4);
    setCoords({ top, left });
  }, [open]);

  const isPreset = LABEL_COLORS.includes(value);
  // Always render a letter inside swatches so text-on-color visibility is
  // clear even before a name is typed; use the label's initial once it exists.
  const preview = initial || 'si';

  return (
    <div className="shrink-0">
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="Label color"
        className="flex items-center gap-1.5 px-1.5 py-1.5 border border-border rounded-md bg-background hover:bg-muted/50"
      >
        <span
          className="h-6 w-6 rounded-full flex items-center justify-center text-white text-xs font-semibold"
          style={{ backgroundColor: value }}
        >
          {preview}
        </span>
        <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
      </button>
      {open && createPortal(
        <div
          ref={menuRef}
          className="fixed z-[210] rounded-lg border border-border bg-background shadow-xl p-2"
          style={{ top: coords?.top ?? -9999, left: coords?.left ?? -9999 }}
        >
          <div className="grid grid-cols-6 gap-2">
            {LABEL_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => { onChange(c); setOpen(false); }}
                aria-label={LABEL_COLOR_NAMES[c] ?? c}
                className={`h-7 w-7 rounded-full flex items-center justify-center text-white text-xs font-semibold transition-transform hover:scale-110 ${value === c ? 'ring-2 ring-offset-2 ring-offset-background ring-foreground/50' : ''}`}
                style={{ backgroundColor: c }}
              >
                {value === c ? <Check className="h-4 w-4" /> : preview}
              </button>
            ))}
            {/* Custom color — opens the OS color picker */}
            <label
              aria-label="Custom color"
              title="Custom color"
              className={`relative h-7 w-7 rounded-full flex items-center justify-center cursor-pointer border border-dashed transition-transform hover:scale-110 ${!isPreset ? 'border-transparent text-white ring-2 ring-offset-2 ring-offset-background ring-foreground/50' : 'border-muted-foreground/50 text-muted-foreground'}`}
              style={!isPreset ? { backgroundColor: value } : undefined}
            >
              {!isPreset ? <Check className="h-4 w-4" /> : <Plus className="h-3.5 w-3.5" />}
              <input
                type="color"
                value={value}
                onChange={(e) => onChange(e.target.value)}
                className="sr-only"
              />
            </label>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
