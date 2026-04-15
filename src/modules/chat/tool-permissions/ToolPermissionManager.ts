import type {
  ToolApprovalRequest,
  ToolApprovalResolution,
  PaperToolName,
  ToolPermissionDecision,
  ToolPermissionDescriptor,
  ToolPermissionMode,
  ToolPermissionPolicyEntry,
  ToolPermissionRequest,
} from "../../../types/tool";
import { config } from "../../../../package.json";

export interface ToolPermissionDecider {
  decide(
    request: ToolPermissionRequest,
    descriptor: ToolPermissionDescriptor,
  ): Promise<ToolPermissionDecision>;
}

export type ToolApprovalHandler = (
  approvalRequest: ToolApprovalRequest,
) =>
  | Promise<ToolApprovalResolution | null | void>
  | ToolApprovalResolution
  | null
  | void;

export interface ToolApprovalObserver {
  onApprovalRequested?: (approvalRequest: ToolApprovalRequest) => void;
  onApprovalResolved?: (
    approvalRequest: ToolApprovalRequest,
    decision: ToolPermissionDecision,
  ) => void;
}

const TOOL_PERMISSION_DESCRIPTORS: Record<
  PaperToolName,
  ToolPermissionDescriptor
> = {
  web_search: {
    name: "web_search",
    riskLevel: "network",
    mode: "ask",
    description: "Search external web content.",
  },
  get_paper_section: {
    name: "get_paper_section",
    riskLevel: "read",
    mode: "auto_allow",
    description: "Read a specific section from a paper.",
  },
  search_paper_content: {
    name: "search_paper_content",
    riskLevel: "read",
    mode: "auto_allow",
    description: "Search within paper content.",
  },
  get_paper_metadata: {
    name: "get_paper_metadata",
    riskLevel: "read",
    mode: "auto_allow",
    description: "Read metadata extracted from a paper.",
  },
  get_pages: {
    name: "get_pages",
    riskLevel: "read",
    mode: "auto_allow",
    description: "Read selected page ranges from a paper.",
  },
  get_page_count: {
    name: "get_page_count",
    riskLevel: "read",
    mode: "auto_allow",
    description: "Read page count and paper statistics.",
  },
  search_with_regex: {
    name: "search_with_regex",
    riskLevel: "read",
    mode: "auto_allow",
    description: "Run a regex search over paper content.",
  },
  get_outline: {
    name: "get_outline",
    riskLevel: "read",
    mode: "auto_allow",
    description: "Read the paper outline.",
  },
  list_sections: {
    name: "list_sections",
    riskLevel: "read",
    mode: "auto_allow",
    description: "List available sections in a paper.",
  },
  get_full_text: {
    name: "get_full_text",
    riskLevel: "high_cost",
    mode: "auto_allow",
    description: "Read the full paper text with higher token cost.",
  },
  list_all_items: {
    name: "list_all_items",
    riskLevel: "read",
    mode: "auto_allow",
    description: "List Zotero library items.",
  },
  get_item_notes: {
    name: "get_item_notes",
    riskLevel: "read",
    mode: "auto_allow",
    description: "Read notes attached to a Zotero item.",
  },
  get_note_content: {
    name: "get_note_content",
    riskLevel: "read",
    mode: "auto_allow",
    description: "Read the full content of a Zotero note.",
  },
  get_item_metadata: {
    name: "get_item_metadata",
    riskLevel: "read",
    mode: "auto_allow",
    description: "Read metadata of a Zotero item.",
  },
  get_annotations: {
    name: "get_annotations",
    riskLevel: "read",
    mode: "auto_allow",
    description: "Read PDF annotations from Zotero.",
  },
  get_pdf_selection: {
    name: "get_pdf_selection",
    riskLevel: "read",
    mode: "auto_allow",
    description: "Read the user's current PDF selection.",
  },
  search_items: {
    name: "search_items",
    riskLevel: "read",
    mode: "auto_allow",
    description: "Search the Zotero library.",
  },
  get_collections: {
    name: "get_collections",
    riskLevel: "read",
    mode: "auto_allow",
    description: "Read Zotero collections.",
  },
  get_collection_items: {
    name: "get_collection_items",
    riskLevel: "read",
    mode: "auto_allow",
    description: "Read items from a Zotero collection.",
  },
  get_tags: {
    name: "get_tags",
    riskLevel: "read",
    mode: "auto_allow",
    description: "Read Zotero tags.",
  },
  search_by_tag: {
    name: "search_by_tag",
    riskLevel: "read",
    mode: "auto_allow",
    description: "Search Zotero items by tag.",
  },
  get_recent: {
    name: "get_recent",
    riskLevel: "read",
    mode: "auto_allow",
    description: "Read recently added Zotero items.",
  },
  search_notes: {
    name: "search_notes",
    riskLevel: "read",
    mode: "auto_allow",
    description: "Search note content in Zotero.",
  },
  create_note: {
    name: "create_note",
    riskLevel: "write",
    mode: "auto_allow",
    description: "Create a new Zotero note.",
  },
  batch_update_tags: {
    name: "batch_update_tags",
    riskLevel: "write",
    mode: "auto_allow",
    description: "Modify tags on multiple Zotero items.",
  },
  add_item: {
    name: "add_item",
    riskLevel: "write",
    mode: "auto_allow",
    description: "Add a new Zotero item.",
  },
  compare_papers: {
    name: "compare_papers",
    riskLevel: "read",
    mode: "auto_allow",
    description: "Compare multiple papers.",
  },
  search_across_papers: {
    name: "search_across_papers",
    riskLevel: "read",
    mode: "auto_allow",
    description: "Search across multiple selected papers.",
  },
  save_memory: {
    name: "save_memory",
    riskLevel: "memory",
    mode: "auto_allow",
    description: "Write a long-term memory entry.",
  },
};

