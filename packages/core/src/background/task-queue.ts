/**
 * TaskQueue - Priority-based task queue with persistence support
 *
 * Manages background tasks with:
 * - Priority-based ordering
 * - Retry logic
 * - Persistence (optional)
 * - Pause/resume functionality
 */

import type { BackgroundTask, TaskStatus } from '../pipeline/types';
import { TaskStatus as Status } from '../pipeline/types';
import { logger } from '../utils/logger';

export interface TaskQueueConfig {
  /** Maximum concurrent tasks */
  maxConcurrent?: number;

  /** Default retry count */
  maxRetries?: number;

  /** Delay between retries (ms) */
  retryDelay?: number;

  /** Whether to persist tasks */
  persistTasks?: boolean;

  /** Storage key for persistence */
  storageKey?: string;
}

/**
 * Task execution function type
 */
export type TaskExecutor<T = any> = (task: BackgroundTask) => Promise<T>;

/**
 * Task completion callback
 */
export type TaskCallback = (task: BackgroundTask, result?: any, error?: Error) => void;

/**
 * Priority-based task queue
 */
export class TaskQueue {
  /** Max terminal (completed/failed/cancelled) tasks retained before oldest are evicted. */
  private static readonly MAX_RETAINED_TERMINAL = 200;

  private config: Required<TaskQueueConfig>;
  private tasks: Map<string, BackgroundTask> = new Map();
  private runningTasks: Set<string> = new Set();
  private executors: Map<string, TaskExecutor> = new Map();
  private callbacks: Map<string, TaskCallback[]> = new Map();
  private isPaused: boolean = false;
  private isProcessing: boolean = false;

  constructor(config: TaskQueueConfig = {}) {
    this.config = {
      maxConcurrent: config.maxConcurrent ?? 2,
      maxRetries: config.maxRetries ?? 3,
      retryDelay: config.retryDelay ?? 5000,
      persistTasks: config.persistTasks ?? false,
      storageKey: config.storageKey ?? 'sarvinbox-task-queue',
    };
  }

  /**
   * Register a task executor for a task type
   */
  registerExecutor(taskType: string, executor: TaskExecutor): void {
    this.executors.set(taskType, executor);
    logger.debug(`Registered executor for task type: ${taskType}`);
  }

  /**
   * Unregister a task executor
   */
  unregisterExecutor(taskType: string): void {
    this.executors.delete(taskType);
  }

  /**
   * Add a task to the queue
   */
  add(task: Omit<BackgroundTask, 'id' | 'status' | 'createdAt'>): string {
    const id = this.generateTaskId();
    const fullTask: BackgroundTask = {
      ...task,
      id,
      status: Status.PENDING,
      createdAt: Date.now(),
      retryCount: task.retryCount ?? 0,
      maxRetries: task.maxRetries ?? this.config.maxRetries,
    };

    this.tasks.set(id, fullTask);
    this.persist();

    logger.debug(`Task added to queue: ${id} (type: ${task.type}, priority: ${task.priority})`);

    // Start processing if not paused
    if (!this.isPaused) {
      this.processNext();
    }

    return id;
  }

  /**
   * Schedule a task to run at a specific time
   */
  schedule(
    task: Omit<BackgroundTask, 'id' | 'status' | 'createdAt'>,
    scheduledAt: number
  ): string {
    const id = this.add({ ...task, scheduledAt });
    return id;
  }

  /**
   * Cancel a task
   */
  cancel(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task) {
      return false;
    }

    if (task.status === Status.RUNNING) {
      // Can't cancel running task, mark for cancellation
      task.status = Status.CANCELLED;
      return true;
    }

    this.tasks.delete(taskId);
    this.persist();

