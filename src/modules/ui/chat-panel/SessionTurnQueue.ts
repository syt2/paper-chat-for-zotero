import type { AttachmentState } from "./types";

export const MAX_QUEUED_TURNS = 3;

export interface TurnRunResult {
  accepted: boolean;
  errorId?: string;
  retry?: () => Promise<TurnRunResult>;
}

export interface QueuedTurn {
  id: string;
  content: string;
  draft: {
    content: string;
    attachmentState: AttachmentState;
  };
  run: () => Promise<TurnRunResult>;
  cancel: () => Promise<boolean>;
  onError?: (error: unknown) => void;
}

export interface SessionTurnQueueSnapshot {
  status: "idle" | "running" | "paused";
  queued: readonly QueuedTurn[];
  failureErrorId?: string;
}

interface FailureState {
  turn: QueuedTurn;
  errorId?: string;
  retry?: () => Promise<TurnRunResult>;
}

interface SessionState {
  active?: QueuedTurn;
  queued: QueuedTurn[];
  failure?: FailureState;
  cancellation?: Promise<boolean>;
}

type Listener = (sessionId: string) => void;

export class SessionTurnQueue {
  private states = new Map<string, SessionState>();
  private listeners = new Set<Listener>();

  enqueue(sessionId: string, turn: QueuedTurn): boolean {
    const state = this.getState(sessionId);
    if (state.queued.length >= MAX_QUEUED_TURNS) return false;

    state.queued.push(turn);
    state.failure = undefined;
    this.pump(sessionId, state);
    this.notify(sessionId);
    return true;
  }

  snapshot(sessionId: string): SessionTurnQueueSnapshot {
    const state = this.states.get(sessionId);
    return {
      status: state?.active ? "running" : state?.failure ? "paused" : "idle",
      queued: state ? [...state.queued] : [],
      failureErrorId: state?.failure?.errorId,
    };
  }

  remove(sessionId: string, turnId: string): QueuedTurn | null {
    const state = this.states.get(sessionId);
    if (!state) return null;

    const index = state.queued.findIndex((turn) => turn.id === turnId);
    if (index < 0) return null;
    const [turn] = state.queued.splice(index, 1);
    if (state.failure?.turn === turn) {
      state.failure = undefined;
      this.pump(sessionId, state);
    }
    this.notify(sessionId);
    this.prune(sessionId, state);
    return turn;
  }

  async stop(sessionId: string): Promise<boolean> {
    const state = this.states.get(sessionId);
    return state ? this.cancelActive(sessionId, state) : false;
  }

  async guide(sessionId: string, turnId: string): Promise<boolean> {
    const state = this.states.get(sessionId);
    if (!state) return false;

    const index = state.queued.findIndex((turn) => turn.id === turnId);
    if (index < 0) return false;
    const [turn] = state.queued.splice(index, 1);
    state.queued.unshift(turn);
    state.failure = undefined;
    this.notify(sessionId);

    if (state.active) await this.cancelActive(sessionId, state);
    else this.pump(sessionId, state);
    return true;
  }

  async retry(sessionId: string, errorId: string): Promise<boolean> {
    const state = this.states.get(sessionId);
    const failure = state?.failure;
    if (
      !state ||
      state.active ||
      !failure?.retry ||
      failure.errorId !== errorId
    ) {
      return false;
    }

    state.failure = undefined;
    await this.start(sessionId, state, failure.turn, failure.retry);
    return true;
  }

  clear(sessionId: string): void {
    if (!this.states.delete(sessionId)) return;
    this.notify(sessionId);
  }

  clearAll(): void {
    const sessionIds = [...this.states.keys()];
    this.states.clear();
    for (const sessionId of sessionIds) this.notify(sessionId);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private getState(sessionId: string): SessionState {
    let state = this.states.get(sessionId);
    if (!state) {
      state = { queued: [] };
      this.states.set(sessionId, state);
    }
    return state;
  }

  private pump(sessionId: string, state: SessionState): void {
    if (state.active || state.failure) return;
    const turn = state.queued.shift();
    if (!turn) {
      this.prune(sessionId, state);
      return;
    }
    void this.start(sessionId, state, turn, turn.run);
  }

  private async cancelActive(
    sessionId: string,
    state: SessionState,
  ): Promise<boolean> {
    if (state.cancellation) return state.cancellation;
    const active = state.active;
    if (!active) return false;

    const cancellation = (async () => {
      const cancelled = await active.cancel();
      if (
        cancelled &&
        this.states.get(sessionId) === state &&
        state.active === active
      ) {
        state.active = undefined;
        this.pump(sessionId, state);
        this.notify(sessionId);
      }
      return cancelled;
    })();
    state.cancellation = cancellation;
    try {
      return await cancellation;
    } finally {
      if (state.cancellation === cancellation) state.cancellation = undefined;
    }
  }

  private async start(
    sessionId: string,
    state: SessionState,
    turn: QueuedTurn,
    run: () => Promise<TurnRunResult>,
  ): Promise<void> {
    state.active = turn;
    this.notify(sessionId);

    try {
      const result = await run();
      if (this.states.get(sessionId) !== state || state.active !== turn) {
        return;
      }
      if (result.errorId) {
        state.failure = {
          turn,
          errorId: result.errorId,
          retry: result.retry,
        };
      } else if (!result.accepted) {
        state.queued.unshift(turn);
        state.failure = { turn };
      }
    } catch (error) {
      if (this.states.get(sessionId) !== state || state.active !== turn) {
        return;
      }
      state.queued.unshift(turn);
      state.failure = { turn };
      turn.onError?.(error);
    } finally {
      if (this.states.get(sessionId) === state && state.active === turn) {
        state.active = undefined;
        this.pump(sessionId, state);
        this.notify(sessionId);
      }
    }
  }

  private prune(sessionId: string, state: SessionState): void {
    if (!state.active && !state.failure && state.queued.length === 0) {
      if (this.states.get(sessionId) === state) this.states.delete(sessionId);
    }
  }

  private notify(sessionId: string): void {
    for (const listener of this.listeners) {
      try {
        listener(sessionId);
      } catch {
        // Detached panels must not interrupt queue progress.
      }
    }
  }
}

export const sessionTurnQueue = new SessionTurnQueue();
