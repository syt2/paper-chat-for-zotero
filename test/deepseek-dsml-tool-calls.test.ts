import { assert } from "chai";
import {
  parseDsmlToolCallsFromContent,
  stripDsmlToolCallBlocks,
} from "../src/modules/providers/OpenAICompatibleProvider.ts";

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
});
