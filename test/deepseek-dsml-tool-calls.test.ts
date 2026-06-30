import { assert } from "chai";
import {
  parseDsmlToolCallsFromContent,
  resolveDsmlFallbackContent,
  stripDsmlToolCallBlocks,
} from "../src/modules/providers/OpenAICompatibleProvider.ts";
import type { ToolDefinition } from "../src/types/tool.ts";

const allowedTools: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "search_paper_content",
      description: "Search paper text",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search query",
          },
        },
      },
    },
  },
];

describe("DeepSeek DSML tool call fallback", function () {
  it("parses leaked DSML tool calls from message content", function () {
    const content = `before
<｜DSML｜tool_calls>
<｜DSML｜invoke name="search_paper_content">
<｜DSML｜parameter name="query" string="true">high-val[ue]*t nickel</｜DSML｜parameter>
<｜DSML｜parameter name="context_lines" string="false">2</｜DSML｜parameter>
<｜DSML｜parameter name="max_results" string="false">10</｜DSML｜parameter>
</｜DSML｜invoke>
<｜DSML｜invoke name="get_pages">
<｜DSML｜parameter name="itemKey" string="true">VAG2KY98</｜DSML｜parameter>
<｜DSML｜parameter name="pages" string="true">2</｜DSML｜parameter>
</｜DSML｜invoke>
</｜DSML｜tool_calls>
after`;

    const toolCalls = parseDsmlToolCallsFromContent(content);

    assert.lengthOf(toolCalls, 2);
    assert.equal(toolCalls[0].id, "dsml_call_0");
    assert.equal(toolCalls[0].function.name, "search_paper_content");
    assert.deepEqual(JSON.parse(toolCalls[0].function.arguments), {
      query: "high-val[ue]*t nickel",
      context_lines: "2",
      max_results: "10",
    });
    assert.equal(toolCalls[1].function.name, "get_pages");
    assert.deepEqual(JSON.parse(toolCalls[1].function.arguments), {
      itemKey: "VAG2KY98",
      pages: "2",
    });
  });

  it("strips DSML tool call blocks from display content", function () {
    const content = `intro
<｜DSML｜tool_calls>
<｜DSML｜invoke name="get_pages">
<｜DSML｜parameter name="pages" string="true">2</｜DSML｜parameter>
</｜DSML｜invoke>
</｜DSML｜tool_calls>
outro`;

    assert.equal(stripDsmlToolCallBlocks(content), "intro\n\noutro");
  });

  it("recovers doubled fullwidth delimiters and typographic quotes", function () {
    const content = `before
<｜｜DSML｜｜tool_calls>
<｜｜DSML｜｜invoke name=“get_pages”>
<｜｜DSML｜｜parameter name=“pages” string=“true”>3-5</｜｜DSML｜｜parameter>
</｜｜DSML｜｜invoke>
</｜｜DSML｜｜tool_calls>
after`;

    const toolCalls = parseDsmlToolCallsFromContent(content);

    assert.lengthOf(toolCalls, 1);
    assert.equal(toolCalls[0].function.name, "get_pages");
    assert.deepEqual(JSON.parse(toolCalls[0].function.arguments), {
      pages: "3-5",
    });
    assert.equal(stripDsmlToolCallBlocks(content), "before\n\nafter");
  });

  it("accepts simple unquoted DSML attributes", function () {
    const content = `<||DSML||tool_calls>
<||DSML||invoke name=get_pages>
<||DSML||parameter name=pages string=true>7</||DSML||parameter>
</||DSML||invoke>
</||DSML||tool_calls>`;

    const toolCalls = parseDsmlToolCallsFromContent(content);

    assert.lengthOf(toolCalls, 1);
    assert.equal(toolCalls[0].function.name, "get_pages");
    assert.deepEqual(JSON.parse(toolCalls[0].function.arguments), {
      pages: "7",
    });
    assert.equal(stripDsmlToolCallBlocks(content), "");
  });

  it("strips disallowed DSML blocks without executing them", function () {
    const content = `before
<｜｜DSML｜｜tool_calls>
<｜｜DSML｜｜invoke name=“search_with_regex”>
<｜｜DSML｜｜parameter name=“pattern” string=“true”>scores based on 100 utterances</｜｜DSML｜｜parameter>
</｜｜DSML｜｜invoke>
</｜｜DSML｜｜tool_calls>
after`;

    const fallback = resolveDsmlFallbackContent(content, allowedTools, true);

    assert.isTrue(fallback.hasDsmlBlock);
    assert.deepEqual(fallback.toolCalls, []);
    assert.equal(fallback.cleanContent, "before\n\nafter");
  });

  it("keeps allowed DSML tool calls while stripping display content", function () {
    const content = `before
<｜｜DSML｜｜tool_calls>
<｜｜DSML｜｜invoke name=“search_paper_content”>
<｜｜DSML｜｜parameter name=“query” string=“true”>neural activity</｜｜DSML｜｜parameter>
</｜｜DSML｜｜invoke>
</｜｜DSML｜｜tool_calls>
after`;

    const fallback = resolveDsmlFallbackContent(content, allowedTools, true);

    assert.isTrue(fallback.hasDsmlBlock);
    assert.lengthOf(fallback.toolCalls, 1);
    assert.equal(fallback.toolCalls[0].function.name, "search_paper_content");
    assert.deepEqual(JSON.parse(fallback.toolCalls[0].function.arguments), {
      query: "neural activity",
    });
    assert.equal(fallback.cleanContent, "before\n\nafter");
  });
});
