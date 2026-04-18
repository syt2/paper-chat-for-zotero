import type { PaperToolName, ToolRuntimeMetadata } from "../../../types/tool";

function assertParallelSafeInvariants(
  registry: Record<string, ToolRuntimeMetadata>,
): void {
  for (const metadata of Object.values(registry)) {
    if (metadata.concurrency === "parallel_safe" && metadata.mutatesState) {
      throw new Error(
        `[ToolMetadataRegistry] invariant violation: tool "${metadata.name}" ` +
          `is marked parallel_safe but mutatesState=true. A write-class tool ` +
          `must run serially.`,
      );
    }
  }
}

const TOOL_RUNTIME_METADATA: Record<PaperToolName, ToolRuntimeMetadata> = {
  web_search: {
    name: "web_search",
    executionClass: "network",
    concurrency: "parallel_safe",
    targetScope: "external",
    mutatesState: false,
  },
  get_paper_section: {
    name: "get_paper_section",
    executionClass: "read",
    concurrency: "parallel_safe",
    targetScope: "paper",
    mutatesState: false,
  },
  search_paper_content: {
    name: "search_paper_content",
    executionClass: "read",
    concurrency: "parallel_safe",
    targetScope: "paper",
    mutatesState: false,
  },
  get_paper_metadata: {
    name: "get_paper_metadata",
    executionClass: "read",
    concurrency: "parallel_safe",
    targetScope: "paper",
    mutatesState: false,
  },
  get_pages: {
    name: "get_pages",
    executionClass: "read",
    concurrency: "parallel_safe",
    targetScope: "paper",
    mutatesState: false,
  },
  get_page_count: {
    name: "get_page_count",
    executionClass: "read",
    concurrency: "parallel_safe",
    targetScope: "paper",
    mutatesState: false,
  },
  search_with_regex: {
    name: "search_with_regex",
    executionClass: "read",
    concurrency: "parallel_safe",
    targetScope: "paper",
    mutatesState: false,
  },
  get_outline: {
    name: "get_outline",
    executionClass: "read",
    concurrency: "parallel_safe",
    targetScope: "paper",
    mutatesState: false,
  },
  list_sections: {
    name: "list_sections",
    executionClass: "read",
    concurrency: "parallel_safe",
    targetScope: "paper",
    mutatesState: false,
  },
  get_full_text: {
    name: "get_full_text",
    executionClass: "high_cost",
    concurrency: "serial",
    targetScope: "paper",
    mutatesState: false,
  },
  list_all_items: {
    name: "list_all_items",
    executionClass: "read",
    concurrency: "parallel_safe",
    targetScope: "library",
    mutatesState: false,
  },
  get_item_notes: {
    name: "get_item_notes",
    executionClass: "read",
    concurrency: "parallel_safe",
    targetScope: "library",
    mutatesState: false,
  },
  get_note_content: {
    name: "get_note_content",
    executionClass: "read",
    concurrency: "parallel_safe",
    targetScope: "library",
    mutatesState: false,
  },
  get_item_metadata: {
    name: "get_item_metadata",
    executionClass: "read",
    concurrency: "parallel_safe",
    targetScope: "library",
    mutatesState: false,
  },
  get_annotations: {
    name: "get_annotations",
    executionClass: "read",
    concurrency: "parallel_safe",
    targetScope: "library",
    mutatesState: false,
  },
  get_pdf_selection: {
    name: "get_pdf_selection",
    executionClass: "read",
    concurrency: "serial",
    targetScope: "paper",
    mutatesState: false,
    requiresActivePaper: true,
  },
  search_items: {
    name: "search_items",
    executionClass: "read",
    concurrency: "parallel_safe",
    targetScope: "library",
    mutatesState: false,
  },
  get_collections: {
    name: "get_collections",
    executionClass: "read",
    concurrency: "parallel_safe",
    targetScope: "library",
    mutatesState: false,
  },
  get_collection_items: {
    name: "get_collection_items",
    executionClass: "read",
    concurrency: "parallel_safe",
    targetScope: "library",
    mutatesState: false,
  },
  get_tags: {
    name: "get_tags",
    executionClass: "read",
    concurrency: "parallel_safe",
    targetScope: "library",
    mutatesState: false,
  },
  search_by_tag: {
    name: "search_by_tag",
    executionClass: "read",
    concurrency: "parallel_safe",
    targetScope: "library",
    mutatesState: false,
  },
  get_recent: {
    name: "get_recent",
    executionClass: "read",
    concurrency: "parallel_safe",
    targetScope: "library",
    mutatesState: false,
  },
  search_notes: {
    name: "search_notes",
    executionClass: "read",
    concurrency: "parallel_safe",
    targetScope: "library",
    mutatesState: false,
  },
  create_note: {
    name: "create_note",
    executionClass: "write",
    concurrency: "serial",
    targetScope: "library",
    mutatesState: true,
  },
  batch_update_tags: {
    name: "batch_update_tags",
    executionClass: "write",
    concurrency: "serial",
    targetScope: "library",
    mutatesState: true,
  },
  add_item: {
    name: "add_item",
    executionClass: "write",
    concurrency: "serial",
    targetScope: "library",
    mutatesState: true,
  },
  save_memory: {
    name: "save_memory",
    executionClass: "memory",
    concurrency: "serial",
    targetScope: "memory",
    mutatesState: true,
  },
};

assertParallelSafeInvariants(TOOL_RUNTIME_METADATA);

export function getToolRuntimeMetadata(
  toolName: string,
): ToolRuntimeMetadata | null {
  return (
    TOOL_RUNTIME_METADATA[toolName as keyof typeof TOOL_RUNTIME_METADATA] ??
    null
  );
}

export function listToolRuntimeMetadata(
  toolNames?: string[],
): ToolRuntimeMetadata[] {
  if (!toolNames) {
    return Object.values(TOOL_RUNTIME_METADATA);
  }

  const results: ToolRuntimeMetadata[] = [];
  for (const toolName of toolNames) {
    const metadata = getToolRuntimeMetadata(toolName);
    if (metadata) {
      results.push(metadata);
    } else {
      ztoolkit.log(
        `[ToolMetadataRegistry] No runtime metadata for tool "${toolName}". ` +
          `Tools without metadata default to serial execution — check the registry.`,
      );
    }
  }
  return results;
}
