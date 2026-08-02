import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  type TaskPriority,
  type TaskStatus,
  type MessageKind,
  type MessagePriority,
  type CoopTask,
  type CoopMessage,
  parseTask,
  serializeTask,
  parseMessage,
  serializeMessage,
} from "../schema/coop.js";
import {
  writeFile,
  readFile,
  listCoopFiles,
  listFilesWithSuffix,
  fileExists,
  removeFile,
  withCanonicalMutationLock,
} from "../storage/fs.js";
import { getGitRevision, gitAddAndCommit } from "../storage/git.js";
import {
  appendEventLog,
  appendPreparedEventLog,
  prepareEventLog,
  trustPolicyErrorToResult,
} from "../storage/events.js";
import type { CoopEventInput } from "../schema/events.js";
import { getCoopDir } from "../config.js";
import { writeTaskCompletionMemory, recommendAgentsFromMemory } from "./memory-bridge.js";
import { emitChat } from "./chat-bridge.js";
import { coopGetGlobalState } from "./global-state.js";

interface WorkerLoad {
  workerId: string;
  activeTasks: number;
  completedTasks: number;  // tasks completed in the time window
  throughput: number;       // tasks per hour
  lastActive: string;
  loadScore: number;        // lower = less loaded
}

const ALLOWED_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  open: ["in_progress", "cancelled", "blocked"],
  in_progress: ["done", "blocked", "cancelled", "open"],
  blocked: ["in_progress", "cancelled", "open"],
  done: [],
  cancelled: [],
};

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
}

function taskSlug(source: string, title: string): string {
  return `${slugify(source)}-${slugify(title)}-${Date.now()}`;
}

function ensureVersionMatch(currentVersion: number, expectedVersion?: number): string | null {
  if (expectedVersion === undefined) return null;
  if (expectedVersion !== currentVersion) {
    return JSON.stringify({
      error: "version_conflict",
      expected_version: expectedVersion,
      actual_version: currentVersion,
      message: "Task changed by another writer; reload and retry.",
    });
  }
  return null;
}

function ensureTransitionAllowed(from: TaskStatus, to: TaskStatus): string | null {
  if (from === to) return null;
  if (!ALLOWED_TRANSITIONS[from].includes(to)) {
    return JSON.stringify({
      error: "invalid_status_transition",
      from,
      to,
      allowed: ALLOWED_TRANSITIONS[from],
    });
  }
  return null;
}

// Dynamic Load Balancing Functions
const LOAD_BALANCE_WINDOW_HOURS = 24; // Look at tasks completed in last 24 hours
// OPTIMIZED: Reduced active task weight to balance with throughput
const ACTIVE_TASK_WEIGHT = 2.5;       // Weight for active tasks (optimized: was 3.0)
// OPTIMIZED: Increased throughput weight to better reflect worker capability
const THROUGHPUT_WEIGHT = 3.5;        // Weight for throughput (optimized: was 1.0)
// OPTIMIZED: Enhanced idle penalty to encourage balanced distribution
const IDLE_PENALTY = -2.5;            // Penalty for idle workers (optimized: was -2.0)
const LOAD_SCORE_WEIGHT = 1.0;        // Weight for load score in variance calculation

// OPTIMIZED: New constants for dynamic weight adjustment
const THROUGHPUT_BOOST_THRESHOLD = 0.3;  // Boost threshold for low-throughput workers
const VARIANCE_TARGET = 0.1;              // Target variance for balanced load

// Throughput signal optimization constants
const THROUGHPUT_EMA_ALPHA = 0.3;     // EMA smoothing factor (0-1, higher = more responsive)
const THROUGHPUT_MIN_SAMPLES = 3;    // Minimum samples for high confidence
const THROUGHPUT_CONFIDENCE_SCALE = 0.5; // Confidence penalty scale
const STALE_HOURS_THRESHOLD = 48;     // Consider worker stale after this many hours

/**
 * Calculate load score for a worker.
 * Lower score = less loaded (better candidate for new tasks)
 *
 * Formula: loadScore = (activeTasks * ACTIVE_TASK_WEIGHT) - (throughput * THROUGHPUT_WEIGHT) + idlePenalty
 */
function calculateLoadScore(worker: WorkerLoad, hoursSinceLastActive: number): number {
  // Base load from active tasks
  const activeLoad = worker.activeTasks * ACTIVE_TASK_WEIGHT;

  // Credit for throughput (higher throughput = lower load)
  const throughputCredit = worker.throughput * THROUGHPUT_WEIGHT;

  // Idle penalty (workers idle for longer get a bonus)
  const idleBonus = Math.min(0, -Math.log1p(hoursSinceLastActive) * IDLE_PENALTY);

  return activeLoad - throughputCredit + idleBonus;
}

/**
 * OPTIMIZED: Calculate dynamic load score with adaptive weights
 * This function adjusts weights based on:
 * 1. Worker's relative throughput compared to average
 * 2. Current load variance across workers
 * 3. Sample size (new workers get bonus to gather experience)
 */
function calculateDynamicLoadScore(
  worker: WorkerLoad,
  hoursSinceLastActive: number,
  allWorkers: WorkerLoad[]
): number {
  // Calculate average throughput
  const avgThroughput = allWorkers.reduce((sum, w) => sum + w.throughput, 0) / allWorkers.length;

  // Calculate current variance
  const loads = allWorkers.map(w => w.loadScore);
  const minLoad = Math.min(...loads);
  const maxLoad = Math.max(...loads);
  const variance = maxLoad - minLoad || 1;

  // Dynamic throughput weight adjustment
  let adjustedThroughputWeight = THROUGHPUT_WEIGHT;

  // Boost low-throughput workers to help them catch up
  if (avgThroughput > 0 && worker.throughput < avgThroughput * (1 - THROUGHPUT_BOOST_THRESHOLD)) {
    adjustedThroughputWeight = THROUGHPUT_WEIGHT * 1.5; // 50% boost for low throughput workers
  }

  // Increase weight when variance is high (to achieve balance faster)
  if (variance > VARIANCE_TARGET * 10) {
    adjustedThroughputWeight *= 1.3;
  }

  // Base load from active tasks
  const activeLoad = worker.activeTasks * ACTIVE_TASK_WEIGHT;

  // Credit for throughput (with dynamic weight)
  const throughputCredit = worker.throughput * adjustedThroughputWeight;

  // Idle penalty with enhanced bonus for workers with low sample count
  let idleBonus = Math.min(0, -Math.log1p(hoursSinceLastActive) * IDLE_PENALTY);

  // Sample bonus for workers with fewer completed tasks (to help them gain experience)
  if (worker.completedTasks < 15) {
    idleBonus -= (15 - worker.completedTasks) * 0.15;
  }

  return activeLoad - throughputCredit + idleBonus;
}

