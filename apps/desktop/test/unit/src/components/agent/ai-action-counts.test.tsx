// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';

import { aiActionCountRows, AiActionCountsView, type AiActionCountsData } from '../../../../../src/components/agent/AiActionCounts';
import { render, type Mounted } from '../../../../helpers/render';

const data = (byKind: Partial<AiActionCountsData['byKind']>, emails = 0, categorized = 0): AiActionCountsData =>
  ({ byKind: { read: 0, draft: 0, archive: 0, ...byKind } as AiActionCountsData['byKind'], emails, categorized });

let mounted: Mounted | undefined;
afterEach(() => { mounted?.unmount(); mounted = undefined; });

describe('the AI section: what the AI did', () => {
  // Breaks: the counts list kinds the AI never did, or bury the most frequent.
  it('lists the kinds it did, most frequent first', () => {
    expect(aiActionCountRows(data({ read: 3, draft: 7, archive: 3 }))).toEqual([
      { kind: 'draft', count: 7 }, { kind: 'read', count: 3 }, { kind: 'archive', count: 3 },
    ]);
  });

  // Breaks: the section shows the wrong totals, or hides categorizing (which
  // has no list icon) altogether.
  it('shows the total, the emails touched and the emails categorized', () => {
    mounted = render(<AiActionCountsView data={data({ read: 3, draft: 1 }, 2, 140)} />);
    const text = mounted.container.textContent ?? '';
    expect(text).toContain('4 actions on 2 emails');
    expect(text).toContain('Marked as read3');
    expect(text).toContain('Drafted a reply1');
    expect(text).toContain('Categorized 140 emails');
  });

  // Breaks: an account with no AI actions yet shows an empty box with no explanation.
  it('explains the icon before the AI has done anything', () => {
    mounted = render(<AiActionCountsView data={data({}, 0, 0)} />);
    expect(mounted.container.textContent).toContain('The AI has not changed any email yet');
  });
});
