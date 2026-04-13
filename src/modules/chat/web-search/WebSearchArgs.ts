import type { WebSearchArgs } from "../../../types/tool";

export function isValidWebSearchArgs(args: unknown): args is WebSearchArgs {
  return (
    typeof args === "object" &&
    args !== null &&
    typeof (args as WebSearchArgs).query === "string" &&
    (typeof (args as WebSearchArgs).max_results === "undefined" ||
      typeof (args as WebSearchArgs).max_results === "number") &&
    (typeof (args as WebSearchArgs).include_content === "undefined" ||
      typeof (args as WebSearchArgs).include_content === "boolean") &&
    (typeof (args as WebSearchArgs).domain_filter === "undefined" ||
      (Array.isArray((args as WebSearchArgs).domain_filter) &&
        (args as WebSearchArgs).domain_filter!.every(
          (domain) => typeof domain === "string",
        )))
  );
}
