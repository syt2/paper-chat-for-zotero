import type { ToolCallingStopReason } from "../../types/chat";

/**
 * Normalize provider-specific completion reasons before they reach the agent
 * runtime. Unknown terminal reasons deliberately remain ordinary end turns.
 */
export function normalizeToolCallingStopReason(
  stopReason: string | null | undefined,
): ToolCallingStopReason {
  switch (stopReason) {
    case "tool_calls":
    case "tool_use":
    case "function_call":
      return "tool_calls";
    case "length":
    case "max_tokens":
    case "max_output_tokens":
      return "max_tokens";
    case "stop":
      return "stop";
    default:
      return "end_turn";
  }
}
