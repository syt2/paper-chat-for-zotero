import type {
  ChatMessage,
  ChatSession,
  ExecutionPlan,
  ExecutionPlanStatus,
  ExecutionPlanStep,
  ExecutionPlanStepStatus,
} from "../../../types/chat";
import type { ToolExecutionResult } from "../../../types/tool";

const RECOVERY_STEP_PREFIX = "replan:";

function createStepId(): string {
  return `step-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + "...";
}

function isTerminalStepStatus(status: ExecutionPlanStepStatus): boolean {
  return (
    status === "completed" || status === "failed" || status === "denied"
  );
}

function isRecoveryStep(stepId: string | undefined): boolean {
  return (stepId || "").startsWith(RECOVERY_STEP_PREFIX);
}

function getToolIntentTitle(toolName: string): string {
  switch (toolName) {
    case "list_all_items":
    case "search_items":
    case "get_recent":
    case "get_collections":
    case "get_collection_items":
    case "get_tags":
    case "search_by_tag":
      return "Find relevant papers in Zotero";
    case "get_item_metadata":
    case "get_paper_metadata":
      return "Inspect paper metadata";
    case "get_item_notes":
    case "get_note_content":
    case "get_annotations":
    case "search_notes":
      return "Review notes and annotations";
    case "get_paper_section":
    case "search_paper_content":
    case "get_pages":
    case "search_with_regex":
    case "get_outline":
    case "list_sections":
    case "get_page_count":
    case "get_pdf_selection":
    case "get_full_text":
      return "Read paper evidence";
    case "search_across_papers":
      return "Compare evidence across papers";
    case "web_search":
      return "Check information outside Zotero";
    case "create_note":
      return "Write findings to a Zotero note";
    case "batch_update_tags":
      return "Update Zotero tags";
    case "add_item":
      return "Add an item to Zotero";
    case "save_memory":
      return "Save durable memory";
    default:
      return `Use ${toolName}`;
  }
}

function summarizeRecoveryResult(result: ToolExecutionResult): string {
  const issue =
    result.permissionDecision?.reason || result.error || result.content || "";
  return `${result.toolCall.function.name}: ${truncate(issue, 100)}`;
}

function getRecoveryStepTitle(results: ToolExecutionResult[]): string {
  const deniedCount = results.filter((result) => result.status === "denied").length;
  const failedCount = results.filter((result) => result.status === "failed").length;

  if (deniedCount > 0 && failedCount > 0) {
    return "Revise plan after blocked or failed tool calls";
  }
  if (deniedCount > 0) {
    return "Revise plan after blocked tool call";
  }
  return "Revise plan after tool failure";
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

    if (status === "in_progress") {
      this.completeActiveRecoveryStep(plan, now);
    }

    if (existingStep) {
      existingStep.title = getToolIntentTitle(toolName);
      existingStep.status = status;
      existingStep.toolName = toolName;
      existingStep.detail = detail;
      if (status === "in_progress" && !existingStep.startedAt) {
        existingStep.startedAt = now;
      }
      if (isTerminalStepStatus(status)) {
        existingStep.completedAt = now;
      }
    } else {
      const newStep: ExecutionPlanStep = {
        id: toolCallId || createStepId(),
        title: getToolIntentTitle(toolName),
        status,
        toolName,
        detail,
        startedAt: now,
      };
      if (isTerminalStepStatus(status)) {
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

  recordRecoveryStep(
    session: ChatSession,
    currentMessages: ChatMessage[],
    results: ToolExecutionResult[],
  ): ExecutionPlan {
    const affectedResults = results.filter(
      (result) => result.status === "denied" || result.status === "failed",
    );
    const plan = this.ensurePlan(session, currentMessages);
    if (affectedResults.length === 0) {
      return plan;
    }

    const now = Date.now();
    const detail = truncate(
      affectedResults.map((result) => summarizeRecoveryResult(result)).join(" | "),
      220,
    );

    plan.steps.push({
      id: `${RECOVERY_STEP_PREFIX}${now}`,
      title: getRecoveryStepTitle(affectedResults),
      status: "in_progress",
      detail,
      startedAt: now,
    });
    plan.activeStepId = plan.steps[plan.steps.length - 1].id;
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
    this.completeActiveRecoveryStep(plan, now);

    if (existingStep) {
      existingStep.status = "completed";
      existingStep.detail = detail;
      existingStep.completedAt = now;
    } else {
      plan.steps.push({
        id: "respond",
        title: "Compose final answer",
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
      failedStep.detail = failedStep.detail || truncate(error, 200);
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

  private completeActiveRecoveryStep(plan: ExecutionPlan, now: number): void {
    if (!isRecoveryStep(plan.activeStepId)) {
      return;
    }

    const activeStep = plan.steps.find((step) => step.id === plan.activeStepId);
    if (!activeStep || activeStep.status !== "in_progress") {
      return;
    }

    activeStep.status = "completed";
    activeStep.completedAt = now;
  }
}