class AutoAllowToolPermissionDecider implements ToolPermissionDecider {
  async decide(
    _request: ToolPermissionRequest,
    descriptor: ToolPermissionDescriptor,
  ): Promise<ToolPermissionDecision> {
    return {
      verdict: descriptor.mode === "deny" ? "deny" : "allow",
      mode: descriptor.mode,
      scope: "once",
      descriptor,
      reason:
        descriptor.mode === "deny"
          ? `Tool ${descriptor.name} is denied by policy.`
          : "Tool is auto-allowed by the default permission policy.",
    };
  }
}

const TOOL_PERMISSION_POLICIES_PREF =
  `${config.prefsPrefix}.toolPermissionPolicies`;

type SessionPolicyMap = Map<string, ToolPermissionPolicyEntry>;

interface PendingApprovalEntry {
  request: ToolApprovalRequest;
  resolve: (decision: ToolPermissionDecision) => void;
}

export class ToolPermissionManager {
  private decider: ToolPermissionDecider = new AutoAllowToolPermissionDecider();
  private oncePolicies: SessionPolicyMap = new Map();
  private sessionPolicies: SessionPolicyMap = new Map();
  private pendingApprovals: Map<string, PendingApprovalEntry> = new Map();
  private approvalObservers: Set<ToolApprovalObserver> = new Set();
  private approvalHandler: ToolApprovalHandler | null = null;
  private descriptorModeOverrides: Map<PaperToolName, ToolPermissionMode> =
    new Map();
  private approvalRequestCounter = 0;

  setDecider(decider: ToolPermissionDecider): void {
    this.decider = decider;
  }

  setApprovalHandler(handler: ToolApprovalHandler | null): void {
    this.approvalHandler = handler;
  }

  addApprovalObserver(observer: ToolApprovalObserver): void {
    this.approvalObservers.add(observer);
  }

  removeApprovalObserver(observer: ToolApprovalObserver): void {
    this.approvalObservers.delete(observer);
  }

  setDescriptorModeOverride(
    toolName: PaperToolName,
    mode: ToolPermissionMode | null,
  ): void {
    if (mode) {
      this.descriptorModeOverrides.set(toolName, mode);
      return;
    }
    this.descriptorModeOverrides.delete(toolName);
  }

  setPolicy(
    entry: Omit<ToolPermissionPolicyEntry, "updatedAt">,
  ): void {
    const normalized: ToolPermissionPolicyEntry = {
      ...entry,
      updatedAt: Date.now(),
    };

    switch (entry.scope) {
      case "once":
        this.oncePolicies.set(this.buildPolicyKey(entry.toolName, entry.sessionId), normalized);
        return;
      case "session":
        this.sessionPolicies.set(
          this.buildPolicyKey(entry.toolName, entry.sessionId),
          normalized,
        );
        return;
      case "always":
        this.setPersistentPolicy(normalized);
        return;
    }
  }

  allowOnce(
    toolName: PaperToolName,
    sessionId?: string,
    reason?: string,
  ): void {
    this.setPolicy({
      toolName,
      verdict: "allow",
      scope: "once",
      sessionId,
      reason,
    });
  }

  allowSession(
    toolName: PaperToolName,
    sessionId: string,
    reason?: string,
  ): void {
    this.setPolicy({
      toolName,
      verdict: "allow",
      scope: "session",
      sessionId,
      reason,
    });
  }

