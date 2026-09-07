/**
 * Background Module - Background task management
 *
 * Provides infrastructure for running tasks in the background:
 * - Email sync
 * - Pipeline processing
 * - AI analysis
 * - Cleanup operations
 */

// Task Queue
export { TaskQueue, createTaskQueue } from './task-queue';
export type { TaskQueueConfig, TaskExecutor, TaskCallback } from './task-queue';

// Task Manager
export {
  BackgroundTaskManager,
  initializeTaskManager,
  getTaskManager,
  createTaskManager,
} from './task-manager';
export type {
  TaskManagerConfig,
  SyncTaskData,
  ProcessTaskData,
  AITaskData,
  CleanupTaskData,
} from './task-manager';

// Enum value aliases from pipeline. The task TYPES (BackgroundTask/TaskPriority/
// TaskStatus) are already exported at the package root via the pipeline barrel;
// re-exporting them here too produced duplicate exports of the same symbols.
export { TaskPriority as TaskPriorityEnum, TaskStatus as TaskStatusEnum } from '../pipeline/types';