    logger.debug(`Task cancelled: ${taskId}`);
    return true;
  }

  /**
   * Get task by ID
   */
  get(taskId: string): BackgroundTask | undefined {
    return this.tasks.get(taskId);
  }

  /**
   * Get task status
   */
  getStatus(taskId: string): TaskStatus | undefined {
    return this.tasks.get(taskId)?.status;
  }

  /**
   * Get all tasks
   */
  getAll(): BackgroundTask[] {
    return Array.from(this.tasks.values());
  }

  /**
   * Get pending tasks sorted by priority
   */
  getPending(): BackgroundTask[] {
    const now = Date.now();
    return this.getAll()
      .filter((t) => {
        if (t.status !== Status.PENDING) return false;
        if (t.scheduledAt && t.scheduledAt > now) return false;
        return true;
      })
      .sort((a, b) => {
        // Sort by priority first, then by created time
        if (a.priority !== b.priority) {
          return a.priority - b.priority;
        }
        return a.createdAt - b.createdAt;
      });
  }

  /**
   * Get running tasks
   */
  getRunning(): BackgroundTask[] {
    return this.getAll().filter((t) => t.status === Status.RUNNING);
  }

  /**
   * Pause the queue
   */
  pause(): void {
    this.isPaused = true;
    logger.info('Task queue paused');
  }

  /**
   * Resume the queue
   */
  resume(): void {
    this.isPaused = false;
    logger.info('Task queue resumed');
    this.processNext();
  }

  /**
   * Clear all tasks
   */
  clear(): void {
    this.tasks.clear();
    this.persist();
    logger.info('Task queue cleared');
  }

  /**
   * Clear completed tasks
   */
  clearCompleted(): void {
    for (const [id, task] of this.tasks) {
      if (task.status === Status.COMPLETED || task.status === Status.CANCELLED) {
        this.tasks.delete(id);
      }
    }
    this.persist();
  }

  /**
   * Subscribe to task completion
   */
  onComplete(taskId: string, callback: TaskCallback): () => void {
    const callbacks = this.callbacks.get(taskId) || [];
    callbacks.push(callback);
    this.callbacks.set(taskId, callbacks);

    return () => {
      const cbs = this.callbacks.get(taskId) || [];
      const index = cbs.indexOf(callback);
      if (index >= 0) {
        cbs.splice(index, 1);
      }
    };
  }

  /**
   * Get queue statistics
   */
  getStats(): {
    total: number;
    pending: number;
    running: number;
    completed: number;
    failed: number;
    cancelled: number;
  } {
    const tasks = this.getAll();
    return {
      total: tasks.length,
      pending: tasks.filter((t) => t.status === Status.PENDING).length,
      running: tasks.filter((t) => t.status === Status.RUNNING).length,
      completed: tasks.filter((t) => t.status === Status.COMPLETED).length,
      failed: tasks.filter((t) => t.status === Status.FAILED).length,
      cancelled: tasks.filter((t) => t.status === Status.CANCELLED).length,
    };
  }

  /**
   * Process next tasks in queue
   */
  private async processNext(): Promise<void> {
    if (this.isPaused || this.isProcessing) {
      return;
    }

    this.isProcessing = true;

    try {
      while (!this.isPaused) {
        // Check if we can run more tasks
        if (this.runningTasks.size >= this.config.maxConcurrent) {
          break;
        }

        // Get next pending task
        const pending = this.getPending();
        if (pending.length === 0) {
          break;
        }

        const task = pending[0];

        // Check if we have an executor for this task type
        const executor = this.executors.get(task.type);
        if (!executor) {
          logger.warn(`No executor registered for task type: ${task.type}`);
          task.status = Status.FAILED;
          task.error = `No executor for task type: ${task.type}`;
          // Notify (and drop the callback entry) so a waiter on this task
          // resolves instead of hanging forever, then prune per the cap.
          this.notifyCallbacks(task, undefined, new Error(task.error));
          this.pruneTerminalTasks();
          this.persist();
          continue;
        }

        // Start task execution
        this.executeTask(task, executor);
      }
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Execute a single task
   */
  private async executeTask(task: BackgroundTask, executor: TaskExecutor): Promise<void> {
    task.status = Status.RUNNING;
    task.startedAt = Date.now();
    this.runningTasks.add(task.id);
    this.persist();

    logger.debug(`Task started: ${task.id} (type: ${task.type})`);

    try {
      const result = await executor(task);

      // Check if task was cancelled during execution
      // Re-fetch from map as status may have been changed externally
      const currentTask = this.tasks.get(task.id);
      if (currentTask?.status === Status.CANCELLED) {
        logger.debug(`Task was cancelled: ${task.id}`);
        this.runningTasks.delete(task.id);
        this.notifyCallbacks(currentTask);
        this.processNext();
        return;
      }

      task.status = Status.COMPLETED;
      task.completedAt = Date.now();
      task.progress = 100;

      logger.debug(`Task completed: ${task.id} (duration: ${task.completedAt - task.startedAt!}ms)`);

      this.notifyCallbacks(task, result);
    } catch (error) {
      const err = error as Error;
      logger.error(`Task failed: ${task.id}`, err);

      task.retryCount++;
      task.error = err.message;

      if (task.retryCount < task.maxRetries) {
        // Schedule retry
        task.status = Status.PENDING;
        task.scheduledAt = Date.now() + this.config.retryDelay * task.retryCount;
        logger.info(`Task ${task.id} scheduled for retry ${task.retryCount}/${task.maxRetries}`);
      } else {
        task.status = Status.FAILED;
        task.completedAt = Date.now();
        this.notifyCallbacks(task, undefined, err);
      }
    } finally {
      this.runningTasks.delete(task.id);
      this.pruneTerminalTasks();
      this.persist();
      this.processNext();
    }
  }

  /**
   * Evict the oldest terminal (completed/failed/cancelled) tasks once they
   * exceed the retention cap. Without this the tasks map grows monotonically
   * for the life of the process — every settled task (with its data payload)
   * stays forever, since nothing calls clearCompleted() on a schedule. A
   * bounded window keeps recent tasks queryable (getStats/waitForTask) while
   * capping memory. Pending/running tasks are never evicted.
   */
  private pruneTerminalTasks(): void {
    const terminal: BackgroundTask[] = [];
    for (const task of this.tasks.values()) {
      if (
        task.status === Status.COMPLETED ||
        task.status === Status.FAILED ||
        task.status === Status.CANCELLED
      ) {
        terminal.push(task);
      }
    }
    if (terminal.length <= TaskQueue.MAX_RETAINED_TERMINAL) return;
    terminal.sort((a, b) => a.createdAt - b.createdAt);
    const excess = terminal.length - TaskQueue.MAX_RETAINED_TERMINAL;
    for (let i = 0; i < excess; i++) {
      this.tasks.delete(terminal[i].id);
    }
  }

  /**
   * Notify callbacks of task completion
   */
  private notifyCallbacks(task: BackgroundTask, result?: any, error?: Error): void {
    const callbacks = this.callbacks.get(task.id) || [];
    for (const callback of callbacks) {
      try {
        callback(task, result, error);
      } catch (err) {
        logger.error('Error in task callback:', err);
      }
    }
    this.callbacks.delete(task.id);
  }

  /**
   * Generate unique task ID
   */
  private generateTaskId(): string {
    return `task_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }

  /**
   * Persist tasks (if enabled)
   */
  private persist(): void {
    if (!this.config.persistTasks) {
      return;
    }

    // This would typically save to localStorage or a database
    // For now, we just log that persistence would happen
    logger.debug(`Would persist ${this.tasks.size} tasks`);
  }

  /**
   * Load persisted tasks
   */
  loadPersisted(): void {
    if (!this.config.persistTasks) {
      return;
    }

    // This would typically load from localStorage or a database
    logger.debug('Would load persisted tasks');
  }
}

/**
 * Create a new TaskQueue instance
 */
export function createTaskQueue(config?: TaskQueueConfig): TaskQueue {
  return new TaskQueue(config);
}