  allowAlways(
    toolName: PaperToolName,
    reason?: string,
  ): void {
    this.setPolicy({
      toolName,
      verdict: "allow",
      scope: "always",
      reason,
    });
  }

  denyOnce(
    toolName: PaperToolName,
    sessionId?: string,
    reason?: string,
  ): void {
    this.setPolicy({
      toolName,
      verdict: "deny",
      scope: "once",
      sessionId,
      reason,
    });
  }

  denySession(
    toolName: PaperToolName,
    sessionId: string,
    reason?: string,
  ): void {
    this.setPolicy({
      toolName,
      verdict: "deny",
      scope: "session",
      sessionId,
      reason,
    });
  }

  denyAlways(
    toolName: PaperToolName,
    reason?: string,
  ): void {
    this.setPolicy({
      toolName,
      verdict: "deny",
      scope: "always",
      reason,
    });
  }

  clearSessionPolicies(sessionId?: string): void {
    this.oncePolicies = this.filterPolicyMap(this.oncePolicies, sessionId);
    this.sessionPolicies = this.filterPolicyMap(this.sessionPolicies, sessionId);
  }

  clearPersistentPolicy(toolName: PaperToolName): void {
    const policies = this.readPersistentPolicies().filter(
      (entry) => entry.toolName !== toolName,
    );
    this.writePersistentPolicies(policies);
  }

  listPolicies(sessionId?: string): ToolPermissionPolicyEntry[] {
    const once = [...this.oncePolicies.values()].filter(
      (entry) => !sessionId || entry.sessionId === sessionId,
    );
    const session = [...this.sessionPolicies.values()].filter(
      (entry) => !sessionId || entry.sessionId === sessionId,
    );
    const persistent = this.readPersistentPolicies();
    return [...once, ...session, ...persistent].sort(
      (a, b) => b.updatedAt - a.updatedAt,
    );
  }

  getDescriptor(toolName: string): ToolPermissionDescriptor | null {
    const descriptor =
      TOOL_PERMISSION_DESCRIPTORS[
        toolName as keyof typeof TOOL_PERMISSION_DESCRIPTORS
      ] ?? null;
    if (!descriptor) {
      return null;
    }

    const override = this.descriptorModeOverrides.get(
      descriptor.name as PaperToolName,
    );
    if (!override || override === descriptor.mode) {
      return descriptor;
    }

    return {
      ...descriptor,
      mode: override,
    };
  }

  async decide(request: ToolPermissionRequest): Promise<ToolPermissionDecision> {
    const descriptor = this.getDescriptor(request.toolCall.function.name);
    if (!descriptor) {
      return {
        verdict: "deny",
        mode: "deny",
        scope: "once",
        descriptor: {
          name: request.toolCall.function.name,
          riskLevel: "read",
          mode: "deny",
          description: `Unknown tool: ${request.toolCall.function.name}`,
        },
        reason: `Unknown tool: ${request.toolCall.function.name}`,
      };
    }

    const matchedPolicy = this.consumeOrGetPolicy(
      descriptor.name as PaperToolName,
      request.sessionId,
    );
    if (matchedPolicy) {
      return this.buildDecisionFromPolicy(descriptor, matchedPolicy);
    }

    if (descriptor.mode === "ask") {
      return this.requestApprovalDecision(request, descriptor);
    }

    return this.decider.decide(request, descriptor);
  }

