import { useCallback, useRef } from 'react';

import { useConfirm, type ConfirmChoice, type ConfirmOptions } from '../components/ConfirmDialog';

import type { CloseAction } from './useDraftAutosave';

/** The Save / Discard / Keep editing question a composer asks on close. */
export const CLOSE_COMPOSE_PROMPT: ConfirmOptions = {
  title: 'Save this draft?',
  message: 'Save it to Drafts to finish later, or discard it.',
  confirmLabel: 'Save draft',
  secondaryLabel: 'Discard',
  cancelLabel: 'Keep editing',
  // Saving is the safe, default answer (Enter) — nothing is lost by it.
  destructive: false,
};

/** Which way a close ends: saved, discarded, or not closed at all. */
export type CloseOutcome = 'save' | 'discard' | 'stay';

/** Map the dialog's button to the close outcome. Escape / backdrop → stay. */
export function closeOutcomeOf(choice: ConfirmChoice): CloseOutcome {
  if (choice === 'confirm') return 'save';
  if (choice === 'secondary') return 'discard';
  return 'stay';
}

interface CloseComposePromptOptions {
  /** From useDraftAutosave — what closing this editor should do. */
  closeAction: () => CloseAction;
  /** Close and keep the work: the autosave's unmount save writes the draft. */
  onSave: () => void;
  /** Close and throw the work away (markDiscarded + discardDraft + close). */
  onDiscard: () => void;
}

/**
 * The composer's close button (X / Escape). Instead of discarding silently, it
 * asks whether to save the mail to Drafts or discard it — and only asks when
 * there is something to decide: an empty compose just goes away, and an opened
 * draft left untouched just closes with the draft as it was.
 *
 * `isAsking()` lets the composer's own keyboard shortcuts stand down while the
 * question is on screen (the dialog owns Escape / Enter then).
 */
export function useCloseComposePrompt({ closeAction, onSave, onDiscard }: CloseComposePromptOptions) {
  const { choose, confirmDialog } = useConfirm();
  const askingRef = useRef(false);
  const latest = useRef({ closeAction, onSave, onDiscard });
  latest.current = { closeAction, onSave, onDiscard };

  const requestClose = useCallback(async () => {
    if (askingRef.current) return;
    const action = latest.current.closeAction();
    if (action === 'discard') return latest.current.onDiscard();
    if (action === 'keep') return latest.current.onSave();

    askingRef.current = true;
    try {
      const outcome = closeOutcomeOf(await choose(CLOSE_COMPOSE_PROMPT));
      if (outcome === 'save') latest.current.onSave();
      else if (outcome === 'discard') latest.current.onDiscard();
    } finally {
      askingRef.current = false;
    }
  }, [choose]);

  const isAsking = useCallback(() => askingRef.current, []);

  return { requestClose, isAsking, closePromptDialog: confirmDialog };
}
