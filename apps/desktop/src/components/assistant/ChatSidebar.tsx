import { ChevronDown, Loader2, Pin, PinOff, Trash2 } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import type { InboxAssistantChatSummary } from '../../types/inbox-assistant';
import { IconButton } from '../Tooltip';

interface ChatSidebarProps {
  chats: InboxAssistantChatSummary[];
  activeChatId: string | null;
  pendingChatIds: ReadonlySet<string>;
  runningChatIds?: ReadonlySet<string>;
  deletePending: boolean;
  error: string | null;
  onSelect: (chatId: string) => void;
  onTogglePinned: (chat: InboxAssistantChatSummary) => void;
  onDelete: (chat: InboxAssistantChatSummary) => void;
}

function updatedLabel(at: number): string {
  const elapsed = Math.max(0, Date.now() - at);
  if (elapsed < 60_000) return 'Updated just now';
  if (elapsed < 3_600_000) return `Updated ${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < 86_400_000) return `Updated ${Math.floor(elapsed / 3_600_000)}h ago`;
  if (elapsed < 604_800_000) return `Updated ${Math.floor(elapsed / 86_400_000)}d ago`;
  return `Updated ${new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`;
}

/** Metadata-only navigation: opening an info card never loads a chat's messages. */
export function ChatSidebar({ chats, activeChatId, pendingChatIds, runningChatIds, deletePending, error, onSelect, onTogglePinned, onDelete }: ChatSidebarProps) {
  const [pinnedOpen, setPinnedOpen] = useState(true);
  const [info, setInfo] = useState<{ chatId: string; top: number; left: number } | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const infoId = useId();
  useEffect(() => () => { if (hoverTimer.current) clearTimeout(hoverTimer.current); }, []);
  const dismissInfo = () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
    setInfo(null);
  };
  const showInfo = (chatId: string, element: HTMLElement, delayed: boolean) => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    const rect = element.getBoundingClientRect();
    const next = { chatId, top: Math.max(8, Math.min(rect.top, window.innerHeight - 170)), left: Math.max(8, Math.min(rect.right + 12, window.innerWidth - 304)) };
    if (delayed) hoverTimer.current = setTimeout(() => { setInfo(next); hoverTimer.current = null; }, 200);
    else setInfo(next);
  };
  const pinned = chats.filter(chat => chat.pinned);
  const recents = chats.filter(chat => !chat.pinned);
  const infoChat = chats.find(chat => chat.id === info?.chatId);
  const row = (chat: InboxAssistantChatSummary) => {
    const pending = pendingChatIds.has(chat.id);
    const running = runningChatIds?.has(chat.id) || !!chat.activeRun;
    return (
      <div key={chat.id} data-chat-row={chat.id} aria-busy={pending} className={`group relative flex h-9 min-w-0 items-center rounded-md transition-colors ${chat.id === activeChatId ? 'bg-muted text-foreground' : 'text-foreground/80 hover:bg-muted/70'}`}>
        <button type="button" aria-current={chat.id === activeChatId ? 'page' : undefined} aria-label={`Open conversation: ${chat.title}`} aria-describedby={info?.chatId === chat.id ? infoId : undefined} disabled={pending}
          onClick={() => { dismissInfo(); onSelect(chat.id); }} onMouseEnter={event => showInfo(chat.id, event.currentTarget, true)} onMouseLeave={dismissInfo} onFocus={event => showInfo(chat.id, event.currentTarget, false)} onBlur={dismissInfo} onKeyDown={event => { if (event.key === 'Escape') dismissInfo(); }}
          className="h-full min-w-0 flex-1 rounded-md pl-3 pr-3 text-left text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-primary/40 group-hover:pr-16 group-focus-within:pr-16 disabled:opacity-50">
          <span className="block overflow-hidden whitespace-nowrap [mask-image:linear-gradient(to_right,black_86%,transparent)]">{chat.title}</span>
        </button>
        {running && <Loader2 role="status" aria-label={`Working in conversation: ${chat.title}`} className="pointer-events-none mr-3 h-3.5 w-3.5 shrink-0 animate-spin text-primary group-hover:invisible group-focus-within:invisible" />}
        <div className="absolute right-1 flex items-center gap-0.5 rounded bg-card opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
          {pending ? <Loader2 aria-label="Updating conversation" className="mx-1 h-3.5 w-3.5 animate-spin text-muted-foreground" /> : <>
            <IconButton tooltip={`${chat.pinned ? 'Unpin' : 'Pin'} conversation: ${chat.title}`} icon={chat.pinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />} size="xs" disabled={deletePending} onClick={() => { dismissInfo(); onTogglePinned(chat); }} className="text-muted-foreground hover:text-foreground" />
            <IconButton tooltip={`Delete conversation: ${chat.title}`} icon={<Trash2 className="h-3.5 w-3.5" />} size="xs" disabled={deletePending} onClick={() => { dismissInfo(); onDelete(chat); }} className="text-muted-foreground hover:text-destructive" />
          </>}
        </div>
      </div>
    );
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-2 pb-3" onScroll={dismissInfo}>
        <section aria-label="Pinned conversations">
          <button type="button" onClick={() => { dismissInfo(); setPinnedOpen(open => !open); }} aria-expanded={pinnedOpen} aria-controls="assistant-pinned-conversations" className="flex h-8 w-full items-center gap-1 px-2 text-left text-xs font-medium text-muted-foreground hover:text-foreground"><ChevronDown className={`h-3 w-3 transition-transform ${pinnedOpen ? '' : '-rotate-90'}`} />Pinned</button>
          {pinnedOpen && <div id="assistant-pinned-conversations">{pinned.length ? pinned.map(row) : <p className="px-5 py-1 text-xs text-muted-foreground/70">Pin conversations to keep them here</p>}</div>}
        </section>
        <section aria-label="Recent conversations">
          <h2 className="flex h-8 items-center px-3 text-xs font-medium text-muted-foreground">Recents</h2>
          {recents.map(row)}
          {!recents.length && <p className="px-3 py-1 text-xs text-muted-foreground/70">No recent conversations</p>}
        </section>
      </div>
      {error && <p role="alert" className="mx-3 mb-3 rounded-md bg-destructive/5 p-2 text-xs text-destructive">{error}</p>}
      {info && infoChat && createPortal(<div id={infoId} role="tooltip" className="pointer-events-none fixed z-50 w-72 space-y-2 rounded-xl border border-border bg-popover p-4 text-popover-foreground shadow-xl" style={{ top: info.top, left: info.left }}><p className="break-words text-sm font-medium">{infoChat.title}</p><p className="text-xs text-muted-foreground">{updatedLabel(infoChat.updatedAt)}</p><p className="text-xs text-muted-foreground">{infoChat.exchangeCount} {infoChat.exchangeCount === 1 ? 'reply' : 'replies'}</p></div>, document.body)}
    </div>
  );
}