/**
 * Get all worker loads based on task history
 */
async function getWorkerLoads(coopDir: string): Promise<WorkerLoad[]> {
  const files = await listCoopFiles("tasks", coopDir);
  const workerMap = new Map<string, WorkerLoad>();
  const now = new Date();
  const windowStart = new Date(now.getTime() - LOAD_BALANCE_WINDOW_HOURS * 60 * 60 * 1000);

  for (const f of files) {
    try {
      const raw = await readFile(f, coopDir);
      const task = parseTask(raw, f);
      const fm = task.frontmatter;

      if (!fm.assignee) continue;

      // Initialize worker if not seen
      if (!workerMap.has(fm.assignee)) {
        workerMap.set(fm.assignee, {
          workerId: fm.assignee,
          activeTasks: 0,
          completedTasks: 0,
          throughput: 0,
          lastActive: fm.updated,
          loadScore: 0,
        });
      }

      const worker = workerMap.get(fm.assignee)!;

      // Update last active
      if (fm.updated > worker.lastActive) {
        worker.lastActive = fm.updated;
      }

      // Count active tasks
      if (fm.status === "in_progress") {
        worker.activeTasks++;
      }

      // Count completed tasks in window
      if (fm.status === "done") {
        const completedDate = new Date(fm.updated);
        if (completedDate >= windowStart) {
          worker.completedTasks++;
        }
      }
    } catch {
      // Skip invalid task files
    }
  }

  // Calculate throughput for all workers first
  const workersArray = Array.from(workerMap.values());
  for (const worker of workersArray) {
    worker.throughput = worker.completedTasks / LOAD_BALANCE_WINDOW_HOURS;
  }

  // Calculate average throughput for dynamic weight adjustment
  const totalThroughput = workersArray.reduce((sum, w) => sum + w.throughput, 0);
  const avgThroughput = workersArray.length > 0 ? totalThroughput / workersArray.length : 0;

  // Calculate load scores using dynamic scoring function
  for (const worker of workersArray) {
    const hoursSinceLastActive = (now.getTime() - new Date(worker.lastActive).getTime()) / (1000 * 60 * 60);
    worker.loadScore = calculateDynamicLoadScore(worker, hoursSinceLastActive, workersArray);
  }

  return workersArray;
}

/**
 * Enhanced throughput calculation with EMA smoothing and confidence adjustment
 * This addresses signal accuracy issues by:
 * 1. Using Exponential Moving Average to smooth volatility
 * 2. Applying confidence penalty for low sample sizes
 * 3. Detecting and handling stale workers
 */
interface EnhancedWorkerLoad extends WorkerLoad {
  throughputEma: number;        // EMA-smoothed throughput
  confidence: number;           // Confidence score (0-1) based on sample size
  adjustedThroughput: number;  // Final throughput with confidence adjustment
  isStale: boolean;            // Whether worker is considered stale
}

function calculateEnhancedThroughput(
  worker: WorkerLoad,
  previousEma?: number,
  windowHours: number = LOAD_BALANCE_WINDOW_HOURS
): EnhancedWorkerLoad {
  const now = new Date();
  const hoursSinceLastActive = (now.getTime() - new Date(worker.lastActive).getTime()) / (1000 * 60 * 60);
  const isStale = hoursSinceLastActive > STALE_HOURS_THRESHOLD;

  // Basic throughput (tasks per hour)
  const rawThroughput = worker.completedTasks / windowHours;

  // EMA smoothing - blend current with previous to reduce volatility
  const throughputEma = previousEma !== undefined
    ? THROUGHPUT_EMA_ALPHA * rawThroughput + (1 - THROUGHPUT_EMA_ALPHA) * previousEma
    : rawThroughput;

  // Confidence based on sample size (completed tasks in window)
  const sampleSize = worker.completedTasks;
  let confidence = Math.min(1.0, sampleSize / THROUGHPUT_MIN_SAMPLES);

  // Reduce confidence for stale workers
  if (isStale) {
    confidence *= 0.5;
  }

  // Apply confidence penalty to throughput signal
  const adjustedThroughput = throughputEma * (THROUGHPUT_CONFIDENCE_SCALE + (1 - THROUGHPUT_CONFIDENCE_SCALE) * confidence);

  return {
    ...worker,
    throughputEma,
    confidence,
    adjustedThroughput,
    isStale,
  };
}

/**
 * Calculate load score with enhanced throughput (more accurate signal)
 */
function calculateEnhancedLoadScore(worker: EnhancedWorkerLoad, hoursSinceLastActive: number): number {
  // Base load from active tasks (unchanged)
  const activeLoad = worker.activeTasks * ACTIVE_TASK_WEIGHT;

  // Use adjusted throughput for load calculation
  const throughputCredit = worker.adjustedThroughput * THROUGHPUT_WEIGHT;

  // Enhanced idle penalty with stale detection
  let idleBonus = 0;
  if (worker.isStale) {
    // Stale workers get a small boost to encourage reactivation
    idleBonus = 1.0;
  } else if (hoursSinceLastActive > 1) {
    // Normal idle bonus
    idleBonus = Math.min(0, -Math.log1p(hoursSinceLastActive) * IDLE_PENALTY);
  }

  return activeLoad - throughputCredit + idleBonus;
}

