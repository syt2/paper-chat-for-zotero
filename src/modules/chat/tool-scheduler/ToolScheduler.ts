import type {
  PaperStructure,
  PaperStructureExtended,
  ToolCall,
  ToolExecutionRequest,
  ToolExecutionResult,
  ToolPermissionDecision,
  ToolRuntimeMetadata,
} from "../../../types/tool";
import { config } from "../../../../package.json";
import { getErrorMessage } from "../../../utils/common";
import { getPdfToolManager } from "../pdf-tools";
import { preflightToolArguments } from "../tool-arguments/ToolArgumentPreflight";
import {
  formatDeniedToolResult,
  formatToolArgumentParseError,
  normalizeToolErrorContent,
} from "../tool-errors/ToolErrorFormatter";
import { getToolPermissionManager } from "../tool-permissions";
import { getToolRuntimeMetadata } from "./ToolMetadataRegistry";

export interface ToolSchedulerRequest {
  toolCall: ToolCall;
  sessionId?: string;
  assistantMessageId?: string;
  fallbackStructure?: PaperStructure | PaperStructureExtended;
}

export interface ToolSchedulerExecutionHooks {
  onExecutionReady?: (request: ToolSchedulerRequest) => void;
}

/**
 * Callable that actually runs a tool once permissions are resolved. Keeping
 * this as an injectable keeps ToolScheduler free of a hard PdfToolManager
 * dependency (simplifies tests and future non-PDF tool back-ends).
 */
export type ToolExecutor = (
  toolCall: ToolCall,
  fallbackStructure: PaperStructure | PaperStructureExtended | undefined,
  args: Record<string, unknown>,
) => Promise<string>;

interface PreparedToolExecution {
  request: ToolSchedulerRequest;
  metadata?: ToolRuntimeMetadata;
  args: Record<string, unknown>;
  permissionDecision: ToolPermissionDecision;
}

type ParsedArgsResult =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; result: ToolExecutionResult };

interface ToolFaultInjectionConfig {
  enabled?: boolean;
  failNextToolCall?: boolean;
  failToolNames?: string[];
  mode?: "failed" | "denied";
  message?: string;
}

const FAULT_INJECTION_PREF = `${config.prefsPrefix}.devToolFaultInjection`;

export class ToolScheduler {
  private readonly executor: ToolExecutor;

  constructor(executor?: ToolExecutor) {
    this.executor =
      executor ??
      ((toolCall, fallbackStructure, args) =>
        getPdfToolManager().executeToolCall(toolCall, fallbackStructure, args));
  }

  createExecutionBatches(
    requests: ToolSchedulerRequest[],
  ): ToolSchedulerRequest[][] {
    const batches: ToolSchedulerRequest[][] = [];
    let currentParallelBatch: ToolSchedulerRequest[] = [];

    for (const request of requests) {
      const metadata = getToolRuntimeMetadata(request.toolCall.function.name);
      if (this.isParallelSafe(metadata)) {
        currentParallelBatch.push(request);
        continue;
      }

      if (currentParallelBatch.length > 0) {
        batches.push(currentParallelBatch);
        currentParallelBatch = [];
      }
      batches.push([request]);
    }

    if (currentParallelBatch.length > 0) {
      batches.push(currentParallelBatch);
    }

    return batches;
  }

  async execute(request: ToolSchedulerRequest): Promise<ToolExecutionResult> {
    const prepared = await this.prepareExecution(request);
    if ("status" in prepared) {
      return prepared;
    }
    return this.executePrepared(prepared);
  }

  async executeBatch(
    requests: ToolSchedulerRequest[],
    hooks?: ToolSchedulerExecutionHooks,
  ): Promise<ToolExecutionResult[]> {
    const prepared: Array<{
      index: number;
      prepared: PreparedToolExecution | ToolExecutionResult;
    }> = [];
    for (const [index, request] of requests.entries()) {
      prepared.push({
        index,
        prepared: await this.prepareExecution(request),
      });
    }

    const results: ToolExecutionResult[] = new Array(requests.length);
    const runnable: Array<{ index: number; prepared: PreparedToolExecution }> =
      [];

    for (const item of prepared) {
      if ("status" in item.prepared) {
        results[item.index] = item.prepared;
      } else {
        runnable.push({
          index: item.index,
          prepared: item.prepared,
        });
      }
    }

    const runInParallel =
      runnable.length > 1 &&
      runnable.every((item) => this.isParallelSafe(item.prepared.metadata));

    if (runInParallel) {
      for (const item of runnable) {
        hooks?.onExecutionReady?.(item.prepared.request);
      }
      const executed = await Promise.all(
        runnable.map(async (item) => ({
          index: item.index,
          result: await this.executePrepared(item.prepared),
        })),
      );
      for (const item of executed) {
        results[item.index] = item.result;
      }
    } else {
      for (const item of runnable) {
        hooks?.onExecutionReady?.(item.prepared.request);
        results[item.index] = await this.executePrepared(item.prepared);
      }
    }

    return results;
  }

