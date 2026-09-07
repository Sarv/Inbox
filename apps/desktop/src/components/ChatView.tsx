import type { EmailRecord } from '@sarvinbox/core';
import { format, isToday, isYesterday } from 'date-fns';
import emailAddresses from 'email-addresses';
import { AlertTriangle, Download, Eye, Forward, Loader2, Paperclip, RefreshCw, Reply, ReplyAll, Sparkles, X } from 'lucide-react';
import prettyBytes from 'pretty-bytes';
import { useMemo, useState, useRef, useEffect, memo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import uniqolor from 'uniqolor';

import { stripSignaturesSimple } from '../services/ai-service';
import { sliceBodyHeuristic, type ConversationMessage } from '../services/conversation-service';
import { resolveRefsInHtml } from '../services/image-cache';
import { parseAddresses } from '../utils/email-address';
import { isConversationEmail } from '../utils/email-classification';
import { htmlLooksDesigned } from '../utils/email-html';

import { EmailMenu } from './email-detail/EmailMenu';
import { getInitials, parseAttachments } from './email-detail/utils';
import { SandboxedEmailBody } from './SandboxedEmailBody';
import { Tooltip } from './Tooltip';


/**
 * Whether a message was sent BY the current user (→ right-aligned bubble).
 * `currentUserEmail` is normally the IMAP username (a single address). If it
 * couldn't be resolved it falls back to the displayed email's recipient LIST
 * (comma-separated) — which isn't a real identity, so we don't attribute in
 * that case (all bubbles left) rather than mis-flag a recipient as "me".
 */
function isFromMe(fromAddress: string | undefined, currentUserEmail: string): boolean {
  const me = (currentUserEmail || '').trim().toLowerCase();
  if (!me || me.includes(',')) return false;
  return (fromAddress || '').trim().toLowerCase() === me;
}

export interface ChatViewProps {
  emails: EmailRecord[];
  currentUserEmail: string;
  conversationMessages?: ConversationMessage[];
  conversationUpdating?: boolean;
  conversationLoading?: boolean;
  /**
   * Progressive-extraction counters — non-null only while an extraction
   * run is in flight (bubbles may still be arriving). Mirrors
   * EmailDetailContext.conversationProgress: done/total are extracted-email
   * counts, status carries rate-limit/retry info.
   */
  conversationProgress?: { done: number; total: number; status?: string } | null;
  /**
   * AI-view only: the extraction fell back to the heuristic regex slice for
   * at least one email, was truncated, or was incomplete (i.e. NOT a clean
   * full LLM extraction). When true, the AI view treats the thread as "not
   * genuinely processed" and shows the empty-state message instead of the
   * fallback bubbles — the raw/heuristic content lives in Standard view.
   */
  conversationPartial?: boolean;
  mode?: 'ai' | 'logical';
  onReply?: (email: any) => void;
  onReplyAll?: (email: any) => void;
  onForward?: (email: any) => void;
  onDelete?: (emailId: string) => void;
  onArchive?: (emailId: string) => void;
  onMarkUnread?: (emailId: string) => void;
  onReportSpam?: (emailId: string) => void;
  onPrint?: (email: any) => void;
  onDownload?: (email: any) => void;
  onShowOriginal?: (email: any) => void;
  onFilterLikeThis?: (email: any) => void;
  onTranslate?: (email: any) => void;
  onDetectSignature?: (email: any) => void;
  onToggleStar?: (emailId: string, starred: boolean) => void;
  /** Email ids whose body permanently failed to fetch (show retry, not a spinner). */
  failedBodies?: Set<string>;
  /** Retry a failed body fetch for one email. */
  onRetryBody?: (emailId: string) => void;
  onReExtractMessage?: (messageId: string) => Promise<void>;
  /**
   * Trigger a full thread re-extraction. Wired to the "Process Now"
   * button shown in the empty-state placeholder when AI view has no
   * extracted messages to display.
   */
  onRetryAll?: () => void;
}

/**
 * A participant's colors, as CSS color strings (applied inline, NOT Tailwind
 * classes) so we're not limited to a fixed palette — every distinct sender gets
 * its own hue, however many there are.
 *   - avatar: solid fill for the avatar circle (white initials sit on it)
 *   - bubble: faint fill behind a normal (non-designed) conversation message
 */
type SenderColor = { avatar: string; bubble: string };

/** Base hue (0–360) for an address via `uniqolor` — deterministic per identity,
 *  so a person's color is stable across threads. */
function senderHue(address: string): number {
  const { color } = uniqolor(address || 'unknown', { format: 'hsl', saturation: [55, 65], lightness: [36, 44] });
  return parseFloat(color.match(/hsl\(\s*([\d.]+)/)?.[1] ?? '0') || 0;
}

/** Avatar (dark enough for white initials) + faint bubble fill, same hue. */
function colorForHue(hue: number): SenderColor {
  const h = ((hue % 360) + 360) % 360;
  return { avatar: `hsl(${h.toFixed(1)} 58% 43%)`, bubble: `hsl(${h.toFixed(1)} 60% 50% / 0.12)` };
}

/** Two hues are "too close" (would read as the same color) within this gap. */
const MIN_HUE_SEP = 28;

/**
 * Per-thread sender→color map. Each participant's IDENTITY hue comes from
 * uniqolor (stable across threads); but uniqolor is a hash, so two people can
 * land on near-identical hues (e.g. both green) — jarring in one conversation.
 * So we assign by order of appearance and, if a hue lands within MIN_HUE_SEP of
 * one already used in THIS thread, rotate it by the golden angle until it's
 * distinct. Result: identity colors when there's no clash, guaranteed-distinct
 * colors when there would be. The current user is excluded (their bubbles use
 * the primary tint).
 */
function buildSenderColorMap(
  addressLists: Array<Array<string | null | undefined>>,
  currentUserEmail: string,
): Map<string, SenderColor> {
  const map = new Map<string, SenderColor>();
  const used: number[] = [];
  const me = (currentUserEmail || '').trim().toLowerCase();
  const tooClose = (h: number) => used.some((u) => {
    const d = Math.abs(h - u) % 360;
    return Math.min(d, 360 - d) < MIN_HUE_SEP;
  });
  for (const list of addressLists) {
    for (const raw of list) {
      const addr = (raw || '').trim().toLowerCase();
      if (!addr || addr === me || map.has(addr)) continue;
      let hue = senderHue(addr);
      for (let i = 0; i < 24 && tooClose(hue); i++) hue = (hue + 137.508) % 360;
      used.push(hue);
      map.set(addr, colorForHue(hue));
    }
  }
  return map;
}

/**
 * Normalize HTML content - remove inline styles but keep structure
 * Keeps bold, lists, etc. but removes font-size, color, font-family
 */
function normalizeHtmlContent(html: string): string {
  const div = document.createElement('div');
  div.innerHTML = html;

  // Remove all inline styles except on specific elements we want to preserve
  div.querySelectorAll('*').forEach(el => {
    // Remove style attribute completely - use CSS classes instead
    el.removeAttribute('style');
    // Remove font tags (old HTML)
    if (el.tagName === 'FONT') {
      const span = document.createElement('span');
      span.innerHTML = el.innerHTML;
      el.replaceWith(span);
    }
  });

  // Remove empty spans that were just for styling
  div.querySelectorAll('span').forEach(el => {
    if (!el.textContent?.trim() && !el.querySelector('img')) {
      el.remove();
    }
  });

  // Clean up nested divs that are just wrappers
  div.querySelectorAll('div').forEach(el => {
    // If div only contains whitespace or another single div, flatten it
    if (!el.textContent?.trim() && !el.querySelector('img, table, ul, ol')) {
      el.remove();
    }
  });

  let content = div.innerHTML;

  // Remove excessive line breaks (more than 2 consecutive)
  content = content.replace(/(<br\s*\/?>\s*){3,}/gi, '<br><br>');

  // Remove line breaks at start and end
  content = content.replace(/^(\s*<br\s*\/?>\s*)+/gi, '');
  content = content.replace(/(\s*<br\s*\/?>\s*)+$/gi, '');

  // Remove empty paragraphs
  content = content.replace(/<p>\s*<\/p>/gi, '');
  content = content.replace(/<p>\s*&nbsp;\s*<\/p>/gi, '');

  // Remove empty divs
  content = content.replace(/<div>\s*<\/div>/gi, '');
  content = content.replace(/<div>\s*&nbsp;\s*<\/div>/gi, '');

  // Normalize multiple spaces
  content = content.replace(/&nbsp;/g, ' ');

  return content.trim();
}

/**
 * Strip leading/trailing blank lines and empty blocks (<br>, empty <p>/<div>,
 * &nbsp;, whitespace) so an AI chat bubble hugs its text instead of showing a
 * large empty gap above/below. Only the ends are trimmed — content in the
 * middle (including intentional blank lines between paragraphs) is untouched.
 */
function trimHtmlEnds(html: string): string {
  const empty =
    '(?:\\s|&nbsp;|<br\\s*/?>|<p[^>]*>(?:\\s|&nbsp;|<br\\s*/?>)*</p>|<div[^>]*>(?:\\s|&nbsp;|<br\\s*/?>)*</div>)';
  const leading = new RegExp('^(?:' + empty + ')+', 'i');
  const trailing = new RegExp('(?:' + empty + ')+$', 'i');
  return html.replace(leading, '').replace(trailing, '').trim();
}

/**
 * Collapse INTERNAL vertical whitespace that AI extraction / quote-stripping
 * leaves mid-content: runs of consecutive <br> (with whitespace/&nbsp; between)
 * become a single break, and wholly-empty <p>/<div> wrappers are dropped
 * entirely. trimHtmlEnds only handles the ENDS; this removes the big gaps that
 * otherwise appear between paragraphs in a chat bubble. Used for plain / AI
 * content only — designed emails keep their own spacing. Regex alternatives are
 * disjoint on their first char (whitespace vs '&' vs '<') so matching is linear;
 * the empty-block peel is looped with a hard guard against pathological input.
 */
function collapseVerticalWhitespace(html: string): string {
  if (!html) return html;
  // Runs of 2+ <br> (with optional whitespace/&nbsp; between each) → one <br>.
  // Each alternative starts with '<br', so matching is linear (no backtracking).
  let out = html.replace(/(?:<br\s*\/?>(?:\s|&nbsp;|&#160;|&#xA0;)*){2,}/gi, '<br>');
  // Drop wholly-empty <p>/<div> wrappers, peeling nested empty shells over
  // repeated passes (bounded guard against pathological input).
  let prev: string;
  let guard = 0;
  do {
    prev = out;
    out = out.replace(
      /<(p|div)\b[^>]*>(?:\s|<br\s*\/?>|&nbsp;|&#160;|&#xA0;)*<\/\1>/gi,
      '',
    );
  } while (out !== prev && ++guard < 200);
  return out;
}

/**
 * Strip quoted content from an email body for the Standard chat view.
 *
 * Reuses `sliceBodyHeuristic` — the AI pipeline's deterministic (no-LLM)
 * quote/signature/header stripper — so the Standard view cleans threads the
 * same way the AI fallback does: it cuts "On … wrote:" attributions, Outlook
 * "From:/Sent:/To:" header blocks (including tag- and underscore-separated
 * ones), forwarded/original-message banners, and known quote/signature
 * containers. We then strip plain-text signatures and normalize inline styling.
 */
function stripQuotedContent(html: string): string {
  const withoutSig = stripSignaturesSimple(html);
  const withoutQuotes = sliceBodyHeuristic(withoutSig);
  return normalizeHtmlContent(withoutQuotes).trim();
}

/* ------------------------------------------------------------------ */
/* Simple-content fast path — small text-only messages render INLINE  */
/* (no iframe) so the bubble hugs its content instead of claiming the */
/* full 80% column that the iframe path needs.                         */
/* ------------------------------------------------------------------ */

/** Tags that force the iframe path — media/layout that needs a real document. */
const COMPLEX_TAG_RE = /<\s*(img|table|pre|iframe|svg|video)\b/i;

/**
 * Classify extracted/clean HTML as "simple": short text-only content
 * (≤ ~350 chars after stripping tags) with none of the media/layout
 * tags above. Simple content renders inline via sanitizeSimpleHtml()
 * inside a content-hugging bubble; everything else keeps the
 * SandboxedEmailBody iframe (which needs a sized containing block).
 */
function isSimpleHtml(html: string): boolean {
  if (!html) return false;
  if (COMPLEX_TAG_RE.test(html)) return false;
  const text = html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > 0 && text.length <= 350;
}

/** Tags the inline sanitizer keeps. Anything else is unwrapped (children kept). */
const INLINE_ALLOWED_TAGS = new Set([
  'P', 'DIV', 'BR', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'A', 'SPAN',
  'UL', 'OL', 'LI', 'CODE', 'BLOCKQUOTE',
]);
/** Tags dropped INCLUDING their content. */
const INLINE_DROPPED_TAGS = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED']);

/**
 * Allowlist sanitizer for the inline (no-iframe) render path. Rebuilds
 * a clean tree from scratch rather than mutating the parsed one:
 *   • allowed tags survive with NO attributes — except a[href] with an
 *     http(s)/mailto scheme — so style/class/on* handlers can never
 *     survive by construction;
 *   • script/style/iframe/object/embed are dropped with their content;
 *   • any other tag is unwrapped (children kept).
 * Parsing happens inside an inert <template> so nothing executes or
 * fetches while we walk.
 */
function sanitizeSimpleHtml(html: string): string {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  const out = document.createElement('div');

  const walk = (src: Node, dst: Node) => {
    src.childNodes.forEach((node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        dst.appendChild(document.createTextNode(node.textContent || ''));
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return; // comments, CDATA, …
      const tag = (node as Element).tagName.toUpperCase();
      if (INLINE_DROPPED_TAGS.has(tag)) return; // drop with content
      if (!INLINE_ALLOWED_TAGS.has(tag)) {
        walk(node, dst); // unwrap: keep children only
        return;
      }
      const el = document.createElement(tag.toLowerCase());
      if (tag === 'A') {
        const href = ((node as Element).getAttribute('href') || '').trim();
        if (/^(https?:\/\/|mailto:)/i.test(href)) el.setAttribute('href', href);
      }
      walk(node, el);
      dst.appendChild(el);
    });
  };
  walk(tpl.content, out);
  return out.innerHTML;
}

/** Open a link in the OS browser — same routing SandboxedEmailBody uses. */
function openLinkExternally(href: string) {
  if (window.electronAPI?.app?.openExternal) {
    window.electronAPI.app.openExternal(href);
  } else {
    window.open(href, '_blank');
  }
}

/**
 * Inline renderer for simple (sanitized) message HTML. No iframe — the
 * content participates in normal layout so the bubble hugs it. Link
 * clicks are delegated, prevented, and rerouted to the OS browser,
 * mirroring SandboxedEmailBody's interception.
 */
function InlineMessageBody({ html }: { html: string }) {
  const handleClick = (e: React.MouseEvent) => {
    const target = e.target as Element | null;
    const anchor = target?.closest?.('a');
    if (!anchor) return;
    e.preventDefault();
    e.stopPropagation();
    const href = (anchor.getAttribute('href') || '').trim();
    if (/^https?:\/\//i.test(href)) openLinkExternally(href);
  };
  return (
    <div
      className="text-sm leading-relaxed [overflow-wrap:anywhere] [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2 [&_a:hover]:opacity-80 [&_ul]:list-disc [&_ul]:pl-4 [&_ol]:list-decimal [&_ol]:pl-4 [&_li]:my-0.5 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-2 [&_blockquote]:text-muted-foreground [&_code]:font-mono [&_code]:text-[12px] [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_p]:m-0 [&_p+p]:mt-1.5 [&_div+div]:mt-1"
      onClick={handleClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

/**
 * Message grouping (V7): consecutive messages in the same date group
 * from the same sender (case-insensitive) within 5 minutes collapse —
 * follow-ups render without avatar/header. Dates are unix seconds.
 */
function isSameSenderRun(
  prevFrom: string | null | undefined,
  prevDate: number | null | undefined,
  from: string,
  date: number,
): boolean {
  if (!prevFrom || !from) return false;
  const a0 = prevFrom.trim().toLowerCase();
  const b0 = from.trim().toLowerCase();
  // Never merge unidentified senders — two different "unknown" messages must
  // stay separate bubbles, each with its own header.
  if (!a0 || !b0 || a0 === 'unknown' || b0 === 'unknown') return false;
  if (a0 !== b0) return false;
  const a = typeof prevDate === 'number' && Number.isFinite(prevDate) && prevDate > 0 ? prevDate : NaN;
  const b = typeof date === 'number' && Number.isFinite(date) && date > 0 ? date : NaN;
  if (Number.isNaN(a) || Number.isNaN(b)) return false;
  return Math.abs(b - a) <= 5 * 60;
}

/**
 * Format date for chat bubbles
 */
function formatChatDate(timestamp: number): string {
  const ts = typeof timestamp === 'number' && Number.isFinite(timestamp) && timestamp > 0
    ? timestamp * 1000
    : NaN;
  const date = new Date(ts);

  if (Number.isNaN(date.getTime())) return '';

  if (isToday(date)) {
    return format(date, 'h:mm a');
  }

  if (isYesterday(date)) {
    return `Yesterday ${format(date, 'h:mm a')}`;
  }

  return format(date, 'MMM d, h:mm a');
}

/**
 * Get initials from name or email
 */
/**
 * Hover action bar for bubbles (star + menu)
 */
function BubbleActions({
  email,
  isFromCurrentUser,
  onReExtract,
  reExtracting,
  extractionFailed,
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
}: {
  email: any;
  isFromCurrentUser: boolean;
  onReExtract?: () => void;
  reExtracting?: boolean;
  /** This message's AI cleanup failed → tint the re-extract icon orange (like the
   *  thread-level reload) so an unprocessed message is visible at a glance. */
  extractionFailed?: boolean;
  onReply?: (email: any) => void;
  onReplyAll?: (email: any) => void;
  onForward?: (email: any) => void;
  onDelete?: (emailId: string) => void;
  onArchive?: (emailId: string) => void;
  onMarkUnread?: (emailId: string) => void;
  onReportSpam?: (emailId: string) => void;
  onPrint?: (email: any) => void;
  onDownload?: (email: any) => void;
  onShowOriginal?: (email: any) => void;
  onFilterLikeThis?: (email: any) => void;
  onTranslate?: (email: any) => void;
  onDetectSignature?: (email: any) => void;
}) {
  // The bar is hover-gated, but the menu portals to <body>: once it's open the
  // cursor leaves the bubble, so without this the trigger would fade out from
  // under the open menu. Pin the bar visible while the menu is open.
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <div
      className={`absolute top-0 z-[50] flex items-center gap-0.5 transition-opacity ${menuOpen ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'} ${isFromCurrentUser ? 'left-0 -translate-x-full pr-1' : 'right-0 translate-x-full pl-1'
        }`}
    >
      {onReExtract && (
        <Tooltip
          content={reExtracting ? 'Re-extracting with AI…' : extractionFailed ? 'Process this message with AI' : 'Re-extract this message with AI'}
          delayMs={120}
        >
          <button
            onClick={(e) => { e.stopPropagation(); onReExtract(); }}
            disabled={reExtracting}
            className="p-1 hover:bg-accent rounded transition-colors"
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${
                reExtracting
                  ? 'animate-spin text-violet-500'
                  : extractionFailed
                    ? 'text-orange-500 hover:text-orange-600'
                    : 'text-muted-foreground'
              }`}
            />
          </button>
        </Tooltip>
      )}
      {onReply && (
        <EmailMenu
          email={email}
          onReply={() => onReply(email)}
          onReplyAll={() => onReplyAll?.(email)}
          onForward={() => onForward?.(email)}
          onDelete={() => onDelete?.(email.id)}
          onArchive={() => onArchive?.(email.id)}
          onMarkUnread={() => onMarkUnread?.(email.id)}
          onReportSpam={() => onReportSpam?.(email.id)}
          onPrint={() => onPrint?.(email)}
          onDownload={() => onDownload?.(email)}
          onShowOriginal={() => onShowOriginal?.(email)}
          onFilterLikeThis={() => onFilterLikeThis?.(email)}
          onTranslate={() => onTranslate?.(email)}
          onDetectSignature={() => onDetectSignature?.(email)}
          onOpenChange={setMenuOpen}
        />
      )}
    </div>
  );
}

interface BaseChatBubbleProps {
  initials: string;
  senderName: string;
  fromAddress?: string;
  toAddress?: string;
  toNames?: string;
  ccAddress?: string;
  ccNames?: string;
  avatarColor: string;
  timeString: string;
  isFromCurrentUser: boolean;
  bubbleBg: string;
  isExtracted?: boolean;
  emailForActions: any;
  actions: ChatViewProps;
  onReExtract?: () => void;
  reExtracting?: boolean;
  extractionFailed?: boolean;
  children: React.ReactNode;
  attachments?: React.ReactNode;
  /**
   * Content-hugging mode for inline (non-iframe) content: the column
   * uses w-fit and the bubble drops w-full so a one-word reply renders
   * as a small chip instead of an 80%-width box. Iframe content must
   * keep hug=false — the iframe needs a sized containing block.
   */
  hug?: boolean;
  /**
   * Grouped follow-up within a sender run (V7): omits the header row,
   * replaces the avatar with an invisible w-8 spacer, and uses plain
   * rounded-xl corners (the chat tail belongs to the run's first
   * message only).
   */
  compact?: boolean;
  /**
   * Bubble padding override. Default p-[5px] is the iframe gutter;
   * inline content passes px-3 py-2, the "no new content" line passes
   * something tighter.
   */
  bubblePadding?: string;
}

/**
 * Parse a comma-separated address list into [{ name, email }] using the RFC
 * 5322 parser (handles quoted display names that contain commas — "Last,
 * First" <a@b> — which a naive comma-split mangles). Falls back to a simple
 * split only if the parser can't make sense of the input.
 */
function parseAddressList(list: string | null | undefined): { name: string | null; email: string }[] {
  if (!list) return [];
  const parsed = emailAddresses.parseAddressList({ input: list, partial: true });
  if (parsed && parsed.length) {
    return parsed.flatMap((a) =>
      a.type === 'mailbox'
        ? [{ name: a.name || null, email: a.address }]
        : (a.addresses || []).map((m) => ({ name: m.name || null, email: m.address })),
    );
  }
  // Fallback: naive split for anything the parser rejects.
  return list
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const m = entry.match(/^(.*?)\s*<([^>]+)>$/);
      if (m) return { name: m[1].replace(/^["']|["']$/g, '').trim() || null, email: m[2].trim() };
      return { name: null, email: entry };
    });
}

/**
 * Inline recipient label for the bubble header (after the "→").
 * One recipient → their name (or email). Several → "first +N others".
 * The full From/To/Cc is always on the header's hover tooltip.
 */
function formatRecipientLabels(toAddress?: string, toNames?: string): string {
  if (!toAddress) return '';
  const addrs = parseAddresses(toAddress);
  if (!addrs.length) return '';
  const names = (toNames || '').split(',').map((s) => s.trim().replace(/^["']|["']$/g, ''));
  const labelFor = (i: number): string => {
    const name = names[i];
    return name && name !== addrs[i] ? name : addrs[i];
  };
  if (addrs.length === 1) return labelFor(0);
  const others = addrs.length - 1;
  return `${labelFor(0)} +${others} other${others === 1 ? '' : 's'}`;
}

function RecipientsTooltipContent({ from, to, cc }: { from?: string; to?: string; cc?: string }) {
  const toList = parseAddressList(to);
  const ccList = parseAddressList(cc);
  const fromList = parseAddressList(from);
  return (
    <div className="flex flex-col gap-1 text-left">
      {fromList.length > 0 && (
        <div className="flex items-start gap-1.5">
          <span className="text-gray-400 font-semibold min-w-[28px]">From</span>
          <span className="break-all">
            {fromList.map((a, i) => (
              <span key={i}>
                {a.name ? `${a.name} <${a.email}>` : a.email}
                {i < fromList.length - 1 && ', '}
              </span>
            ))}
          </span>
        </div>
      )}
      {toList.length > 0 && (
        <div className="flex items-start gap-1.5">
          <span className="text-gray-400 font-semibold min-w-[28px]">To</span>
          <span className="break-all">
            {toList.map((a, i) => (
              <span key={i}>
                {a.name ? `${a.name} <${a.email}>` : a.email}
                {i < toList.length - 1 && ', '}
              </span>
            ))}
          </span>
        </div>
      )}
      {ccList.length > 0 && (
        <div className="flex items-start gap-1.5">
          <span className="text-gray-400 font-semibold min-w-[28px]">Cc</span>
          <span className="break-all">
            {ccList.map((a, i) => (
              <span key={i}>
                {a.name ? `${a.name} <${a.email}>` : a.email}
                {i < ccList.length - 1 && ', '}
              </span>
            ))}
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * Base chat bubble layout that enforces DRY principles
 */
function BaseChatBubble({
  initials,
  senderName,
  fromAddress,
  toAddress,
  toNames,
  ccAddress,
  avatarColor,
  timeString,
  isFromCurrentUser,
  emailForActions,
  actions,
  onReExtract,
  reExtracting,
  extractionFailed,
  children,
  attachments,
  hug = false,
  compact = false,
  bubblePadding,
  bubbleBg,
}: BaseChatBubbleProps) {
  const hasRecipients = !!(toAddress || ccAddress || fromAddress);
  const recipientLabels = formatRecipientLabels(toAddress, toNames);
  // "Sender → recipients" as one unit, built once so the tooltip-wrapped and
  // bare branches below cannot drift apart. The recipient half is the part the
  // tooltip actually explains ("+1 other" says nothing on its own), so it has to
  // be inside the same hover target as the sender, not next to it.
  const headerNames = (
    <>
      <span className="font-semibold text-foreground/80">{senderName}</span>
      {recipientLabels && (
        <>
          <span className="text-muted-foreground/40">&rarr;</span>
          <span className="text-muted-foreground/70 truncate max-w-[240px]">{recipientLabels}</span>
        </>
      )}
    </>
  );
  return (
    <div className={`group relative flex gap-3 hover:z-10 ${isFromCurrentUser ? 'flex-row-reverse' : ''}`}>
      {/* Avatar — grouped follow-ups swap it for an invisible spacer
          so the bubbles in a sender run stay column-aligned. */}
      {compact ? (
        <div className="w-8 flex-shrink-0" aria-hidden="true" />
      ) : (
        <div
          className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-semibold flex-shrink-0 shadow-sm ${isFromCurrentUser
            ? 'bg-primary text-primary-foreground'
            : 'text-white'
            }`}
          style={isFromCurrentUser ? undefined : { backgroundColor: avatarColor }}
        >
          {initials}
        </div>
      )}

      {/* Message column.
          • iframe content (hug=false): w-full + max-w-[80%] — the iframe
            inside SandboxedEmailBody renders at width:100% of its
            container, so without a defined column width it collapses to
            the UA-default 300px and the bubble looks tiny.
          • inline content (hug=true): w-fit + max-w-[80%] — the column
            shrinks to the content so a one-word reply renders as a
            small chip, not an 80%-wide box. */}
      <div className={`relative ${hug ? 'w-fit' : 'w-full'} max-w-[80%] flex flex-col ${isFromCurrentUser ? 'items-end' : 'items-start'}`}>

        {/* Header: "Sender → recipient · time". One recipient shows its name;
            several show "first +N others". The full From/To/Cc is on the hover
            tooltip. Omitted on grouped follow-ups. */}
        {!compact && (
          <div
            className={`flex items-baseline gap-1.5 mb-1 px-0.5 text-xs ${isFromCurrentUser ? 'justify-end' : ''}`}
          >
            {hasRecipients ? (
              // The whole "Sender → recipients" run is the hover target, not
              // just the bold name: `min-w-0` keeps the recipient half
              // truncatable inside the wrapper, and the gap/baseline classes
              // reproduce the spacing the header row gave these spans directly.
              <Tooltip
                content={<RecipientsTooltipContent from={fromAddress} to={toAddress} cc={ccAddress} />}
                maxWidth={420}
                delayMs={40}
                className="inline-flex items-baseline gap-1.5 min-w-0 cursor-help"
              >
                {headerNames}
              </Tooltip>
            ) : (
              headerNames
            )}
            <span className="text-muted-foreground/50">{timeString}</span>
          </div>
        )}

        {/* Message bubble.
            • w-full only for iframe content (see column comment above);
              inline content hugs.
            • default p-[5px] keeps a 5px gutter between bubble border
              and the iframe; inline content overrides via bubblePadding.
            • overflow-hidden + rounded-xl gives the iframe a clean clip
              against the bubble corners.
            • chat-tail corner (rounded-tl-sm / rounded-tr-sm) only on
              the FIRST message of a sender run; grouped follow-ups use
              plain rounded-xl.
            • subtle background tint per direction so the chat flow
              reads, but no violet "AI" accent — every bubble is
              extracted in v20 so the accent was just noise. The
              cache's partial flag still drives the amber refresh
              icon when something falls back to heuristic slicing. */}
        <div
          className={`relative ${hug ? '' : 'w-full'} rounded-xl overflow-hidden ${bubblePadding || 'p-[5px]'} shadow-sm transition-all border ${isFromCurrentUser
            ? `bg-primary/5 border-primary/15 ${compact ? '' : 'rounded-tr-sm'}`
            : `${bubbleBg ? '' : 'bg-card'} border-border/60 ${compact ? '' : 'rounded-tl-sm'}`
            }`}
          // Sender tint — applied ONLY to normal conversation messages (the
          // caller passes an empty bubbleBg for designed/heavy HTML, which then
          // renders on a neutral bg-card, as-is). Inline so the hue isn't capped
          // by a Tailwind palette.
          style={!isFromCurrentUser && bubbleBg ? { backgroundColor: bubbleBg } : undefined}
        >
          {children}
        </div>

        {/* Attachments */}
        {attachments && (
          <div className={`mt-1.5 flex flex-wrap gap-1.5 ${isFromCurrentUser ? 'justify-end' : ''}`}>
            {attachments}
          </div>
        )}

        {/* Hover actions */}
        <BubbleActions
          email={emailForActions}
          isFromCurrentUser={isFromCurrentUser}
          onReExtract={onReExtract}
          reExtracting={reExtracting}
          extractionFailed={extractionFailed}
          onReply={actions.onReply}
          onReplyAll={actions.onReplyAll}
          onForward={actions.onForward}
          onDelete={actions.onDelete}
          onArchive={actions.onArchive}
          onMarkUnread={actions.onMarkUnread}
          onReportSpam={actions.onReportSpam}
          onPrint={actions.onPrint}
          onDownload={actions.onDownload}
          onShowOriginal={actions.onShowOriginal}
          onFilterLikeThis={actions.onFilterLikeThis}
          onTranslate={actions.onTranslate}
          onDetectSignature={actions.onDetectSignature}
        />
      </div>
    </div>
  );
}

/**
 * Chat message bubble component
 */
interface ChatBubbleProps {
  email: EmailRecord;
  isFromCurrentUser: boolean;
  preserveFullContent?: boolean;
  avatarColor: string;
  bubbleBg: string;
  actions: ChatViewProps;
  compact?: boolean;
}

// Only re-render when something that affects the bubble's OUTPUT changes.
// Handler identity is ignored on purpose — the callbacks take the email as an
// argument and read fresh store state, so a "stale" reference is still correct,
// and comparing them would defeat memoization (they're fresh arrows each render).
const chatBubbleAreEqual = (a: ChatBubbleProps, b: ChatBubbleProps): boolean =>
  a.email === b.email &&
  a.isFromCurrentUser === b.isFromCurrentUser &&
  a.preserveFullContent === b.preserveFullContent &&
  a.avatarColor === b.avatarColor &&
  a.bubbleBg === b.bubbleBg &&
  a.compact === b.compact &&
  a.actions.failedBodies === b.actions.failedBodies;

const ChatBubble = memo(function ChatBubble({
  email,
  isFromCurrentUser,
  preserveFullContent = false,
  avatarColor,
  bubbleBg,
  actions,
  compact = false,
}: ChatBubbleProps) {
  const rawBody = email.rawBody || email.cleanBody || '';
  // A designed notification/transactional email is NOT a real conversation turn.
  // Running the quote-slicer + normalizer over it (below) truncated its copy and
  // wrecked its layout in the bubble — render its own HTML verbatim instead
  // (resolve image refs only), mirroring the AI bubble's normalize={!designed}.
  // A real conversation turn: a HUMAN sender (not a template / system / bulk
  // message — classifyEmail scores unsubscribe/pixel/placeholder/ESP-id/no-reply).
  // This is what earns the chat treatment (sender tint), NOT the HTML "designed"
  // heuristic — which false-positives on ordinary Outlook/Word mail (inline
  // styles on every <p>) and was turning real replies into plain white bubbles.
  const conversation = useMemo(
    () => isConversationEmail({ rawBody, messageId: email.messageId, fromAddress: email.fromAddress }),
    [rawBody, email.messageId, email.fromAddress],
  );
  const cleanBody = useMemo(() => {
    if (!rawBody) return '';
    // Template / heavy mail: render its own HTML verbatim (resolve image refs
    // only) so its layout survives. A conversation turn: strip the quoted
    // thread / signature so the bubble shows just the new message.
    if (!conversation) return resolveRefsInHtml(rawBody);
    if (preserveFullContent) return stripSignaturesSimple(rawBody);
    return stripQuotedContent(rawBody);
  }, [rawBody, preserveFullContent, conversation]);

  const hasBody = !!(email.rawBody || email.cleanBody);
  // Every human conversation turn gets the sender tint — regardless of length or
  // Outlook styling.
  const chatLike = hasBody && conversation;
  // What actually needs the iframe: real media/layout (img/table/pre/…). Inline
  // styles alone don't — sanitizeSimpleHtml strips them. So a text/bold/list
  // reply renders inline (the tint shows through); only genuine media/layout, or
  // any non-conversation mail, keeps the sandboxed iframe.
  const hasComplexLayout = useMemo(() => COMPLEX_TAG_RE.test(cleanBody), [cleanBody]);
  const renderInline = chatLike && !hasComplexLayout;
  // `simple` (short, no complex tags) still picks the compact "chip" bubble.
  const simple = useMemo(() => hasBody && isSimpleHtml(cleanBody), [hasBody, cleanBody]);
  const inlineHtml = useMemo(() => (renderInline ? sanitizeSimpleHtml(cleanBody) : ''), [renderInline, cleanBody]);

  const initials = getInitials(email.fromName, email.fromAddress);
  const senderName = email.fromName || email.fromAddress.split('@')[0];

  const attachmentNodes = email.hasAttachments ? (
    <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-muted/50 border border-border text-xs text-muted-foreground group">
      <Paperclip className="h-3 w-3 flex-shrink-0" />
      <span>{email.attachmentCount} attachment{email.attachmentCount !== 1 ? 's' : ''}</span>
    </div>
  ) : null;

  return (
    <BaseChatBubble
      initials={initials}
      senderName={senderName}
      fromAddress={email.fromName ? `${email.fromName} <${email.fromAddress}>` : email.fromAddress}
      toAddress={email.toAddress || ''}
      toNames={(email as any).toNames || ''}
      ccAddress={email.ccAddress || ''}
      ccNames={(email as any).ccNames || ''}
      avatarColor={avatarColor}
      timeString={formatChatDate(email.date)}
      isFromCurrentUser={isFromCurrentUser}
      bubbleBg={bubbleBg}
      emailForActions={email}
      actions={actions}
      attachments={attachmentNodes}
      compact={compact}
      hug={!hasBody || simple}
      bubblePadding={!hasBody || simple ? 'px-3 py-2' : 'px-3.5 py-2.5 overflow-hidden'}
    >
      {!hasBody ? (
        actions.failedBodies?.has(email.id) ? (
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">Couldn't load content.</span>
            {actions.onRetryBody && (
              <button
                onClick={() => actions.onRetryBody!(email.id)}
                className="text-xs font-medium text-primary hover:underline"
              >
                Retry
              </button>
            )}
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
            <span className="text-xs text-muted-foreground font-medium">Downloading…</span>
          </div>
        )
      ) : renderInline ? (
        <InlineMessageBody html={inlineHtml} />
      ) : (
        // Original email HTML. `normalize` is the key: for a CONVERSATION turn
        // (chatLike) it makes the iframe canvas TRANSPARENT (lightCanvas =
        // !normalize) so the bubble's sender tint shows through instead of a
        // white box, and cleans the Outlook typography — this is what fixes
        // "long emails render white". For designed/heavy mail (chatLike=false)
        // it stays off, so the iframe keeps its white canvas and the email's own
        // layout renders verbatim. styledTables stays off either way (it's only
        // for AI-extracted markdown tables; on real layout tables it draws an
        // ugly wireframe).
        <SandboxedEmailBody html={cleanBody} normalize={chatLike} transparentCanvas senderAddress={email.fromAddress} className="text-[13px] leading-relaxed" />
      )}
    </BaseChatBubble>
  );
}, chatBubbleAreEqual);

/**
 * Chat bubble for AI-extracted conversation messages
 */
interface ConversationBubbleProps {
  message: ConversationMessage;
  isFromCurrentUser: boolean;
  sourceEmail?: EmailRecord;
  avatarColor: string;
  bubbleBg: string;
  actions: ChatViewProps;
  onReExtract?: () => void;
  reExtracting?: boolean;
  /** Grouped follow-up in a sender run — no avatar/header (V7). */
  compact?: boolean;
}

// Re-render only on output-affecting changes (handler identity ignored — see
// chatBubbleAreEqual).
const conversationBubbleAreEqual = (a: ConversationBubbleProps, b: ConversationBubbleProps): boolean =>
  a.message === b.message &&
  a.sourceEmail === b.sourceEmail &&
  a.isFromCurrentUser === b.isFromCurrentUser &&
  a.avatarColor === b.avatarColor &&
  a.bubbleBg === b.bubbleBg &&
  a.compact === b.compact &&
  a.reExtracting === b.reExtracting &&
  a.actions.failedBodies === b.actions.failedBodies;

const ConversationBubble = memo(function ConversationBubble({
  message,
  isFromCurrentUser,
  sourceEmail,
  avatarColor,
  bubbleBg,
  actions,
  onReExtract,
  reExtracting,
  compact = false,
}: ConversationBubbleProps) {
  const initials = getInitials(message.fromName, message.fromAddress);
  const senderName = message.fromName || message.fromAddress.split('@')[0];
  // For a message whose AI cleanup failed, "Preview" opens a floating panel
  // rendering the ORIGINAL mail as received (sourceEmail.rawBody) instead of the
  // noisy heuristic slice. The panel is anchored at the Preview button's
  // top-left and stretches to the right/bottom, leaving ~20% clear on the right.
  const [showRawPreview, setShowRawPreview] = useState(false);
  const [previewAnchor, setPreviewAnchor] = useState<{ left: number; top: number } | null>(null);

  // v20: bodies are always HTML (marker-based pipeline slices the
  // original HTML byte-for-byte; Phase 1 returns HTML per its prompt).
  // No markdown auto-detection or conversion.
  const body = message.body ? trimHtmlEnds(message.body) : '';
  // Media/layout-only bodies (a pasted screenshot <img>, or a layout table
  // with no text) strip to empty text but ARE content — treat the presence of
  // an image/table/etc. as content so they render instead of collapsing to the
  // "No new content" chip. Genuinely empty / quoted-only bodies (no text, no
  // media) still fall through to the no-content case.
  const hasContent = !!body.replace(/<[^>]*>/g, '').trim() || COMPLEX_TAG_RE.test(body);
  // Resolve sarv-image:HASH refs to the original base64 data URLs from
  // the renderer image cache (before classification so an <img> that
  // materializes from a ref still forces the iframe path — refs keep
  // their <img> tag either way).
  const rawResolved = useMemo(() => (hasContent ? resolveRefsInHtml(body) : ''), [hasContent, body]);
  // Designed emails carry their own bespoke layout — injecting table borders
  // (styledTables) or normalizing fonts turns them into a wireframe of empty
  // boxes. Render VERBATIM. styledTables/normalize apply only to plain replies
  // or AI-extracted markdown, which need the readability help. (Shared helper.)
  const looksDesigned = useMemo(() => htmlLooksDesigned(rawResolved), [rawResolved]);
  // For plain replies / AI-extracted content (BOTH Standard and AI chat modes),
  // collapse stray empty blocks + runs of <br> that extraction/quoting leave
  // behind — they render as big vertical gaps in a bubble. Designed emails are
  // exempt (they own their spacing).
  const resolvedBody = useMemo(
    () => (looksDesigned ? rawResolved : collapseVerticalWhitespace(rawResolved)),
    [rawResolved, looksDesigned],
  );
  const simple = useMemo(() => hasContent && isSimpleHtml(resolvedBody), [hasContent, resolvedBody]);
  const inlineHtml = useMemo(() => (simple ? sanitizeSimpleHtml(resolvedBody) : ''), [simple, resolvedBody]);
  // Empty + isExtracted → legit "no new content" signal; render the
  // de-noised single-line version (V6) in a hugging chip.
  const noContentLine = !hasContent && message.isExtracted;

  const attachments = sourceEmail?.hasAttachments
    ? parseAttachments(sourceEmail.attachmentNames, sourceEmail.attachmentSizes)
    : [];

  const [downloading, setDownloading] = useState<Set<string>>(new Set());

  const isPreviewable = (filename: string) => {
    const ext = filename.split('.').pop()?.toLowerCase() || '';
    return ['pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'txt', 'csv'].includes(ext);
  };

  const handleAction = async (filename: string, action: 'preview' | 'download') => {
    if (!sourceEmail) return;
    setDownloading(prev => new Set(prev).add(filename));
    try {
      if (action === 'preview') {
        await window.electronAPI.emails.previewAttachment(sourceEmail.id, filename);
      } else {
        await window.electronAPI.emails.downloadAttachment(sourceEmail.id, filename);
      }
    } catch (err) {
      console.error(`[ChatView] ${action} failed:`, err);
    } finally {
      setDownloading(prev => { const n = new Set(prev); n.delete(filename); return n; });
    }
  };

  const emailForActions = sourceEmail || {
    id: message.sourceEmailId,
    fromAddress: message.fromAddress,
    fromName: message.fromName,
    subject: '',
    tags: '',
  };

  const attachmentNodes = attachments.length > 0 ? (
    <>
      {attachments.map(({ name, size }, i: number) => {
        const busy = downloading.has(name);
        const canPreview = isPreviewable(name);
        return (
          <div
            key={i}
            className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-background/50 backdrop-blur shadow-sm border border-border text-xs text-muted-foreground group hover:border-border/80 transition-colors"
          >
            <Paperclip className="h-3 w-3 flex-shrink-0" />
            <span className="truncate max-w-[150px] font-medium" title={name}>{name}</span>
            {size != null && (
              <span className="flex-shrink-0 tabular-nums opacity-60">{prettyBytes(size)}</span>
            )}
            {busy ? (
              <Loader2 className="h-3 w-3 animate-spin flex-shrink-0 text-primary" />
            ) : (
              <span className="flex items-center gap-1 opacity-60 group-hover:opacity-100 transition-opacity">
                {canPreview && (
                  <button
                    onClick={() => handleAction(name, 'preview')}
                    title="Preview Attachment"
                    aria-label={`Preview ${name}`}
                    className="p-1 rounded hover:bg-accent hover:text-foreground transition-all"
                  >
                    <Eye className="h-3 w-3" />
                  </button>
                )}
                <button
                  onClick={() => handleAction(name, 'download')}
                  title="Download Attachment"
                  aria-label={`Download ${name}`}
                  className="p-1 rounded hover:bg-accent hover:text-foreground transition-all"
                >
                  <Download className="h-3 w-3" />
                </button>
              </span>
            )}
          </div>
        );
      })}
    </>
  ) : null;

  return (
    <BaseChatBubble
      initials={initials}
      senderName={senderName}
      fromAddress={message.fromName ? `${message.fromName} <${message.fromAddress}>` : message.fromAddress}
      toAddress={message.toAddress || sourceEmail?.toAddress || ''}
      toNames={(message as any).toNames || (sourceEmail as any)?.toNames || ''}
      ccAddress={sourceEmail?.ccAddress || ''}
      ccNames={sourceEmail?.ccNames || ''}
      avatarColor={avatarColor}
      timeString={formatChatDate(message.date)}
      isFromCurrentUser={isFromCurrentUser}
      bubbleBg={bubbleBg}
      isExtracted={message.isExtracted}
      emailForActions={emailForActions}
      actions={actions}
      onReExtract={onReExtract}
      reExtracting={reExtracting}
      extractionFailed={message.extractionFailed}
      attachments={attachmentNodes}
      compact={compact}
      hug={!hasContent || simple}
      // Every bubble is a chat bubble: comfortable padding + a transparent iframe
      // canvas (above) so the sender tint always shows. Designed emails keep
      // their own layout INSIDE the padded, tinted bubble.
      bubblePadding={noContentLine ? 'px-2.5 py-1' : (!hasContent || simple) ? 'px-3 py-2' : 'px-3.5 py-2.5'}
    >
      {reExtracting ? (
        // Re-processing THIS message with AI — show progress, not the old body.
        <div className="flex items-center gap-2 text-xs text-muted-foreground font-medium">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-violet-500" />
          <span className="animate-pulse">Processing with AI…</span>
        </div>
      ) : message.extractionFailed ? (
        // AI cleanup FAILED for this message: do NOT show the uncleaned body
        // (raw signature/quote noise). Keep the bubble in the sender's colour
        // (bubbleBg on BaseChatBubble) and just show a compact notice + actions:
        // process it with AI, or Preview the original mail (opens a popup).
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-1.5 text-[12px] font-medium text-amber-700 dark:text-amber-400">
            <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0" />
            <span>AI couldn't process this message.</span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {onReExtract && (
              <button
                onClick={(e) => { e.stopPropagation(); onReExtract(); }}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[12px] font-medium bg-violet-500/15 hover:bg-violet-500/25 text-violet-700 dark:text-violet-300 border border-violet-500/30 transition-colors"
              >
                <Sparkles className="h-3.5 w-3.5" /> Process with AI
              </button>
            )}
            {(sourceEmail?.rawBody || sourceEmail?.cleanBody) && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  const el = e.currentTarget as HTMLElement;
                  const btn = el.getBoundingClientRect();
                  // Left stays at the button (never expand leftward); top uses the
                  // TOP of the reading-pane scroll area so the panel gets the full
                  // available height, not just from the button down.
                  const pane = el.closest('[data-email-detail-scroll]')?.getBoundingClientRect();
                  setPreviewAnchor({
                    left: Math.round(btn.left),
                    top: Math.round((pane?.top ?? btn.top) + 6),
                  });
                  setShowRawPreview(true);
                }}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[12px] font-medium bg-background/60 hover:bg-background text-muted-foreground hover:text-foreground border border-border/70 transition-colors"
              >
                <Eye className="h-3.5 w-3.5" /> Preview
              </button>
            )}
          </div>
          {showRawPreview && (sourceEmail?.rawBody || sourceEmail?.cleanBody) && createPortal(
            // Floating preview of the ORIGINAL mail as received — rendered
            // verbatim (no AI). Anchored at the Preview button's top-left and
            // stretched toward the right/bottom, leaving ~20% of the width clear
            // on the right. No dark backdrop, so the thread stays visible; a
            // transparent full-screen catcher handles click-outside-to-close.
            <div className="fixed inset-0 z-[200]" onClick={() => setShowRawPreview(false)}>
              <div
                className="fixed flex flex-col rounded-xl bg-card border border-border shadow-2xl overflow-hidden"
                style={{
                  left: previewAnchor?.left ?? 120,
                  top: previewAnchor?.top ?? 120,
                  right: '20vw',
                  bottom: 16,
                }}
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex items-center justify-between px-4 py-2.5 border-b border-border flex-shrink-0">
                  <div className="flex items-center gap-2 text-sm font-medium min-w-0">
                    <Eye className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                    <span className="truncate">Original message — {senderName}</span>
                  </div>
                  <button
                    onClick={() => setShowRawPreview(false)}
                    className="p-1 rounded-md hover:bg-accent text-muted-foreground hover:text-foreground"
                    aria-label="Close preview"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
                <div className="overflow-auto p-3">
                  <SandboxedEmailBody
                    html={sourceEmail!.rawBody || sourceEmail!.cleanBody || ''}
                    className="text-[13px] leading-relaxed"
                    styledTables={false}
                    normalize={false}
                    senderAddress={sourceEmail?.fromAddress}
                  />
                </div>
              </div>
            </div>,
            document.body,
          )}
        </div>
      ) : !hasContent ? (
        // Empty body — two distinct cases:
        //   • isExtracted=true  → LLM ran and said "no new content"
        //     (legit signal: forwarded/replied without comment).
        //     De-noised single-line chip (V6).
        //   • isExtracted=false → still extracting OR placeholder
        //     during a re-extract click. Render the loading spinner
        //     so the user knows the click took effect.
        noContentLine ? (
          <div className="flex items-center gap-1.5 text-[11px] italic text-muted-foreground/70">
            <Forward className="h-3 w-3 opacity-60 flex-shrink-0" />
            <span>No new content (forwarded or replied without comment)</span>
          </div>
        ) : (
          <div className="flex items-center gap-2 text-xs text-muted-foreground font-medium">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            <span className="animate-pulse">Loading content...</span>
          </div>
        )
      ) : simple ? (
        // Short text-only message → inline render, bubble hugs content.
        <InlineMessageBody html={inlineHtml} />
      ) : (
        // normalize=true: AI bubbles are extracted from different
        // senders / clients, each with its own font + spacing — without
        // normalization the chat view looks like a patchwork. Standard
        // view (ChatBubble + EmailCard + ThreadList) keeps normalize
        // OFF so the sender's own rendering is preserved verbatim.
        // key on the content so switching AI<->Standard REMOUNTS the iframe
        // (fresh measure) instead of reusing one mid-srcdoc-reload — which left
        // the bubble sized to the previous view's content (blank space).
        <SandboxedEmailBody key={`${resolvedBody.length}:${resolvedBody.slice(0, 32)}`} html={resolvedBody} className="text-[13px] leading-relaxed" styledTables={!looksDesigned} normalize={!looksDesigned} transparentCanvas senderAddress={message.fromAddress || sourceEmail?.fromAddress} />
      )}
    </BaseChatBubble>
  );
}, conversationBubbleAreEqual);

/**
 * Reply / Reply All / Forward quick actions at bottom of chat
 */
function ChatReplyFooter({
  lastEmail,
  onReply,
  onReplyAll,
  onForward,
}: {
  lastEmail: any;
  onReply?: (email: any) => void;
  onReplyAll?: (email: any) => void;
  onForward?: (email: any) => void;
}) {
  if (!onReply && !onReplyAll && !onForward) return null;

  return (
    <div className="flex items-center gap-2 px-4 pt-2 pb-1">
      {onReply && (
        <button
          onClick={() => onReply(lastEmail)}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-accent border border-border rounded-lg transition-colors"
        >
          <Reply className="h-3.5 w-3.5" />
          Reply
        </button>
      )}
      {onReplyAll && (
        <button
          onClick={() => onReplyAll(lastEmail)}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-accent border border-border rounded-lg transition-colors"
        >
          <ReplyAll className="h-3.5 w-3.5" />
          Reply All
        </button>
      )}
      {onForward && (
        <button
          onClick={() => onForward(lastEmail)}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-accent border border-border rounded-lg transition-colors"
        >
          <Forward className="h-3.5 w-3.5" />
          Forward
        </button>
      )}
    </div>
  );
}

/**
 * Date separator line between day groups
 */
function DateSeparator({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3 mb-4">
      <div className="h-px flex-1 bg-border" />
      <span className="text-xs text-muted-foreground px-2">{label}</span>
      <div className="h-px flex-1 bg-border" />
    </div>
  );
}

/**
 * Cold-open loading state (V2): ghost bubbles + a compact progress
 * row. Shown while an extraction run is in flight and no bubbles have
 * arrived yet — replaces the old bare spinner that could sit there for
 * a minute with zero feedback.
 */
function ExtractionSkeleton({ progress }: { progress: ChatViewProps['conversationProgress'] }) {
  const ghosts: { mine: boolean; width: string; lines: string[] }[] = [
    { mine: false, width: '60%', lines: ['w-full', 'w-3/4', 'w-1/2'] },
    { mine: true, width: '42%', lines: ['w-full', 'w-2/3'] },
    { mine: false, width: '72%', lines: ['w-full', 'w-5/6'] },
  ];
  return (
    <div className="flex flex-col gap-5">
      {ghosts.map((g, i) => (
        <div key={i} className={`flex gap-3 animate-pulse ${g.mine ? 'flex-row-reverse' : ''}`} aria-hidden="true">
          <div className="w-8 h-8 rounded-full bg-muted flex-shrink-0" />
          <div className={`flex flex-col gap-1.5 ${g.mine ? 'items-end' : 'items-start'}`} style={{ width: g.width }}>
            <div className="h-2.5 w-24 rounded-full bg-muted" />
            <div className={`w-full rounded-xl border border-border/40 bg-muted/30 px-3 py-2.5 flex flex-col gap-2 ${g.mine ? 'rounded-tr-sm' : 'rounded-tl-sm'}`}>
              {g.lines.map((w, j) => (
                <div key={j} className={`h-3 rounded-full bg-muted ${w}`} />
              ))}
            </div>
          </div>
        </div>
      ))}

      {/* Compact status row: spinner + counts (+ rate-limit/retry note) */}
      <div className="flex flex-col items-center gap-1 py-2 text-center">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-violet-500" />
          <span>Extracting conversation…</span>
          {progress && progress.total > 0 && (
            <span className="font-medium text-foreground/70 tabular-nums">
              {progress.done} of {progress.total}
            </span>
          )}
        </div>
        {progress?.status && (
          <span className="text-[11px] text-amber-600 dark:text-amber-400">{progress.status}</span>
        )}
      </div>
    </div>
  );
}

/**
 * Standard-mode bubble list: date separators + grouped ChatBubbles.
 * Shared by the 'logical' mode render path AND the AI-mode fallback
 * (V4) so both branches stay pixel-identical.
 */
function GroupedEmailBubbles({
  groups,
  currentUserEmail,
  oldestEmailId,
  actions,
  resolveSenderColor,
}: {
  groups: { date: string; emails: EmailRecord[] }[];
  currentUserEmail: string;
  oldestEmailId?: string;
  actions: ChatViewProps;
  resolveSenderColor: (address?: string | null) => SenderColor;
}) {
  return (
    <>
      {groups.map((group, groupIndex) => (
        <div key={groupIndex}>
          <DateSeparator label={group.date} />

          {/* Messages — gap-1 within a sender run, mt-3 between runs */}
          <div className="flex flex-col">
            {group.emails.map((email, idx) => {
              const prev = idx > 0 ? group.emails[idx - 1] : null;
              const grouped = !!prev && isSameSenderRun(prev.fromAddress, prev.date, email.fromAddress, email.date);
              const senderColor = resolveSenderColor(email.fromAddress);
              const senderAvatarColor = senderColor.avatar;
              const senderBubbleBg = senderColor.bubble;
              return (
                <div key={email.id} className={idx === 0 ? '' : grouped ? 'mt-1' : 'mt-3'}>
                  <ChatBubble
                    email={email}
                    isFromCurrentUser={isFromMe(email.fromAddress, currentUserEmail)}
                    preserveFullContent={email.id === oldestEmailId}
                    avatarColor={senderAvatarColor}
                    bubbleBg={senderBubbleBg}
                    actions={actions}
                    compact={grouped}
                  />
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </>
  );
}

/**
 * Chat view for email threads - displays emails as chat bubbles
 */
export function ChatView(props: ChatViewProps) {
  const { emails, currentUserEmail, conversationMessages, conversationUpdating, conversationLoading, conversationProgress, conversationPartial, mode = 'logical', onReExtractMessage, onRetryAll } = props;
  const [reExtractingId, setReExtractingId] = useState<string | null>(null);

  // Drafts (unsent — \Draft flag → |draft| tag) must NOT appear as sent
  // messages in the thread conversation. A Gmail draft shares its thread's
  // id, so it gets pulled into the thread and (before this) rendered as a
  // bubble that looks like you already replied. Identify them so both the
  // AI and standard renderings skip them.
  const draftIds = useMemo(
    () => new Set(emails.filter(e => (e.tags || '').includes('|draft|')).map(e => e.id)),
    [emails],
  );

  // Sort emails by date (oldest first for chat flow), excluding drafts.
  const sortedEmails = useMemo(
    () => [...emails].filter(e => !draftIds.has(e.id)).sort((a, b) => a.date - b.date),
    [emails, draftIds]
  );

  // Build email lookup map for attachment info
  const emailMap = useMemo(() => {
    const map = new Map<string, EmailRecord>();
    for (const email of emails) {
      map.set(email.id, email);
    }
    return map;
  }, [emails]);

  // Per-thread sender colors: uniqolor identity hue per address, de-collided so
  // two participants never read as the same color in one conversation (see
  // buildSenderColorMap). Built from the chronological emails + any AI-extracted
  // message senders. The current user is excluded (their bubbles use the primary
  // tint); anything not in the map falls back to its plain identity color.
  const senderColorMap = useMemo(
    () => buildSenderColorMap(
      [sortedEmails.map((e) => e.fromAddress), (conversationMessages || []).map((m) => m.fromAddress)],
      currentUserEmail,
    ),
    [sortedEmails, conversationMessages, currentUserEmail],
  );
  const resolveSenderColor = useCallback(
    (address?: string | null): SenderColor => {
      const key = (address || '').trim().toLowerCase();
      return senderColorMap.get(key) ?? colorForHue(senderHue(key || 'unknown'));
    },
    [senderColorMap],
  );

  // The last (newest) email for reply footer
  const lastEmail = sortedEmails[sortedEmails.length - 1];

  // Auto-scroll to the newest bubble on open / when a new message arrives.
  // Chat bubbles render oldest→newest, so without this the pane sits at the
  // oldest message. Keyed on the message SET (count + last id), not body loads,
  // so we don't fight the user's scroll while bodies stream in — with a short
  // delayed re-scroll to catch the initial async body-height growth.
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollSig = mode === 'ai'
    ? `${conversationMessages?.length ?? 0}:${conversationMessages?.[(conversationMessages.length ?? 0) - 1]?.id ?? ''}`
    : `${sortedEmails.length}:${lastEmail?.id ?? ''}`;
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
    const t = setTimeout(() => bottomRef.current?.scrollIntoView({ block: 'end' }), 250);
    return () => clearTimeout(t);
  }, [scrollSig]);

  // Group conversation messages by date.
  // v20 (marker-based extraction): we render every bubble we get
  // from the cache. No filter on isExtracted — the marker pipeline
  // marks all bubbles isExtracted=true regardless of whether the
  // body was produced by LLM slicing or by heuristic-regex fallback.
  // The `partial` flag on the cache turns the refresh icon amber if
  // any email needed the heuristic fallback.
  const groupedConversation = useMemo(() => {
    if (!conversationMessages || conversationMessages.length === 0) return null;

    // Drop bubbles whose source email is an unsent draft (also covers
    // bubbles left in an older cache built before drafts were excluded).
    // Sort oldest→newest (like standard mode). Progressive extraction appends
    // bubbles as each email completes, so without sorting they can arrive out of
    // order — producing misordered bubbles and repeated date separators
    // ("Today" … "Yesterday" … "Today"). Stable sort keeps date-less messages
    // in their original relative position.
    const visibleMessages = (draftIds.size > 0
      ? conversationMessages.filter(m => !draftIds.has(m.sourceEmailId))
      : conversationMessages)
      .slice()
      .sort((a, b) => (a.date || 0) - (b.date || 0));
    if (visibleMessages.length === 0) return null;

    const groups: { date: string; messages: ConversationMessage[] }[] = [];
    let currentDateKey = '';

    for (const msg of visibleMessages) {
      // AI-extracted embedded messages don't always carry a date —
      // Phase 1 sometimes produces zero/undefined when the LLM can't
      // parse a quoted "Sent:" header. Guard against `new Date(NaN)`
      // because `format()` throws RangeError on Invalid Date and crashes
      // the whole ChatView render.
      const ts = typeof msg.date === 'number' && Number.isFinite(msg.date) && msg.date > 0
        ? msg.date * 1000
        : NaN;
      const date = new Date(ts);
      let dateKey: string;

      if (Number.isNaN(date.getTime())) {
        dateKey = 'Unknown date';
      } else if (isToday(date)) {
        dateKey = 'Today';
      } else if (isYesterday(date)) {
        dateKey = 'Yesterday';
      } else {
        dateKey = format(date, 'MMMM d, yyyy');
      }

      if (dateKey !== currentDateKey) {
        groups.push({ date: dateKey, messages: [] });
        currentDateKey = dateKey;
      }

      groups[groups.length - 1].messages.push(msg);
    }

    return groups;
  }, [conversationMessages, draftIds]);

  // Group emails by date for date separators (standard mode)
  const groupedEmails = useMemo(() => {
    const groups: { date: string; emails: EmailRecord[] }[] = [];
    let currentDateKey = '';

    for (const email of sortedEmails) {
      const ts = typeof email.date === 'number' && Number.isFinite(email.date) && email.date > 0
        ? email.date * 1000
        : NaN;
      const date = new Date(ts);
      let dateKey: string;

      if (Number.isNaN(date.getTime())) {
        dateKey = 'Unknown date';
      } else if (isToday(date)) {
        dateKey = 'Today';
      } else if (isYesterday(date)) {
        dateKey = 'Yesterday';
      } else {
        dateKey = format(date, 'MMMM d, yyyy');
      }

      if (dateKey !== currentDateKey) {
        groups.push({ date: dateKey, emails: [] });
        currentDateKey = dateKey;
      }

      groups[groups.length - 1].emails.push(email);
    }

    return groups;
  }, [sortedEmails]);

  // Oldest email shows full content in standard mode, rest strip quotes
  const oldestEmailId = sortedEmails[0]?.id;

  // Render conversation messages mode if explicitly in AI mode OR if groupedConversation explicitly has items
  if (mode === 'ai' || groupedConversation) {
    // conversationProgress !== null means a run is in flight even after
    // conversationLoading flipped false (it drops as soon as the first
    // bubbles render).
    const extractionInFlight = !!(conversationLoading || conversationUpdating || conversationProgress);
    // Graceful degradation: if extraction produced ANY bubbles, SHOW them —
    // even when the run was partial (some messages fell back to a heuristic
    // slice). Those individual messages render with an inline "Process with AI"
    // retry (extractionFailed → onReExtract) while every cleanly-extracted
    // message shows normally. We only fall through to the whole-thread "AI
    // couldn't fully process" wall when extraction produced NOTHING to show —
    // hiding good bubbles just because one message failed is what made a 34-mail
    // thread look completely unprocessed. 'logical' (Standard) mode never sets
    // conversationPartial, so it's unaffected.
    const hasMessages = !!groupedConversation && groupedConversation.length > 0;
    const heuristicFallback =
      mode === 'ai' && !!conversationPartial && !extractionInFlight && !hasMessages;

    return (
      <div className="flex flex-col gap-6 p-4">
        {hasMessages ? (
          groupedConversation!.map((group, groupIndex) => (
            <div key={groupIndex}>
              <DateSeparator label={group.date} />

              {/* Messages — gap-1 within a sender run, mt-3 between runs */}
              <div className="flex flex-col">
                {group.messages.map((msg, idx) => {
                  const prev = idx > 0 ? group.messages[idx - 1] : null;
                  const grouped = !!prev && isSameSenderRun(prev.fromAddress, prev.date, msg.fromAddress, msg.date);
                  const senderColor = resolveSenderColor(msg.fromAddress);
                  const senderAvatarColor = senderColor.avatar;
                  const senderBubbleBg = senderColor.bubble;
                  return (
                    <div key={`${groupIndex}-${idx}-${msg.id}-${msg.sourceEmailId}`} className={idx === 0 ? '' : grouped ? 'mt-1' : 'mt-3'}>
                      <ConversationBubble
                        message={msg}
                        isFromCurrentUser={isFromMe(msg.fromAddress, currentUserEmail)}
                        sourceEmail={emailMap.get(msg.sourceEmailId)}
                        avatarColor={senderAvatarColor}
                        bubbleBg={senderBubbleBg}
                        actions={props}
                        compact={grouped}
                        onReExtract={onReExtractMessage ? async () => {
                          setReExtractingId(msg.id);
                          try { await onReExtractMessage(msg.id); } finally { setReExtractingId(null); }
                        } : undefined}
                        reExtracting={reExtractingId === msg.id}
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          ))
        ) : extractionInFlight ? (
          /* Cold open: skeleton bubbles + progress while extraction runs */
          <ExtractionSkeleton progress={conversationProgress ?? null} />
        ) : (
          /* No AI-extracted conversation for this thread and no run in flight.
             Show an explicit empty state — NOT the raw thread messages — so the
             AI tab stays distinct from Standard (which already renders those).
             The user can trigger processing from here. */
          <div className="flex flex-col items-center justify-center gap-3 py-10 px-4 text-center text-muted-foreground bg-accent/30 rounded-lg border border-border border-dashed">
            <Sparkles className="h-6 w-6 text-violet-500/50" />
            <div className="space-y-1">
              <p className="text-sm font-medium text-foreground">
                {heuristicFallback ? 'AI couldn’t fully process this thread' : 'AI hasn’t processed this thread yet'}
              </p>
              <p className="text-xs">Switch to Standard to read the messages, or process this thread with AI.</p>
            </div>
            {onRetryAll && (
              <button
                onClick={onRetryAll}
                className="mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-violet-500/10 hover:bg-violet-500/20 text-violet-700 dark:text-violet-300 border border-violet-500/30 transition-colors"
              >
                <Sparkles className="h-3.5 w-3.5" />
                {heuristicFallback ? 'Try AI again' : 'Process with AI'}
              </button>
            )}
          </div>
        )}

        {/* Bottom in-flight indicators (only meaningful under rendered
            bubbles — the skeleton carries its own status row).
            • progress non-null → run still going, bubbles arriving (V3)
            • progress null + updating → joiner/incremental run with
              final-only results (existing loader, kept) */}
        {hasMessages && conversationProgress ? (
          <div className="flex items-center justify-center gap-2 py-1.5">
            <Loader2 className="h-3 w-3 animate-spin text-violet-500" />
            <span className="text-[11px] text-muted-foreground tabular-nums">
              Extracting {conversationProgress.done} of {conversationProgress.total}…
            </span>
            {conversationProgress.status && (
              <span className="text-[11px] text-amber-600 dark:text-amber-400">{conversationProgress.status}</span>
            )}
          </div>
        ) : hasMessages && conversationUpdating ? (
          <div className="flex items-center justify-center gap-2 py-3">
            <Loader2 className="h-4 w-4 animate-spin text-violet-500" />
            <span className="text-xs text-muted-foreground">Processing new messages...</span>
          </div>
        ) : null}

        {/* Reply / Reply All / Forward */}
        <ChatReplyFooter
          lastEmail={lastEmail}
          onReply={props.onReply}
          onReplyAll={props.onReplyAll}
          onForward={props.onForward}
        />
        <div ref={bottomRef} aria-hidden="true" />
      </div>
    );
  }

  // Standard email mode — first email shows full content, rest strip quotes
  return (
    <div className="flex flex-col gap-6 p-4">
      <GroupedEmailBubbles
        groups={groupedEmails}
        currentUserEmail={currentUserEmail}
        oldestEmailId={oldestEmailId}
        actions={props}
        resolveSenderColor={resolveSenderColor}
      />

      {/* Reply / Reply All / Forward */}
      <ChatReplyFooter
        lastEmail={lastEmail}
        onReply={props.onReply}
        onReplyAll={props.onReplyAll}
        onForward={props.onForward}
      />
      <div ref={bottomRef} aria-hidden="true" />
    </div>
  );
}
