import { assert } from "chai";
import type {
  AgentRuntimeEvent,
  ChatMessage,
  ChatSession,
  ExecutionPlan,
} from "../../src/types/chat";
import type {
  ProviderConfig,
  ToolCallingProvider,
} from "../../src/types/provider";
import type {
  PaperStructure,
  PaperStructureExtended,
  ToolCall,
  ToolDefinition,
  ToolExecutionResult,
  ToolPermissionDecision,
  ToolPermissionDescriptor,
} from "../../src/types/tool";

export interface ScriptedProviderRound {
  content: string;
  toolCalls?: ToolCall[];
  expectMessages?: (messages: ChatMessage[]) => void;
}

export interface AgentTraceRunOptions {
  userContent: string;
  rounds: ScriptedProviderRound[];
  decideTool?: (
    toolCall: ToolCall,
    args: Record<string, unknown>,
  ) =>
    | { verdict: "allow" | "deny"; reason?: string }
    | "allow"
    | "deny"
    | null
    | undefined;
  executeTool?: (
    toolCall: ToolCall,
    args: Record<string, unknown>,
  ) => Promise<string> | string;
  afterToolStarted?: (
    toolCall: ToolCall,
    args: Record<string, unknown>,
  ) => void;
  isSessionTracked?: () => boolean;
  paperStructure?: PaperStructure | PaperStructureExtended | null;
  tools?: ToolDefinition[];
}

export interface AgentTraceRunResult {
  session: ChatSession;
  assistantMessage: ChatMessage;
  currentMessages: ChatMessage[];
  runtimeEvents: AgentRuntimeEvent[];
  planSnapshots: Array<ExecutionPlan | undefined>;
  providerRounds: ChatMessage[][];
  executedToolCalls: Array<{
    toolCallId: string;
    toolName: string;
    args: Record<string, unknown>;
  }>;
  storageOps: Array<
    | {
        type: "updateSessionMeta";
        executionPlanStatus?: ChatSession["executionPlan"] extends ExecutionPlan
          ? ExecutionPlan["status"]
          : ExecutionPlan["status"] | undefined;
        toolResults: number;
      }
    | {
        type: "updateMessageContent";
        messageId: string;
        content: string;
        reasoning?: string;
        streamingState?: ChatMessage["streamingState"] | null;
      }
  >;
}

export type TraceExpectation =
  | string
  | RegExp
  | ((entry: string, index: number, trace: string[]) => boolean);

export function createTraceSession(userContent: string): ChatSession {
  const now = Date.now();
  return {
    id: "session-trace-1",
    createdAt: now,
    updatedAt: now,
    lastActiveItemKey: null,
    messages: [
      {
        id: "user-1",
        role: "user",
        content: userContent,
        timestamp: now,
      },
    ],
  };
}

export function createToolCall(
  id: string,
  toolName: string,
  args: Record<string, unknown>,
): ToolCall {
  return {
    id,
    type: "function",
    function: {
      name: toolName,
      arguments: JSON.stringify(args),
    },
  };
}

