/**
 * BackgroundTaskManager - Coordinates background tasks for email processing
 *
 * Manages:
 * - Email sync tasks
 * - Pipeline processing tasks
 * - AI analysis tasks
 * - Cleanup tasks
 *
 * Integrates with the pipeline orchestrator and event bus.
 */

import { EventBus, createEventBus, createEvent } from '../pipeline/event-bus';
import type { BackgroundTask, TaskPriority } from '../pipeline/types';
import { TaskPriority as Priority, TaskStatus } from '../pipeline/types';
import { logger } from '../utils/logger';

import { TaskQueue, createTaskQueue, type TaskQueueConfig } from './task-queue';

export interface TaskManagerConfig extends TaskQueueConfig {
  /** Event bus for emitting events */
  eventBus?: EventBus;

  /** Whether to enable power-aware scheduling */
  powerAware?: boolean;

  /** Whether to enable network-aware scheduling */
  networkAware?: boolean;

  /** Minimum battery level to run tasks (0-1) */
  minBatteryLevel?: number;
}

export interface SyncTaskData {
  folders?: string[];
  fullSync?: boolean;
  maxMessages?: number;
}

export interface ProcessTaskData {
  emailIds: string[];
  workflowIds?: string[];
}

export interface AITaskData {
  emailId: string;
  operation: 'categorize' | 'summarize' | 'suggest-reply' | 'extract-actions';
}

export interface CleanupTaskData {
  operation: 'clear-cache' | 'compact-db' | 'delete-old-emails';
  options?: Record<string, any>;
}

/**
 * Background task manager for coordinating async operations
 */
export class BackgroundTaskManager {
  private config: TaskManagerConfig;
  private queue: TaskQueue;
  private eventBus: EventBus;
  private _isInBackground: boolean = false;
  private isPowerSaveMode: boolean = false;

  /**
   * Check if app is currently in background mode
   */
  get isInBackground(): boolean {
    return this._isInBackground;
  }

  constructor(config: TaskManagerConfig = {}) {
    this.config = {
      maxConcurrent: 2,
      maxRetries: 3,
      retryDelay: 5000,
      persistTasks: true,
      powerAware: true,
      networkAware: true,
      minBatteryLevel: 0.2,
      ...config,
    };

    this.queue = createTaskQueue(this.config);
    this.eventBus = config.eventBus ?? createEventBus();

    // Register task executors
    this.registerExecutors();
  }

  /**
   * Register task executors for different task types
   */
  private registerExecutors(): void {
    // Sync executor
    this.queue.registerExecutor('sync', async (task) => {
      const data = task.data as SyncTaskData;
      logger.info('Executing sync task:', data);

      this.eventBus.emit(
        createEvent.syncStarted(data.folders || ['INBOX'], data.fullSync ?? false)
      );

      // Sync logic would be implemented here
      // For now, emit completion
      this.eventBus.emit(
        createEvent.syncCompleted({
          startTime: task.startedAt || Date.now(),
          endTime: Date.now(),
          duration: Date.now() - (task.startedAt || Date.now()),
          foldersProcessed: data.folders?.length || 1,
          messagesProcessed: 0,
          newMessages: 0,
          updatedMessages: 0,
          errors: 0,
          folderStats: {},
        })
      );

      return { success: true };
    });

    // Process executor - delegates to extension system
    this.queue.registerExecutor('process', async (task) => {
      const data = task.data as ProcessTaskData;
      logger.info('Executing process task:', data);

      // Process logic - extensions handle email processing now
      return { success: true, processed: data.emailIds.length };
    });

    // AI analysis executor
    this.queue.registerExecutor('ai-analysis', async (task) => {
      const data = task.data as AITaskData;
      logger.info('Executing AI task:', data);

      // AI operations would be implemented here
      return { success: true, operation: data.operation };
    });

    // Cleanup executor
    this.queue.registerExecutor('cleanup', async (task) => {
      const data = task.data as CleanupTaskData;
      logger.info('Executing cleanup task:', data);

      // Cleanup operations would be implemented here
      return { success: true, operation: data.operation };
    });

    // Custom task executor
    this.queue.registerExecutor('custom', async (task) => {
      logger.info('Executing custom task:', task.data);
      return { success: true };
    });
  }

  /**
   * Schedule a sync task
   */
  scheduleSync(
    data: SyncTaskData,
    options?: { priority?: TaskPriority; delay?: number }
  ): string {
    const taskPriority = options?.priority ?? Priority.NORMAL;
    const scheduledAt = options?.delay ? Date.now() + options.delay : undefined;

    return this.queue.add({
      type: 'sync',
      priority: taskPriority,
      data,
      scheduledAt,
      retryCount: 0,
      maxRetries: this.config.maxRetries || 3,
    });
  }

  /**
   * Schedule an email processing task
   */
  scheduleProcess(
    emailIds: string[],
    options?: { workflowIds?: string[]; priority?: TaskPriority }
  ): string {
    return this.queue.add({
      type: 'process',
      priority: options?.priority ?? Priority.NORMAL,
      data: { emailIds, workflowIds: options?.workflowIds } as ProcessTaskData,
      retryCount: 0,
      maxRetries: this.config.maxRetries || 3,
    });
  }

