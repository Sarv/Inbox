// Pure decision functions — no DOM, no store, no IPC.
import { describe, expect, it } from 'vitest';

import {
  chatSourceFor,
  shouldShowProcessPrompt,
} from '../../../../../src/components/email-detail/chat-view-rules';

describe('chatSourceFor', () => {
  // Regression: the AI view used to fall back to the deterministic split when
  // the pipeline had produced nothing, so both views rendered IDENTICAL
  // bubbles. The reader then cannot tell AI output from raw mail, and a thread
  // the LLM never touched looks fully processed. AI view shows AI output only.
  it('renders nothing in the AI view when no message has been extracted', () => {
    expect(chatSourceFor(true, 0)).toBe('none');
  });

  // Regression: the counterpart — once the pipeline HAS produced turns, the AI
  // view must render those and not silently keep showing the thread split.
  it('renders the extracted turns in the AI view when there are some', () => {
    expect(chatSourceFor(true, 1)).toBe('ai');
    expect(chatSourceFor(true, 12)).toBe('ai');
  });

  // Regression: Standard is the view that always has content. If it ever
  // started depending on the AI pipeline, an unprocessed thread would have
  // nowhere left to show its mail at all.
  it('always renders the thread split in Standard, extracted or not', () => {
    expect(chatSourceFor(false, 0)).toBe('thread');
    expect(chatSourceFor(false, 5)).toBe('thread');
  });
});

describe('shouldShowProcessPrompt', () => {
  const base = {
    showAIView: true,
    extractionInFlight: false,
    conversationLoading: false,
    renderedCount: 0,
  };

  // Regression: with nothing extracted and nothing running, the AI view must
  // offer the extraction. Gating this on `conversationPartial` (as it was)
  // hid the prompt for threads the pipeline had never touched, which is
  // exactly the case that most needs it.
  it('offers the extraction when the AI view is empty and idle', () => {
    expect(shouldShowProcessPrompt(base)).toBe(true);
  });

  // Regression: inviting the user to start an extraction that is already
  // running produces duplicate LLM work and a confusing double spinner.
  it('stays hidden while an extraction is in flight', () => {
    expect(shouldShowProcessPrompt({ ...base, extractionInFlight: true })).toBe(false);
  });

  // Regression: the stored conversation loads asynchronously. Prompting during
  // that window makes an already-processed thread look unprocessed, and one
  // click throws away a good extraction to redo it.
  it('stays hidden while the stored conversation is still loading', () => {
    expect(shouldShowProcessPrompt({ ...base, conversationLoading: true })).toBe(false);
  });

  // Regression: the prompt replaces the bubbles, so showing it with messages
  // on screen would hide real content behind an invitation.
  it('stays hidden once anything is rendered', () => {
    expect(shouldShowProcessPrompt({ ...base, renderedCount: 1 })).toBe(false);
  });

  // Regression: Standard has no extraction to offer — the prompt there would
  // be an AI affordance on a view that is deliberately AI-free.
  it('never appears in Standard view', () => {
    expect(shouldShowProcessPrompt({ ...base, showAIView: false })).toBe(false);
    expect(
      shouldShowProcessPrompt({ ...base, showAIView: false, conversationLoading: true }),
    ).toBe(false);
  });
});
