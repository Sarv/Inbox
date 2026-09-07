# Email Sync & Pipeline Workflow Architecture Plan

> Historical design note (2026). Superseded by [docs/ARCHITECTURE.md](./ARCHITECTURE.md); kept for context.

## Current State Analysis

### Issues with Current Implementation:
1. **Sync is blocking** - UI freezes during heavy sync
2. **No proper workflow pipeline** - Processing is ad-hoc, not pluggable
3. **Limited background support** - No OS-level background task integration
4. **Tight coupling** - Sync, storage, and processing are intertwined
5. **No retry/failure queue** - Failed operations get dropped
6. **No priority system** - All emails treated equally during sync

---

## Proposed Architecture

### 1. Email Pipeline System

```
┌─────────────────────────────────────────────────────────────────┐
│                      EMAIL PIPELINE ORCHESTRATOR                │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐  │
│  │  STAGE 1 │───▶│  STAGE 2 │───▶│  STAGE 3 │───▶│  STAGE N │  │
│  │  (Sync)  │    │ (Parse)  │    │(Process) │    │  (AI)    │  │
│  └──────────┘    └──────────┘    └──────────┘    └──────────┘  │
│       │              │               │               │          │
│       ▼              ▼               ▼               ▼          │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                    EVENT BUS                             │   │
│  │  (email:synced, email:parsed, email:processed, etc.)    │   │
│  └─────────────────────────────────────────────────────────┘   │
│                              │                                  │
│                              ▼                                  │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                  WORKFLOW REGISTRY                       │   │
│  │  - ImportanceScorer                                      │   │
│  │  - SpamDetector                                          │   │
│  │  - CategoryClassifier                                    │   │
│  │  - AIResponseSuggester                                   │   │
│  │  - SmartLabelAssigner                                    │   │
│  │  - CustomUserWorkflows                                   │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 2. Core Components

#### A. Pipeline Orchestrator
```typescript
interface PipelineOrchestrator {
  // Register a workflow to process emails
  registerWorkflow(workflow: EmailWorkflow): void;

  // Unregister a workflow
  unregisterWorkflow(workflowId: string): void;

  // Process an email through all registered workflows
  processEmail(email: EmailRecord): Promise<ProcessedEmail>;

  // Process emails in batch with concurrency control
  processBatch(emails: EmailRecord[], options?: BatchOptions): Promise<void>;

  // Get workflow status
  getStatus(): PipelineStatus;
}
```

#### B. Email Workflow Interface
```typescript
interface EmailWorkflow {
  id: string;
  name: string;
  description: string;

  // Priority determines order of execution (lower = earlier)
  priority: number;

  // Whether this workflow requires AI/LLM
  requiresAI: boolean;

  // Whether to run in background thread
  runInBackground: boolean;

  // Filter which emails this workflow processes
  shouldProcess(email: EmailRecord): boolean;

  // Process the email and return modifications
  process(email: EmailRecord, context: WorkflowContext): Promise<WorkflowResult>;

  // Cleanup/teardown
  dispose(): void;
}

interface WorkflowResult {
  success: boolean;
  modifications?: Partial<EmailRecord>;
  labels?: string[];
  metadata?: Record<string, any>;
  nextWorkflows?: string[];  // Chain to specific workflows
  error?: Error;
}

interface WorkflowContext {
  storage: Storage;
  aiClient?: AIClient;
  senderStats?: SenderStats;
  userPreferences?: UserPreferences;
  previousResults?: Map<string, WorkflowResult>;
}
```

#### C. Background Task Manager
```typescript
interface BackgroundTaskManager {
  // Schedule a task to run in background
  schedule(task: BackgroundTask): string;

  // Cancel a scheduled task
  cancel(taskId: string): void;

  // Get task status
  getTaskStatus(taskId: string): TaskStatus;

  // Register for OS-level background execution
  registerBackgroundMode(): void;

  // Handle app going to background
  onAppBackground(): void;

  // Handle app coming to foreground
  onAppForeground(): void;
}

interface BackgroundTask {
  id: string;
  type: 'sync' | 'process' | 'ai-analysis' | 'cleanup';
  priority: 'high' | 'normal' | 'low';
  data: any;
  retryCount: number;
  maxRetries: number;
  createdAt: number;
  scheduledAt?: number;
}
```

### 3. Improved Sync Strategy

#### A. Tiered Sync Approach
```
TIER 1 - Critical (Immediate)
├── New emails in INBOX
├── Flagged/Starred changes
└── High-priority sender emails