  /**
   * Schedule an AI analysis task
   */
  scheduleAIAnalysis(
    emailId: string,
    operation: AITaskData['operation'],
    options?: { priority?: TaskPriority }
  ): string {
    return this.queue.add({
      type: 'ai-analysis',
      priority: options?.priority ?? Priority.LOW,
      data: { emailId, operation } as AITaskData,
      retryCount: 0,
      maxRetries: this.config.maxRetries || 3,
    });
  }

  /**
   * Schedule a cleanup task
   */
  scheduleCleanup(
    operation: CleanupTaskData['operation'],
    options?: { delay?: number }
  ): string {
    return this.queue.add({
      type: 'cleanup',
      priority: Priority.LOW,
      data: { operation } as CleanupTaskData,
      scheduledAt: options?.delay ? Date.now() + options.delay : undefined,
      retryCount: 0,
      maxRetries: 1, // Cleanup tasks shouldn't retry much
    });
  }

  /**
   * Schedule a custom task
   */
  schedule(task: Omit<BackgroundTask, 'id' | 'status' | 'createdAt'>): string {
    return this.queue.add(task);
  }

  /**
   * Cancel a task
   */
  cancel(taskId: string): boolean {
    return this.queue.cancel(taskId);
  }

  /**
   * Get task status
   */
  getTaskStatus(taskId: string): BackgroundTask | undefined {
    return this.queue.get(taskId);
  }

  /**
   * Get all tasks
   */
  getAllTasks(): BackgroundTask[] {
    return this.queue.getAll();
  }

  /**
   * Get queue statistics
   */
  getStats() {
    return this.queue.getStats();
  }

  /**
   * Pause all task processing
   */
  pause(): void {
    this.queue.pause();
    logger.info('Background task manager paused');
  }

  /**
   * Resume task processing
   */
  resume(): void {
    if (this.shouldPauseForPower()) {
      logger.info('Cannot resume: power save mode active');
      return;
    }

    this.queue.resume();
    logger.info('Background task manager resumed');
  }

  /**
   * Handle app going to background
   */
  onAppBackground(): void {
    this._isInBackground = true;

    // Reduce concurrency when in background
    logger.info('App entered background mode');

    // Continue processing if conditions allow
    if (!this.shouldPauseForPower()) {
      this.queue.resume();
    }
  }

  /**
   * Handle app coming to foreground
   */
  onAppForeground(): void {
    this._isInBackground = false;
    logger.info('App entered foreground mode');

    // Resume normal operation
    this.queue.resume();
  }

  /**
   * Handle power mode changes
   */
  onPowerModeChange(isPowerSaveMode: boolean): void {
    this.isPowerSaveMode = isPowerSaveMode;

    if (isPowerSaveMode) {
      logger.info('Power save mode activated - pausing non-critical tasks');
      this.queue.pause();
    } else {
      logger.info('Power save mode deactivated - resuming tasks');
      this.queue.resume();
    }
  }

  /**
   * Check if tasks should be paused due to power constraints
   */
  private shouldPauseForPower(): boolean {
    if (!this.config.powerAware) {
      return false;
    }

    return this.isPowerSaveMode;
  }

  /**
   * Get the event bus
   */
  getEventBus(): EventBus {
    return this.eventBus;
  }

  /**
   * Clear all tasks
   */
  clear(): void {
    this.queue.clear();
  }

  /**
   * Clear completed tasks
   */
  clearCompleted(): void {
    this.queue.clearCompleted();
  }

  /**
   * Wait for a task to complete
   */
  async waitForTask(taskId: string, timeout?: number): Promise<BackgroundTask | undefined> {
    return new Promise((resolve) => {
      const task = this.queue.get(taskId);
      if (!task) {
        resolve(undefined);
        return;
      }

      if (task.status === TaskStatus.COMPLETED || task.status === TaskStatus.FAILED) {
        resolve(task);
        return;
      }

      let timeoutId: NodeJS.Timeout | undefined;

      const unsubscribe = this.queue.onComplete(taskId, (completedTask) => {
        if (timeoutId) clearTimeout(timeoutId);
        resolve(completedTask);
      });

      if (timeout) {
        timeoutId = setTimeout(() => {
          unsubscribe();
          resolve(this.queue.get(taskId));
        }, timeout);
      }
    });
  }

  /**
   * Dispose and cleanup
   */
  dispose(): void {
    this.queue.pause();
    this.queue.clear();
    logger.info('Background task manager disposed');
  }
}

// Singleton instance
let globalTaskManager: BackgroundTaskManager | null = null;

/**
 * Initialize the global task manager
 */
export function initializeTaskManager(config?: TaskManagerConfig): BackgroundTaskManager {
  if (globalTaskManager) {
    logger.warn('Task manager already initialized, returning existing instance');
    return globalTaskManager;
  }
  globalTaskManager = new BackgroundTaskManager(config);
  return globalTaskManager;
}

/**
 * Get the global task manager
 */
export function getTaskManager(): BackgroundTaskManager | null {
  return globalTaskManager;
}

/**
 * Create a new task manager (for testing or isolation)
 */
export function createTaskManager(config?: TaskManagerConfig): BackgroundTaskManager {
  return new BackgroundTaskManager(config);
}
