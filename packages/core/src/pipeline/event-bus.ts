/**
 * EventBus - Pub/Sub system for pipeline events
 * Enables loose coupling between pipeline components
 */

import { logger } from '../utils/logger';

import type { PipelineEvent, EventHandler, Unsubscribe } from './types';

/**
 * Type-safe event bus for pipeline communication
 */
export class EventBus {
  private handlers: Map<string, Set<EventHandler>> = new Map();
  private allHandlers: Set<EventHandler> = new Set();
  // Circular buffer for event history (avoids O(n) shift() operations)
  private eventHistory: PipelineEvent[] = [];
  private historyWriteIndex: number = 0;
  private maxHistorySize: number = 1000;
  private paused: boolean = false;
  private pendingEvents: PipelineEvent[] = [];

  /**
   * Subscribe to a specific event type
   * @param eventType The event type to subscribe to (e.g., 'email:synced')
   * @param handler The handler function
   * @returns Unsubscribe function
   */
  on<T extends PipelineEvent>(
    eventType: T['type'],
    handler: EventHandler<T>
  ): Unsubscribe {
    if (!this.handlers.has(eventType)) {
      this.handlers.set(eventType, new Set());
    }
    this.handlers.get(eventType)!.add(handler as EventHandler);

    return () => {
      this.handlers.get(eventType)?.delete(handler as EventHandler);
    };
  }

  /**
   * Subscribe to a specific event type for one-time handling
   * @param eventType The event type to subscribe to
   * @param handler The handler function
   */
  once<T extends PipelineEvent>(
    eventType: T['type'],
    handler: EventHandler<T>
  ): Unsubscribe {
    const wrappedHandler: EventHandler<T> = (event) => {
      this.handlers.get(eventType)?.delete(wrappedHandler as EventHandler);
      return handler(event);
    };
    // Return the unsubscribe so callers can detach a `once` handler that never
    // fires — otherwise it stays attached to this long-lived bus forever.
    return this.on(eventType, wrappedHandler);
  }

  /**
   * Subscribe to all events
   * @param handler The handler function
   * @returns Unsubscribe function
   */
  onAll(handler: EventHandler): Unsubscribe {
    this.allHandlers.add(handler);
    return () => {
      this.allHandlers.delete(handler);
    };
  }

  /**
   * Emit an event to all subscribers
   * @param event The event to emit
   */
  emit(event: PipelineEvent): void {
    // Add timestamp if not present
    if (!('timestamp' in event)) {
      (event as any).timestamp = Date.now();
    }

    // Store in history
    this.addToHistory(event);

    // If paused, queue the event
    if (this.paused) {
      this.pendingEvents.push(event);
      return;
    }

    this.dispatchEvent(event);
  }

  /**
   * Emit an event and wait for all handlers to complete
   * @param event The event to emit
   */
  async emitAsync(event: PipelineEvent): Promise<void> {
    // Add timestamp if not present
    if (!('timestamp' in event)) {
      (event as any).timestamp = Date.now();
    }

    // Store in history
    this.addToHistory(event);

    // If paused, queue the event
    if (this.paused) {
      this.pendingEvents.push(event);
      return;
    }

    await this.dispatchEventAsync(event);
  }

  /**
   * Dispatch event to handlers (sync)
   */
  private dispatchEvent(event: PipelineEvent): void {
    // Notify specific handlers. Handlers may be async — catch rejected
    // promises too, otherwise they escape as process-level
    // unhandledRejection (the try/catch only covers synchronous throws).
    const handlers = this.handlers.get(event.type);
    if (handlers) {
      for (const handler of handlers) {
        try {
          Promise.resolve(handler(event)).catch((error) => {
            logger.error(`EventBus handler error for ${event.type}:`, error);
          });
        } catch (error) {
          logger.error(`EventBus handler error for ${event.type}:`, error);
        }
      }
    }

    // Notify all-event handlers
    for (const handler of this.allHandlers) {
      try {
        Promise.resolve(handler(event)).catch((error) => {
          logger.error(`EventBus global handler error:`, error);
        });
      } catch (error) {
        logger.error(`EventBus global handler error:`, error);
      }
    }
  }

  /**
   * Dispatch event to handlers (async)
   */
  private async dispatchEventAsync(event: PipelineEvent): Promise<void> {
    const promises: Promise<void>[] = [];

    // Notify specific handlers
    const handlers = this.handlers.get(event.type);
    if (handlers) {
      for (const handler of handlers) {
        promises.push(
          Promise.resolve(handler(event)).catch((error) => {
            logger.error(`EventBus handler error for ${event.type}:`, error);
          })
        );
      }
    }

    // Notify all-event handlers
    for (const handler of this.allHandlers) {
      promises.push(
        Promise.resolve(handler(event)).catch((error) => {
          logger.error(`EventBus global handler error:`, error);
        })
      );
    }

    await Promise.all(promises);
  }

  /**
   * Add event to history using circular buffer (O(1) instead of O(n) shift)
   */
  private addToHistory(event: PipelineEvent): void {
    if (this.eventHistory.length < this.maxHistorySize) {
      // Still filling the buffer
      this.eventHistory.push(event);
    } else {
      // Buffer is full, overwrite oldest entry
      this.eventHistory[this.historyWriteIndex] = event;
    }
    this.historyWriteIndex = (this.historyWriteIndex + 1) % this.maxHistorySize;
  }

  /**
   * Pause event emission (events will be queued)
   */
  pause(): void {
    this.paused = true;
  }

