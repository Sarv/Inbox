/**
 * Extension IPC Handlers
 *
 * Handles extension management and extension function calls.
 */

import type { EmailSummarizationExports, AICategorizationExports } from '@sarvinbox/core';
import { createLogger } from '@sarvinbox/core';
import { ipcMain, dialog } from 'electron';

import { getExtensionManager, getMainWindow } from '../shared';

const logger = createLogger('extension-handlers');

export function registerExtensionHandlers(): void {
  // ========== Extension Function Handlers ==========

  /**
   * Call extension's summarizeThread function
   */
  ipcMain.handle('extension:summarizeThread', async (_event, emails: any[]) => {
    try {
      const extensionManager = getExtensionManager();
      if (!extensionManager) {
        throw new Error('Extension manager not initialized');
      }

      const exports = extensionManager.getExtensionExports<EmailSummarizationExports>('email-summarization');
      if (!exports || typeof exports.summarizeThread !== 'function') {
        throw new Error('Email summarization extension not available');
      }

      const result = await exports.summarizeThread(emails);
      return { success: true, data: result };
    } catch (error) {
      logger.error('[Extension] summarizeThread error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  /**
   * Call extension's summarizeEmail function
   */
  ipcMain.handle('extension:summarizeEmail', async (_event, email: any) => {
    try {
      const extensionManager = getExtensionManager();
      if (!extensionManager) {
        throw new Error('Extension manager not initialized');
      }

      const exports = extensionManager.getExtensionExports<EmailSummarizationExports>('email-summarization');
      if (!exports || typeof exports.summarizeEmail !== 'function') {
        throw new Error('Email summarization extension not available');
      }

      const result = await exports.summarizeEmail(email);
      return { success: true, data: result };
    } catch (error) {
      logger.error('[Extension] summarizeEmail error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  /**
   * Call extension's categorizeEmails function
   */
  ipcMain.handle('extension:categorizeEmails', async (_event, emails: any[], userEmail: string) => {
    try {
      const extensionManager = getExtensionManager();
      if (!extensionManager) {
        throw new Error('Extension manager not initialized');
      }

      const exports = extensionManager.getExtensionExports<AICategorizationExports>('ai-categorization');
      if (!exports || typeof exports.categorizeEmails !== 'function') {
        throw new Error('AI categorization extension not available');
      }

      const result = await exports.categorizeEmails(emails, userEmail);
      return { success: true, data: result };
    } catch (error) {
      logger.error('[Extension] categorizeEmails error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  /**
   * Check if an extension is available and active
   */
  ipcMain.handle('extension:isAvailable', async (_event, extensionId: string) => {
    try {
      const extensionManager = getExtensionManager();
      if (!extensionManager) {
        return { success: true, data: false };
      }
      const host = extensionManager.getHost();
      return { success: true, data: host.isActive(extensionId) };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  // ========== Extension Management Handlers ==========

  /**
   * List all installed extensions
   */
  ipcMain.handle('extensions:list', async () => {
    try {
      const extensionManager = getExtensionManager();
      if (!extensionManager) {
        return { success: true, data: [] };
      }
      const extensions = extensionManager.getInstalledExtensions();
      return { success: true, data: extensions };
    } catch (error) {
      logger.error('[Extensions] List error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  /**
   * Get extension info by ID
   */
  ipcMain.handle('extensions:getInfo', async (_event, extensionId: string) => {
    try {
      const extensionManager = getExtensionManager();
      if (!extensionManager) {
        return { success: false, error: 'Extension manager not initialized' };
      }

      const info = extensionManager.getExtensionInfo(extensionId);
      const registry = extensionManager.getRegistry();
      const loaded = registry.getLoaded(extensionId);

      if (!info && !loaded) {
        return { success: false, error: `Extension '${extensionId}' not found` };
      }

      const result = {
        manifest: loaded?.manifest || null,
        state: info?.state || 'unloaded',
        enabled: info?.enabled ?? false,
        path: loaded?.path || info?.path || '',
        error: info?.error,
        activatedAt: info?.activatedAt,
        workflowIds: info?.workflowIds || [],
      };

      return { success: true, data: result };
    } catch (error) {
      logger.error('[Extensions] Get info error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  /**
   * Enable an extension
   */
  ipcMain.handle('extensions:enable', async (_event, extensionId: string) => {
    try {
      const extensionManager = getExtensionManager();
      if (!extensionManager) {
        return { success: false, error: 'Extension manager not initialized' };
      }
      await extensionManager.enableExtension(extensionId);
      return { success: true };
    } catch (error) {
      logger.error('[Extensions] Enable error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  /**
   * Disable an extension
   */
  ipcMain.handle('extensions:disable', async (_event, extensionId: string) => {
    try {
      const extensionManager = getExtensionManager();
      if (!extensionManager) {
        return { success: false, error: 'Extension manager not initialized' };
      }
      await extensionManager.disableExtension(extensionId);
      return { success: true };
    } catch (error) {
      logger.error('[Extensions] Disable error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  /**
   * Uninstall an extension
   */
  ipcMain.handle('extensions:uninstall', async (_event, extensionId: string) => {
    try {
      const extensionManager = getExtensionManager();
      if (!extensionManager) {
        return { success: false, error: 'Extension manager not initialized' };
      }
      await extensionManager.uninstallExtension(extensionId);
      return { success: true };
    } catch (error) {
      logger.error('[Extensions] Uninstall error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  /**
   * Open dialog to select and install an extension
   */
  ipcMain.handle('extensions:selectAndInstall', async () => {
    try {
      const extensionManager = getExtensionManager();
      const mainWindow = getMainWindow();

      if (!extensionManager) {
        return { success: false, error: 'Extension manager not initialized' };
      }

      const result = await dialog.showOpenDialog(mainWindow!, {
        properties: ['openDirectory'],
        title: 'Select Extension Folder',
        message: 'Select a folder containing a Sarv Inbox extension',
      });

      if (result.canceled || result.filePaths.length === 0) {
        return { success: false, error: 'No folder selected' };
      }

      const extensionPath = result.filePaths[0];
      const installed = await extensionManager.installExtension(extensionPath);

      return { success: true, data: installed };
    } catch (error) {
      logger.error('[Extensions] Install error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  /**
   * Get active workflow IDs
   */
  ipcMain.handle('extensions:getWorkflows', async () => {
    try {
      const extensionManager = getExtensionManager();
      if (!extensionManager) {
        return { success: true, data: [] };
      }
      const workflowIds = extensionManager.getActiveWorkflowIds();
      return { success: true, data: workflowIds };
    } catch (error) {
      logger.error('[Extensions] Get workflows error:', error);
      return { success: false, error: (error as Error).message };
    }
  });
}