TIER 2 - Important (Within 5 minutes)
├── Sent folder updates
├── Drafts changes
└── Label/folder changes

TIER 3 - Background (When idle)
├── All Mail full sync
├── Spam/Trash cleanup
└── Historical email fetch
```

#### B. Smart Sync Algorithm
```typescript
interface SmartSyncStrategy {
  // Determine sync priority for a folder
  getFolderPriority(folder: Folder): SyncPriority;

  // Determine optimal batch size based on network/CPU
  getOptimalBatchSize(): number;

  // Check if sync should pause (battery, network, etc.)
  shouldPauseSync(): boolean;

  // Get next folders to sync based on priority
  getNextSyncBatch(): Folder[];

  // Handle sync conflicts
  resolveConflict(local: EmailRecord, remote: IMAPMessage): EmailRecord;
}
```

### 4. Event-Driven Architecture

```typescript
// Event types
type EmailEvent =
  | { type: 'email:received'; email: EmailRecord }
  | { type: 'email:synced'; email: EmailRecord; folder: string }
  | { type: 'email:processed'; email: EmailRecord; workflow: string }
  | { type: 'email:labeled'; email: EmailRecord; labels: string[] }
  | { type: 'email:flagged'; email: EmailRecord; flags: string[] }
  | { type: 'sync:started'; folders: string[] }
  | { type: 'sync:progress'; status: SyncStatus }
  | { type: 'sync:completed'; stats: SyncStats }
  | { type: 'workflow:started'; workflow: string; emailId: string }
  | { type: 'workflow:completed'; workflow: string; result: WorkflowResult };

// Event bus
interface EventBus {
  emit(event: EmailEvent): void;
  on(type: string, handler: (event: EmailEvent) => void): () => void;
  once(type: string, handler: (event: EmailEvent) => void): void;
}
```

### 5. Built-in Workflows

#### A. ImportanceScorer (Existing, Refactored)
```typescript
class ImportanceScorerWorkflow implements EmailWorkflow {
  id = 'importance-scorer';
  priority = 10;  // Run early
  requiresAI = false;
  runInBackground = true;

  shouldProcess(email) {
    return email.importanceScore === undefined;
  }

  async process(email, context) {
    const score = await this.calculateScore(email, context);
    return {
      success: true,
      modifications: { importanceScore: score },
      labels: score >= 3 ? ['Important'] : []
    };
  }
}
```

#### B. AICategorizerWorkflow (New)
```typescript
class AICategorizerWorkflow implements EmailWorkflow {
  id = 'ai-categorizer';
  priority = 50;  // Run after basic processing
  requiresAI = true;
  runInBackground = true;

  shouldProcess(email) {
    return !email.aiCategory && email.importanceScore >= 1;
  }

  async process(email, context) {
    const category = await context.aiClient.categorize(email);
    return {
      success: true,
      metadata: { aiCategory: category },
      labels: [category]
    };
  }
}
```

#### C. SmartReplyWorkflow (New)
```typescript
class SmartReplyWorkflow implements EmailWorkflow {
  id = 'smart-reply';
  priority = 100;  // Run later
  requiresAI = true;
  runInBackground = true;

  shouldProcess(email) {
    // Only for important, recent emails
    return email.importanceScore >= 3 &&
           Date.now() - email.date * 1000 < 24 * 60 * 60 * 1000;
  }

  async process(email, context) {
    const suggestions = await context.aiClient.generateReplySuggestions(email);
    return {
      success: true,
      metadata: { replySuggestions: suggestions }
    };
  }
}
```

### 6. Background Execution Strategy

#### For macOS (Electron)
```typescript
// Use powerMonitor and app.setActivationPolicy
app.setActivationPolicy('accessory');  // Run as background app

powerMonitor.on('suspend', () => {
  backgroundTaskManager.pauseAllTasks();
});

powerMonitor.on('resume', () => {
  backgroundTaskManager.resumeAllTasks();
});

// Use worker threads for CPU-intensive tasks
const worker = new Worker('./sync-worker.js');
worker.postMessage({ type: 'sync', folders: [...] });
```

#### Background Sync Service
```typescript
class BackgroundSyncService {
  private worker: Worker;
  private taskQueue: BackgroundTask[] = [];

