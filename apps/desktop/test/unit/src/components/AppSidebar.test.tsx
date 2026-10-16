// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppSidebar } from '../../../../src/components/AppSidebar';
import { cleanup, fire, render } from '../../../helpers/render';

afterEach(() => cleanup());

describe('AppSidebar', () => {
  // Regression: a screen listed in APP_SECTIONS but missing from the rail is
  // unreachable — the Calendar screen shipped that way once, built but with no
  // icon to open it.
  it('shows a Calendar entry that opens the calendar section', () => {
    const onSectionChange = vi.fn();
    const mounted = render(<AppSidebar activeSection="mail" onSectionChange={onSectionChange} />);
    const calendar = mounted.find('button[title="Calendar"]');
    expect(calendar).not.toBeNull();

    fire(calendar, 'click');
    expect(onSectionChange).toHaveBeenCalledWith('calendar');
  });

  // Regression: the active screen's entry must be highlighted.
  it('marks Calendar active when it is the current section', () => {
    const mounted = render(<AppSidebar activeSection="calendar" onSectionChange={vi.fn()} />);
    expect(mounted.find('button[title="Calendar"]')!.className).toContain('text-primary');
  });
});
