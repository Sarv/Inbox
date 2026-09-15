/**
 * Extension AI Backend
 *
 * Provides AI capabilities to extensions by routing requests
 * through IPC to the renderer process which has the AI service.
 */

import type { ExtensionAIBackend } from '@sarvinbox/core';
import { ipcMain } from 'electron';

import { getMainWindow } from '../shared';

/**
 * Create AI backend for extensions that calls renderer via IPC
 */
export function createExtensionAIBackend(): ExtensionAIBackend {
  return {
    async categorize(_email) {
      // Extensions use their own categorization logic
      return { category: 'other', categories: [], confidence: 0 };
    },
    async generateReplySuggestions(_email) {
      return [];
    },
    async summarize(_content) {
      return '';
    },
    async extractActionItems(_email) {
      return [];
    },
    isAvailable() {
      return getMainWindow() !== null;
    },
    async complete(options: { systemPrompt: string; userPrompt: string; maxTokens?: number }) {
      const mainWindow = getMainWindow();
      // Send IPC to renderer to make AI call
      if (!mainWindow) {
        throw new Error('Main window not available for AI calls');
      }

      return new Promise((resolve, reject) => {
        const requestId = `ai-complete-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

        const handler = (_event: any, response: { requestId: string; success: boolean; result?: string; error?: string }) => {
          if (response.requestId === requestId) {
            clearTimeout(timeoutHandle);
            ipcMain.removeListener('ai:complete-response', handler);
            // typeof check: an empty-string completion is a legitimate
            // success, not a failure.
            if (response.success && typeof response.result === 'string') {
              resolve(response.result);
            } else {
              reject(new Error(response.error || 'AI completion failed'));
            }
          }
        };

        ipcMain.on('ai:complete-response', handler);
        mainWindow.webContents.send('ai:complete-request', {
          requestId,
          systemPrompt: options.systemPrompt,
          userPrompt: options.userPrompt,
          maxTokens: options.maxTokens,
        });

        // Timeout after 60 seconds (cleared on response so it doesn't
        // retain the closure / fire after shutdown)
        const timeoutHandle = setTimeout(() => {
          ipcMain.removeListener('ai:complete-response', handler);
          reject(new Error('AI completion timed out'));
        }, 60000);
      });
    },
  };
}
