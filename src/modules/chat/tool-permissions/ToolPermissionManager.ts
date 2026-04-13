import type {
  PaperToolName,
  ToolPermissionDecision,
  ToolPermissionDescriptor,
  ToolPermissionRequest,
} from "../../../types/tool";

export interface ToolPermissionDecider {
  decide(
    request: ToolPermissionRequest,
    descriptor: ToolPermissionDescriptor,
  ): Promise<ToolPermissionDecision>;
}

const TOOL_PERMISSION_DESCRIPTORS: Record<
  PaperToolName,
  ToolPermissionDescriptor
> = {
  web_search: {
    name: "web_search",
    riskLevel: "network",
    mode: "auto_allow",
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

export class ToolPermissionManager {
  private decider: ToolPermissionDecider = new AutoAllowToolPermissionDecider();

  setDecider(decider: ToolPermissionDecider): void {
    this.decider = decider;
  }

  getDescriptor(toolName: string): ToolPermissionDescriptor | null {
    return (
      TOOL_PERMISSION_DESCRIPTORS[
        toolName as keyof typeof TOOL_PERMISSION_DESCRIPTORS
      ] ?? null
    );
  }

  async decide(request: ToolPermissionRequest): Promise<ToolPermissionDecision> {
    const descriptor = this.getDescriptor(request.toolCall.function.name);
    if (!descriptor) {
      return {
        verdict: "deny",
        mode: "deny",
        scope: "once",
        descriptor: {
          name: "list_all_items",
          riskLevel: "read",
          mode: "deny",
          description: `Unknown tool: ${request.toolCall.function.name}`,
        },
        reason: `Unknown tool: ${request.toolCall.function.name}`,
      };
    }

    return this.decider.decide(request, descriptor);
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
}

let toolPermissionManager: ToolPermissionManager | null = null;

export function getToolPermissionManager(): ToolPermissionManager {
  if (!toolPermissionManager) {
    toolPermissionManager = new ToolPermissionManager();
  }
  return toolPermissionManager;
}
