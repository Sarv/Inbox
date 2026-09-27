import { useCallback, useMemo, useState } from 'react';

/**
 * What a reader has typed into the Send-later menu but not yet scheduled.
 *
 * It lives OUTSIDE the menu on purpose. The menu unmounts the moment the
 * pointer goes down anywhere else, and holding the pick inside it meant a
 * mistaken click outside threw away a date and time that had just been entered
 * — reopening the menu offered the defaults again as if nothing had happened.
 * Held by the owner (a composer, an outbox row), it survives every open and
 * close for as long as that owner is on screen, and dies with it.
 */
export interface SendLaterDraft {
  /** Whether the custom date/time pane is open rather than the preset list. */
  showCustom: boolean;
  /** Local `YYYY-MM-DD`. Empty until a custom pick is started. */
  date: string;
  /** Local `HH:mm`. */
  time: string;
}

/** Nothing typed yet. A module constant, so an untouched key is referentially stable. */
export const EMPTY_SEND_LATER_DRAFT: SendLaterDraft = { showCustom: false, date: '', time: '' };

export interface SendLaterDraftStore {
  /** The draft for one owner; an unknown key reads as empty, never undefined. */
  draftFor: (key: string) => SendLaterDraft;
  /** Merge a change into one owner's draft, leaving every other key alone. */
  updateDraft: (key: string, patch: Partial<SendLaterDraft>) => void;
}

/**
 * Send-later drafts keyed by owner — one composer, one outbox row, one key.
 *
 * Keyed rather than single because two composers open at once must not share a
 * delivery time: picking Friday 6pm in one cannot show up in the other, and
 * scheduling one must not disturb what the other has half-entered.
 */
export function useSendLaterDrafts(): SendLaterDraftStore {
  const [drafts, setDrafts] = useState<Record<string, SendLaterDraft>>({});

  const draftFor = useCallback((key: string) => drafts[key] ?? EMPTY_SEND_LATER_DRAFT, [drafts]);

  const updateDraft = useCallback((key: string, patch: Partial<SendLaterDraft>) => {
    setDrafts((current) => ({
      ...current,
      [key]: { ...(current[key] ?? EMPTY_SEND_LATER_DRAFT), ...patch },
    }));
  }, []);

  return useMemo(() => ({ draftFor, updateDraft }), [draftFor, updateDraft]);
}

/** The single key a lone owner (one composer's toolbar) stores its draft under. */
const SOLE_OWNER = 'sole';

export interface SoleSendLaterDraft {
  draft: SendLaterDraft;
  update: (patch: Partial<SendLaterDraft>) => void;
}

/** The one-owner shape of {@link useSendLaterDrafts}, for a toolbar with a single menu. */
export function useSendLaterDraft(): SoleSendLaterDraft {
  const { draftFor, updateDraft } = useSendLaterDrafts();
  const update = useCallback(
    (patch: Partial<SendLaterDraft>) => updateDraft(SOLE_OWNER, patch),
    [updateDraft],
  );
  return useMemo(() => ({ draft: draftFor(SOLE_OWNER), update }), [draftFor, update]);
}
