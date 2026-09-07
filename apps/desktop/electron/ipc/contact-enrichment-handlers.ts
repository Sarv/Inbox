/**
 * Contact enrichment IPC handlers (main side).
 *
 * The scheduler lives in the main process — it knows which contacts are
 * eligible and paces the crawl. But the LLM call lives in the renderer
 * (that's where the AI provider config is). This bridge plumbs the
 * two together:
 *
 *   main  →  renderer   `contact-enrichment:run-batch`  (trigger work)
 *   renderer → main     `contact-enrichment:report-progress`   (per-contact result)
 *   renderer → main     `contact-enrichment:report-batch-done` (queue drained)
 *   renderer → main     `contact-enrichment:trigger-now`       (Enrich button, one-off)
 *
 * The scheduler awaits `report-batch-done` before starting the next
 * tick's batch, so we never have two batches in flight at once.
 */

import { ipcMain } from 'electron';
import {
  reportContactEnrichmentProgress,
  reportBatchDone,
  triggerEnrichmentNow,
} from '../services/contact-enrichment-scheduler';

export function registerContactEnrichmentHandlers(): void {
  ipcMain.handle(
    'contact-enrichment:report-progress',
    async (_event, payload: { contactId: string; ok: boolean; reason?: string | null }) => {
      reportContactEnrichmentProgress(payload);
      return { success: true };
    },
  );

  ipcMain.handle('contact-enrichment:report-batch-done', async () => {
    reportBatchDone();
    return { success: true };
  });

  /**
   * Trigger the crawler immediately — e.g. from a "Run enrichment now"
   * button in settings. Returns how many candidates were queued.
   */
  ipcMain.handle('contact-enrichment:trigger-now', async () => {
    try {
      const queued = await triggerEnrichmentNow();
      return { success: true, data: { queued } };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });
}
