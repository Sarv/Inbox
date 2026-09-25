// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';

import type { AppSection } from '../../../../src/components/app-sections';
import { useActiveSection } from '../../../../src/hooks/useActiveSection';
import { ACTIVE_SECTION_KEY } from '../../../../src/utils/active-section-storage';
import { render, fire } from '../../../helpers/render';

/**
 * A stand-in for App: shows the current section and can navigate, so a test can
 * unmount and remount it exactly the way a renderer reload does.
 */
function Probe({ goTo }: { goTo: AppSection }) {
  const [activeSection, setActiveSection] = useActiveSection();
  return (
    <div>
      <span data-testid="section">{activeSection}</span>
      <button type="button" aria-label="navigate" onClick={() => setActiveSection(goTo)} />
    </div>
  );
}

const sectionOf = (mounted: ReturnType<typeof render>) =>
  mounted.find('[data-testid="section"]')?.textContent;

describe('useActiveSection', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  // The regression: before this, App held `useState<AppSection>('mail')`, so a
  // reload (Cmd+R sits directly above the zoom items in the View menu) took a
  // user three tabs into Settings back to the inbox with no explanation.
  it('comes back on the same section after a remount', () => {
    const first = render(<Probe goTo="settings" />);
    fire(first.byLabel('navigate'), 'click');
    expect(sectionOf(first)).toBe('settings');
    first.unmount();

    const reloaded = render(<Probe goTo="settings" />);
    expect(sectionOf(reloaded)).toBe('settings');
    reloaded.unmount();
  });

  // A fresh session (a real cold launch) opens on the mailbox — the restore
  // must not turn "I closed the app in Settings" into "the app opens there".
  it('starts on the mailbox with an empty session', () => {
    const mounted = render(<Probe goTo="settings" />);
    expect(sectionOf(mounted)).toBe('mail');
    mounted.unmount();
  });

  // The value has to be there from the FIRST render, not written by an effect
  // after it: an effect-based restore paints the inbox for a frame first.
  it('reads the stored section during the initial render', () => {
    sessionStorage.setItem(ACTIVE_SECTION_KEY, 'contacts');
    const mounted = render(<Probe goTo="settings" />);
    expect(sectionOf(mounted)).toBe('contacts');
    mounted.unmount();
  });

  it('records every navigation, not just the first', () => {
    const toSecurity = render(<Probe goTo="security" />);
    fire(toSecurity.byLabel('navigate'), 'click');
    expect(sessionStorage.getItem(ACTIVE_SECTION_KEY)).toBe('security');
    toSecurity.unmount();

    const toAgent = render(<Probe goTo="agent" />);
    fire(toAgent.byLabel('navigate'), 'click');
    expect(sessionStorage.getItem(ACTIVE_SECTION_KEY)).toBe('agent');
    toAgent.unmount();
  });

  // Mounting alone must persist too, so a reload that happens before the user
  // navigates anywhere still records where they were.
  it('records the section on mount', () => {
    const mounted = render(<Probe goTo="settings" />);
    expect(sessionStorage.getItem(ACTIVE_SECTION_KEY)).toBe('mail');
    mounted.unmount();
  });

  // A section removed in a later build must not reach App's renderContent
  // switch, which falls through to `null` — an empty pane with no way out.
  it('ignores a stored section this build no longer has', () => {
    sessionStorage.setItem(ACTIVE_SECTION_KEY, 'webmail-classic');
    const mounted = render(<Probe goTo="settings" />);
    expect(sectionOf(mounted)).toBe('mail');
    mounted.unmount();
  });
});
