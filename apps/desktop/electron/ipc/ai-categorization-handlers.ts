/**
 * AI Categorization IPC Handlers
 *
 * Bridges the renderer process to the AICategorizationService
 * running in the main process.
 */

import { createLogger } from '@sarvinbox/core';
import { ipcMain } from 'electron';

import { AICategorizationService } from '../services/ai-categorization-service';
import { isAIEndpointRefusedError, prepareAIProviderConfig, reportAIEndpointRefused } from '../services/ai-provider-config';
import { getAICategorizationService, setAICategorizationService } from '../shared';
const logger = createLogger('ai-categorization-handlers');

/**
 * The handlers' answer to a failed start. A refused provider address is the
 * user's to fix, so it also goes to the Fix banner (and clears the renderer's
 * "processing" state, which waits on that channel) and is logged without a
 * stack; anything else is an unexpected failure.
 */
function startFailure(channel: string, error: unknown): { success: false; error: string } {
  if (isAIEndpointRefusedError(error)) {
    logger.warn(`[AI Categorization IPC] ${channel} refused: ${error.message}`);
    reportAIEndpointRefused(error);
  } else {
    logger.error(`[AI Categorization IPC] ${channel} error:`, error);
  }
  return { success: false, error: (error as Error).message };
}

export function registerAICategorizationHandlers(): void {
  // Ensure singleton service exists
  function ensureService(): AICategorizationService {
    let service = getAICategorizationService();
    if (!service) {
      service = new AICategorizationService();
      setAICategorizationService(service);
    }
    return service;
  }

  /**
   * Start AI categorization processing
   */
  ipcMain.handle('ai-categorization:start', async (_event, config, mode, options) => {
    try {
      const service = ensureService();
      const status = service.getStatus();
      if (status.running) {
        return { success: false, error: 'Already running' };
      }

      // Fill in the saved API key (the renderer never holds it) and attach the
      // fresh-bearer resolver for oauth-backed providers — main-only steps.
      const wrapped = await prepareAIProviderConfig(config);
      service.start(wrapped, mode, options).catch(err => {
        logger.error('[AI Categorization IPC] Background processing error:', err);
      });

      return { success: true };
    } catch (error) {
      return startFailure('Start', error);
    }
  });

  /**
   * Stop AI categorization processing
   */
  ipcMain.handle('ai-categorization:stop', async () => {
    try {
      const service = getAICategorizationService();
      if (service) {
        service.stop();
      }
      return { success: true };
    } catch (error) {
      logger.error('[AI Categorization IPC] Stop error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  /**
   * Get current processing status
   */
  ipcMain.handle('ai-categorization:status', async () => {
    try {
      const service = getAICategorizationService();
      if (!service) {
        return { success: true, data: { running: false, progress: null, autoProcessing: false } };
      }
      return { success: true, data: { ...service.getStatus(), autoProcessing: service.isAutoProcessing() } };
    } catch (error) {
      logger.error('[AI Categorization IPC] Status error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  /**
   * Start auto-processing timer (30s interval)
   */
  ipcMain.handle('ai-categorization:startAuto', async (_event, config, options) => {
    try {
      const service = ensureService();
      service.startAutoProcess(await prepareAIProviderConfig(config), options);
      return { success: true };
    } catch (error) {
      // The provider the loop was using is no longer the user's choice, and
      // the new one is refused: stop rather than keep sending to the old one.
      if (isAIEndpointRefusedError(error)) getAICategorizationService()?.stopAutoProcess();
      return startFailure('startAuto', error);
    }
  });

  /**
   * Stop auto-processing timer
   */
  ipcMain.handle('ai-categorization:stopAuto', async () => {
    try {
      const service = getAICategorizationService();
      if (service) {
        service.stopAutoProcess();
      }
      return { success: true };
    } catch (error) {
      logger.error('[AI Categorization IPC] stopAuto error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  logger.info('[IPC] AI categorization handlers registered');
}