export async function runAgentTraceScenario(
  options: AgentTraceRunOptions,
): Promise<AgentTraceRunResult> {
  ensureRuntimeGlobals();
  const session = createTraceSession(options.userContent);
  const assistantMessage: ChatMessage = {
    id: "assistant-1",
    role: "assistant",
    content: "",
    streamingState: "in_progress",
    timestamp: Date.now(),
  };
  session.messages.push(assistantMessage);

  const currentMessages = session.messages.filter(
    (message) => message.id !== assistantMessage.id,
  );
  const runtimeEvents: AgentRuntimeEvent[] = [];
  const planSnapshots: Array<ExecutionPlan | undefined> = [];
  const providerRounds: ChatMessage[][] = [];
  const executedToolCalls: AgentTraceRunResult["executedToolCalls"] = [];
  const storageOps: AgentTraceRunResult["storageOps"] = [];

  const provider = new ScriptedToolProvider(options.rounds, providerRounds);
  const { AgentRuntime } = await import(
    "../../src/modules/chat/agent-runtime/AgentRuntime.ts"
  );
  const toolScheduler = {
    createExecutionBatches(
      requests: Array<{
        toolCall: ToolCall;
        sessionId?: string;
        assistantMessageId?: string;
      }>,
    ) {
      return requests.map((request) => [request]);
    },
    async executeBatch(
      requests: Array<{
        toolCall: ToolCall;
        sessionId?: string;
        assistantMessageId?: string;
      }>,
      hooks?: {
        onExecutionReady?: (request: {
          toolCall: ToolCall;
          sessionId?: string;
          assistantMessageId?: string;
        }) => void;
      },
    ): Promise<ToolExecutionResult[]> {
      const results: ToolExecutionResult[] = [];
      for (const request of requests) {
        const args = JSON.parse(
          request.toolCall.function.arguments,
        ) as Record<string, unknown>;
        const decision = normalizeDecision(
          options.decideTool?.(request.toolCall, args),
          request.toolCall.function.name,
        );
        if (decision.verdict === "deny") {
          results.push({
            toolCall: request.toolCall,
            args,
            permissionDecision: decision,
            policyTrace: [
              {
                stage: "scheduler",
                policy: "permission_decision",
                outcome: "blocked",
                summary: `Blocked ${request.toolCall.function.name} by the test harness permission policy.`,
                detail: decision.reason || "Blocked by test harness policy.",
                data: {
                  verdict: decision.verdict,
                  mode: decision.mode,
                  scope: decision.scope,
                  riskLevel: decision.descriptor.riskLevel,
                },
              },
            ],
            status: "denied",
            content: [
              `Error: Permission denied for ${request.toolCall.function.name}.`,
              "Category: permission_denied",
              `Cause: ${decision.reason || "Blocked by test harness policy."}`,
              "Retryable: no",
            ].join("\n"),
            error: decision.reason || "Blocked by test harness policy.",
          });
          continue;
        }

        hooks?.onExecutionReady?.(request);
        options.afterToolStarted?.(request.toolCall, args);
        executedToolCalls.push({
          toolCallId: request.toolCall.id,
          toolName: request.toolCall.function.name,
          args: clone(args),
        });

        try {
          const content = options.executeTool
            ? await options.executeTool(request.toolCall, args)
            : `ok:${request.toolCall.function.name}`;
          const failed = content.trimStart().startsWith("Error:");
          results.push({
            toolCall: request.toolCall,
            args,
            permissionDecision: decision,
            status: failed ? "failed" : "completed",
            content,
            error: failed ? content : undefined,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          results.push({
            toolCall: request.toolCall,
            args,
            permissionDecision: decision,
            status: "failed",
            content: `Error: Tool execution failed: ${message}`,
            error: message,
          });
        }
      }
      return results;
    },
  };
  const runtime = new AgentRuntime(
    {
      updateSessionMeta: async (trackedSession: ChatSession) => {
        storageOps.push({
          type: "updateSessionMeta",
          executionPlanStatus: trackedSession.executionPlan?.status,
          toolResults: trackedSession.toolExecutionState?.results.length || 0,
        });
      },
      updateMessageContent: async (
        _sessionId: string,
        messageId: string,
        content: string,
        reasoning?: string,
        options?: { streamingState?: ChatMessage["streamingState"] | null },
      ) => {
        storageOps.push({
          type: "updateMessageContent",
          messageId,
          content,
          reasoning,
          streamingState: options?.streamingState,
        });
      },
    } as any,
    {
      isSessionActive: () => true,
      isSessionTracked: () => options.isSessionTracked?.() ?? true,
      onRuntimeEvent: (event) => {
        runtimeEvents.push(clone(event));
      },
      onExecutionPlanUpdate: (plan) => {
        planSnapshots.push(plan ? clone(plan) : undefined);
      },
      onStreamingUpdate: () => undefined,
      onReasoningUpdate: () => undefined,
      onMessageUpdate: () => undefined,
      onPdfAttached: () => undefined,
      onMessageComplete: () => undefined,
      formatToolCallCard: (toolName, args, status) =>
        `\n<tool-call status="${status}" tool="${toolName}" args="${args}"></tool-call>\n`,
      generateId: createGeneratedId(),
    },
    toolScheduler,
  );

  await runtime.executeNonStreamingToolLoop({
    provider,
    currentMessages,
    assistantMessage,
    pdfWasAttached: false,
    summaryTriggered: false,
    tools: options.tools || [],
    paperStructure: options.paperStructure,
    sendingSession: session,
  });

  provider.assertExhausted();

  return {
    session,
    assistantMessage,
    currentMessages,
    runtimeEvents,
    planSnapshots,
    providerRounds,
    executedToolCalls,
    storageOps,
  };
}

export function summarizeAgentTrace(result: AgentTraceRunResult): string[] {
  return result.runtimeEvents.map((event) => {
    switch (event.type) {
      case "turn_started":
        return `turn_started:${event.summary}`;
      case "tool_started":
        return `tool_started:${event.toolName}`;
      case "tool_completed":
        return `tool_completed:${event.toolName}:${event.status}`;
      case "approval_requested":
        return `approval_requested:${event.toolName}`;
      case "approval_resolved":
        return `approval_resolved:${event.toolName}:${event.verdict}`;
      case "turn_completed":
        return `turn_completed:${truncateLine(event.content, 60)}`;
      case "turn_failed":
        return `turn_failed:${event.error}`;
      case "text_delta":
        return `text_delta:${truncateLine(event.delta, 40)}`;
      case "reasoning_delta":
        return `reasoning_delta:${truncateLine(event.delta, 40)}`;
      default:
        return event.type;
    }
  });
}

export function getExecutedToolNames(result: AgentTraceRunResult): string[] {
  return result.executedToolCalls.map((entry) => entry.toolName);
}

export function getToolCompletionStatuses(
  result: AgentTraceRunResult,
): string[] {
  return result.runtimeEvents
    .filter((event) => event.type === "tool_completed")
    .map((event) => `${event.toolName}:${event.status}`);
}

export function getToolCompletionPolicies(
  result: AgentTraceRunResult,
): string[] {
  return result.runtimeEvents
    .filter((event) => event.type === "tool_completed")
    .map(
      (event) =>
        `${event.toolName}:${event.status}:${event.origin}:${event.policyName || "none"}`,
    );
}

export function getLatestExecutionPlan(
  result: AgentTraceRunResult,
): ExecutionPlan | undefined {
  return [...result.planSnapshots].reverse().find(Boolean);
}

export function getRecoveryNoticeMessages(
  result: AgentTraceRunResult,
): ChatMessage[] {
  return result.providerRounds
    .flat()
    .filter(
      (message) =>
        message.role === "system" &&
        message.content.includes("Tool recovery notice:"),
    );
}

export function assertTraceContainsSequence(
  result: AgentTraceRunResult,
  expectations: TraceExpectation[],
): void {
  const trace = summarizeAgentTrace(result);
  let cursor = 0;

  for (const expected of expectations) {
    let matchedIndex = -1;
    for (let i = cursor; i < trace.length; i += 1) {
      if (matchesTraceExpectation(trace[i], i, trace, expected)) {
        matchedIndex = i;
        break;
      }
    }

    assert.isAtLeast(
      matchedIndex,
      0,
      [
        `Missing trace expectation after index ${cursor - 1}:`,
        formatTraceExpectation(expected),
        "Actual trace:",
        ...trace.map((line) => `- ${line}`),
      ].join("\n"),
    );
    cursor = matchedIndex + 1;
  }
}

export function assertExecutedTools(
  result: AgentTraceRunResult,
  expectedToolNames: string[],
): void {
  assert.deepEqual(getExecutedToolNames(result), expectedToolNames);
}

export function assertExecutionPlanTerminalState(
  result: AgentTraceRunResult,
  status: ExecutionPlan["status"],
  finalStepTitle?: string | RegExp,
): void {
  const plan = getLatestExecutionPlan(result) || result.session.executionPlan;
  assert.isDefined(plan, "Expected an execution plan snapshot.");
  assert.equal(plan?.status, status);

  if (!finalStepTitle) {
    return;
  }

  const finalStep = plan?.steps.at(-1);
  assert.isDefined(finalStep, "Expected the execution plan to contain steps.");
  if (typeof finalStepTitle === "string") {
    assert.equal(finalStep?.title, finalStepTitle);
    return;
  }
  assert.match(finalStep?.title || "", finalStepTitle);
}

export function assertRecoveryNoticeIncludes(
  result: AgentTraceRunResult,
  category: string,
  requiredSnippets: string[],
): void {
  const notice = getRecoveryNoticeMessages(result).find((message) =>
    message.content.includes(category),
  );
  assert.isDefined(
    notice,
    `Expected a recovery notice containing category "${category}".`,
  );
  for (const snippet of requiredSnippets) {
    assert.include(notice?.content || "", snippet);
  }
}

export function assertAssistantContentMatches(
  result: AgentTraceRunResult,
  expectation: string | RegExp,
): void {
  if (typeof expectation === "string") {
    assert.include(result.assistantMessage.content, expectation);
    return;
  }
  assert.match(result.assistantMessage.content, expectation);
}

export function assertToolResultContains(
  result: AgentTraceRunResult,
  toolName: string,
  requiredSnippet: string,
): void {
  const matchingResult = result.session.toolExecutionState?.results.find(
    (entry) => entry.toolCall.function.name === toolName,
  );
  assert.isDefined(
    matchingResult,
    `Expected a tool result for ${toolName}, but none was recorded.`,
  );
  assert.include(matchingResult?.content || "", requiredSnippet);
}

class ScriptedToolProvider implements ToolCallingProvider {
  readonly config = {
    id: "scripted-provider",
    name: "Scripted Provider",
    type: "custom",
    enabled: true,
    isBuiltin: false,
    order: 0,
    apiKey: "",
    baseUrl: "",
    defaultModel: "scripted-model",
    availableModels: ["scripted-model"],
  } as const;

  private cursor = 0;

  constructor(
    private readonly rounds: ScriptedProviderRound[],
    private readonly capturedRounds: ChatMessage[][],
  ) {}

  getName(): string {
    return "Scripted Provider";
  }

  isReady(): boolean {
    return true;
  }

  supportsPdfUpload(): boolean {
    return false;
  }

  updateConfig(_config: Partial<ProviderConfig>): void {}

  async streamChatCompletion(
    _messages?: ChatMessage[],
    _callbacks?: unknown,
    _pdfAttachment?: unknown,
    _signal?: AbortSignal,
  ): Promise<void> {
    throw new Error("streamChatCompletion is not implemented in the test harness");
  }

  async chatCompletion(
    _messages?: ChatMessage[],
    _signal?: AbortSignal,
  ): Promise<string> {
    throw new Error("chatCompletion is not implemented in the test harness");
  }

  async testConnection(): Promise<boolean> {
    return true;
  }

  async getAvailableModels(): Promise<string[]> {
    return ["scripted-model"];
  }

  chatCompletionWithTools(
    messages: ChatMessage[],
    _tools?: ToolDefinition[],
    _signal?: AbortSignal,
  ): Promise<{ content: string; toolCalls?: ToolCall[] }> {
    const round = this.rounds[this.cursor];
    assert.isDefined(
      round,
      `Unexpected extra provider round at index ${this.cursor + 1}`,
    );

    const snapshot = clone(messages);
    this.capturedRounds.push(snapshot);
    round.expectMessages?.(snapshot);
    this.cursor += 1;
    return Promise.resolve({
      content: round.content,
      toolCalls: round.toolCalls,
    });
  }

  assertExhausted(): void {
    assert.equal(
      this.cursor,
      this.rounds.length,
      `Expected ${this.rounds.length} provider rounds, got ${this.cursor}`,
    );
  }
}

function createGeneratedId(): () => string {
  let counter = 0;
  return () => {
    counter += 1;
    return `generated-${counter}`;
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function truncateLine(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

function matchesTraceExpectation(
  entry: string,
  index: number,
  trace: string[],
  expected: TraceExpectation,
): boolean {
  if (typeof expected === "string") {
    return entry === expected;
  }
  if (expected instanceof RegExp) {
    return expected.test(entry);
  }
  return expected(entry, index, trace);
}

function formatTraceExpectation(expected: TraceExpectation): string {
  if (typeof expected === "string") {
    return expected;
  }
  if (expected instanceof RegExp) {
    return expected.toString();
  }
  return "[custom predicate]";
}

function ensureRuntimeGlobals(): void {
  if (typeof (globalThis as { ztoolkit?: unknown }).ztoolkit === "undefined") {
    (globalThis as { ztoolkit: { log: () => void } }).ztoolkit = {
      log: () => undefined,
    };
  }
}

function normalizeDecision(
  value:
    | { verdict: "allow" | "deny"; reason?: string }
    | "allow"
    | "deny"
    | null
    | undefined,
  toolName: string,
): ToolPermissionDecision {
  const verdict =
    value === "deny" || value?.verdict === "deny" ? "deny" : "allow";
  const reason =
    typeof value === "object" && value ? value.reason : undefined;
  const descriptor: ToolPermissionDescriptor = {
    name: toolName as ToolPermissionDescriptor["name"],
    riskLevel: getRiskLevel(toolName),
    mode: verdict === "deny" ? "deny" : "auto_allow",
    description: `Test harness decision for ${toolName}`,
  };
  return {
    verdict,
    mode: descriptor.mode,
    scope: "once",
    descriptor,
    reason,
  };
}

function getRiskLevel(toolName: string): ToolPermissionDescriptor["riskLevel"] {
  switch (toolName) {
    case "web_search":
      return "network";
    case "create_note":
    case "batch_update_tags":
    case "add_item":
      return "write";
    case "get_full_text":
      return "high_cost";
    case "save_memory":
      return "memory";
    default:
      return "read";
  }
}
