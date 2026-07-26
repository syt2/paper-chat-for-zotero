/**
 * UserInputRequestCoordinator - lifecycle of `request_user_input` tool calls.
 *
 * Owns the pending-resolver registry that bridges the agent loop (which
 * blocks on an answer) and the UI (which resolves, cancels, or lets a
 * request auto-expire). The host (AgentRuntime) supplies persistence,
 * session-tracking, runtime-event emission, and execution-plan updates.
 */

import type {
  AgentRuntimeEvent,
  AgentRuntimeEventType,
  ChatMessage,
  ChatSession,
  UserInputRequest,
} from "../../../types/chat";
import type {
  RequestUserInputResponse,
  ToolCall,
  ToolExecutionResult,
} from "../../../types/tool";
import { formatToolError } from "../tool-errors/ToolErrorFormatter";
import {
  createAutoResolvedUserInputResponse,
  createCancelledUserInputResponse,
  formatUserInputToolResult,
  normalizeRequestUserInputArgs,
} from "../user-input-request";
import {
  applyNoteSummaryDestinationResponse,
  type NoteSummaryContext,
} from "../note-summary-destination";

export type RuntimeEventPayload<T extends AgentRuntimeEventType> = Omit<
  Extract<AgentRuntimeEvent, { type: T }>,
  "sessionId" | "assistantMessageId" | "timestamp" | "planId"
>;

interface PendingUserInputResolver {
  request: UserInputRequest;
  session: ChatSession;
  sessionRunId?: number;
  timer?: ReturnType<typeof setTimeout>;
  resolve: (resolution: {
    response: RequestUserInputResponse;
    status: "resolved" | "cancelled" | "expired";
  }) => void;
}

function formatRequestUserInputValidationFix(issues: string[]): string {
  const issueText = issues.join(" | ");
  if (/secret.*defaultValue|defaultValue.*secret/i.test(issueText)) {
    return "Retry request_user_input with the same secret question but remove defaultValue. Secret fields must be entered by the user and cannot be auto-filled or auto-resolved.";
  }
  if (/autoResolutionMs/i.test(issueText)) {
    return "Retry with autoResolutionMs only if every required question has a recommended option or non-secret defaultValue; otherwise omit autoResolutionMs.";
  }
  if (/at most 3/i.test(issueText)) {
    return "Retry with at most three concise questions, or ask only the single most important decision.";
  }
  return "Retry with a smaller request_user_input payload that matches the schema, changing the invalid arguments before retrying.";
}

/** Runtime services the coordinator borrows from AgentRuntime. */
export interface UserInputRequestHost {
  persistUserInputRequestState(session: ChatSession): Promise<void>;
  /** Refresh plan/messages in the UI when the session is the active one. */
  notifySessionUpdated(session: ChatSession): void;
  ensureSessionTracked(session: ChatSession, sessionRunId?: number): void;
  emitRuntimeEvent<T extends AgentRuntimeEventType>(
    session: ChatSession,
    sessionRunId: number | undefined,
    assistantMessage: ChatMessage,
    event: RuntimeEventPayload<T>,
  ): void;
  addUserInputPlanStep(
    session: ChatSession,
    currentMessages: ChatMessage[],
    toolCallId: string,
    description: string,
  ): void;
}

export class UserInputRequestCoordinator {
  private pendingUserInputResolvers = new Map<
    string,
    PendingUserInputResolver
  >();
  private userInputRequestCounter = 0;

  constructor(private readonly host: UserInputRequestHost) {}

  resolveUserInputRequest(
    requestId: string,
    response: RequestUserInputResponse,
  ): boolean {
    const pending = this.pendingUserInputResolvers.get(requestId);
    if (!pending) {
      return false;
    }
    this.resolvePendingUserInputRequest(pending, response, "resolved");
    return true;
  }

  cancelPendingUserInputRequests(sessionId: string): number {
    let cancelled = 0;
    for (const pending of [...this.pendingUserInputResolvers.values()]) {
      if (pending.request.sessionId !== sessionId) {
        continue;
      }
      this.resolvePendingUserInputRequest(
        pending,
        createCancelledUserInputResponse(pending.request.args),
        "cancelled",
      );
      cancelled++;
    }
    return cancelled;
  }