  async startBackgroundSync() {
    // Check network conditions
    if (!navigator.onLine) return;

    // Check battery (if available)
    const battery = await navigator.getBattery?.();
    if (battery && battery.level < 0.2 && !battery.charging) return;

    // Start worker
    this.worker = new Worker('./sync-worker.js');
    this.worker.onmessage = this.handleWorkerMessage.bind(this);

    // Process queue
    while (this.taskQueue.length > 0) {
      const task = this.taskQueue.shift();
      await this.processTask(task);
    }
  }
}
```

### 7. Implementation Phases

#### Phase 1: Core Pipeline (Week 1-2)
- [ ] Create `PipelineOrchestrator` class
- [ ] Create `EmailWorkflow` interface
- [ ] Create `EventBus` implementation
- [ ] Refactor `ImportanceScorer` as workflow
- [ ] Add workflow registry

#### Phase 2: Background Support (Week 2-3)
- [ ] Create `BackgroundTaskManager`
- [ ] Implement worker threads for sync
- [ ] Add task persistence/recovery
- [ ] Implement power-aware sync

#### Phase 3: Smart Sync (Week 3-4)
- [ ] Implement tiered sync strategy
- [ ] Add conflict resolution
- [ ] Optimize batch sizes
- [ ] Add network-aware sync

#### Phase 4: AI Workflows (Week 4-5)
- [ ] Create `AICategorizerWorkflow`
- [ ] Create `SmartReplyWorkflow`
- [ ] Create `SummarizationWorkflow`
- [ ] Add AI provider abstraction

#### Phase 5: User Workflows (Week 5-6)
- [ ] Create workflow editor UI
- [ ] Allow custom workflow creation
- [ ] Add workflow triggers/conditions
- [ ] Implement workflow chaining

---

## File Structure

```
packages/core/src/
├── pipeline/
│   ├── index.ts
│   ├── orchestrator.ts
│   ├── event-bus.ts
│   ├── workflow-registry.ts
│   └── types.ts
├── workflows/
│   ├── index.ts
│   ├── base-workflow.ts
│   ├── importance-scorer.ts
│   ├── ai-categorizer.ts
│   ├── smart-reply.ts
│   ├── spam-detector.ts
│   └── label-assigner.ts
├── background/
│   ├── index.ts
│   ├── task-manager.ts
│   ├── sync-worker.ts
│   └── task-queue.ts
├── sync/
│   ├── index.ts
│   ├── sync-manager.ts (refactored)
│   ├── smart-strategy.ts
│   └── conflict-resolver.ts
```

---

## API Examples

### Register Custom Workflow
```typescript
const pipeline = new PipelineOrchestrator();

// Register built-in workflows
pipeline.registerWorkflow(new ImportanceScorerWorkflow());
pipeline.registerWorkflow(new AICategorizerWorkflow(aiClient));

// Register custom workflow
pipeline.registerWorkflow({
  id: 'vip-notifier',
  priority: 5,
  requiresAI: false,
  runInBackground: false,

  shouldProcess(email) {
    return email.fromAddress.includes('@important-client.com');
  },

  async process(email, context) {
    // Send desktop notification
    new Notification('VIP Email', { body: email.subject });
    return { success: true, labels: ['VIP'] };
  }
});
```

### Process Emails Through Pipeline
```typescript
// Single email
const result = await pipeline.processEmail(newEmail);

// Batch processing
await pipeline.processBatch(syncedEmails, {
  concurrency: 4,
  onProgress: (processed, total) => {
    console.log(`Processed ${processed}/${total}`);
  }
});
```

### Background Task Scheduling
```typescript
const taskManager = new BackgroundTaskManager();

// Schedule sync task
taskManager.schedule({
  id: 'daily-full-sync',
  type: 'sync',
  priority: 'low',
  data: { fullSync: true, folders: ['All Mail'] },
  scheduledAt: Date.now() + 6 * 60 * 60 * 1000  // 6 hours later
});

// Handle app background
app.on('did-enter-background', () => {
  taskManager.onAppBackground();
});
```

---

## Questions to Clarify

1. **AI Provider**: Which AI/LLM provider should we integrate? (OpenAI, Claude, local?)
2. **Workflow UI**: Do you want a visual workflow builder or code-based workflows?
3. **Priority**: Which phase should we start with first?
4. **Mobile**: Should this architecture also support React Native mobile app?
