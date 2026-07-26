/**
 * AssistantMessageCheckpointer - debounced, per-message serialized persistence
 * of streaming assistant content.
 *
 * `schedule` arms a 1s debounce timer per message while deltas stream in;
 * `flush` cancels the timer and persists immediately (end of round, tool
 * boundaries). Writes for the same message are chained on a queue so an
 * earlier slow write can never clobber a later state. Every entry point
 * re-checks session tracking through the host so a cancelled or superseded
 * run stops persisting.
 */

import type {
  ChatMessage,
  ChatMessageStreamingState,
  ChatSession,
} from "../../../types/chat";

export interface AssistantMessageCheckpointHost {
  isSessionTracked(session: ChatSession, sessionRunId?: number): boolean;
  persistCheckpoint(
    session: ChatSession,
    message: ChatMessage,
    streamingState: ChatMessageStreamingState | null,
  ): Promise<void>;
}

const CHECKPOINT_DEBOUNCE_MS = 1000;

export class AssistantMessageCheckpointer {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private queues = new Map<string, Promise<void>>();

  constructor(private readonly host: AssistantMessageCheckpointHost) {}

  schedule(
    session: ChatSession,
    sessionRunId: number | undefined,
    message: ChatMessage,
  ): void {
    if (!this.host.isSessionTracked(session, sessionRunId)) {
      return;
    }
    if (this.timers.has(message.id)) {
      return;
    }

    const timer = setTimeout(() => {
      this.timers.delete(message.id);
      if (!this.host.isSessionTracked(session, sessionRunId)) {
        return;
      }
      void this.enqueue(session, sessionRunId, message, "in_progress");
    }, CHECKPOINT_DEBOUNCE_MS);
    this.timers.set(message.id, timer);
  }

  async flush(
    session: ChatSession,
    sessionRunId: number | undefined,
    message: ChatMessage,
    streamingState: ChatMessageStreamingState | null,
  ): Promise<void> {
    if (!this.host.isSessionTracked(session, sessionRunId)) {
      return;
    }
    const timer = this.timers.get(message.id);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(message.id);
    }

    await this.enqueue(session, sessionRunId, message, streamingState);
  }

  private async enqueue(
    session: ChatSession,
    sessionRunId: number | undefined,
    message: ChatMessage,
    streamingState: ChatMessageStreamingState | null,
  ): Promise<void> {
    if (!this.host.isSessionTracked(session, sessionRunId)) {
      return;
    }
    const previous = this.queues.get(message.id) || Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        if (!this.host.isSessionTracked(session, sessionRunId)) {
          return;
        }
        await this.host.persistCheckpoint(session, message, streamingState);
      });
    this.queues.set(message.id, next);

    try {
      await next;
    } finally {
      if (this.queues.get(message.id) === next) {
        this.queues.delete(message.id);
      }
    }
  }
}