  listPendingApprovals(sessionId?: string): ToolApprovalRequest[] {
    return [...this.pendingApprovals.values()]
      .map((entry) => entry.request)
      .filter(
        (entry) => !sessionId || entry.request.sessionId === sessionId,
      )
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  resolveApprovalRequest(
    approvalRequestId: string,
    resolution: ToolApprovalResolution,
  ): ToolPermissionDecision | null {
    const pending = this.pendingApprovals.get(approvalRequestId);
    if (!pending) {
      return null;
    }

    const effectiveResolution = this.normalizeApprovalResolution(
      pending.request.request,
      resolution,
    );

    if (
      effectiveResolution.scope === "session" &&
      pending.request.request.sessionId
    ) {
      this.setPolicy({
        toolName: pending.request.toolName,
        verdict: effectiveResolution.verdict,
        scope: "session",
        sessionId: pending.request.request.sessionId,
        reason: effectiveResolution.reason,
      });
    } else if (effectiveResolution.scope === "always") {
      this.setPolicy({
        toolName: pending.request.toolName,
        verdict: effectiveResolution.verdict,
        scope: "always",
        reason: effectiveResolution.reason,
      });
    }

    const decision = this.buildApprovalDecision(
      pending.request.descriptor,
      effectiveResolution,
    );
    this.finalizePendingApproval(approvalRequestId, pending, decision);
    return decision;
  }

  denyPendingApprovals(
    options: {
      sessionId?: string;
      reason?: string;
    } = {},
  ): ToolPermissionDecision[] {
    const { sessionId, reason } = options;
    const resolved: ToolPermissionDecision[] = [];

    for (const [approvalRequestId, pending] of this.pendingApprovals.entries()) {
      if (sessionId && pending.request.request.sessionId !== sessionId) {
        continue;
      }

      const decision = this.buildApprovalDecision(
        pending.request.descriptor,
        {
          verdict: "deny",
          scope: "once",
          reason:
            reason ||
            `Tool ${pending.request.toolName} was denied because the session state changed before approval completed.`,
        },
      );
      this.finalizePendingApproval(approvalRequestId, pending, decision);
      resolved.push(decision);
    }

    return resolved;
  }

  formatDeniedResult(decision: ToolPermissionDecision): string {
    return [
      `Error: Permission denied for tool "${decision.descriptor.name}".`,
      `Risk level: ${decision.descriptor.riskLevel}.`,
      decision.reason
        ? `Reason: ${decision.reason}`
        : "Reason: No permission was granted.",
      "Please continue without this tool or choose a safer alternative.",
    ].join(" ");
  }

  private consumeOrGetPolicy(
    toolName: PaperToolName,
    sessionId?: string,
  ): ToolPermissionPolicyEntry | null {
    const sessionKey = this.buildPolicyKey(toolName, sessionId);
    const onceMatch = this.oncePolicies.get(sessionKey);
    if (onceMatch) {
      this.oncePolicies.delete(sessionKey);
      return onceMatch;
    }

    const sessionMatch = this.sessionPolicies.get(sessionKey);
    if (sessionMatch) {
      return sessionMatch;
    }

    const persistentMatch = this.readPersistentPolicies().find(
      (entry) => entry.toolName === toolName && entry.scope === "always",
    );
    return persistentMatch || null;
  }

  private async requestApprovalDecision(
    request: ToolPermissionRequest,
    descriptor: ToolPermissionDescriptor,
  ): Promise<ToolPermissionDecision> {
    if (!this.approvalHandler && this.approvalObservers.size === 0) {
      return {
        verdict: "deny",
        mode: "ask",
        scope: "once",
        descriptor,
        reason: `Tool ${descriptor.name} requires approval, but no approval channel is available.`,
      };
    }

    const approvalRequest = this.createApprovalRequest(request, descriptor);
    const decisionPromise = new Promise<ToolPermissionDecision>((resolve) => {
      this.pendingApprovals.set(approvalRequest.id, {
        request: approvalRequest,
        resolve,
      });
    });
    this.notifyApprovalRequested(approvalRequest);

    if (this.approvalHandler) {
      try {
        const immediateResolution = await this.approvalHandler(approvalRequest);
        if (immediateResolution) {
          const resolvedDecision = this.resolveApprovalRequest(
            approvalRequest.id,
            immediateResolution,
          );
          if (resolvedDecision) {
            return resolvedDecision;
          }
        }
      } catch (error) {
        const reason =
          error instanceof Error ? error.message : String(error);
        const fallbackDecision: ToolPermissionDecision = {
          verdict: "deny",
          mode: "ask",
          scope: "once",
          descriptor,
          reason: `Approval handler failed: ${reason}`,
        };
        const pending = this.pendingApprovals.get(approvalRequest.id);
        if (pending) {
          this.finalizePendingApproval(
            approvalRequest.id,
            pending,
            fallbackDecision,
          );
        }
        return fallbackDecision;
      }
    }

    return decisionPromise;
  }

  private createApprovalRequest(
    request: ToolPermissionRequest,
    descriptor: ToolPermissionDescriptor,
  ): ToolApprovalRequest {
    const toolName = descriptor.name as PaperToolName;
    return {
      id: this.nextApprovalRequestId(toolName),
      toolName,
      descriptor,
      request,
      createdAt: Date.now(),
      assistantMessageId: request.assistantMessageId,
    };
  }

  private nextApprovalRequestId(toolName: PaperToolName): string {
    this.approvalRequestCounter += 1;
    return `tool-approval-${toolName}-${Date.now()}-${this.approvalRequestCounter}`;
  }

  private buildApprovalDecision(
    descriptor: ToolPermissionDescriptor,
    resolution: ToolApprovalResolution,
  ): ToolPermissionDecision {
    return {
      verdict: resolution.verdict,
      mode: "ask",
      scope: resolution.scope,
      descriptor,
      reason:
        resolution.reason ||
        this.formatApprovalReason(descriptor.name, resolution),
    };
  }

  private normalizeApprovalResolution(
    request: ToolPermissionRequest,
    resolution: ToolApprovalResolution,
  ): ToolApprovalResolution {
    if (resolution.scope !== "session" || request.sessionId) {
      return resolution;
    }

    return {
      ...resolution,
      scope: "once",
    };
  }

  private buildDecisionFromPolicy(
    descriptor: ToolPermissionDescriptor,
    policy: ToolPermissionPolicyEntry,
  ): ToolPermissionDecision {
    return {
      verdict: policy.verdict,
      mode: "ask",
      scope: policy.scope,
      descriptor,
      reason:
        policy.reason ||
        this.formatPolicyReason(descriptor.name, policy),
    };
  }

  private setPersistentPolicy(entry: ToolPermissionPolicyEntry): void {
    const policies = this.readPersistentPolicies().filter(
      (existing) => existing.toolName !== entry.toolName,
    );
    policies.push(entry);
    this.writePersistentPolicies(policies);
  }

  private readPersistentPolicies(): ToolPermissionPolicyEntry[] {
    const raw = (Zotero.Prefs.get(TOOL_PERMISSION_POLICIES_PREF, true) as string) || "";
    if (!raw) return [];

    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(this.isPolicyEntry);
    } catch {
      return [];
    }
  }

