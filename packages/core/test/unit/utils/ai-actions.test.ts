import { describe, expect, it } from 'vitest';

import {
  AI_ACTION_KINDS, aiActionKindForLoggedAction, aiActionShowsIcon, appendAiAction, describeAiAction,
  iconAiActions, MAX_AI_ACTIONS_PER_EMAIL, parseAiActions, removeLatestAiAction, type AiAction,
} from '../../../src/utils/ai-actions';

const at = (kind: AiAction['kind'], seconds: number, auto = true): AiAction => ({ kind, at: seconds, auto });

describe('the AI action record on an email', () => {
  // Breaks: one damaged or foreign value in emails.ai_actions throws while the
  // list draws, and the whole mailbox list fails to render.
  it.each([
    ['empty', ''], ['not JSON', '{oops'], ['not a list', '{"kind":"read"}'], ['null', null], ['a number', 7],
  ])('reads %s as no actions', (_name, raw) => {
    expect(parseAiActions(raw)).toEqual([]);
  });

  // Breaks: an entry the app never wrote (an unknown kind, a missing time)
  // reaches the tooltip as "undefined".
  it('keeps only well-formed entries', () => {
    const raw = JSON.stringify([
      { kind: 'read', at: 10, auto: true }, { kind: 'teleport', at: 11 }, { kind: 'star', at: 'soon' },
      { kind: 'archive', at: Number.NaN }, null, { kind: 'draft', at: 12.7, auto: 'yes' },
    ]);
    expect(parseAiActions(raw)).toEqual([at('read', 10), { kind: 'draft', at: 12, auto: false }]);
  });

  // Breaks: an email the AI keeps acting on grows its row without bound, and
  // every list read carries it.
  it(`keeps the newest ${MAX_AI_ACTIONS_PER_EMAIL} actions`, () => {
    let raw: string | null = null;
    for (let index = 0; index < MAX_AI_ACTIONS_PER_EMAIL + 3; index++) raw = appendAiAction(raw, at('read', index));
    const kept = parseAiActions(raw);
    expect(kept).toHaveLength(MAX_AI_ACTIONS_PER_EMAIL);
    expect(kept[0]!.at).toBe(3);
    expect(kept.at(-1)!.at).toBe(MAX_AI_ACTIONS_PER_EMAIL + 2);
  });

  // Breaks: Undo removes the wrong action (an older one, or one of another
  // kind), so the tooltip keeps describing what was undone.
  it('takes back the newest action of that kind only, and empties the column when none is left', () => {
    const raw = JSON.stringify([at('read', 1), at('star', 2), at('read', 3)]);
    expect(parseAiActions(removeLatestAiAction(raw, 'read'))).toEqual([at('read', 1), at('star', 2)]);
    expect(parseAiActions(removeLatestAiAction(raw, 'archive'))).toEqual([at('read', 1), at('star', 2), at('read', 3)]);
    expect(removeLatestAiAction(JSON.stringify([at('star', 2)]), 'star')).toBeNull();
    expect(removeLatestAiAction(null, 'star')).toBeNull();
  });

  // Breaks: categorizing, which the AI does to nearly every email, puts the AI
  // icon on every row so it stops meaning anything.
  it('gives every kind but a category change the list icon', () => {
    expect(AI_ACTION_KINDS.filter(kind => !aiActionShowsIcon(kind))).toEqual(['category']);
    expect(iconAiActions([at('category', 1), at('read', 2)])).toEqual([at('read', 2)]);
    expect(iconAiActions(undefined)).toEqual([]);
  });

  // Breaks: a kind with no wording shows a blank line in the tooltip.
  it('describes every kind', () => {
    for (const kind of AI_ACTION_KINDS) expect(describeAiAction(kind)).toMatch(/^[A-Z]/);
  });

  // Breaks: the background agent's actions get the wrong name, a drafted
  // reply reads as sent (or the reverse), or opening an email counts as an AI action.
  it.each([
    ['read', null, 'read'], ['star', null, 'star'], ['archive', null, 'archive'], ['spam', null, 'spam'],
    ['important', null, 'important'], ['delete', null, 'trash'], ['label_add', null, 'label'], ['label_remove', null, 'unlabel'],
    ['reply', null, 'draft'], ['reply', 'auto-sent', 'sent'], ['reply_all', 'auto-sent', 'sent'],
    ['open', null, null], ['ignore', null, null], ['mute', null, null],
  ])('names a logged %s (%s) as %s', (type, value, kind) => {
    expect(aiActionKindForLoggedAction(type, value)).toBe(kind);
  });
});
