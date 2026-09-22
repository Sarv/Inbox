import type { AvailablePanel } from '@sarvinbox/core';
import { useCallback, useEffect, useState } from 'react';


/**
 * The panels the app should currently offer.
 *
 * Re-read rather than cached across the session: enabling, disabling or
 * uninstalling an extension has to add or remove its panel straight away, and
 * a panel left on screen after its extension was disabled would keep asking
 * main for things it is no longer allowed to have.
 */
export function useExtensionPanels(): {
  panels: AvailablePanel[];
  refresh: () => Promise<void>;
} {
  const [panels, setPanels] = useState<AvailablePanel[]>([]);

  const refresh = useCallback(async () => {
    try {
      const result = await window.electronAPI.extensions.listPanels();
      setPanels(result.success && result.data ? result.data : []);
    } catch {
      // Panels are additive: if the list cannot be read the app simply shows
      // none, rather than failing the mail view it sits next to.
      setPanels([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { panels, refresh };
}

/** The panels for one surface, in manifest order. */
export function panelsForSurface(
  panels: AvailablePanel[],
  surface: 'sidebar' | 'modal'
): AvailablePanel[] {
  return panels.filter((available) => available.panel.surface === surface);
}
