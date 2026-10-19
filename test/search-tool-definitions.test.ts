import { assert } from "chai";
import { createSearchToolDefinitions } from "../src/modules/chat/pdf-tools/SearchToolDefinitions.ts";

describe("search tool definitions", function () {
  it("only exposes web_fetch when the provider advertises Fetch", function () {
    assert.deepEqual(
      createSearchToolDefinitions().map((tool) => tool.function.name),
      ["web_search", "search_scholarly_sources"],
    );
    assert.deepEqual(
      createSearchToolDefinitions({ includeFetch: true }).map(
        (tool) => tool.function.name,
      ),
      ["web_search", "web_fetch", "search_scholarly_sources"],
    );
  });

  it("describes Fetch as URL-specific untrusted page reading", function () {
    const fetch = createSearchToolDefinitions({ includeFetch: true }).find(
      (tool) => tool.function.name === "web_fetch",
    );
    assert.isDefined(fetch);
    assert.include(fetch?.function.description || "", "Markdown");
    assert.include(fetch?.function.description || "", "untrusted");
    assert.deepEqual(fetch?.function.parameters.required, ["url"]);
  });
});
