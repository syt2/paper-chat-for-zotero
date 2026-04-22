import {
  WEB_SEARCH_INTENTS,
  WEB_SEARCH_SOURCES,
  type WebSearchArgs,
} from "../../../types/tool";

const WEB_SEARCH_SOURCE_SET = new Set<string>(WEB_SEARCH_SOURCES);
const WEB_SEARCH_INTENT_SET = new Set<string>(WEB_SEARCH_INTENTS);

export function isValidWebSearchArgs(args: unknown): args is WebSearchArgs {
  const source = (args as WebSearchArgs).source;
  const intent = (args as WebSearchArgs).intent;

  return (
    typeof args === "object" &&
    args !== null &&
    typeof (args as WebSearchArgs).query === "string" &&
    (typeof source === "undefined" ||
      (typeof source === "string" && WEB_SEARCH_SOURCE_SET.has(source))) &&
    (typeof intent === "undefined" ||
      (typeof intent === "string" && WEB_SEARCH_INTENT_SET.has(intent))) &&
    (typeof (args as WebSearchArgs).max_results === "undefined" ||
      typeof (args as WebSearchArgs).max_results === "number") &&
    (typeof (args as WebSearchArgs).include_content === "undefined" ||
      typeof (args as WebSearchArgs).include_content === "boolean") &&
    (typeof (args as WebSearchArgs).year_from === "undefined" ||
      typeof (args as WebSearchArgs).year_from === "number") &&
    (typeof (args as WebSearchArgs).year_to === "undefined" ||
      typeof (args as WebSearchArgs).year_to === "number") &&
    (typeof (args as WebSearchArgs).open_access_only === "undefined" ||
      typeof (args as WebSearchArgs).open_access_only === "boolean") &&
    (typeof (args as WebSearchArgs).seed_title === "undefined" ||
      typeof (args as WebSearchArgs).seed_title === "string") &&
    (typeof (args as WebSearchArgs).seed_doi === "undefined" ||
      typeof (args as WebSearchArgs).seed_doi === "string") &&
    (typeof (args as WebSearchArgs).seed_paper_id === "undefined" ||
      typeof (args as WebSearchArgs).seed_paper_id === "string") &&
    (typeof (args as WebSearchArgs).domain_filter === "undefined" ||
      (Array.isArray((args as WebSearchArgs).domain_filter) &&
        (args as WebSearchArgs).domain_filter!.every(
          (domain) => typeof domain === "string",
        )))
  );
}