/**
 * Get load variance across all workers
 * Uses loadScore for more accurate representation of actual worker load
 * Variance < 0.2 means balanced distribution
 */
function calculateLoadVariance(workers: WorkerLoad[]): number {
  if (workers.length < 2) return 0;

  // Use loadScore for variance calculation (more accurate than just activeTasks)
  const loads = workers.map(w => w.loadScore);
  const minLoad = Math.min(...loads);
  const maxLoad = Math.max(...loads);

  // Normalize load scores to 0-1 range for consistent variance
  const range = maxLoad - minLoad || 1;
  const normalized = loads.map(l => (l - minLoad) / range);

  const mean = normalized.reduce((a, b) => a + b, 0) / normalized.length;
  const variance = normalized.reduce((sum, load) => sum + Math.pow(load - mean, 2), 0) / normalized.length;

  return variance;
}

// Dynamic Priority Algorithm
// Adjusts priority based on wait time, dependencies, and resource需求
interface DynamicPriorityOptions {
  basePriority: TaskPriority;
  createdAt: string;
  dependsOn: string[];
  allTasks: CoopTask[];
}

const PRIORITY_BOOST_THRESHOLD_HOURS = 4; // Start boosting after 4 hours
const PRIORITY_BOOST_MAX_LEVELS = 2; // Max 2 levels boost
const DEPENDENCY_BOOST = 1; // Boost level if other tasks depend on this one

function calculateDynamicPriority(options: DynamicPriorityOptions): TaskPriority {
  const { basePriority, createdAt, dependsOn, allTasks } = options;

  const priorityLevels: TaskPriority[] = ["low", "medium", "high", "critical"];
  const baseIndex = priorityLevels.indexOf(basePriority);

  // 1. Wait time boost
  const waitTimeMs = Date.now() - new Date(createdAt).getTime();
  const waitTimeHours = waitTimeMs / (1000 * 60 * 60);
  let waitBoost = 0;
  if (waitTimeHours > PRIORITY_BOOST_THRESHOLD_HOURS) {
    waitBoost = Math.min(
      Math.floor((waitTimeHours - PRIORITY_BOOST_THRESHOLD_HOURS) / 4),
      PRIORITY_BOOST_MAX_LEVELS
    );
  }

  // 2. Dependency boost - if other tasks depend on this, boost it
  let depBoost = 0;
  if (dependsOn.length > 0) {
    // Check how many tasks depend on tasks in our dependency chain
    const dependentTasks = allTasks.filter(t =>
      t.frontmatter.depends_on.some(d => dependsOn.includes(d))
    );
    depBoost = Math.min(dependentTasks.length, DEPENDENCY_BOOST);
  }

  // Calculate new priority level
  const newIndex = Math.max(0, baseIndex - waitBoost - depBoost);
  return priorityLevels[newIndex];
}

function normalizeDependsOn(dependsOn?: string[]): string[] | undefined {
  if (dependsOn === undefined) return undefined;
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const dependency of dependsOn) {
    const id = dependency.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    normalized.push(id);
  }
  return normalized;
}

async function findUnresolvedDependencies(taskIds: string[], coopDir: string): Promise<string[]> {
  const unresolved: string[] = [];
  for (const taskId of taskIds) {
    try {
      const raw = await readFile(taskId, coopDir);
      const dependencyTask = parseTask(raw, taskId);
      if (dependencyTask.frontmatter.status !== "done") unresolved.push(taskId);
    } catch {
      unresolved.push(taskId);
    }
  }
  return unresolved;
}

