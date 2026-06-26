import { assert } from "chai";
import { bindReadingLoopToolbarButtonEvents } from "../src/modules/ui/chat-panel/ReadingLoopToolbarEvents.ts";

describe("reading loop toolbar events", function () {
  it("shows the popover on hover and focus without changing click behavior", function () {
    const button = document.createElement("button");
    document.body.appendChild(button);

    const shown: string[] = [];
    const hidden: Document[] = [];
    let clickCount = 0;
    let panelShown = false;

    bindReadingLoopToolbarButtonEvents(button, {
      togglePanel: () => {
        clickCount += 1;
      },
      isPanelShown: () => panelShown,
      showPopover: (target) => {
        shown.push(target.tagName);
      },
      hidePopover: (doc) => {
        hidden.push(doc);
      },
    });

    button.dispatchEvent(new MouseEvent("mouseenter"));
    button.dispatchEvent(new MouseEvent("mousemove"));
    button.dispatchEvent(new FocusEvent("focus"));
    button.click();

    assert.deepEqual(shown, ["button", "button", "button"]);
    assert.equal(button.style.backgroundColor, "var(--fill-quinary)");
    assert.equal(clickCount, 1);

    button.dispatchEvent(new MouseEvent("mouseleave"));
    assert.equal(button.style.backgroundColor, "transparent");
    assert.deepEqual(hidden, [document]);

    panelShown = true;
    button.style.backgroundColor = "var(--fill-quinary)";
    button.dispatchEvent(new MouseEvent("mouseout"));
    assert.equal(button.style.backgroundColor, "var(--fill-quinary)");
    assert.deepEqual(hidden, [document, document]);

    button.dispatchEvent(new FocusEvent("blur"));
    assert.deepEqual(hidden, [document, document, document]);

    button.remove();
  });
});