  private writePersistentPolicies(policies: ToolPermissionPolicyEntry[]): void {
    Zotero.Prefs.set(
      TOOL_PERMISSION_POLICIES_PREF,
      JSON.stringify(policies),
      true,
    );
  }

  private buildPolicyKey(toolName: string, sessionId?: string): string {
    return `${sessionId || "__global__"}::${toolName}`;
  }

  private filterPolicyMap(
    source: SessionPolicyMap,
    sessionId?: string,
  ): SessionPolicyMap {
    if (!sessionId) {
      return new Map();
    }

    return new Map(
      [...source.entries()].filter(([, entry]) => entry.sessionId !== sessionId),
    );
  }

  private formatPolicyReason(
    toolName: string,
    entry: ToolPermissionPolicyEntry,
  ): string {
    if (entry.verdict === "allow") {
      return `Tool ${toolName} was allowed by ${entry.scope} permission policy.`;
    }
    return `Tool ${toolName} was denied by ${entry.scope} permission policy.`;
  }

  private formatApprovalReason(
    toolName: string,
    resolution: ToolApprovalResolution,
  ): string {
    if (resolution.verdict === "allow") {
      return `Tool ${toolName} was approved for ${resolution.scope} scope.`;
    }
    return `Tool ${toolName} was denied for ${resolution.scope} scope.`;
  }

  private notifyApprovalRequested(approvalRequest: ToolApprovalRequest): void {
    for (const observer of this.approvalObservers) {
      observer.onApprovalRequested?.(approvalRequest);
    }
  }

  private notifyApprovalResolved(
    approvalRequest: ToolApprovalRequest,
    decision: ToolPermissionDecision,
  ): void {
    for (const observer of this.approvalObservers) {
      observer.onApprovalResolved?.(approvalRequest, decision);
    }
  }

  private finalizePendingApproval(
    approvalRequestId: string,
    pending: PendingApprovalEntry,
    decision: ToolPermissionDecision,
  ): void {
    this.pendingApprovals.delete(approvalRequestId);
    this.notifyApprovalResolved(pending.request, decision);
    pending.resolve(decision);
  }

  private isPolicyEntry(value: unknown): value is ToolPermissionPolicyEntry {
    return (
      typeof value === "object" &&
      value !== null &&
      typeof (value as ToolPermissionPolicyEntry).toolName === "string" &&
      ((value as ToolPermissionPolicyEntry).verdict === "allow" ||
        (value as ToolPermissionPolicyEntry).verdict === "deny") &&
      ((value as ToolPermissionPolicyEntry).scope === "once" ||
        (value as ToolPermissionPolicyEntry).scope === "session" ||
        (value as ToolPermissionPolicyEntry).scope === "always") &&
      typeof (value as ToolPermissionPolicyEntry).updatedAt === "number"
    );
  }
}

let toolPermissionManager: ToolPermissionManager | null = null;

export function getToolPermissionManager(): ToolPermissionManager {
  if (!toolPermissionManager) {
    toolPermissionManager = new ToolPermissionManager();
  }
  return toolPermissionManager;
}
