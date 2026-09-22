import { Puzzle, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { formatExpiryCountdown } from '../utils/format-time';
import { openEmailFromNotification } from '../utils/open-email-from-notification';

import { CopyButton } from './CopyButton';
import { Tooltip } from './Tooltip';

/**
 * Cards extensions ask the app to show.
 *
 * This is the UI half of the `ui:notify` permission. An extension that spots a
 * verification code has something worth putting in front of the user right
 * then — a tag on the message would be found minutes later, which for a code
 * that expires in five is the same as not finding it. So the card carries the
 * value itself, a copy button, and a live countdown to the moment it stops
 * working.
 *
 * Everything rendered here was sanitised in the main process
 * (`sanitizeExtensionNotification`): strings are capped, malformed fields are
 * dropped, and the card id is namespaced by extension so one extension cannot
 * replace or dismiss another's card. React escapes the text, so nothing an
 * extension returns can become markup.
 *
 * Kept separate from `InAppNotification` — that one mirrors OS notifications
 * about new mail and lives in the top-right; these are extension output, live
 * in the bottom-right, and stay until they expire or are dismissed.
 */
interface NotificationField {
  label: string;
  value: string;
  copyable?: boolean;
  emphasis?: boolean;
}

interface NotificationCard {
  id: string;
  extensionId: string;
  title: string;
  body?: string;
  fields?: NotificationField[];
  expiresAt?: number;
  timeoutMs?: number;
  emailId?: string;
  accountId?: string;
}

const MAX_VISIBLE = 3;

type CardAction = 'copy' | 'dismiss' | 'expire' | 'open';

export function ExtensionNotification() {
  const [cards, setCards] = useState<NotificationCard[]>([]);
  // One clock for every card, not one timer each: the cards all tick together,
  // and a timer per card would keep re-rendering the whole stack anyway.
  const [now, setNow] = useState(() => Date.now());
  const timeouts = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  /**
   * Tell the extension that raised a card what the reader just did with it.
   *
   * This is the return leg of `ui:notify`: without it a card is a dead end —
   * the extension can show a verification code but never learn that the reader
   * took it, so it cannot file the message, stop watching for a newer code, or
   * do anything else that follows from the click. Reporting is deliberately
   * one-way and best-effort: the card is already doing its job locally, and a
   * disabled or crashed extension must not make the copy button look broken.
   */
  const report = useCallback(
    (card: NotificationCard, action: CardAction, extra?: { fieldIndex?: number; fieldLabel?: string }) => {
      void window.electronAPI?.extensions
        ?.cardAction?.(card.id, {
          action,
          emailId: card.emailId,
          accountId: card.accountId,
          ...extra,
        })
        .catch(() => {
          /* the extension is gone or refused it; the card still behaved normally */
        });
    },
    []
  );

  const remove = useCallback((id: string) => {
    setCards((current) => current.filter((card) => card.id !== id));
    const timer = timeouts.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timeouts.current.delete(id);
    }
  }, []);

  useEffect(() => {
    const api = window.electronAPI?.extensions;
    const offNotify = api?.onNotify?.((card: NotificationCard) => {
      setCards((current) => {
        // Same id replaces in place rather than stacking a second copy — that
        // is what makes a card updatable (a countdown restarting, a value
        // corrected) instead of a queue of near-identical cards.
        const without = current.filter((existing) => existing.id !== card.id);
        return [card, ...without].slice(0, MAX_VISIBLE);
      });

      // `expiresAt` wins over `timeoutMs`: a card that says when it stops being
      // true should not disappear earlier for an unrelated reason.
      const lifetimeMs = card.expiresAt
        ? card.expiresAt - Date.now()
        : card.timeoutMs && card.timeoutMs > 0
          ? card.timeoutMs
          : null;
      if (lifetimeMs !== null) {
        const existing = timeouts.current.get(card.id);
        if (existing) clearTimeout(existing);
        timeouts.current.set(
          card.id,
          setTimeout(() => {
            // 'expire' is distinct from 'dismiss': nobody acted, the value
            // simply stopped being true. An extension treats the two
            // differently (a code that went unused is worth re-offering).
            report(card, 'expire');
            remove(card.id);
          }, Math.max(0, lifetimeMs))
        );
      }
    });

    const offDismiss = api?.onDismiss?.(({ id }: { id: string }) => remove(id));

    return () => {
      try { offNotify?.(); } catch { /* listener already gone */ }
      try { offDismiss?.(); } catch { /* listener already gone */ }
    };
    // The extension's own `ui.dismiss` is NOT reported back — it already knows.
  }, [remove, report]);

  // Only run the clock while a card is actually counting down.
  const hasCountdown = useMemo(() => cards.some((card) => !!card.expiresAt), [cards]);
  useEffect(() => {
    if (!hasCountdown) return;
    const interval = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(interval);
  }, [hasCountdown]);

  useEffect(() => {
    const timers = timeouts.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  if (cards.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-[240] flex flex-col gap-2 w-[340px] max-w-[calc(100vw-2rem)]">
      {cards.map((card) => (
        <div
          key={card.id}
          className="group bg-card border border-border rounded-lg shadow-2xl overflow-hidden animate-in slide-in-from-bottom-4 fade-in duration-200"
        >
          <div className="flex items-start gap-3 p-3">
            <div className="p-1.5 bg-primary/10 rounded-md shrink-0">
              <Puzzle className="h-4 w-4 text-primary" />
            </div>

            <div className="flex-1 min-w-0">
              <div className="flex items-baseline gap-2">
                <div className="text-sm font-medium truncate flex-1">{card.title}</div>
                {card.expiresAt && (
                  <div
                    className={`text-xs tabular-nums shrink-0 ${
                      card.expiresAt - now <= 60_000 ? 'text-destructive' : 'text-muted-foreground'
                    }`}
                  >
                    {formatExpiryCountdown(card.expiresAt, now)}
                  </div>
                )}
              </div>

              {card.body && (
                <div className="text-xs text-muted-foreground truncate">{card.body}</div>
              )}

              {card.fields && card.fields.length > 0 && (
                <div className="mt-2 flex flex-col gap-1.5">
                  {card.fields.map((field, index) => (
                    <div key={`${card.id}:${index}`} className="flex items-center gap-2 min-w-0">
                      <div className="flex-1 min-w-0">
                        {field.label && (
                          <div className="text-[11px] text-muted-foreground truncate">
                            {field.label}
                          </div>
                        )}
                        <div
                          className={
                            field.emphasis
                              ? 'font-mono text-lg font-semibold tracking-wider truncate'
                              : 'text-sm truncate'
                          }
                        >
                          {field.value}
                        </div>
                      </div>
                      {field.copyable && (
                        <CopyButton
                          value={field.value}
                          label={`Copy ${field.label || 'value'}`}
                          iconOnly
                          onCopied={() =>
                            report(card, 'copy', { fieldIndex: index, fieldLabel: field.label })
                          }
                        />
                      )}
                    </div>
                  ))}
                </div>
              )}

              {card.emailId && (
                <button
                  type="button"
                  onClick={() => {
                    report(card, 'open');
                    openEmailFromNotification(card.emailId!, card.accountId);
                  }}
                  className="mt-2 text-xs text-primary hover:underline"
                >
                  Open the message
                </button>
              )}
            </div>

            <Tooltip content="Dismiss" delayMs={40}>
              <button
                type="button"
                onClick={() => {
                  report(card, 'dismiss');
                  remove(card.id);
                }}
                aria-label="Dismiss"
                className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted/60 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </Tooltip>
          </div>
        </div>
      ))}
    </div>
  );
}