  /**
   * Resume event emission and dispatch queued events
   */
  resume(): void {
    this.paused = false;
    const events = [...this.pendingEvents];
    this.pendingEvents = [];
    for (const event of events) {
      this.dispatchEvent(event);
    }
  }

  /**
   * Get event history (reads from circular buffer in correct order)
   * @param eventType Optional filter by event type
   * @param limit Maximum events to return
   */
  getHistory(eventType?: string, limit: number = 100): PipelineEvent[] {
    // Reconstruct events in chronological order from circular buffer
    const len = this.eventHistory.length;
    if (len === 0) return [];

    let events: PipelineEvent[];
    if (len < this.maxHistorySize) {
      // Buffer not yet full, events are in order
      events = [...this.eventHistory];
    } else {
      // Buffer is full, need to read from writeIndex onwards (oldest first)
      events = [
        ...this.eventHistory.slice(this.historyWriteIndex),
        ...this.eventHistory.slice(0, this.historyWriteIndex),
      ];
    }

    if (eventType) {
      events = events.filter((e) => e.type === eventType);
    }
    return events.slice(-limit);
  }

  /**
   * Clear all handlers
   */
  clear(): void {
    this.handlers.clear();
    this.allHandlers.clear();
  }

  /**
   * Clear event history
   */
  clearHistory(): void {
    this.eventHistory = [];
    this.historyWriteIndex = 0;
  }

  /**
   * Get subscriber count for an event type
   */
  getSubscriberCount(eventType?: string): number {
    if (eventType) {
      return this.handlers.get(eventType)?.size ?? 0;
    }
    let count = this.allHandlers.size;
    for (const handlers of this.handlers.values()) {
      count += handlers.size;
    }
    return count;
  }

  /**
   * Check if there are subscribers for an event type
   */
  hasSubscribers(eventType: string): boolean {
    return (this.handlers.get(eventType)?.size ?? 0) > 0 || this.allHandlers.size > 0;
  }
}

// Singleton instance
let globalEventBus: EventBus | null = null;

/**
 * Get the global event bus instance
 */
export function getEventBus(): EventBus {
  if (!globalEventBus) {
    globalEventBus = new EventBus();
  }
  return globalEventBus;
}

/**
 * Create a new event bus instance (for testing or isolation)
 */
export function createEventBus(): EventBus {
  return new EventBus();
}

// Helper functions for creating events
export const createEvent = {
  emailSynced: (email: any, folder: string, isNew: boolean): PipelineEvent => ({
    type: 'email:synced',
    email,
    folder,
    isNew,
    timestamp: Date.now(),
  }),

  // A message's body finished fetching (bodies are fetched lazily AFTER the
  // email:synced event, so new mail is body-less at sync time). The pipeline
  // listens for this to categorize the moment the body lands, instead of waiting
  // for the 30s poll — near-instant for active AND background accounts.
  emailBodyReady: (emailId: string): PipelineEvent => ({
    type: 'email:body-ready',
    emailId,
    timestamp: Date.now(),
  }),

  emailProcessed: (emailId: string, workflowId: string, result: any): PipelineEvent => ({
    type: 'email:processed',
    emailId,
    workflowId,
    result,
    timestamp: Date.now(),
  }),

  syncStarted: (folders: string[], fullSync: boolean): PipelineEvent => ({
    type: 'sync:started',
    folders,
    fullSync,
    timestamp: Date.now(),
  }),

  syncProgress: (
    currentFolder: string,
    foldersCompleted: number,
    totalFolders: number,
    messagesProcessed: number,
    totalMessages: number
  ): PipelineEvent => ({
    type: 'sync:progress',
    currentFolder,
    foldersCompleted,
    totalFolders,
    messagesProcessed,
    totalMessages,
    percentComplete: totalFolders > 0 ? Math.round((foldersCompleted / totalFolders) * 100) : 0,
    timestamp: Date.now(),
  }),

  syncCompleted: (stats: any): PipelineEvent => ({
    type: 'sync:completed',
    stats,
    timestamp: Date.now(),
  }),

  syncError: (error: Error, folder?: string, recoverable: boolean = false): PipelineEvent => ({
    type: 'sync:error',
    error,
    folder,
    recoverable,
    timestamp: Date.now(),
  }),

  workflowStarted: (workflowId: string, emailId: string): PipelineEvent => ({
    type: 'workflow:started',
    workflowId,
    emailId,
    timestamp: Date.now(),
  }),

  workflowCompleted: (workflowId: string, emailId: string, result: any): PipelineEvent => ({
    type: 'workflow:completed',
    workflowId,
    emailId,
    result,
    timestamp: Date.now(),
  }),

  workflowError: (workflowId: string, emailId: string, error: Error): PipelineEvent => ({
    type: 'workflow:error',
    workflowId,
    emailId,
    error,
    timestamp: Date.now(),
  }),

  taskScheduled: (taskId: string, taskType: string, scheduledAt: number): PipelineEvent => ({
    type: 'task:scheduled',
    taskId,
    taskType,
    scheduledAt,
    timestamp: Date.now(),
  }),

  taskCompleted: (taskId: string, taskType: string, result: any): PipelineEvent => ({
    type: 'task:completed',
    taskId,
    taskType,
    result,
    timestamp: Date.now(),
  }),

  taskFailed: (taskId: string, taskType: string, error: Error, retryCount: number): PipelineEvent => ({
    type: 'task:failed',
    taskId,
    taskType,
    error,
    retryCount,
    timestamp: Date.now(),
  }),
};
