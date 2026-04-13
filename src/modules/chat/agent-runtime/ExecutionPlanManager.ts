import type {
  ChatMessage,
  ChatSession,
  ExecutionPlan,
  ExecutionPlanStatus,
  ExecutionPlanStep,
  ExecutionPlanStepStatus,
} from "../../../types/chat";

function createStepId(): string {
  return `step-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + "...";
}

export class ExecutionPlanManager {
  createInitialPlan(currentMessages: ChatMessage[]): ExecutionPlan {
    const now = Date.now();
    const lastUserMessage = [...currentMessages]
      .reverse()
      .find((message) => message.role === "user");

    return {
      id: `plan-${now}`,
      sourceMessageId: lastUserMessage?.id,
      summary: truncate(lastUserMessage?.content || "Handle current user request", 120),
      status: "in_progress",
      steps: [],
      createdAt: now,
      updatedAt: now,
    };
  }

  startPlan(session: ChatSession, currentMessages: ChatMessage[]): ExecutionPlan {
    session.executionPlan = this.createInitialPlan(currentMessages);
    return session.executionPlan;
  }

  ensurePlan(session: ChatSession, currentMessages: ChatMessage[]): ExecutionPlan {
    if (!session.executionPlan) {
      session.executionPlan = this.createInitialPlan(currentMessages);
    }
    return session.executionPlan;
  }

  addOrUpdateToolStep(
    session: ChatSession,
    currentMessages: ChatMessage[],
    toolCallId: string,
    toolName: string,
    status: ExecutionPlanStepStatus,
    detail?: string,
  ): ExecutionPlan {
    const plan = this.ensurePlan(session, currentMessages);
    const existingStep = plan.steps.find((step) => step.id === toolCallId);
    const now = Date.now();

    if (existingStep) {
      existingStep.status = status;
      existingStep.toolName = toolName;
      existingStep.detail = detail;
      if (status === "in_progress" && !existingStep.startedAt) {
        existingStep.startedAt = now;
      }
      if (status === "completed" || status === "failed") {
        existingStep.completedAt = now;
      }
    } else {
      const newStep: ExecutionPlanStep = {
        id: toolCallId || createStepId(),
        title: `Run ${toolName}`,
        status,
        toolName,
        detail,
        startedAt: now,
      };
      if (status === "completed" || status === "failed") {
        newStep.completedAt = now;
      }
      plan.steps.push(newStep);
    }

    plan.activeStepId =
      status === "in_progress" ? toolCallId : undefined;
    plan.updatedAt = now;
    plan.status = "in_progress";

    return plan;
  }

  completeRespondStep(
    session: ChatSession,
    currentMessages: ChatMessage[],
    detail?: string,
  ): ExecutionPlan {
    const plan = this.ensurePlan(session, currentMessages);
    const now = Date.now();
    const existingStep = plan.steps.find((step) => step.id === "respond");

    if (existingStep) {
      existingStep.status = "completed";
      existingStep.detail = detail;
      existingStep.completedAt = now;
    } else {
      plan.steps.push({
        id: "respond",
        title: "Respond to user",
        status: "completed",
        detail,
        startedAt: now,
        completedAt: now,
      });
    }

    plan.activeStepId = undefined;
    plan.updatedAt = now;
    plan.status = "completed";
    return plan;
  }

  failPlan(
    session: ChatSession,
    currentMessages: ChatMessage[],
    error: string,
  ): ExecutionPlan {
    const plan = this.ensurePlan(session, currentMessages);
    const now = Date.now();
    plan.status = "failed";
    plan.activeStepId = undefined;
    plan.updatedAt = now;

    const failedStep = plan.steps.find((step) => step.status === "in_progress");
    if (failedStep) {
      failedStep.status = "failed";
      failedStep.error = error;
      failedStep.completedAt = now;
    } else {
      plan.steps.push({
        id: createStepId(),
        title: "Execution failed",
        status: "failed",
        detail: error,
        error,
        startedAt: now,
        completedAt: now,
      });
    }

    return plan;
  }

  setPlanStatus(
    session: ChatSession,
    currentMessages: ChatMessage[],
    status: ExecutionPlanStatus,
  ): ExecutionPlan {
    const plan = this.ensurePlan(session, currentMessages);
    plan.status = status;
    plan.updatedAt = Date.now();
    return plan;
  }
}
