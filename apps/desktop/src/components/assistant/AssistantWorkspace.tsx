import { Bot, GripHorizontal, Loader2, Maximize2, PanelRight, PictureInPicture2, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';

import type { InboxAssistantViewState } from './InboxAssistant';

type Layout = 'pip' | 'split';
type Rect = { x: number; y: number; width: number; height: number };
const PREFERENCE = 'sarvinbox-assistant-workspace';
const initialState: InboxAssistantViewState = { chatId: null, title: 'Inbox Agent', requestId: null, running: false, status: 'Ready' };
const viewport = () => ({ width: window.innerWidth, height: window.innerHeight });
function bounds(rect: Rect): Rect {
  const size = viewport();
  const width = Math.min(Math.max(360, rect.width), Math.max(1, size.width - 24));
  const height = Math.min(Math.max(340, rect.height), Math.max(1, size.height - 24));
  return { width, height, x: Math.max(12, Math.min(rect.x, size.width - width - 12)), y: Math.max(12, Math.min(rect.y, size.height - height - 12)) };
}
function savedLayout(): Layout {
  try { return localStorage.getItem(PREFERENCE) === 'split' ? 'split' : 'pip'; } catch { return 'pip'; }
}

export interface AssistantWorkspaceProps {
  section: string;
  onOpenInbox(): void;
  onOpenAssistant(): void;
  onFocusChange?(focused: boolean): void;
  renderAssistant(options: { compact: boolean; visible: boolean; onStateChange(state: InboxAssistantViewState): void }): ReactNode;
  children: ReactNode;
}

/** Keep one chat tree alive; changing its presentation never cancels its request. */
export function AssistantWorkspace({ section, onOpenInbox, onOpenAssistant, onFocusChange, renderAssistant, children }: AssistantWorkspaceProps) {
  const [layout, setLayout] = useState<Layout>(savedLayout);
  const [started, setStarted] = useState(() => section === 'assistant' || savedLayout() === 'split');
  const [awayOpen, setAwayOpen] = useState(() => savedLayout() === 'split');
  const [manuallyOpened, setManuallyOpened] = useState(() => savedLayout() === 'split');
  const [dismissed, setDismissed] = useState(false);
  const [state, setState] = useState(initialState);
  const [size, setSize] = useState(viewport);
  const [rect, setRect] = useState(() => bounds({ x: window.innerWidth - 520, y: window.innerHeight - 620, width: 500, height: 580 }));
  const [splitWidth, setSplitWidth] = useState(480);
  const [dragging, setDragging] = useState(false);
  const gesture = useRef<{ kind: 'move' | 'resize' | 'split'; x: number; y: number; rect: Rect; width: number } | null>(null);
  const lastActivity = useRef<string | null>(null);
  const focusListener = useRef(onFocusChange);
  useEffect(() => { focusListener.current = onFocusChange; }, [onFocusChange]);
  const report = useCallback((next: InboxAssistantViewState) => {
    setState(previous => Object.keys(next).every(key => previous[key as keyof InboxAssistantViewState] === next[key as keyof InboxAssistantViewState]) ? previous : next);
  }, []);
  const splitMax = Math.max(360, Math.min(800, size.width * 0.56));
  const needsAttention = !!state.attentionId;
  const active = state.running || needsAttention;
  const activityId = state.running ? `run:${state.requestId ?? state.chatId ?? 'active'}` : needsAttention ? `approval:${state.attentionId}` : null;
  const mode = section === 'assistant' ? 'full' : !started || !awayOpen || dismissed || (!manuallyOpened && !active) ? 'hidden' : layout === 'split' && size.width >= 1000 ? 'split' : 'pip';

  useEffect(() => {
    if (section === 'assistant') { setStarted(true); setDismissed(false); }
    else if (active && ((!dismissed && !awayOpen) || activityId !== lastActivity.current)) {
      setStarted(true); setAwayOpen(true); setDismissed(false);
    }
    if (active) lastActivity.current = activityId;
  }, [section, active, activityId, dismissed, awayOpen]);
  useEffect(() => {
    if (mode === 'hidden') focusListener.current?.(false);
  }, [mode]);
  useEffect(() => {
    const resize = () => { setSize(viewport()); setRect(current => bounds(current)); };
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  useEffect(() => {
    if (!dragging) return;
    const move = (event: PointerEvent) => {
      const start = gesture.current;
      if (!start) return;
      const x = event.clientX - start.x; const y = event.clientY - start.y;
      if (start.kind === 'split') setSplitWidth(Math.max(360, Math.min(splitMax, start.width - x)));
      else setRect(bounds(start.kind === 'move' ? { ...start.rect, x: start.rect.x + x, y: start.rect.y + y }
        : { ...start.rect, width: start.rect.width + x, height: start.rect.height + y }));
    };
    const finish = () => { gesture.current = null; setDragging(false); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', finish); window.addEventListener('pointercancel', finish);
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', finish); window.removeEventListener('pointercancel', finish); };
  }, [dragging, splitMax]);

  function startGesture(event: ReactPointerEvent<HTMLElement>, kind: 'move' | 'resize' | 'split') {
    if (event.button !== 0 || (kind === 'move' && (event.target as HTMLElement).closest('button, input, select, a'))) return;
    event.preventDefault();
    if (kind !== 'move') event.currentTarget.focus();
    gesture.current = { kind, x: event.clientX, y: event.clientY, rect, width: splitWidth };
    setDragging(true);
  }
  function choose(next: Layout) {
    setStarted(true); setLayout(next); setAwayOpen(true); setManuallyOpened(true); setDismissed(false);
    try { localStorage.setItem(PREFERENCE, next); } catch { /* Layout remains available for this session. */ }
    if (section === 'assistant' || next === 'split') onOpenInbox();
  }
  function hide() {
    setDismissed(true); setManuallyOpened(false); focusListener.current?.(false);
    if (section === 'assistant') onOpenInbox();
  }
  const button = 'flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-lg px-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary';
  return <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden" data-assistant-layout={mode}>
    <div hidden={mode === 'full'} style={mode === 'full' ? { display: 'none' } : undefined} className="flex min-h-0 min-w-0 flex-1 overflow-hidden">{children}</div>
    {mode === 'split' && <div role="separator" aria-label="Resize Inbox and AI panels" aria-orientation="vertical" aria-valuemin={360} aria-valuemax={Math.round(splitMax)} aria-valuenow={Math.round(Math.min(splitWidth, splitMax))} tabIndex={0}
      onFocus={() => focusListener.current?.(true)} onBlur={() => focusListener.current?.(false)}
      onPointerDown={event => startGesture(event, 'split')} onKeyDown={event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault(); event.stopPropagation(); setSplitWidth(current => event.key === 'Home' ? 360 : event.key === 'End' ? splitMax : Math.max(360, Math.min(splitMax, current + (event.key === 'ArrowLeft' ? 24 : -24))));
      }} className="group relative z-10 w-1.5 shrink-0 cursor-col-resize touch-none bg-border/60 transition-colors hover:bg-primary/20 focus:bg-primary/20 focus:outline-none"><span aria-hidden="true" className="absolute left-1/2 top-1/2 h-8 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-muted-foreground/30 group-hover:bg-primary/60" /></div>}
    <aside data-assistant-workspace="true" aria-label={mode === 'pip' ? 'Floating Inbox Agent' : 'Inbox Agent workspace'} aria-hidden={mode === 'hidden'} inert={mode === 'hidden'}
      onFocusCapture={() => focusListener.current?.(true)} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) focusListener.current?.(false); }}
      style={mode === 'hidden' ? { display: 'none' } : mode === 'pip' ? { left: rect.x, top: rect.y, width: rect.width, height: rect.height }
        : mode === 'split' ? { width: Math.min(splitWidth, splitMax) } : undefined}
      className={`assistant-theme flex min-h-0 min-w-0 flex-col overflow-hidden bg-background ${mode === 'pip' ? 'fixed z-30 rounded-2xl border border-border shadow-[0_8px_40px_-8px_rgba(0,0,0,0.25)]' : mode === 'split' ? 'relative shrink-0' : 'relative flex-1'}`}>
      <div onPointerDown={mode === 'pip' ? event => startGesture(event, 'move') : undefined} className={`assistant-chrome flex h-12 shrink-0 items-center gap-1 border-b border-border/70 bg-muted/20 px-3 ${mode === 'pip' ? 'cursor-move select-none touch-none' : ''}`}>
        {mode === 'pip' && <GripHorizontal aria-hidden="true" className="mr-1 h-4 w-4 shrink-0 text-muted-foreground/60" />}
        <span className="mr-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"><Bot aria-hidden="true" className="h-4 w-4" /></span>
        <p className="min-w-0 flex-1 truncate text-xs font-semibold">Inbox Agent</p>
        {state.running && <span title={state.status} className="mr-1 flex shrink-0 items-center gap-1.5 rounded-full bg-primary/5 px-2 py-1 text-[11px] text-primary"><Loader2 aria-hidden="true" className="h-3 w-3 animate-spin" /><span>Working</span></span>}
        {mode !== 'split' && <button type="button" className={button} onClick={() => choose('split')} aria-label="Inbox + AI split view" title="Keep Inbox and AI side by side"><PanelRight className="h-4 w-4" />{mode === 'full' && <span>Inbox + AI</span>}</button>}
        {mode !== 'pip' && <button type="button" className={button} onClick={() => choose('pip')} aria-label="Float AI chat" title="Show chat in a floating picture-in-picture view"><PictureInPicture2 className="h-4 w-4" /></button>}
        {mode !== 'full' && <button type="button" className={button} onClick={onOpenAssistant} aria-label="Open full AI chat" title="Open full chat"><Maximize2 className="h-4 w-4" /></button>}
        <button type="button" className={button} onClick={hide} aria-label="Hide AI view" title="Close view; the agent keeps working"><X className="h-4 w-4" /></button>
      </div>
      <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">{started || section === 'assistant' ? renderAssistant({ compact: mode !== 'full', visible: mode !== 'hidden', onStateChange: report }) : null}</div>
      {mode === 'pip' && <button type="button" aria-label="Resize floating chat" title="Drag to resize, or use arrow keys" onPointerDown={event => startGesture(event, 'resize')} onKeyDown={event => {
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
        event.preventDefault(); event.stopPropagation(); setRect(current => bounds({ ...current, width: current.width + (event.key === 'ArrowRight' ? 24 : event.key === 'ArrowLeft' ? -24 : 0), height: current.height + (event.key === 'ArrowDown' ? 24 : event.key === 'ArrowUp' ? -24 : 0) }));
      }} className="absolute bottom-0 right-0 h-5 w-5 cursor-nwse-resize touch-none rounded-tl-lg border-l border-t border-border bg-muted/80 text-muted-foreground focus:outline focus:outline-2 focus:outline-primary"><span aria-hidden="true">⌟</span></button>}
    </aside>
    {mode === 'hidden' && started && active && <button type="button" onClick={() => { setAwayOpen(true); setManuallyOpened(true); setDismissed(false); }} aria-label={state.running ? 'Show running AI chat' : 'Show AI approval'} className="assistant-theme assistant-launcher fixed bottom-5 right-5 z-30 flex max-w-[min(22rem,calc(100vw-2rem))] items-center gap-3 rounded-2xl border border-border bg-background px-4 py-3 text-left shadow-xl hover:bg-accent">
      {state.running ? <Loader2 className="h-5 w-5 shrink-0 animate-spin text-primary" /> : <Bot className="h-5 w-5 shrink-0 text-primary" />}<span className="min-w-0"><span className="block truncate text-sm font-medium">{state.title}</span><span className="block truncate text-xs text-muted-foreground">{state.running ? state.status : 'Awaiting your approval'}</span></span>
    </button>}
  </div>;
}