  async executeUserInputRequest(
    session: ChatSession,
    sessionRunId: number | undefined,
    currentMessages: ChatMessage[],
    assistantMessage: ChatMessage,
    toolCall: ToolCall,
    iteration: number,
    noteSummaryContext?: NoteSummaryContext,
  ): Promise<ToolExecutionResult> {
    let parsedArgs: unknown;
    try {
      parsedArgs = JSON.parse(toolCall.function.arguments || "{}");
    } catch {
      return {
        toolCall,
        status: "failed",
        policyTrace: [
          {
            stage: "scheduler",
            policy: "argument_parse",
            outcome: "blocked",
            summary:
              "Blocked request_user_input because arguments were not valid JSON.",
          },
        ],
        content: formatToolError({
          summary: "Invalid arguments for request_user_input.",
          category: "invalid_arguments",
          retryable: true,
          cause: "Arguments must be valid JSON.",
          suggestedFix:
            "Retry with a valid JSON object matching the request_user_input schema.",
          saferAlternative:
            "Continue without blocking user input if a safe default exists.",
        }),
        error: "Invalid JSON arguments.",
      };
    }

    const normalized = normalizeRequestUserInputArgs(
      parsedArgs,
      noteSummaryContext ? { maxOptions: 100 } : undefined,
    );
    if (!normalized.ok) {
      return {
        toolCall,
        status: "failed",
        policyTrace: [
          {
            stage: "scheduler",
            policy: "argument_validation",
            outcome: "blocked",
            summary:
              "Blocked request_user_input because arguments did not satisfy the schema.",
            detail: normalized.issues.join(" | "),
          },
        ],
        content: formatToolError({
          summary: "Invalid arguments for request_user_input.",
          category: "invalid_arguments",
          retryable: true,
          cause: normalized.issues.join(" | "),
          suggestedFix: formatRequestUserInputValidationFix(normalized.issues),
          saferAlternative:
            "Do not ask the user if a safe default exists; otherwise ask with a simpler valid request.",
        }),
        error: "Invalid request_user_input arguments.",
      };
    }

    this.host.ensureSessionTracked(session, sessionRunId);
    this.host.addUserInputPlanStep(
      session,
      currentMessages,
      toolCall.id,
      normalized.args.questions[0]?.question || "Waiting for user input",
    );

    const request = this.createUserInputRequest(
      session,
      assistantMessage,
      toolCall,
      normalized.args,
    );
    await this.addPendingUserInputRequest(session, request);

    this.host.emitRuntimeEvent<"tool_started">(
      session,
      sessionRunId,
      assistantMessage,
      {
        type: "tool_started",
        toolCallId: toolCall.id,
        toolName: toolCall.function.name,
        args: toolCall.function.arguments,
        iteration,
      },
    );
    this.host.emitRuntimeEvent<"user_input_requested">(
      session,
      sessionRunId,
      assistantMessage,
      {
        type: "user_input_requested",
        requestId: request.id,
        toolCallId: toolCall.id,
        questionCount: request.args.questions.length,
        autoResolutionMs: request.args.autoResolutionMs,
        pendingCount:
          session.userInputRequestState?.pendingRequests.length || 0,
        iteration,
      },
    );

    const resolution = await this.waitForUserInputResolution(
      session,
      sessionRunId,
      request,
    );
    this.host.ensureSessionTracked(session, sessionRunId);
    if (noteSummaryContext) {
      applyNoteSummaryDestinationResponse(
        noteSummaryContext,
        resolution.response,
      );
    }

    this.host.emitRuntimeEvent<"user_input_resolved">(
      session,
      sessionRunId,
      assistantMessage,
      {
        type: "user_input_resolved",
        requestId: request.id,
        toolCallId: toolCall.id,
        status: resolution.status,
        pendingCount:
          session.userInputRequestState?.pendingRequests.length || 0,
        iteration,
      },
    );

    return {
      toolCall,
      args: normalized.args as unknown as Record<string, unknown>,
      status: "completed",
      content: formatUserInputToolResult(resolution.response),
    };
  }

  private createUserInputRequest(
    session: ChatSession,
    assistantMessage: ChatMessage,
    toolCall: ToolCall,
    args: UserInputRequest["args"],
  ): UserInputRequest {
    this.userInputRequestCounter += 1;
    const now = Date.now();
    return {
      id: `user-input-${now}-${this.userInputRequestCounter}`,
      sessionId: session.id,
      assistantMessageId: assistantMessage.id,
      toolCallId: toolCall.id,
      toolName: "request_user_input",
      args,
      status: "pending",
      createdAt: now,
      updatedAt: now,
      expiresAt: args.autoResolutionMs
        ? now + args.autoResolutionMs
        : undefined,
    };
  }

  private async addPendingUserInputRequest(
    session: ChatSession,
    request: UserInputRequest,
  ): Promise<void> {
    const pendingRequests = [
      ...(session.userInputRequestState?.pendingRequests || []).filter(
        (entry) => entry.id !== request.id,
      ),
      request,
    ].sort((a, b) => a.createdAt - b.createdAt);
    session.userInputRequestState = {
      pendingRequests,
      updatedAt: Date.now(),
    };
    await this.host.persistUserInputRequestState(session);
    this.host.notifySessionUpdated(session);
  }

  private async waitForUserInputResolution(
    session: ChatSession,
    sessionRunId: number | undefined,
    request: UserInputRequest,
  ): Promise<{
    response: RequestUserInputResponse;
    status: "resolved" | "cancelled" | "expired";
  }> {
    this.host.ensureSessionTracked(session, sessionRunId);
    return new Promise((resolve) => {
      const pending: PendingUserInputResolver = {
        request,
        session,
        sessionRunId,
        resolve,
      };
      if (request.args.autoResolutionMs) {
        pending.timer = setTimeout(() => {
          this.resolvePendingUserInputRequest(
            pending,
            createAutoResolvedUserInputResponse(request.args),
            "expired",
          );
        }, request.args.autoResolutionMs);
      }
      this.pendingUserInputResolvers.set(request.id, pending);
    });
  }

  private resolvePendingUserInputRequest(
    pending: PendingUserInputResolver,
    response: RequestUserInputResponse,
    status: "resolved" | "cancelled" | "expired",
  ): void {
    if (!this.pendingUserInputResolvers.has(pending.request.id)) {
      return;
    }
    this.pendingUserInputResolvers.delete(pending.request.id);
    if (pending.timer) {
      clearTimeout(pending.timer);
    }

    const now = Date.now();
    const nextPendingRequests = (
      pending.session.userInputRequestState?.pendingRequests || []
    ).filter((entry) => entry.id !== pending.request.id);
    pending.session.userInputRequestState =
      nextPendingRequests.length > 0
        ? {
            pendingRequests: nextPendingRequests,
            updatedAt: now,
          }
        : undefined;
    pending.request.status = status;
    pending.request.updatedAt = now;
    pending.request.resolution = response;
    void this.host
      .persistUserInputRequestState(pending.session)
      .catch((error) => {
        ztoolkit.log(
          "[UserInputRequestCoordinator] Failed to persist user-input request state:",
          error,
        );
      });
    this.host.notifySessionUpdated(pending.session);
    pending.resolve({ response, status });
  }
}
