import { readFileSync } from "node:fs";
import { assert } from "chai";

describe("preferences checkbox rendering", function () {
  it("uses the native Zotero appearance for every XUL checkbox", function () {
    const markup = readFileSync(
      new URL("../addon/content/preferences.xhtml", import.meta.url),
      "utf8",
    );
    const checkboxes = markup.match(/<checkbox\b[^>]*\/?\s*>/g) ?? [];

    assert.isNotEmpty(checkboxes);
    for (const checkbox of checkboxes) {
      assert.include(checkbox, 'native="true"', checkbox);
    }
  });

  it("localizes XUL checkbox labels without replacing their native content", function () {
    const checkboxMessageIds = [
      "pref-aisummary-auto-generate-on-item-add",
      "pref-aisummary-include-annotations",
    ];

    for (const locale of ["en-US", "zh-CN"]) {
      const messages = readFileSync(
        new URL(`../addon/locale/${locale}/preferences.ftl`, import.meta.url),
        "utf8",
      );

      for (const messageId of checkboxMessageIds) {
        assert.match(
          messages,
          new RegExp(`^${messageId}\\s*=\\s*\\n\\s+\\.label\\s*=`, "m"),
          `${locale}: ${messageId}`,
        );
      }
    }
  });
});
