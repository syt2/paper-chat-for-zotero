import { assert } from "chai";
import { refreshChatThemeContent } from "../src/modules/ui/chat-panel/ChatThemeRefresh.ts";

describe("chat theme refresh", function () {
  it("preserves form drafts, choices and focused text selection across a redraw", function () {
    const field = (type: string, value: string) => ({
      tagName: "INPUT",
      name: type,
      type,
      value,
      checked: false,
      selectionStart: type === "text" ? 1 : null,
      selectionEnd: type === "text" ? 3 : null,
      focused: false,
      focus(options: unknown) {
        assert.deepEqual(options, { preventScroll: true });
        this.focused = true;
      },
      setSelectionRange(start: number, end: number) {
        this.selectionStart = start;
        this.selectionEnd = end;
      },
    });
    let controls = [field("text", "draft"), field("radio", "choice")];
    controls[1].checked = true;
    const container = {
      ownerDocument: { activeElement: controls[0] },
      querySelectorAll: () => controls,
    };
    refreshChatThemeContent(container as any, () => {
      controls = [field("text", ""), field("radio", "choice")];
    });
    assert.equal(controls[0].value, "draft");
    assert.isTrue(controls[0].focused);
    assert.equal(controls[0].selectionStart, 1);
    assert.equal(controls[0].selectionEnd, 3);
    assert.isTrue(controls[1].checked);
  });

  it("does not restore drafts onto a different control", function () {
    let controls = [
      { tagName: "INPUT", name: "first", type: "text", value: "private draft" },
    ];
    const container = {
      ownerDocument: { activeElement: null },
      querySelectorAll: () => controls,
    };
    refreshChatThemeContent(container as any, () => {
      controls = [
        { tagName: "INPUT", name: "second", type: "text", value: "" },
      ];
    });
    assert.equal(controls[0].value, "");
  });
});
