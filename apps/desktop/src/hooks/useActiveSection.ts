import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';

import type { AppSection } from '../components/app-sections';
import { persistActiveSection, restoreActiveSection } from '../utils/active-section-storage';

/**
 * `useState` for the current app section that survives a renderer reload.
 *
 * A drop-in replacement for the `useState<AppSection>('mail')` App.tsx used to
 * hold: same tuple, same setter. The persistence is an effect on the value
 * rather than a wrapped setter on purpose — App changes the section from about
 * a dozen places (sidebar, keyboard, notification click, banners' "Fix"), and a
 * single point that mirrors whatever the state ended up as cannot be bypassed
 * by the next one added.
 *
 * See utils/active-section-storage.ts for why this is sessionStorage.
 */
export function useActiveSection(): [AppSection, Dispatch<SetStateAction<AppSection>>] {
  // Lazy initialiser: read once, on mount, before the first paint — not on
  // every render, and never as a post-mount effect that would flash the inbox.
  const [activeSection, setActiveSection] = useState<AppSection>(restoreActiveSection);

  useEffect(() => {
    persistActiveSection(activeSection);
  }, [activeSection]);

  return [activeSection, setActiveSection];
}
