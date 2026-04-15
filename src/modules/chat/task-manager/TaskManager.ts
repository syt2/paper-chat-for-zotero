import type {
  TaskEvent,
  TaskEventType,
  TaskProgress,
  TaskRecord,
  TaskStatus,
  TaskType,
} from "../../../types/chat";
import { generateTimestampId } from "../../../utils/common";
import { getStorageDatabase } from "../db/StorageDatabase";

interface CreateTaskInput {
  type: TaskType;
  title: string;
  sessionId?: string;
  sourceMessageId?: string;
  executionPlanId?: string;
  parentTaskId?: string;
  progress?: TaskProgress;
  input?: Record<string, unknown>;
}

interface UpdateTaskInput {
  status?: TaskStatus;
  title?: string;
  progress?: TaskProgress;
  output?: Record<string, unknown>;
  error?: string | null;
  startedAt?: number | null;
  completedAt?: number | null;
  cancelledAt?: number | null;
}

export class TaskManager {
  async createTask(input: CreateTaskInput): Promise<TaskRecord> {
    const db = await getStorageDatabase().ensureInit();
    const now = Date.now();
    const task: TaskRecord = {
      id: generateTimestampId(),
      type: input.type,
      status: "pending",
      title: input.title,
      sessionId: input.sessionId,
      sourceMessageId: input.sourceMessageId,
      executionPlanId: input.executionPlanId,
      parentTaskId: input.parentTaskId,
      progress: input.progress,
      input: input.input,
      createdAt: now,
      updatedAt: now,
    };

    await db.queryAsync(
      `INSERT INTO tasks
       (id, type, status, title, session_id, source_message_id, execution_plan_id, parent_task_id, progress, input, output, error, created_at, updated_at, started_at, completed_at, cancelled_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        task.id,
        task.type,
        task.status,
        task.title,
        task.sessionId || null,
        task.sourceMessageId || null,
        task.executionPlanId || null,
        task.parentTaskId || null,
        task.progress ? JSON.stringify(task.progress) : null,
        task.input ? JSON.stringify(task.input) : null,
        null,
        null,
        task.createdAt,
        task.updatedAt,
        null,
        null,
        null,
      ],
    );

    await this.appendTaskEvent(task.id, "created", {
      type: task.type,
      title: task.title,
    });

    return task;
  }

  async getTask(taskId: string): Promise<TaskRecord | null> {
    const db = await getStorageDatabase().ensureInit();
    const rows = (await db.queryAsync(
      "SELECT * FROM tasks WHERE id = ?",
      [taskId],
    )) || [];

    if (rows.length === 0) {
      return null;
    }

    return this.mapTaskRow(rows[0]);
  }

  async listTasks(options: {
    sessionId?: string;
    statuses?: TaskStatus[];
    limit?: number;
  } = {}): Promise<TaskRecord[]> {
    const db = await getStorageDatabase().ensureInit();
    const where: string[] = [];
    const params: unknown[] = [];

    if (options.sessionId) {
      where.push("session_id = ?");
      params.push(options.sessionId);
    }

    if (options.statuses && options.statuses.length > 0) {
      where.push(
        `status IN (${options.statuses.map(() => "?").join(", ")})`,
      );
      params.push(...options.statuses);
    }

    const sql = [
      "SELECT * FROM tasks",
      where.length > 0 ? `WHERE ${where.join(" AND ")}` : "",
      "ORDER BY updated_at DESC",
      options.limit ? "LIMIT ?" : "",
    ]
      .filter(Boolean)
      .join(" ");

    if (options.limit) {
      params.push(options.limit);
    }

    const rows = (await db.queryAsync(sql, params)) || [];
    return rows.map((row) => this.mapTaskRow(row));
  }

  async listTaskEvents(taskId: string): Promise<TaskEvent[]> {
    const db = await getStorageDatabase().ensureInit();
    const rows = (await db.queryAsync(
      "SELECT * FROM task_events WHERE task_id = ? ORDER BY created_at ASC",
      [taskId],
    )) || [];
    return rows.map((row) => this.mapTaskEventRow(row));
  }

  async startTask(taskId: string, progress?: TaskProgress): Promise<TaskRecord | null> {
    const now = Date.now();
    const task = await this.updateTask(taskId, {
      status: "running",
      progress,
      startedAt: now,
      completedAt: null,
      cancelledAt: null,
      error: null,
    });
    if (task) {
      await this.appendTaskEvent(taskId, "started", {
        progress,
      });
    }
    return task;
  }

  async requestCancelTask(taskId: string, reason?: string): Promise<TaskRecord | null> {
    const task = await this.updateTask(taskId, {
      status: "cancel_requested",
      error: reason || null,
    });
    if (task) {
      await this.appendTaskEvent(taskId, "cancel_requested", {
        reason,
      });
    }
    return task;
  }

  async cancelTask(taskId: string, reason?: string): Promise<TaskRecord | null> {
    const now = Date.now();
    const task = await this.updateTask(taskId, {
      status: "cancelled",
      error: reason || null,
      cancelledAt: now,
      completedAt: now,
    });
    if (task) {
      await this.appendTaskEvent(taskId, "cancelled", {
        reason,
      });
    }
    return task;
  }

  async completeTask(
    taskId: string,
    output?: Record<string, unknown>,
  ): Promise<TaskRecord | null> {
    const now = Date.now();
    const task = await this.updateTask(taskId, {
      status: "completed",
      output,
      error: null,
      completedAt: now,
    });
    if (task) {
      await this.appendTaskEvent(taskId, "completed", {
        output,
      });
    }
    return task;
  }

  async failTask(taskId: string, error: string): Promise<TaskRecord | null> {
    const now = Date.now();
    const task = await this.updateTask(taskId, {
      status: "failed",
      error,
      completedAt: now,
    });
    if (task) {
      await this.appendTaskEvent(taskId, "failed", {
        error,
      });
    }
    return task;
  }

  async updateTaskProgress(
    taskId: string,
    progress: TaskProgress,
  ): Promise<TaskRecord | null> {
    const task = await this.updateTask(taskId, {
      progress,
    });
    if (task) {
      await this.appendTaskEvent(taskId, "progress", {
        current: progress.current,
        total: progress.total,
        label: progress.label,
      });
    }
    return task;
  }

  async recoverInterruptedTasks(sessionId?: string): Promise<TaskRecord[]> {
    const recoverable = await this.listTasks({
      sessionId,
      statuses: ["running", "cancel_requested"],
    });

    const recovered: TaskRecord[] = [];
    for (const task of recoverable) {
      const status = task.status === "cancel_requested" ? "cancelled" : "failed";
      const message =
        task.status === "cancel_requested"
          ? "Task cancellation completed during recovery."
          : "Task was interrupted before completion.";
      const next = await this.updateTask(task.id, {
        status,
        error: task.status === "cancel_requested" ? task.error || null : message,
        cancelledAt: task.status === "cancel_requested" ? Date.now() : task.cancelledAt ?? null,
        completedAt: Date.now(),
      });
      if (next) {
        await this.appendTaskEvent(task.id, "recovered", {
          previousStatus: task.status,
          recoveredStatus: status,
        });
        recovered.push(next);
      }
    }

    return recovered;
  }

  private async updateTask(
    taskId: string,
    input: UpdateTaskInput,
  ): Promise<TaskRecord | null> {
    const existing = await this.getTask(taskId);
    if (!existing) {
      return null;
    }

    const updated: TaskRecord = {
      ...existing,
      status: input.status ?? existing.status,
      title: input.title ?? existing.title,
      progress: input.progress ?? existing.progress,
      output: input.output ?? existing.output,
      error:
        input.error === null
          ? undefined
          : input.error !== undefined
            ? input.error
            : existing.error,
      updatedAt: Date.now(),
      startedAt:
        input.startedAt === null
          ? undefined
          : input.startedAt !== undefined
            ? input.startedAt
            : existing.startedAt,
      completedAt:
        input.completedAt === null
          ? undefined
          : input.completedAt !== undefined
            ? input.completedAt
            : existing.completedAt,
      cancelledAt:
        input.cancelledAt === null
          ? undefined
          : input.cancelledAt !== undefined
            ? input.cancelledAt
            : existing.cancelledAt,
    };

    const db = await getStorageDatabase().ensureInit();
    await db.queryAsync(
      `UPDATE tasks SET
        status = ?,
        title = ?,
        progress = ?,
        output = ?,
        error = ?,
        updated_at = ?,
        started_at = ?,
        completed_at = ?,
        cancelled_at = ?
      WHERE id = ?`,
      [
        updated.status,
        updated.title,
        updated.progress ? JSON.stringify(updated.progress) : null,
        updated.output ? JSON.stringify(updated.output) : null,
        updated.error || null,
        updated.updatedAt,
        updated.startedAt ?? null,
        updated.completedAt ?? null,
        updated.cancelledAt ?? null,
        taskId,
      ],
    );

    return updated;
  }

  private async appendTaskEvent(
    taskId: string,
    type: TaskEventType,
    payload?: Record<string, unknown>,
  ): Promise<TaskEvent> {
    const db = await getStorageDatabase().ensureInit();
    const event: TaskEvent = {
      id: generateTimestampId(),
      taskId,
      type,
      payload,
      createdAt: Date.now(),
    };

    await db.queryAsync(
      `INSERT INTO task_events (id, task_id, type, payload, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [
        event.id,
        event.taskId,
        event.type,
        event.payload ? JSON.stringify(event.payload) : null,
        event.createdAt,
      ],
    );

    return event;
  }
  private mapTaskRow(row: any): TaskRecord {
    return {
      id: row.id,
      type: row.type,
      status: row.status,
      title: row.title,
      sessionId: row.session_id || undefined,
      sourceMessageId: row.source_message_id || undefined,
      executionPlanId: row.execution_plan_id || undefined,
      parentTaskId: row.parent_task_id || undefined,
      progress: row.progress ? JSON.parse(row.progress) : undefined,
      input: row.input ? JSON.parse(row.input) : undefined,
      output: row.output ? JSON.parse(row.output) : undefined,
      error: row.error || undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      startedAt: row.started_at ?? undefined,
      completedAt: row.completed_at ?? undefined,
      cancelledAt: row.cancelled_at ?? undefined,
    };
  }

  private mapTaskEventRow(row: any): TaskEvent {
    return {
      id: row.id,
      taskId: row.task_id,
      type: row.type,
      payload: row.payload ? JSON.parse(row.payload) : undefined,
      createdAt: row.created_at,
    };
  }
}

let taskManager: TaskManager | null = null;

export function getTaskManager(): TaskManager {
  if (!taskManager) {
    taskManager = new TaskManager();
  }
  return taskManager;
}
