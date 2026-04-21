import { assert } from "chai";
import { buildErrorProps } from "../src/modules/analytics/errorProps.ts";

describe("buildErrorProps", function () {
  it("returns only reason for known reasons", function () {
    assert.deepEqual(buildErrorProps("rate_limited", new Error("boom")), {
      reason: "rate_limited",
    });
  });

  it("keeps unknown Error messages as detail", function () {
    assert.deepEqual(buildErrorProps("unknown", new Error("server boom")), {
      reason: "unknown",
      error_detail: "server boom",
    });
  });

  it("keeps unknown string errors as detail", function () {
    assert.deepEqual(buildErrorProps("unknown", "plain text failure"), {
      reason: "unknown",
      error_detail: "plain text failure",
    });
  });

  it("redacts email addresses", function () {
    assert.deepEqual(
      buildErrorProps("unknown", "failed for foo@example.com"),
      {
        reason: "unknown",
        error_detail: "failed for [email]",
      },
    );
  });

  it("redacts urls and paths", function () {
    assert.deepEqual(
      buildErrorProps(
        "unknown",
        "request failed at https://example.com/api/login and /tmp/session.txt",
      ),
      {
        reason: "unknown",
        error_detail: "request failed at [path] and [path]",
      },
    );
  });

  it("truncates long messages", function () {
    const result = buildErrorProps("unknown", "a".repeat(250));
    assert.equal(result.reason, "unknown");
    assert.equal(result.error_detail, `${"a".repeat(200)}…`);
  });

  it("omits detail when error is undefined", function () {
    assert.deepEqual(buildErrorProps("unknown"), {
      reason: "unknown",
    });
  });
});
