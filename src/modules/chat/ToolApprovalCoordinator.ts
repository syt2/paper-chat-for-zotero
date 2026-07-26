/**
 * ToolApprovalCoordinator - keeps a session's persisted tool-approval and
 * user-input-request state in sync with the ToolPermissionManager.
 *
 * Handles approval-observer events (request added/resolved on the tracked
 * session, persisted, surfaced as runtime events) and the reconcile passes
 * run when a session is created, forked, switched, or deleted.
 */

import type {
  AgentRuntimeEvent,
  ChatSession,
  ToolApprovalState,
} from "../../types/chat";
import type {
  ToolApprovalRequest,
  ToolPermissionDecision,
} from "../../types/tool";
import { getToolPermissionManager } from "./tool-permissions";
import type { SessionStorageService } from "./SessionStorageService";

/** ChatManager services the coordinator borrows. */
export interface ToolApprovalHost {
  getTrackedSessionById(sessionId?: string): ChatSession | null;
  getSessionStorage(): SessionStorageService;
  isSessionActive(session: ChatSession): boolean;
  isSessionRunActive(sessionId: string): boolean;
  notifyExecutionPlanUpdate(session: ChatSession): void;
  emitRuntimeEvent(event: AgentRuntimeEvent): void;
}

export class ToolApprovalCoordinator {
  constructor(private readonly host: ToolApprovalHost) {}

  handleApprovalRequested(approvalRequest: ToolApprovalRequest): void {
    const session = this.host.getTrackedSessionById(
      approvalRequest.request.sessionId,
    );
    if (!session) {
      return;
    }

    const pendingRequests = [
      ...(session.toolApprovalState?.pendingRequests || []).filter(
        (entry) => entry.id !== approvalRequest.id,
      ),
      approvalRequest,
    ].sort((a, b) => a.createdAt - b.createdAt);

    session.toolApprovalState = {
      pendingRequests,
      updatedAt: Date.now(),
    };
    this.persistApprovalState(session);
    this.notifyApprovalStateChanged(session);
    this.emitApprovalRuntimeEvent(
      session,
      {
        type: "approval_requested",
        requestId: approvalRequest.id,
        toolCallId: approvalRequest.request.toolCall.id,
        toolName: approvalRequest.toolName,
        riskLevel: approvalRequest.descriptor.riskLevel,
        pendingCount: pendingRequests.length,
      },
      approvalRequest.assistantMessageId,
    );
  }

  handleApprovalResolved(
    approvalRequest: ToolApprovalRequest,
    decision: ToolPermissionDecision,
  ): void {
    const session = this.host.getTrackedSessionById(
      approvalRequest.request.sessionId,
    );
    if (!session) {
      return;
    }

    const pendingRequests = (
      session.toolApprovalState?.pendingRequests || []
    ).filter((entry) => entry.id !== approvalRequest.id);

    session.toolApprovalState =
      pendingRequests.length > 0
        ? {
            pendingRequests,
            updatedAt: Date.now(),
          }
        : undefined;

    this.persistApprovalState(session);
    this.notifyApprovalStateChanged(session);
    this.emitApprovalRuntimeEvent(
      session,
      {
        type: "approval_resolved",
        requestId: approvalRequest.id,
        toolCallId: approvalRequest.request.toolCall.id,
        toolName: approvalRequest.toolName,
        verdict: decision.verdict,
        scope: decision.scope,
        pendingCount: pendingRequests.length,
      },
      approvalRequest.assistantMessageId,
    );
  }

  reconcileApprovalState(session: ChatSession | null): void {
    if (!session) {
      return;
    }

    const pendingRequests = getToolPermissionManager().listPendingApprovals(
      session.id,
    );
    const normalizedState: ToolApprovalState | undefined =
      pendingRequests.length > 0
        ? {
            pendingRequests,
            updatedAt: Date.now(),
          }
        : undefined;

    const currentIds = (session.toolApprovalState?.pendingRequests || [])
      .map((entry) => entry.id)
      .sort();
    const normalizedIds = pendingRequests.map((entry) => entry.id).sort();
    const isSameState =
      currentIds.length === normalizedIds.length &&
      currentIds.every((id, index) => id === normalizedIds[index]);

    if (isSameState && !!session.toolApprovalState === !!normalizedState) {
      return;
    }

    session.toolApprovalState = normalizedState;
    this.persistApprovalState(session);
  }

  reconcileUserInputRequestState(session: ChatSession | null): void {
    if (!session?.userInputRequestState?.pendingRequests.length) {
      return;
    }
    if (this.host.isSessionRunActive(session.id)) {
      return;
    }
    session.userInputRequestState = undefined;
    this.host
      .getSessionStorage()
      .updateSessionUserInputRequestState(session)
      .catch((error) => {
        ztoolkit.log(
          "[ToolApprovalCoordinator] Failed to clear stale user-input request state:",
          error,
        );
      });
  }

  private persistApprovalState(session: ChatSession): void {
    this.host
      .getSessionStorage()
      .updateSessionApprovalState(session)
      .catch((error) => {
        ztoolkit.log(
          "[ToolApprovalCoordinator] Failed to persist tool approval state:",
          error,
        );
      });
  }

  private notifyApprovalStateChanged(session: ChatSession): void {
    if (this.host.isSessionActive(session)) {
      this.host.notifyExecutionPlanUpdate(session);
    }
  }

  private emitApprovalRuntimeEvent(
    session: ChatSession,
    payload:
      | Omit<
          Extract<AgentRuntimeEvent, { type: "approval_requested" }>,
          "sessionId" | "assistantMessageId" | "timestamp" | "planId"
        >
      | Omit<
          Extract<AgentRuntimeEvent, { type: "approval_resolved" }>,
          "sessionId" | "assistantMessageId" | "timestamp" | "planId"
        >,
    assistantMessageId?: string,
  ): void {
    const resolvedAssistantMessageId =
      assistantMessageId ||
      [...session.messages].reverse().find((m) => m.role === "assistant")?.id ||
      payload.toolCallId;

    this.host.emitRuntimeEvent({
      ...payload,
      sessionId: session.id,
      assistantMessageId: resolvedAssistantMessageId,
      timestamp: Date.now(),
      planId: session.executionPlan?.id,
    } as AgentRuntimeEvent);
  }
}
