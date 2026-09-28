import type { SendFollowUpRequest } from '@sarvinbox/core';
import { Bell, BellDot, ChevronDown, Loader2, Paperclip, Send, Trash2, Wand2, BellRing } from 'lucide-react';
import { useCallback, useRef, useState } from 'react';

import { useClickAway } from '../hooks/useClickAway';
import { useSendLaterDraft } from '../hooks/useSendLaterDrafts';
import { describeFollowUp } from '../utils/follow-up-presets';

import { FollowUpDropdown } from './FollowUpDropdown';
import { SendLaterDropdown } from './SendLaterDropdown';
import { Tooltip } from './Tooltip';
export interface ComposeToolbarProps {
    sending: boolean;
    hasAIProvider: boolean;
    plainBody: string;
    hasRecipients: boolean;
    onSend: () => void;
    /** Schedule the message instead of sending it now; UTC epoch SECONDS.
     *  Omitted (inline reply/forward) hides the Send-later affordance. */
    onSendLater?: (sendAt: number) => void;
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
    /** "Remind me if nobody replies". Only rendered when a handler is provided. */
    followUp?: SendFollowUpRequest | null;
    onFollowUpChange?: (value: SendFollowUpRequest | null) => void;
}

// OS specific modifier key for tooltips
const MOD_KEY = navigator.platform.toLowerCase().includes('mac') ? '⌘' : 'Ctrl';

export function ComposeToolbar({
    sending,
    hasAIProvider,
    plainBody,
    hasRecipients,
    onSend,
    onSendLater,
    onAttach,
    onPolish,
    onDiscard,
    discarding = false,
    isInline = false,
    isForward = false,
    readReceipt = false,
    onToggleReadReceipt,
    followUp = null,
    onFollowUpChange,
}: ComposeToolbarProps) {
    const [showSendLater, setShowSendLater] = useState(false);
    // Held HERE, not in the menu: the menu unmounts on a click outside, and a
    // half-entered delivery time must survive that. One store per toolbar, so
    // two open composers can hold two different times without meeting.
    const { draft: sendLaterDraft, update: updateSendLaterDraft } = useSendLaterDraft();
    const sendLaterRef = useRef<HTMLDivElement>(null);
    const closeSendLater = useCallback(() => setShowSendLater(false), []);

    // Click-away, so the menu can't be left open behind the composer.
    useClickAway(sendLaterRef, showSendLater, closeSendLater);

    const [showFollowUp, setShowFollowUp] = useState(false);
    // Its own draft, so a half-typed reminder date never shows up as a delivery time.
    const { draft: followUpDraft, update: updateFollowUpDraft } = useSendLaterDraft();
    const followUpRef = useRef<HTMLDivElement>(null);
    const closeFollowUp = useCallback(() => setShowFollowUp(false), []);
    useClickAway(followUpRef, showFollowUp, closeFollowUp);
    const followUpSummary = describeFollowUp(followUp);

    const sendDisabled = sending || (!isForward && !plainBody.trim()) || !hasRecipients;

    return (
        <div className={`flex items-center justify-between px-3 py-2 border-t border-border ${isInline ? 'bg-muted/30' : 'bg-muted/50'}`}>
            <div className="flex items-center gap-2">
                <div className="flex items-stretch" ref={sendLaterRef}>
                    <Tooltip content="Send" shortcut={`${MOD_KEY}+Enter`} position="top">
                        <button
                            onClick={onSend}
                            disabled={sendDisabled}
                            className={`flex items-center gap-2 px-4 py-1.5 bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed text-sm font-medium ${onSendLater ? 'rounded-l-md' : 'rounded-md'}`}
                        >
                            <Send className="h-4 w-4" />
                            {sending ? 'Sending...' : 'Send'}
                        </button>
                    </Tooltip>

                    {onSendLater && (
                        <div className="relative flex">
                            {/* Icon-only control: tooltip + aria-label, 40ms so it reads as instant. */}
                            <Tooltip content="Send later" position="top" delayMs={40} hidden={showSendLater}>
                                <button
                                    onClick={() => setShowSendLater((open) => !open)}
                                    disabled={sendDisabled}
                                    aria-label="Send later"
                                    aria-expanded={showSendLater}
                                    className="flex items-center px-1.5 rounded-r-md bg-primary text-primary-foreground hover:bg-primary/90 border-l border-primary-foreground/20 disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                    <ChevronDown className="h-4 w-4" />
                                </button>
                            </Tooltip>
                            {showSendLater && (
                                <SendLaterDropdown
                                    onPick={onSendLater}
                                    onClose={closeSendLater}
                                    draft={sendLaterDraft}
                                    onDraftChange={updateSendLaterDraft}
                                />
                            )}
                        </div>
                    )}
                </div>

                {onFollowUpChange && (
                    <div className="relative flex" ref={followUpRef}>
                        {/* Icon-only control: tooltip + aria-label, 40ms so it reads as instant. */}
                        <Tooltip content={followUpSummary ?? 'Remind me if no reply'} position="top" delayMs={40} hidden={showFollowUp}>
                            <button
                                onClick={() => setShowFollowUp((open) => !open)}
                                aria-label={followUpSummary ?? 'Remind me if no reply'}
                                aria-expanded={showFollowUp}
                                aria-pressed={!!followUp}
                                className={`p-1.5 rounded-md transition-colors ${followUp ? 'bg-primary/15 text-primary' : 'hover:bg-accent text-muted-foreground'}`}
                            >
                                {followUp ? <BellDot className="h-4 w-4" /> : <Bell className="h-4 w-4" />}
                            </button>
                        </Tooltip>
                        {showFollowUp && (
                            <FollowUpDropdown
                                value={followUp}
                                onChange={onFollowUpChange}
                                onClose={closeFollowUp}
                                draft={followUpDraft}
                                onDraftChange={updateFollowUpDraft}
                            />
                        )}
                    </div>
                )}

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
