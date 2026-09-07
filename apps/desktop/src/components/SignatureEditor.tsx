import DOMPurify from 'dompurify';
import {
  Bold, Italic, Underline, Strikethrough, Link as LinkIcon,
  List, ListOrdered, Image as ImageIcon,
  AlignLeft, AlignCenter, AlignRight,
  Baseline, Highlighter, RemoveFormatting, Maximize2, Minimize2,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { Tooltip } from './Tooltip';

interface SignatureEditorProps {
  value: string;
  onChange: (html: string) => void;
  className?: string;
}

/** Email-safe fonts (widely available across mail clients + web fallbacks). */
const FONTS = [
  'Arial', 'Helvetica', 'Verdana', 'Tahoma', 'Trebuchet MS',
  'Georgia', 'Times New Roman', 'Courier New', 'Roboto', 'Segoe UI',
];

/** Point-ish sizes offered in the size dropdown. */
const SIZES = ['10px', '12px', '14px', '16px', '18px', '24px', '32px'];

/** Strip only genuinely unsafe bits (scripts, inline event handlers) while
 *  keeping tables, inline styles, and image sizing — the layout we must NOT
 *  lose. Deliberately light-touch, unlike a rich-text schema allowlist. */
const sanitize = (html: string): string =>
  DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    ADD_TAGS: ['table', 'thead', 'tbody', 'tr', 'td', 'th'],
    ADD_ATTR: ['style', 'target', 'width', 'height', 'align', 'valign', 'bgcolor', 'color'],
    ALLOW_DATA_ATTR: false,
  });

/**
 * Fidelity-preserving signature editor. A plain contentEditable keeps pasted
 * HTML (tables, flex, inline styles, image width/height) exactly as pasted —
 * the TipTap editor drops all of that because its schema has no table/flex
 * nodes. innerHTML is stored verbatim so a designed signature renders here (and
 * when sent) identically to how it looks in Gmail; the toolbar also lets a user
 * build a good-looking signature from scratch (font, size, color, image, …).
 *
 * Remount via a `key` when switching between signatures so each loads fresh.
 */
