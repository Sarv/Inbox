import {
  Reply,
  ReplyAll,
  Forward,
  Trash2,
  Archive,
  MailOpen,
  MoreVertical,
  Printer,
  Download,
  AlertOctagon,
  ShieldAlert,
  Filter,
  Languages,
  Code,
  FileSignature,
} from 'lucide-react';
import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

export interface EmailMenuProps {
  email: any;
  onReply: () => void;
  onReplyAll: () => void;
  onForward: () => void;
  onDelete: () => void;
  onArchive: () => void;
  onMarkUnread: () => void;
  onReportSpam: () => void;
  onPrint: () => void;
  onDownload: () => void;
  onShowOriginal: () => void;
  onFilterLikeThis: () => void;
  onTranslate: () => void;
  onDetectSignature: () => void;
  className?: string;
  /** Notified whenever the dropdown opens/closes, so a hover-gated parent bar can
   *  stay visible while the menu is open (the cursor leaves the bubble to use it). */
  onOpenChange?: (open: boolean) => void;
}

export function EmailMenu({
  email: _email,
  onReply,
  onReplyAll,
  onForward,
  onDelete,
  onArchive,
  onMarkUnread,
  onReportSpam,
  onPrint,
  onDownload,
  onShowOriginal,
  onFilterLikeThis,
  onTranslate,
  onDetectSignature,
  className = '',
  onOpenChange,
}: EmailMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  // Surface open/close to the parent (kept in an effect so every close path —
  // toggle, action, outside-click, scroll, resize — is covered by one hook).
  useEffect(() => { onOpenChange?.(isOpen); }, [isOpen, onOpenChange]);
  // Fixed-viewport coordinates for the dropdown. Rendered in a portal so the
  // email card's `overflow-hidden` (needed for its rounded corners) can't clip
  // the menu — previously the lower items were cut off on short emails.
  const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number; maxHeight: number }>({
    left: 0,
    maxHeight: 0,
  });
  const menuRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Close on outside click (checking both the trigger and the portalled menu),
  // and on scroll/resize since the menu is position:fixed to the button.
  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || dropdownRef.current?.contains(target)) return;
      setIsOpen(false);
    };
    // Close when the PAGE scrolls (the menu is position:fixed to the button),
    // but NOT when scrolling inside the menu itself — otherwise a tall,
    // scrollable menu closes the moment you try to scroll it.
    const onScroll = (event: Event) => {
      if (dropdownRef.current?.contains(event.target as Node)) return;
      setIsOpen(false);
    };
    const close = () => setIsOpen(false);
    document.addEventListener('mousedown', handleClickOutside);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', close);
    };
  }, [isOpen]);

  const MENU_WIDTH = 224; // matches w-56

  const handleToggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!isOpen && buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      const left = Math.max(8, rect.right - MENU_WIDTH);
      // Prefer opening DOWNWARD so the first items (Reply/Reply all) sit right
      // under the button; the menu (~600px) just scrolls within the space
      // below. Only flip upward when there's too little room below to be usable
      // AND more room above. Height is capped to the chosen side's space so it
      // never runs off-screen.
      const GAP = 8;
      const MIN_DOWN = 220;
      const spaceBelow = window.innerHeight - rect.bottom - GAP;
      const spaceAbove = rect.top - GAP;
      if (spaceBelow >= MIN_DOWN || spaceBelow >= spaceAbove) {
        setPos({ left, top: rect.bottom + 4, maxHeight: spaceBelow });
      } else {
        setPos({ left, bottom: window.innerHeight - rect.top + 4, maxHeight: spaceAbove });
      }
    }
    setIsOpen(!isOpen);
  };

  const handleAction = (action: () => void) => {
    action();
    setIsOpen(false);
  };

  return (
    <div ref={menuRef} className={`relative ${className}`}>
      <button
        ref={buttonRef}
        onClick={handleToggle}
        className="p-1.5 hover:bg-accent rounded transition-colors"
        title="More actions"
      >
        <MoreVertical className="h-4 w-4 text-muted-foreground" />
      </button>

      {isOpen && createPortal(
        <div
          ref={dropdownRef}
          className="fixed w-56 bg-popover border border-border rounded-lg shadow-lg z-[100] py-1 overflow-y-auto"
          style={{ left: pos.left, top: pos.top, bottom: pos.bottom, maxHeight: pos.maxHeight }}
        >
          {/* Reply Actions */}
          <button
            onClick={() => handleAction(onReply)}
            className="w-full flex items-center gap-3 px-4 py-2 text-sm hover:bg-accent transition-colors text-left"
          >
            <Reply className="h-4 w-4 text-muted-foreground" />
            Reply
          </button>
          <button
            onClick={() => handleAction(onReplyAll)}
            className="w-full flex items-center gap-3 px-4 py-2 text-sm hover:bg-accent transition-colors text-left"
          >
            <ReplyAll className="h-4 w-4 text-muted-foreground" />
            Reply all
          </button>
          <button
            onClick={() => handleAction(onForward)}
            className="w-full flex items-center gap-3 px-4 py-2 text-sm hover:bg-accent transition-colors text-left"
          >
            <Forward className="h-4 w-4 text-muted-foreground" />
            Forward
          </button>

          <div className="h-px bg-border my-1" />

          {/* Email Management */}
          <button
            onClick={() => handleAction(onDelete)}
            className="w-full flex items-center gap-3 px-4 py-2 text-sm hover:bg-accent transition-colors text-left"
          >
            <Trash2 className="h-4 w-4 text-muted-foreground" />
            Delete
          </button>
          <button
            onClick={() => handleAction(onArchive)}
            className="w-full flex items-center gap-3 px-4 py-2 text-sm hover:bg-accent transition-colors text-left"
          >
            <Archive className="h-4 w-4 text-muted-foreground" />
            Archive
          </button>
          <button
            onClick={() => handleAction(onMarkUnread)}
            className="w-full flex items-center gap-3 px-4 py-2 text-sm hover:bg-accent transition-colors text-left"
          >
            <MailOpen className="h-4 w-4 text-muted-foreground" />
            Mark as unread
          </button>

          <div className="h-px bg-border my-1" />

          {/* Reporting */}
          <button
            onClick={() => handleAction(onReportSpam)}
            className="w-full flex items-center gap-3 px-4 py-2 text-sm hover:bg-accent transition-colors text-left"
          >
            <AlertOctagon className="h-4 w-4 text-muted-foreground" />
            Report spam
          </button>
          <button
            onClick={() => handleAction(() => {})}
            className="w-full flex items-center gap-3 px-4 py-2 text-sm hover:bg-accent transition-colors text-left"
          >
            <ShieldAlert className="h-4 w-4 text-muted-foreground" />
            Report phishing
          </button>

          <div className="h-px bg-border my-1" />

          {/* Tools */}
          <button
            onClick={() => handleAction(onFilterLikeThis)}
            className="w-full flex items-center gap-3 px-4 py-2 text-sm hover:bg-accent transition-colors text-left"
          >
            <Filter className="h-4 w-4 text-muted-foreground" />
            Filter messages like this
          </button>
          <button
            onClick={() => handleAction(onTranslate)}
            className="w-full flex items-center gap-3 px-4 py-2 text-sm hover:bg-accent transition-colors text-left"
          >
            <Languages className="h-4 w-4 text-muted-foreground" />
            Translate
          </button>
          <button
            onClick={() => handleAction(onPrint)}
            className="w-full flex items-center gap-3 px-4 py-2 text-sm hover:bg-accent transition-colors text-left"
          >
            <Printer className="h-4 w-4 text-muted-foreground" />
            Print
          </button>
          <button
            onClick={() => handleAction(onDownload)}
            className="w-full flex items-center gap-3 px-4 py-2 text-sm hover:bg-accent transition-colors text-left"
          >
            <Download className="h-4 w-4 text-muted-foreground" />
            Download message
          </button>
          <button
            onClick={() => handleAction(onShowOriginal)}
            className="w-full flex items-center gap-3 px-4 py-2 text-sm hover:bg-accent transition-colors text-left"
          >
            <Code className="h-4 w-4 text-muted-foreground" />
            Show original
          </button>
          <button
            onClick={() => handleAction(onDetectSignature)}
            className="w-full flex items-center gap-3 px-4 py-2 text-sm hover:bg-accent transition-colors text-left"
          >
            <FileSignature className="h-4 w-4 text-muted-foreground" />
            Detect Signature
          </button>
        </div>,
        document.body,
      )}
    </div>
  );
}
