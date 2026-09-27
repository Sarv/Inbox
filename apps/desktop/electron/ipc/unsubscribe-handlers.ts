/**
 * Unsubscribe IPC — one handler, one deliberate shape.
 *
 * The renderer sends an EMAIL ID and the ROUTE the reader chose. It never sends
 * a URL. The main process re-reads that message's own stored headers and
 * resolves the route against them (`resolveUnsubscribeAction`), so the only
 * address this process can ever act on is one the sender published in the
 * message. Accepting a URL over IPC instead would turn a click in a crafted
 * email into an unauthenticated POST, from the reader's network, to anywhere.
 *
 * The three routes and what each costs the reader:
 *   * `one-click` — RFC 8058. A POST from here, no browser, nothing shown to
 *     the sender beyond the request itself.
 *   * `page`      — the sender's own form, opened in the default browser
 *     through the app's existing scheme allow-list.
 *   * `mailto`    — an ordinary message through the outbox, so it is durable,
 *     retried and visible in Sent exactly like any other mail.
 */
import { createLogger, resolveUnsubscribeAction, type UnsubscribeRoute } from '@sarvinbox/core';
import { ipcMain, shell } from 'electron';

import { getOutboxQueue, getOutboxQueueForAccount, notifyOutboxChanged } from '../services/outbox-service';
import { postOneClick } from '../services/unsubscribe-service';
import { getCurrentAccountId, getStorageFor, requireStorage } from '../shared';

const logger = createLogger('unsubscribe-handlers');

export interface UnsubscribeRunResult {
  success: boolean;
  /** Which route actually ran. Absent on failure. */
  route?: UnsubscribeRoute;
  /** True when the reader still has something to do (a browser form is open). */
  needsBrowser?: boolean;
  error?: string;
}

const ROUTES: ReadonlySet<string> = new Set<UnsubscribeRoute>(['one-click', 'page', 'mailto']);

export function registerUnsubscribeHandlers(): void {
  ipcMain.handle(
    'unsubscribe:run',
    async (_event, emailId: string, route: UnsubscribeRoute, accountId?: string): Promise<UnsubscribeRunResult> => {
      if (typeof emailId !== 'string' || !emailId || !ROUTES.has(route)) {
        return { success: false, error: 'Unsupported unsubscribe request' };
      }
      try {
        // The account that OWNS the message, so an All-Inboxes mail from a
        // non-active account is read from its own DB rather than missing.
        const storage = (accountId ? getStorageFor(accountId) : null) ?? requireStorage();
        const email = await storage.getEmail(emailId);
        if (!email) return { success: false, error: 'Email not found' };

        const action = resolveUnsubscribeAction(email.listUnsubscribe, email.listUnsubscribePost, route);
        if (!action) {
          // Not an error the reader caused: the message does not offer this
          // route (most often one-click asked for where no RFC 8058 header
          // exists). Refused rather than downgraded, because a route silently
          // swapped for another is a different promise than the one shown.
          logger.warn(`[Unsubscribe] ${emailId} does not offer route "${route}"`);
          return { success: false, error: 'This message does not offer that way to unsubscribe' };
        }

        if (action.kind === 'one-click') {
          const result = await postOneClick(action.url, action.body);
          if (!result.ok) return { success: false, error: result.error ?? 'The unsubscribe request failed' };
          logger.info(`[Unsubscribe] one-click accepted (${result.status}) for ${emailId}`);
          return { success: true, route };
        }

        if (action.kind === 'page') {
          await shell.openExternal(action.url);
          logger.info(`[Unsubscribe] opened the sender's page for ${emailId}`);
          return { success: true, route, needsBrowser: true };
        }

        const queue =
          accountId && accountId !== getCurrentAccountId()
            ? getOutboxQueueForAccount(accountId)
            : getOutboxQueue();
        await queue.enqueueAndSend({
          to: [action.mail.to],
          subject: action.mail.subject,
          body: action.mail.body,
          accountId,
        });
        notifyOutboxChanged();
        logger.info(`[Unsubscribe] queued a mailto unsubscribe for ${emailId}`);
        return { success: true, route };
      } catch (error) {
        logger.error('[Unsubscribe] run failed:', error);
        return { success: false, error: (error as Error).message };
      }
    },
  );
}