function areDependsOnEqual(a: string[], b?: string[]): boolean {
  if (b === undefined) return true;
  if (a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}

async function persistFileAndEvent(input: {
  relativePath: string;
  previousContent: string | null;
  nextContent: string;
  event: CoopEventInput;
  commitMessage: string;
  coopDir: string;
}): Promise<string> {
  // Authorization and schema validation must happen before canonical state is
  // changed. A rejected operation therefore leaves the task/message untouched.
  const preparedEvent = await prepareEventLog(input.event, input.coopDir);

  await writeFile(input.relativePath, input.nextContent, input.coopDir);
  let eventLogPath: string;
  try {
    eventLogPath = await appendPreparedEventLog(preparedEvent, input.coopDir);
  } catch (error) {
    if (input.previousContent === null) {
      await removeFile(input.relativePath, input.coopDir);
    } else {
      await writeFile(input.relativePath, input.previousContent, input.coopDir);
    }
    throw error;
  }

  // A successful API response means the task and its evidence are in the same
  // Git commit. Do not hide commit failures as earlier versions did.
  await gitAddAndCommit([input.relativePath, eventLogPath], input.commitMessage, input.coopDir);
  return eventLogPath;
}

export async function coopPostTask(input: {
  title: string;
  body: string;
  priority?: TaskPriority;
  tags?: string[];
  source: string;
}): Promise<string> {
  const coopDir = getCoopDir();
  return withCanonicalMutationLock(async () => {
    const now = new Date().toISOString();
    const slug = taskSlug(input.source, input.title);
    const relativePath = path.join("cooperation/tasks", `${slug}.md`);

    const task: Omit<CoopTask, "filePath"> = {
      frontmatter: {
        status: "open",
        priority: input.priority ?? "medium",
        created_by: input.source,
        assignee: null,
        created: now,
        updated: now,
        tags: input.tags ?? [],
        depends_on: [],
        version: 1,
      },
      title: input.title,
      body: input.body,
    };

    try {
      await persistFileAndEvent({
        relativePath,
        previousContent: null,
        nextContent: serializeTask(task),
        event: {
          event_id: randomUUID(),
          event_type: "post_task",
          task_id: relativePath,
          actor: input.source,
          payload: {
            title: input.title,
            priority: task.frontmatter.priority,
            tags: task.frontmatter.tags,
          },
        },
        commitMessage: `coop: post task - ${input.title}`,
        coopDir,
      });
    } catch (error) {
      const policyError = trustPolicyErrorToResult(error);
      if (policyError) return policyError;
      throw error;
    }
    try {
      await emitChat({
        topic: "tasks",
        actor: input.source,
        event: "post_task",
        task_id: relativePath,
        payload: { title: input.title, priority: task.frontmatter.priority },
      }, coopDir);
    } catch {}
    return JSON.stringify({ id: relativePath, title: input.title, status: "open", version: 1 });
  }, coopDir);
}

export async function coopClaimTask(input: { task_id: string; assignee: string; expected_version?: number; }): Promise<string> {
  const coopDir = getCoopDir();
  return withCanonicalMutationLock(async () => {
    const raw = await readFile(input.task_id, coopDir);
    const task = parseTask(raw, input.task_id);

    const versionConflict = ensureVersionMatch(task.frontmatter.version, input.expected_version);
    if (versionConflict) return versionConflict;

    if (task.frontmatter.assignee && task.frontmatter.status === "in_progress") {
      return JSON.stringify({ error: `Task already claimed by ${task.frontmatter.assignee}` });
    }

    const transitionError = ensureTransitionAllowed(task.frontmatter.status, "in_progress");
    if (transitionError) return transitionError;

    const previousStatus = task.frontmatter.status;
    task.frontmatter.assignee = input.assignee;
    task.frontmatter.status = "in_progress";
    task.frontmatter.updated = new Date().toISOString();
    task.frontmatter.version += 1;

    try {
      await persistFileAndEvent({
        relativePath: input.task_id,
        previousContent: raw,
        nextContent: serializeTask(task),
        event: {
          event_type: "claim_task",
          task_id: input.task_id,
          actor: input.assignee,
          payload: {
            status: task.frontmatter.status,
            old_status: previousStatus,
            expected_version: input.expected_version,
            current_version: task.frontmatter.version,
          },
        },
        commitMessage: `coop: ${input.assignee} claimed - ${task.title}`,
        coopDir,
      });
    } catch (error) {
      const policyError = trustPolicyErrorToResult(error);
      if (policyError) return policyError;
      throw error;
    }

    try {
      await emitChat({
        topic: "tasks",
        actor: input.assignee,
        event: "claim_task",
        task_id: input.task_id,
        payload: { status: task.frontmatter.status },
      }, coopDir);
    } catch {}

    return JSON.stringify({ id: input.task_id, status: "in_progress", assignee: input.assignee, version: task.frontmatter.version });
  }, coopDir);
}

export async function coopUpdateTask(input: {
  task_id: string;
  status?: TaskStatus;
  comment?: string;
  assignee?: string;
  depends_on?: string[];
  expected_version?: number;
}): Promise<string> {
  const coopDir = getCoopDir();
  return withCanonicalMutationLock(async () => {
    const raw = await readFile(input.task_id, coopDir);
    const task = parseTask(raw, input.task_id);

    const versionConflict = ensureVersionMatch(task.frontmatter.version, input.expected_version);
    if (versionConflict) return versionConflict;

    const prevStatus = task.frontmatter.status;
    const prevAssignee = task.frontmatter.assignee;
    const prevDependsOn = [...task.frontmatter.depends_on];
    const trimmedComment = input.comment?.trim();

    const normalizedDependsOn = normalizeDependsOn(input.depends_on);
    if (normalizedDependsOn !== undefined) task.frontmatter.depends_on = normalizedDependsOn;

    if (input.status) {
      const transitionError = ensureTransitionAllowed(task.frontmatter.status, input.status);
      if (transitionError) return transitionError;

      if (input.status === "done") {
        const unresolved = await findUnresolvedDependencies(task.frontmatter.depends_on, coopDir);
        if (unresolved.length > 0) return JSON.stringify({ error: "unmet_dependencies", unresolved });
      }
      task.frontmatter.status = input.status;
    }

    if (input.assignee !== undefined) task.frontmatter.assignee = input.assignee;

    const changed =
      task.frontmatter.status !== prevStatus ||
      task.frontmatter.assignee !== prevAssignee ||
      !areDependsOnEqual(prevDependsOn, normalizedDependsOn);

    if (!changed && !trimmedComment) {
      return JSON.stringify({
        id: input.task_id,
        status: task.frontmatter.status,
        assignee: task.frontmatter.assignee,
        version: task.frontmatter.version,
        no_op: true,
      });
    }

    task.frontmatter.updated = new Date().toISOString();
    if (trimmedComment) {
      task.body += `\n\n---\n**[${task.frontmatter.assignee ?? "unknown"} @ ${task.frontmatter.updated}]**: ${trimmedComment}`;
    }
    task.frontmatter.version += 1;

    const statusChanged = task.frontmatter.status !== prevStatus;
    const updatePayload: Record<string, unknown> = {
      assignee: task.frontmatter.assignee,
      comment: trimmedComment,
      depends_on: task.frontmatter.depends_on,
      expected_version: input.expected_version,
      current_version: task.frontmatter.version,
    };
    if (statusChanged || input.status) updatePayload.status = task.frontmatter.status;

    const actor = input.assignee ?? task.frontmatter.assignee ?? task.frontmatter.created_by;
    try {
      await persistFileAndEvent({
        relativePath: input.task_id,
        previousContent: raw,
        nextContent: serializeTask(task),
        event: {
          event_type: "update_task",
          task_id: input.task_id,
          actor,
          payload: updatePayload,
        },
        commitMessage: `coop: update task - ${task.title}${input.status ? ` → ${input.status}` : ""}`,
        coopDir,
      });
    } catch (error) {
      const policyError = trustPolicyErrorToResult(error);
      if (policyError) return policyError;
      throw error;
    }

    try {
      await emitChat({
        topic: "tasks",
        actor,
        event: "update_task",
        task_id: input.task_id,
        payload: { status: task.frontmatter.status, assignee: task.frontmatter.assignee },
      }, coopDir);
    } catch {}

    if (task.frontmatter.status === "done") {
      await writeTaskCompletionMemory({
        taskId: input.task_id,
        title: task.title,
        assignee: task.frontmatter.assignee,
        summary: trimmedComment,
        tags: task.frontmatter.tags,
      });
    }

    return JSON.stringify({ id: input.task_id, status: task.frontmatter.status, assignee: task.frontmatter.assignee, version: task.frontmatter.version });
  }, coopDir);
}


export async function coopLogMilestone(input: {
  task_id: string;
  actor: string;
  milestone: string;
  status?: TaskStatus;
  expected_version?: number;
}): Promise<string> {
  const coopDir = getCoopDir();
  return withCanonicalMutationLock(async () => {
    const raw = await readFile(input.task_id, coopDir);
    const task = parseTask(raw, input.task_id);

    const versionConflict = ensureVersionMatch(task.frontmatter.version, input.expected_version);
    if (versionConflict) return versionConflict;

    let eventLogPath: string;
    try {
      eventLogPath = await appendEventLog({
        event_type: "milestone",
        task_id: input.task_id,
        actor: input.actor,
        payload: {
          milestone: input.milestone,
          status: input.status ?? task.frontmatter.status,
          expected_version: input.expected_version,
          current_version: task.frontmatter.version,
        },
      }, coopDir);
    } catch (error) {
      const policyError = trustPolicyErrorToResult(error);
      if (policyError) return policyError;
      throw error;
    }

    try {
      await emitChat({
        topic: "tasks",
        actor: input.actor,
        event: "milestone",
        task_id: input.task_id,
        payload: { milestone: input.milestone, status: input.status ?? task.frontmatter.status },
      }, coopDir);
    } catch {}

    await gitAddAndCommit([eventLogPath], `coop: milestone - ${task.title}`, coopDir);

    return JSON.stringify({
      id: input.task_id,
      milestone: input.milestone,
      status: input.status ?? task.frontmatter.status,
      version: task.frontmatter.version,
    });
  }, coopDir);
}

export async function coopGetTask(input: { task_id: string }): Promise<string> {
  const coopDir = getCoopDir();
  const raw = await readFile(input.task_id, coopDir);
  const task = parseTask(raw, input.task_id);
  const fm = task.frontmatter;

  return JSON.stringify({
    id: input.task_id,
    title: task.title,
    body: task.body,
    status: fm.status,
    priority: fm.priority,
    created_by: fm.created_by,
    assignee: fm.assignee,
    created: fm.created,
    updated: fm.updated,
    tags: fm.tags,
    depends_on: fm.depends_on,
    version: fm.version,
  });
}

export async function coopRecommendAgents(input: {
  title: string;
  tags?: string[];
  limit?: number;
}): Promise<string> {
  const recommendations = await recommendAgentsFromMemory({
    title: input.title,
    tags: input.tags,
    limit: input.limit,
  });

  return JSON.stringify({
    title: input.title,
    tags: input.tags ?? [],
    recommended_agents: recommendations,
  });
}

export async function coopListTasks(input: { status?: TaskStatus; assignee?: string; priority?: TaskPriority; tags?: string[]; }): Promise<string> {
  const coopDir = getCoopDir();
  const files = await listCoopFiles("tasks", coopDir);
  const results: Array<{id:string; title:string; status:TaskStatus; priority:TaskPriority; assignee:string|null; created_by:string; tags:string[]; updated:string; version:number;}> = [];

  for (const f of files) {
    try {
      const raw = await readFile(f, coopDir);
      const task = parseTask(raw, f);
      const fm = task.frontmatter;
      if (input.status && fm.status !== input.status) continue;
      if (input.assignee && fm.assignee !== input.assignee) continue;
      if (input.priority && fm.priority !== input.priority) continue;
      if (input.tags?.length && !input.tags.some((t) => fm.tags.includes(t))) continue;
      results.push({ id:f, title:task.title, status:fm.status, priority:fm.priority, assignee:fm.assignee, created_by:fm.created_by, tags:fm.tags, updated:fm.updated, version: fm.version });
    } catch {}
  }

  const priorityOrder: Record<TaskPriority, number> = { critical:0, high:1, medium:2, low:3 };
  results.sort((a,b) => priorityOrder[a.priority]-priorityOrder[b.priority]);
  return JSON.stringify({ count: results.length, tasks: results });
}

// Recalculate priorities for all open tasks (dynamic priority trigger)
export async function coopRecalculatePriorities(): Promise<string> {
  const coopDir = getCoopDir();
  const files = await listCoopFiles("tasks", coopDir);
  const allTasks: CoopTask[] = [];

  // Load all tasks
  for (const f of files) {
    try {
      const raw = await readFile(f, coopDir);
      const task = parseTask(raw, f);
      allTasks.push(task);
    } catch {}
  }

  const updates: Array<{id: string; oldPriority: TaskPriority; newPriority: TaskPriority}> = [];

  // Calculate dynamic priority for each open task
  for (const task of allTasks) {
    if (task.frontmatter.status !== "open") continue;

    const dynamicPriority = calculateDynamicPriority({
      basePriority: task.frontmatter.priority,
      createdAt: task.frontmatter.created,
      dependsOn: task.frontmatter.depends_on,
      allTasks,
    });

    if (dynamicPriority !== task.frontmatter.priority) {
      updates.push({
        id: task.filePath,
        oldPriority: task.frontmatter.priority,
        newPriority: dynamicPriority,
      });

      // Update the task file
      task.frontmatter.priority = dynamicPriority;
      task.frontmatter.updated = new Date().toISOString();
      await writeFile(task.filePath, serializeTask(task), coopDir);
    }
  }

  return JSON.stringify({
    recalculated: updates.length,
    updates,
    message: `Recalculated priorities for ${updates.length} tasks`
  });
}

// Dynamic Load Balancing API

/**
 * Get current load status of all workers
 */
export async function coopGetWorkerLoads(): Promise<string> {
  const coopDir = getCoopDir();
  const workers = await getWorkerLoads(coopDir);
  const variance = calculateLoadVariance(workers);

  // Sort by load score (lowest first = least loaded)
  workers.sort((a, b) => a.loadScore - b.loadScore);

  return JSON.stringify({
    workers,
    variance,
    balanced: variance < 0.2,
    message: variance < 0.2
      ? "Load is balanced"
      : `Load is unbalanced (variance: ${variance.toFixed(3)} >= 0.2)`,
  });
}

/**
 * Recommend the best worker for a new task based on current load
 */
export async function coopRecommendWorker(): Promise<string> {
  const coopDir = getCoopDir();
  const workers = await getWorkerLoads(coopDir);

  if (workers.length === 0) {
    return JSON.stringify({
      recommended: null,
      reason: "No workers found",
      workers: [],
    });
  }

  // Sort by load score (lowest first)
  workers.sort((a, b) => a.loadScore - b.loadScore);

  const best = workers[0];
  const variance = calculateLoadVariance(workers);

  return JSON.stringify({
    recommended: best.workerId,
    loadScore: best.loadScore,
    activeTasks: best.activeTasks,
    throughput: best.throughput,
    variance,
    allWorkers: workers.map(w => ({
      workerId: w.workerId,
      loadScore: w.loadScore,
      activeTasks: w.activeTasks,
      throughput: w.throughput,
    })),
  });
}

/**
 * Check load balance and generate alerts if thresholds exceeded
 */
export async function coopCheckLoadBalance(): Promise<string> {
  const coopDir = getCoopDir();
  const workers = await getWorkerLoads(coopDir);

  if (workers.length < 2) {
    return JSON.stringify({ balanced: true, message: "Not enough workers to check balance" });
  }

  const variance = calculateLoadVariance(workers);
  const activeLoads = workers.map(w => w.activeTasks);
  const loadGap = Math.max(...activeLoads) - Math.min(...activeLoads);

  // Config thresholds
  const varianceThreshold = 0.3;
  const gapThreshold = 2;

  const alerts: string[] = [];

  if (variance >= varianceThreshold) {
    alerts.push(`Load variance ${variance.toFixed(3)} exceeds threshold ${varianceThreshold}`);
  }

  if (loadGap > gapThreshold) {
    alerts.push(`Load gap ${loadGap} exceeds threshold ${gapThreshold}`);
  }

  return JSON.stringify({
    balanced: alerts.length === 0,
    variance: variance,
    loadGap: loadGap,
    varianceThreshold: varianceThreshold,
    gapThreshold: gapThreshold,
    alerts: alerts,
    workers: workers.map(w => ({
      workerId: w.workerId,
      activeTasks: w.activeTasks,
      loadScore: w.loadScore,
      throughput: w.throughput,
    })),
  });
}

export interface SendMessageInput {
  from: string;
  to?: string | null;
  kind?: MessageKind;
  subject: string;
  body: string;
  priority?: MessagePriority;
  task_id?: string;
  expected_task_version?: number;
  source_commit?: string;
  thread_id?: string;
  correlation_id?: string;
  reply_to?: string;
  requires_ack?: boolean;
  expires_at?: string;
  dedupe_key?: string;
  tags?: string[];
}

export type MessageReceiptStatus = "read" | "ack" | "reject";

interface MessageReceipt {
  schema: "agent-coop.message-receipt.v1";
  receipt_id: string;
  message_id: string;
  actor: string;
  status: MessageReceiptStatus;
  created: string;
  note: string | null;
  source_commit: string | null;
}

function messageReceiptPath(messageId: string, actor: string, status: MessageReceiptStatus): string {
  const digest = createHash("sha256").update(`${messageId}\0${actor}\0${status}`).digest("hex");
  return path.join("cooperation/message-receipts", `${digest}.json`);
}

async function findMessageById(messageId: string, coopDir: string): Promise<CoopMessage | null> {
  if (await fileExists(messageId, coopDir)) {
    try {
      return parseMessage(await readFile(messageId, coopDir), messageId);
    } catch {}
  }
  for (const file of await listCoopFiles("messages", coopDir)) {
    try {
      const message = parseMessage(await readFile(file, coopDir), file);
      if (message.frontmatter.message_id === messageId) return message;
    } catch {}
  }
  return null;
}

async function findMessageByDedupeKey(from: string, dedupeKey: string, coopDir: string): Promise<CoopMessage | null> {
  for (const file of await listCoopFiles("messages", coopDir)) {
    try {
      const message = parseMessage(await readFile(file, coopDir), file);
      if (message.frontmatter.from === from && message.frontmatter.dedupe_key === dedupeKey) return message;
    } catch {}
  }
  return null;
}

async function loadMessageReceipts(coopDir: string): Promise<Map<string, Map<string, Set<MessageReceiptStatus>>>> {
  const index = new Map<string, Map<string, Set<MessageReceiptStatus>>>();
  for (const file of await listFilesWithSuffix("cooperation/message-receipts", ".json", coopDir)) {
    try {
      const receipt = JSON.parse(await readFile(file, coopDir)) as MessageReceipt;
      if (!index.has(receipt.message_id)) index.set(receipt.message_id, new Map());
      const byActor = index.get(receipt.message_id)!;
      if (!byActor.has(receipt.actor)) byActor.set(receipt.actor, new Set());
      byActor.get(receipt.actor)!.add(receipt.status);
    } catch {}
  }
  return index;
}

async function validateMessageTaskBinding(
  taskId: string | undefined,
  expectedVersion: number | undefined,
  coopDir: string,
): Promise<string | null> {
  if (!taskId) return null;
  if (expectedVersion === undefined) {
    return JSON.stringify({
      error: "missing_expected_task_version",
      task_id: taskId,
      message: "Task-linked messages must bind to an observed task version.",
    });
  }
  try {
    const task = parseTask(await readFile(taskId, coopDir), taskId);
    return ensureVersionMatch(task.frontmatter.version, expectedVersion);
  } catch (error) {
    return JSON.stringify({
      error: "task_not_found",
      task_id: taskId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function coopSendMessage(input: SendMessageInput): Promise<string> {
  const coopDir = getCoopDir();
  const kind = input.kind ?? "notice";
  const subject = input.subject.trim();
  const body = input.body.trim();
  if (!subject || !body) {
    return JSON.stringify({ error: "invalid_message", message: "subject and body must be non-empty" });
  }
  const dedupeKey = input.dedupe_key?.trim() || randomUUID();
  const expiresAt = input.expires_at ?? null;
  if (expiresAt !== null) {
    const expiresAtMs = Date.parse(expiresAt);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
      return JSON.stringify({ error: "invalid_expires_at", expires_at: expiresAt });
    }
  }

  return withCanonicalMutationLock(async () => {
    const existing = await findMessageByDedupeKey(input.from, dedupeKey, coopDir);
    if (existing) {
      const samePayload = existing.frontmatter.to === (input.to ?? null)
        && existing.frontmatter.kind === kind
        && existing.frontmatter.task_id === (input.task_id ?? null)
        && existing.subject === subject
        && existing.body === body;
      if (!samePayload) {
        return JSON.stringify({
          error: "dedupe_conflict",
          dedupe_key: dedupeKey,
          existing_id: existing.frontmatter.message_id,
        });
      }
      return JSON.stringify({
        id: existing.frontmatter.message_id,
        subject: existing.subject,
        to: existing.frontmatter.to ?? "broadcast",
        deduplicated: true,
      });
    }

    const bindingError = await validateMessageTaskBinding(input.task_id, input.expected_task_version, coopDir);
    if (bindingError) return bindingError;

    const now = new Date().toISOString();
    const messageUuid = randomUUID();
    const relativePath = path.join(
      "cooperation/messages",
      `${slugify(input.from)}-${slugify(subject)}-${messageUuid}.md`,
    );
    const sourceCommit = input.source_commit ?? await getGitRevision("HEAD", coopDir);
    const msg: Omit<CoopMessage, "filePath"> = {
      frontmatter: {
        message_id: relativePath,
        kind,
        from: input.from,
        to: input.to ?? null,
        created: now,
        expires_at: expiresAt,
        priority: input.priority ?? "normal",
        task_id: input.task_id ?? null,
        expected_task_version: input.expected_task_version ?? null,
        source_commit: sourceCommit,
        thread_id: input.thread_id ?? input.task_id ?? relativePath,
        correlation_id: input.correlation_id ?? null,
        reply_to: input.reply_to ?? null,
        requires_ack: input.requires_ack ?? false,
        dedupe_key: dedupeKey,
        tags: input.tags ?? [],
        read_by: [],
      },
      subject,
      body,
    };

    try {
      await persistFileAndEvent({
        relativePath,
        previousContent: null,
        nextContent: serializeMessage(msg),
        event: {
          event_type: "send_message",
          message_id: relativePath,
          task_id: input.task_id,
          actor: input.from,
          trace_id: msg.frontmatter.thread_id,
          payload: {
            kind,
            to: input.to ?? null,
            subject,
            priority: msg.frontmatter.priority,
            requires_ack: msg.frontmatter.requires_ack,
            expected_task_version: msg.frontmatter.expected_task_version,
            source_commit: sourceCommit,
            dedupe_key: dedupeKey,
            tags: input.tags ?? [],
          },
        },
        commitMessage: `coop: ${kind} from ${input.from} - ${subject}`,
        coopDir,
      });
    } catch (error) {
      const policyError = trustPolicyErrorToResult(error);
      if (policyError) return policyError;
      throw error;
    }
    try {
      await emitChat({
        topic: "messages",
        actor: input.from,
        event: "send_message",
        message_id: relativePath,
        task_id: input.task_id,
        payload: { kind, to: input.to ?? null, subject },
      }, coopDir);
    } catch {}
    return JSON.stringify({
      id: relativePath,
      kind,
      subject,
      to: input.to ?? "broadcast",
      requires_ack: msg.frontmatter.requires_ack,
      deduplicated: false,
    });
  }, coopDir);
}

export async function coopAcknowledgeMessage(input: {
  message_id: string;
  actor: string;
  status?: MessageReceiptStatus;
  note?: string;
}): Promise<string> {
  const coopDir = getCoopDir();
  const status = input.status ?? "ack";
  const message = await findMessageById(input.message_id, coopDir);
  if (!message) return JSON.stringify({ error: "message_not_found", message_id: input.message_id });
  const fm = message.frontmatter;
  if (fm.to !== null && fm.to !== input.actor) {
    return JSON.stringify({ error: "not_message_recipient", message_id: fm.message_id, recipient: fm.to });
  }
  if (fm.expires_at && Date.parse(fm.expires_at) <= Date.now() && status !== "reject") {
    return JSON.stringify({ error: "message_expired", message_id: fm.message_id, expires_at: fm.expires_at });
  }
  if (status === "ack" && fm.task_id && fm.expected_task_version !== null) {
    const taskBindingError = await validateMessageTaskBinding(
      fm.task_id,
      fm.expected_task_version,
      coopDir,
    );
    if (taskBindingError) {
      const detail = JSON.parse(taskBindingError) as Record<string, unknown>;
      return JSON.stringify({ ...detail, error: "stale_message", message_id: fm.message_id });
    }
  }

  const receiptPath = messageReceiptPath(fm.message_id, input.actor, status);
  return withCanonicalMutationLock(async () => {
    if (await fileExists(receiptPath, coopDir)) {
      return JSON.stringify({
        message_id: fm.message_id,
        actor: input.actor,
        status,
        already_recorded: true,
      });
    }
    const now = new Date().toISOString();
    const sourceCommit = await getGitRevision("HEAD", coopDir);
    const receipt: MessageReceipt = {
      schema: "agent-coop.message-receipt.v1",
      receipt_id: path.basename(receiptPath, ".json"),
      message_id: fm.message_id,
      actor: input.actor,
      status,
      created: now,
      note: input.note?.trim() || null,
      source_commit: sourceCommit,
    };
    try {
      await persistFileAndEvent({
        relativePath: receiptPath,
        previousContent: null,
        nextContent: `${JSON.stringify(receipt, null, 2)}\n`,
        event: {
          event_type: `message_${status}`,
          message_id: fm.message_id,
          task_id: fm.task_id ?? undefined,
          actor: input.actor,
          trace_id: fm.thread_id,
          payload: {
            status,
            note: receipt.note,
            source_commit: sourceCommit,
            expected_task_version: fm.expected_task_version,
          },
        },
        commitMessage: `coop: ${input.actor} ${status} message - ${message.subject}`,
        coopDir,
      });
    } catch (error) {
      const policyError = trustPolicyErrorToResult(error);
      if (policyError) return policyError;
      throw error;
    }
    return JSON.stringify({
      message_id: fm.message_id,
      actor: input.actor,
      status,
      already_recorded: false,
    });
  }, coopDir);
}

export async function coopReadMessages(input: {
  recipient?: string;
  since?: string;
  kinds?: MessageKind[];
  task_id?: string;
  tags?: string[];
  include_expired?: boolean;
  mark_read_as?: string;
}): Promise<string> {
  const coopDir = getCoopDir();
  const files = await listCoopFiles("messages", coopDir);
  const receipts = await loadMessageReceipts(coopDir);
  const results: Array<Record<string, unknown>> = [];

  for (const file of files) {
    try {
      const message = parseMessage(await readFile(file, coopDir), file);
      const fm = message.frontmatter;
      const expired = Boolean(fm.expires_at && Date.parse(fm.expires_at) <= Date.now());
      if (input.recipient && fm.to !== null && fm.to !== input.recipient) continue;
      if (input.since && fm.created < input.since) continue;
      if (input.kinds?.length && !input.kinds.includes(fm.kind)) continue;
      if (input.task_id && fm.task_id !== input.task_id) continue;
      if (input.tags?.length && !input.tags.some((tag) => fm.tags.includes(tag))) continue;
      if (!input.include_expired && expired) continue;

      const receiptActor = input.recipient ?? input.mark_read_as;
      const statuses = receiptActor
        ? receipts.get(fm.message_id)?.get(receiptActor) ?? new Set<MessageReceiptStatus>()
        : new Set<MessageReceiptStatus>();
      const isRead = Boolean(
        receiptActor && (
          fm.read_by.includes(receiptActor)
          || statuses.has("read")
          || statuses.has("ack")
          || statuses.has("reject")
        )
      );
      results.push({
        id: fm.message_id,
        kind: fm.kind,
        from: fm.from,
        to: fm.to,
        subject: message.subject,
        body: message.body,
        created: fm.created,
        expires_at: fm.expires_at,
        expired,
        priority: fm.priority,
        task_id: fm.task_id,
        expected_task_version: fm.expected_task_version,
        source_commit: fm.source_commit,
        thread_id: fm.thread_id,
        correlation_id: fm.correlation_id,
        reply_to: fm.reply_to,
        requires_ack: fm.requires_ack,
        dedupe_key: fm.dedupe_key,
        tags: fm.tags,
        is_read: isRead,
        receipt_statuses: [...statuses].sort(),
      });
    } catch {}
  }

  results.sort((a, b) => String(a.created) > String(b.created) ? -1 : 1);
  if (input.mark_read_as) {
    for (const message of results) {
      const receiptResult = JSON.parse(await coopAcknowledgeMessage({
        message_id: String(message.id),
        actor: input.mark_read_as,
        status: "read",
      })) as { error?: string };
      if (!receiptResult.error) {
        message.is_read = true;
        const statuses = new Set(message.receipt_statuses as MessageReceiptStatus[]);
        statuses.add("read");
        message.receipt_statuses = [...statuses].sort();
      }
    }
  }

  return JSON.stringify({ count: results.length, messages: results });
}

export async function coopCheckInbox(input: {
  agent_id: string;
  fetch?: boolean;
  remote?: string;
  branch?: string;
}): Promise<string> {
  let globalState: Record<string, unknown> | null = null;
  try {
    globalState = JSON.parse(await coopGetGlobalState({
      fetch: input.fetch !== false,
      remote: input.remote,
      branch: input.branch,
    })) as Record<string, unknown>;
  } catch {}

  const openTasks = JSON.parse(await coopListTasks({ status: "open" }));
  const myTasks = JSON.parse(await coopListTasks({ status: "in_progress", assignee: input.agent_id }));
  const allMessages = JSON.parse(await coopReadMessages({ recipient: input.agent_id }));
  const unreadMessages = allMessages.messages.filter((message: { is_read?: boolean }) => !message.is_read);
  const revisionRelation = globalState?.revision_relation;
  const syncRequired = revisionRelation === "remote_ahead" || revisionRelation === "diverged";
  const publishRequired = revisionRelation === "local_ahead";

  return JSON.stringify({
    summary: {
      open_tasks: openTasks.count,
      my_active_tasks: myTasks.count,
      unread_messages: unreadMessages.length,
      sync_required: syncRequired,
      publish_required: publishRequired,
      reconciliation_required: revisionRelation === "diverged",
    },
    global_state: globalState,
    open_tasks: openTasks.tasks,
    my_active_tasks: myTasks.tasks,
    unread_messages: unreadMessages,
  });
}