  private parseArguments(toolCall: ToolCall): ParsedArgsResult {
    try {
      const parsed = JSON.parse(toolCall.function.arguments);
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed)
      ) {
        const cause = `Invalid arguments JSON: ${toolCall.function.arguments}`;
      return {
        ok: false,
        result: {
          toolCall,
          status: "failed",
          policyTrace: [
            {
              stage: "scheduler",
              policy: "argument_parse",
              outcome: "blocked",
              summary: `Blocked ${toolCall.function.name} because tool arguments did not decode to an object.`,
              detail: cause,
            },
          ],
          content: formatToolArgumentParseError(
            toolCall,
            `${cause}. Tool arguments must decode to an object.`,
            ),
            error: "Tool arguments must decode to an object.",
          },
        };
      }
      return {
        ok: true,
        args: preflightToolArguments(
          toolCall.function.name,
          parsed as Record<string, unknown>,
        ),
      };
    } catch {
      const cause = `Invalid arguments JSON: ${toolCall.function.arguments}`;
      return {
        ok: false,
        result: {
          toolCall,
          status: "failed",
          policyTrace: [
            {
              stage: "scheduler",
              policy: "argument_parse",
              outcome: "blocked",
              summary: `Blocked ${toolCall.function.name} because tool arguments were not valid JSON.`,
              detail: cause,
            },
          ],
          content: formatToolArgumentParseError(
            toolCall,
            `${cause}. Tool arguments are not valid JSON.`,
          ),
          error: "Tool arguments are not valid JSON.",
        },
      };
    }
  }

  private maybeInjectFailure(
    toolCall: ToolCall,
    args: Record<string, unknown>,
    metadata: ToolExecutionResult["metadata"],
    permissionDecision: ToolPermissionDecision,
  ): ToolExecutionResult | null {
    const state = this.readFaultInjectionConfig();
    const cfg = state.config;
    if (!cfg?.enabled) {
      return null;
    }

    const toolName = toolCall.function.name;
    const shouldFailNext = cfg.failNextToolCall === true;
    const shouldFailNamed = cfg.failToolNames?.includes(toolName) === true;

    if (!shouldFailNext && !shouldFailNamed) {
      return null;
    }

    if (shouldFailNext) {
      cfg.failNextToolCall = false;
      this.writeFaultInjectionConfig(cfg);
    }

    if (cfg.mode === "denied") {
      const deniedDecision: ToolPermissionDecision = {
        ...permissionDecision,
        verdict: "deny",
        reason:
          cfg.message || "Injected permission denial for development testing.",
      };
      return {
        toolCall,
        args,
        metadata,
        permissionDecision: deniedDecision,
        policyTrace: [
          {
            stage: "scheduler",
            policy: "fault_injection",
            outcome: "blocked",
            summary: `Blocked ${toolName} via development fault injection.`,
            detail: deniedDecision.reason,
            data: {
              mode: cfg.mode || "denied",
            },
          },
        ],
        status: "denied",
        content: formatDeniedToolResult(deniedDecision),
        error: deniedDecision.reason,
      };
    }

    const message =
      cfg.message ||
      `Injected tool failure for development testing (${toolName}).`;
    const normalizedError = normalizeToolErrorContent(toolName, `Error: ${message}`);
    return {
      toolCall,
      args,
      metadata,
      permissionDecision,
      policyTrace: [
        {
          stage: "scheduler",
          policy: "fault_injection",
          outcome: "blocked",
          summary: `Failed ${toolName} via development fault injection.`,
          detail: normalizedError.parsed.cause || normalizedError.parsed.summary,
          data: {
            mode: cfg.mode || "failed",
          },
        },
      ],
      status: "failed",
      content: normalizedError.content,
      error: normalizedError.parsed.cause || normalizedError.parsed.summary,
    };
  }

  private readFaultInjectionConfig(): {
    config: ToolFaultInjectionConfig | null;
    raw: string;
  } {
    // Fault injection is a dev-only debugging aid. Never honor a stray pref
    // in a production build, even if it was set in a previous dev session.
    if (typeof __env__ !== "undefined" && __env__ === "production") {
      return { config: null, raw: "" };
    }

    const raw = (Zotero.Prefs.get(FAULT_INJECTION_PREF, true) as string) || "";
    if (!raw) {
      return { config: null, raw: "" };
    }

    try {
      const parsed = JSON.parse(raw);
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed)
      ) {
        return { config: null, raw };
      }
      return { config: parsed as ToolFaultInjectionConfig, raw };
    } catch {
      return { config: null, raw };
    }
  }

  private writeFaultInjectionConfig(
    configValue: ToolFaultInjectionConfig,
  ): void {
    Zotero.Prefs.set(FAULT_INJECTION_PREF, JSON.stringify(configValue), true);
  }

  private async prepareExecution(
    request: ToolSchedulerRequest,
  ): Promise<PreparedToolExecution | ToolExecutionResult> {
    const metadata = getToolRuntimeMetadata(request.toolCall.function.name);
    const argsResult = this.parseArguments(request.toolCall);
    if (!argsResult.ok) {
      return {
        ...argsResult.result,
        metadata: metadata || undefined,
      };
    }

    const executionRequest: ToolExecutionRequest = {
      toolCall: request.toolCall,
      args: argsResult.args,
      sessionId: request.sessionId,
      assistantMessageId: request.assistantMessageId,
    };

    const permissionManager = getToolPermissionManager();
    const permissionDecision = await permissionManager.decide(executionRequest);
    if (permissionDecision.verdict !== "allow") {
      return {
        toolCall: request.toolCall,
        args: argsResult.args,
        metadata: metadata || undefined,
        permissionDecision,
        policyTrace: [
          {
            stage: "scheduler",
            policy: "permission_decision",
            outcome: "blocked",
            summary: `Blocked ${request.toolCall.function.name} by the active permission policy.`,
            detail: permissionDecision.reason,
            data: {
              verdict: permissionDecision.verdict,
              mode: permissionDecision.mode,
              scope: permissionDecision.scope,
              riskLevel: permissionDecision.descriptor.riskLevel,
            },
          },
        ],
        status: "denied",
        content: formatDeniedToolResult(permissionDecision),
        error: permissionDecision.reason,
      };
    }

    const injectedResult = this.maybeInjectFailure(
      request.toolCall,
      argsResult.args,
      metadata || undefined,
      permissionDecision,
    );
    if (injectedResult) {
      return injectedResult;
    }

    return {
      request,
      metadata: metadata || undefined,
      args: argsResult.args,
      permissionDecision,
    };
  }

  private async executePrepared(
    prepared: PreparedToolExecution,
  ): Promise<ToolExecutionResult> {
    try {
      const content = await this.executor(
        prepared.request.toolCall,
        prepared.request.fallbackStructure,
        prepared.args,
      );
      const normalizedError = content.trimStart().startsWith("Error:")
        ? normalizeToolErrorContent(
            prepared.request.toolCall.function.name,
            content,
          )
        : null;

      return {
        toolCall: prepared.request.toolCall,
        args: prepared.args,
        metadata: prepared.metadata,
        permissionDecision: prepared.permissionDecision,
        status: normalizedError ? "failed" : "completed",
        content: normalizedError ? normalizedError.content : content,
        error: normalizedError
          ? normalizedError.parsed.cause || normalizedError.parsed.summary
          : undefined,
      };
    } catch (error) {
      const message = getErrorMessage(error);
      const normalizedError = normalizeToolErrorContent(
        prepared.request.toolCall.function.name,
        `Error: Tool execution failed: ${message}`,
      );
      return {
        toolCall: prepared.request.toolCall,
        args: prepared.args,
        metadata: prepared.metadata,
        permissionDecision: prepared.permissionDecision,
        status: "failed",
        content: normalizedError.content,
        error: normalizedError.parsed.cause || normalizedError.parsed.summary,
      };
    }
  }

  private isParallelSafe(metadata?: ToolRuntimeMetadata | null): boolean {
    return (
      metadata?.concurrency === "parallel_safe" &&
      (metadata.executionClass === "read" ||
        metadata.executionClass === "network") &&
      metadata.mutatesState === false
    );
  }
}

let toolScheduler: ToolScheduler | null = null;

export function getToolScheduler(): ToolScheduler {
  if (!toolScheduler) {
    toolScheduler = new ToolScheduler();
  }
  return toolScheduler;
}
