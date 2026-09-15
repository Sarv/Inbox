/**
 * AI Categorization IPC Handlers
 *
 * Bridges the renderer process to the AICategorizationService
 * running in the main process.
 */

import { createLogger } from '@sarvinbox/core';
import { ipcMain } from 'electron';

import { AICategorizationService } from '../services/ai-categorization-service';
import { attachOAuthBearer } from '../services/oauth-service';
import { getAICategorizationService, setAICategorizationService } from '../shared';
const logger = createLogger('ai-categorization-handlers');

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

      // Attach fresh-bearer resolver for oauth-backed providers — the
      // renderer can't send a function over IPC, so we wrap here.
      const wrapped = attachOAuthBearer(config);
      service.start(wrapped, mode, options).catch(err => {
        logger.error('[AI Categorization IPC] Background processing error:', err);
      });

      return { success: true };
    } catch (error) {
      logger.error('[AI Categorization IPC] Start error:', error);
      return { success: false, error: (error as Error).message };
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
      service.startAutoProcess(attachOAuthBearer(config), options);
      return { success: true };
    } catch (error) {
      logger.error('[AI Categorization IPC] startAuto error:', error);
      return { success: false, error: (error as Error).message };
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