export function SignatureEditor({ value, onChange, className }: SignatureEditorProps) {
  const ref = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // Last HTML we emitted, so an external value change (switching signatures)
  // resets the DOM but our own keystroke-driven updates don't clobber the caret.
  const lastEmitted = useRef<string | null>(null);
  // Last selection inside the editor — restored before applying a command from a
  // control that steals focus (a <select> or <input type=color>), so the format
  // lands on the text the user had selected.
  const savedRange = useRef<Range | null>(null);
  // The image the user clicked — surfaces a size control (contentEditable has no
  // native resize handles in Chromium).
  const [selectedImg, setSelectedImg] = useState<HTMLImageElement | null>(null);
  // Font family + size at the caret, so the dropdowns show what you're typing in.
  const [activeFont, setActiveFont] = useState('');
  const [activeSize, setActiveSize] = useState('');
  // Expanded (tall) editing mode for building a big signature comfortably.
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (ref.current && value !== lastEmitted.current) {
      ref.current.innerHTML = value || '';
      lastEmitted.current = value;
    }
  }, [value]);

  const emit = () => {
    const html = sanitize(ref.current?.innerHTML || '');
    lastEmitted.current = html;
    onChange(html);
  };

  const saveSelection = () => {
    const sel = window.getSelection();
    if (sel && sel.rangeCount && ref.current?.contains(sel.anchorNode)) {
      savedRange.current = sel.getRangeAt(0).cloneRange();
    }
  };

  const restoreSelection = () => {
    const sel = window.getSelection();
    if (sel && savedRange.current) {
      sel.removeAllRanges();
      sel.addRange(savedRange.current);
    }
  };

  // Reflect the caret's actual font family + size in the dropdowns.
  const syncActiveFormat = () => {
    const node = window.getSelection()?.anchorNode;
    const el = node ? (node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as HTMLElement)) : null;
    if (!el || !ref.current?.contains(el)) return;
    const cs = window.getComputedStyle(el);
    setActiveFont((cs.fontFamily || '').split(',')[0].replace(/["']/g, '').trim());
    const px = Math.round(parseFloat(cs.fontSize || '0'));
    setActiveSize(px ? `${px}px` : '');
  };

  const onSelect = () => { saveSelection(); syncActiveFormat(); };

  /** Run an editing operation with the editor focused and the saved selection
   *  restored, then persist the result. */
  const run = (fn: () => void) => {
    ref.current?.focus();
    restoreSelection();
    fn();
    saveSelection();
    syncActiveFormat();
    emit();
  };

  // styleWithCSS=true → commands emit `<span style>` instead of legacy <font>
  // tags, which render more consistently in modern mail clients.
  const cmd = (command: string, val?: string, css = true) =>
    run(() => {
      document.execCommand('styleWithCSS', false, String(css));
      document.execCommand(command, false, val);
    });

  const setFontName = (font: string) => { if (font) cmd('fontName', font); };
  const setForeColor = (c: string) => cmd('foreColor', c);
  const setBackColor = (c: string) => cmd('hiliteColor', c);

  // execCommand('fontSize') only takes the legacy 1–7 scale, so mark the
  // selection with size 7 (as <font>), then rewrite those nodes to the exact px.
  const setFontSize = (px: string) => {
    if (!px) return;
    run(() => {
      document.execCommand('styleWithCSS', false, 'false');
      document.execCommand('fontSize', false, '7');
      ref.current?.querySelectorAll('font[size="7"]').forEach((el) => {
        el.removeAttribute('size');
        (el as HTMLElement).style.fontSize = px;
      });
    });
  };

  const addLink = () => {
    const url = window.prompt('Link URL');
    if (!url) return;
    cmd('createLink', url);
  };

  // Insert a picked image as an inline data URL so it travels with the signature
  // HTML. Capped to a sensible default width so a full-res photo isn't inserted
  // giant — the user can then click it to resize.
  const insertImageFromFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const src = String(reader.result);
      run(() => document.execCommand('insertHTML', false, `<img src="${src}" alt="" style="width:200px;height:auto;" />`));
    };
    reader.readAsDataURL(file);
  };

  // Resize the clicked image. Clears max-width so an explicit width always wins.
  const setImgWidth = (w: string) => {
    if (!selectedImg) return;
    selectedImg.style.maxWidth = w === '100%' ? '100%' : '';
    selectedImg.style.width = w;
    selectedImg.style.height = 'auto';
    emit();
  };

  // Float the image so text can sit BESIDE it (logo left, text right — the
  // classic signature layout). 'none' puts it back in normal flow.
  const setImgFloat = (dir: 'left' | 'right' | 'none') => {
    if (!selectedImg) return;
    if (dir === 'none') {
      selectedImg.style.float = '';
      selectedImg.style.margin = '';
    } else {
      selectedImg.style.float = dir;
      selectedImg.style.margin = dir === 'left' ? '0 12px 8px 0' : '0 0 8px 12px';
    }
    emit();
  };

  const btn = 'p-1.5 rounded hover:bg-muted/50';
  const sep = <span className="w-px h-5 bg-border mx-1" />;
  // Keep the editor selection when a toolbar button is pressed.
  const keepSel = (e: React.MouseEvent) => e.preventDefault();

  return (
    <>
      {/* Backdrop when expanded to a popup (kept as index-0 slot so the card
          below never remounts — the contentEditable keeps its content). */}
      {expanded && (
        <div className="fixed inset-0 z-[190] bg-black/50" onClick={() => setExpanded(false)} />
      )}
      <div
        className={
          expanded
            ? 'fixed inset-0 z-[200] m-auto w-[min(900px,92vw)] h-[85vh] flex flex-col rounded-lg border border-border bg-background shadow-xl overflow-hidden'
            // Collapsed: the whole box is drag-resizable both ways (bottom-right).
            : 'flex flex-col border border-border rounded-md overflow-hidden bg-background resize min-h-[220px] min-w-[320px]'
        }
      >
      <div className="flex items-center gap-0.5 flex-wrap border-b border-border px-2 py-1">
        {/* Font family — shows the family at the caret */}
        <select
          aria-label="Font"
          value={activeFont}
          onChange={(e) => setFontName(e.target.value)}
          className="h-7 px-1 rounded border border-border bg-background text-xs"
        >
          {!activeFont && <option value="">Font</option>}
          {activeFont && !FONTS.includes(activeFont) && <option value={activeFont}>{activeFont}</option>}
          {FONTS.map((f) => <option key={f} value={f} style={{ fontFamily: f }}>{f}</option>)}
        </select>
        {/* Font size — shows the size at the caret */}
        <select
          aria-label="Font size"
          value={activeSize}
          onChange={(e) => setFontSize(e.target.value)}
          className="h-7 px-1 rounded border border-border bg-background text-xs"
        >
          {!activeSize && <option value="">Size</option>}
          {activeSize && !SIZES.includes(activeSize) && <option value={activeSize}>{activeSize.replace('px', '')}</option>}
          {SIZES.map((s) => <option key={s} value={s}>{s.replace('px', '')}</option>)}
        </select>

        {sep}

        <Tooltip content="Bold" delayMs={40}><button type="button" onMouseDown={keepSel} onClick={() => cmd('bold')} className={btn} aria-label="Bold"><Bold className="h-4 w-4" /></button></Tooltip>
        <Tooltip content="Italic" delayMs={40}><button type="button" onMouseDown={keepSel} onClick={() => cmd('italic')} className={btn} aria-label="Italic"><Italic className="h-4 w-4" /></button></Tooltip>
        <Tooltip content="Underline" delayMs={40}><button type="button" onMouseDown={keepSel} onClick={() => cmd('underline')} className={btn} aria-label="Underline"><Underline className="h-4 w-4" /></button></Tooltip>
        <Tooltip content="Strikethrough" delayMs={40}><button type="button" onMouseDown={keepSel} onClick={() => cmd('strikeThrough')} className={btn} aria-label="Strikethrough"><Strikethrough className="h-4 w-4" /></button></Tooltip>

        {sep}

        {/* Text color */}
        <Tooltip content="Text color" delayMs={40}>
          <label className={`${btn} relative cursor-pointer flex items-center`} aria-label="Text color">
            <Baseline className="h-4 w-4" />
            <input type="color" onChange={(e) => setForeColor(e.target.value)} className="absolute inset-0 opacity-0 cursor-pointer" />
          </label>
        </Tooltip>
        {/* Highlight color */}
        <Tooltip content="Highlight color" delayMs={40}>
          <label className={`${btn} relative cursor-pointer flex items-center`} aria-label="Highlight color">
            <Highlighter className="h-4 w-4" />
            <input type="color" onChange={(e) => setBackColor(e.target.value)} className="absolute inset-0 opacity-0 cursor-pointer" />
          </label>
        </Tooltip>

        {sep}

        <Tooltip content="Bulleted list" delayMs={40}><button type="button" onMouseDown={keepSel} onClick={() => cmd('insertUnorderedList')} className={btn} aria-label="Bulleted list"><List className="h-4 w-4" /></button></Tooltip>
        <Tooltip content="Numbered list" delayMs={40}><button type="button" onMouseDown={keepSel} onClick={() => cmd('insertOrderedList')} className={btn} aria-label="Numbered list"><ListOrdered className="h-4 w-4" /></button></Tooltip>

        {sep}

        <Tooltip content="Align left" delayMs={40}><button type="button" onMouseDown={keepSel} onClick={() => cmd('justifyLeft')} className={btn} aria-label="Align left"><AlignLeft className="h-4 w-4" /></button></Tooltip>
        <Tooltip content="Align center" delayMs={40}><button type="button" onMouseDown={keepSel} onClick={() => cmd('justifyCenter')} className={btn} aria-label="Align center"><AlignCenter className="h-4 w-4" /></button></Tooltip>
        <Tooltip content="Align right" delayMs={40}><button type="button" onMouseDown={keepSel} onClick={() => cmd('justifyRight')} className={btn} aria-label="Align right"><AlignRight className="h-4 w-4" /></button></Tooltip>

        {sep}

        <Tooltip content="Insert link" delayMs={40}><button type="button" onMouseDown={keepSel} onClick={addLink} className={btn} aria-label="Insert link"><LinkIcon className="h-4 w-4" /></button></Tooltip>
        <Tooltip content="Insert image" delayMs={40}><button type="button" onMouseDown={keepSel} onClick={() => fileRef.current?.click()} className={btn} aria-label="Insert image"><ImageIcon className="h-4 w-4" /></button></Tooltip>
        <Tooltip content="Clear formatting" delayMs={40}><button type="button" onMouseDown={keepSel} onClick={() => cmd('removeFormat')} className={btn} aria-label="Clear formatting"><RemoveFormatting className="h-4 w-4" /></button></Tooltip>

        <Tooltip content={expanded ? 'Shrink editor' : 'Expand editor'} delayMs={40}>
          <button type="button" onMouseDown={keepSel} onClick={() => setExpanded((v) => !v)} className={`${btn} ml-auto`} aria-label={expanded ? 'Shrink editor' : 'Expand editor'}>
            {expanded ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
          </button>
        </Tooltip>

        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) insertImageFromFile(file);
            e.target.value = '';
          }}
        />
      </div>
      {/* Image size controls — shown when an image in the signature is clicked
          (contentEditable has no native resize handles in Chromium). */}
      {selectedImg && (
        <div className="flex items-center gap-x-4 gap-y-1.5 flex-wrap border-b border-border bg-muted/20 px-2 py-1.5 text-xs">
          <div className="flex items-center gap-1.5">
            <span className="text-muted-foreground">Size</span>
            <button type="button" onMouseDown={keepSel} onClick={() => setImgWidth('120px')} className="px-2 h-6 rounded border border-border hover:bg-muted/50">Small</button>
            <button type="button" onMouseDown={keepSel} onClick={() => setImgWidth('200px')} className="px-2 h-6 rounded border border-border hover:bg-muted/50">Medium</button>
            <button type="button" onMouseDown={keepSel} onClick={() => setImgWidth('320px')} className="px-2 h-6 rounded border border-border hover:bg-muted/50">Large</button>
            <button type="button" onMouseDown={keepSel} onClick={() => setImgWidth('100%')} className="px-2 h-6 rounded border border-border hover:bg-muted/50">Fit</button>
            <input
              type="number"
              placeholder="px"
              className="w-14 h-6 px-1 rounded border border-border bg-background"
              onKeyDown={(e) => { if (e.key === 'Enter') { const v = (e.target as HTMLInputElement).value; if (v) setImgWidth(`${v}px`); } }}
            />
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-muted-foreground">Wrap</span>
            <button type="button" onMouseDown={keepSel} onClick={() => setImgFloat('left')} className="px-2 h-6 rounded border border-border hover:bg-muted/50">Left</button>
            <button type="button" onMouseDown={keepSel} onClick={() => setImgFloat('right')} className="px-2 h-6 rounded border border-border hover:bg-muted/50">Right</button>
            <button type="button" onMouseDown={keepSel} onClick={() => setImgFloat('none')} className="px-2 h-6 rounded border border-border hover:bg-muted/50">None</button>
          </div>
          <button type="button" onClick={() => setSelectedImg(null)} className="ml-auto h-6 px-2 rounded text-muted-foreground hover:text-foreground hover:bg-muted/50">Done</button>
        </div>
      )}
      <div
        ref={ref}
        contentEditable
        suppressContentEditableWarning
        onInput={() => { emit(); syncActiveFormat(); }}
        onBlur={() => { saveSelection(); emit(); }}
        onKeyUp={onSelect}
        onMouseUp={onSelect}
        onFocus={syncActiveFormat}
        onClick={(e) => {
          const t = e.target as HTMLElement;
          setSelectedImg(t.tagName === 'IMG' ? (t as HTMLImageElement) : null);
        }}
        className={`flex-1 px-3 py-2 text-sm focus:outline-none overflow-auto ${className ?? ''}`}
      />
      </div>
    </>
  );
}
