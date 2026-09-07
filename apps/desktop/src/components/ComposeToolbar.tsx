import { Loader2, Paperclip, Send, Trash2, Wand2, BellRing } from 'lucide-react';

import { Tooltip } from './Tooltip';
export interface ComposeToolbarProps {
    sending: boolean;
    hasAIProvider: boolean;
    plainBody: string;
    hasRecipients: boolean;
    onSend: () => void;
    onAttach: () => void;
    onPolish: () => void;
    onDiscard: () => void;
    /** True while a discard is being processed (IMAP delete in flight) — shows a
     *  spinner on the bin and blocks repeat clicks. */
    discarding?: boolean;
    isInline?: boolean;
    isForward?: boolean;
    /** Read-receipt (MDN) toggle. Only rendered when a handler is provided. */
    readReceipt?: boolean;
    onToggleReadReceipt?: () => void;
}

// OS specific modifier key for tooltips
const MOD_KEY = navigator.platform.toLowerCase().includes('mac') ? '⌘' : 'Ctrl';

export function ComposeToolbar({
    sending,
    hasAIProvider,
    plainBody,
    hasRecipients,
    onSend,
    onAttach,
    onPolish,
    onDiscard,
    discarding = false,
    isInline = false,
    isForward = false,
    readReceipt = false,
    onToggleReadReceipt,
}: ComposeToolbarProps) {

    return (
        <div className={`flex items-center justify-between px-3 py-2 border-t border-border ${isInline ? 'bg-muted/30' : 'bg-muted/50'}`}>
            <div className="flex items-center gap-2">
                <Tooltip content="Send" shortcut={`${MOD_KEY}+Enter`} position="top">
                    <button
                        onClick={onSend}
                        disabled={sending || (!isForward && !plainBody.trim()) || !hasRecipients}
                        className="flex items-center gap-2 px-4 py-1.5 bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed text-sm font-medium"
                    >
                        <Send className="h-4 w-4" />
                        {sending ? 'Sending...' : 'Send'}
                    </button>
                </Tooltip>

                {hasAIProvider && (
                    <Tooltip content="Polish with AI" position="top">
                        <button
                            onClick={onPolish}
                            disabled={!plainBody.trim()}
                            className="p-1.5 hover:bg-accent rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed group relative"
                        >
                            <Wand2 className="h-4 w-4 text-primary" />
                            <div className="absolute inset-0 bg-primary/20 blur-md rounded-full opacity-0 group-hover:opacity-100 transition-opacity" />
                        </button>
                    </Tooltip>
                )}
            </div>

            <div className="flex items-center gap-2">
                {onToggleReadReceipt && (
                    <Tooltip content={readReceipt ? 'Read receipt requested' : 'Request read receipt'} position="top">
                        <button
                            onClick={onToggleReadReceipt}
                            aria-pressed={readReceipt}
                            className={`p-1.5 rounded-md transition-colors ${readReceipt ? 'bg-primary/15 text-primary' : 'hover:bg-accent text-muted-foreground'}`}
                        >
                            <BellRing className="h-4 w-4" />
                        </button>
                    </Tooltip>
                )}

                <Tooltip content="Attach files" position="top">
                    <button
                        onClick={onAttach}
                        className="p-1.5 hover:bg-accent rounded-md transition-colors"
                    >
                        <Paperclip className="h-4 w-4 text-muted-foreground" />
                    </button>
                </Tooltip>

                <Tooltip content={discarding ? "Discarding…" : (isInline ? "Discard drafting" : "Discard message")} position="top">
                    <button
                        onClick={onDiscard}
                        disabled={discarding}
                        className="p-1.5 hover:bg-destructive/10 rounded-md transition-colors group disabled:cursor-not-allowed"
                    >
                        {discarding
                            ? <Loader2 className="h-4 w-4 text-destructive animate-spin" />
                            : <Trash2 className="h-4 w-4 text-muted-foreground group-hover:text-destructive transition-colors" />}
                    </button>
                </Tooltip>
            </div>
        </div>
    );
}
