import { assert } from "chai";
import { dispatchInputEvent } from "../src/modules/ui/chat-panel/InputEvents.ts";

describe("chat input events in Zotero's sandbox", function () {
  it("uses the input window's Event when the global constructor is absent", function () {
    const runtime = globalThis as any;
    const originalEvent = runtime.Event;
    let received: Event | undefined;
    class WindowEvent extends originalEvent {}
    try {
      runtime.Event = undefined;
      const input = {
        ownerDocument: { defaultView: { Event: WindowEvent } },
        dispatchEvent: (event: Event) => {
          received = event;
          return true;
        },
      } as unknown as HTMLTextAreaElement;
      dispatchInputEvent(input);
      assert.instanceOf(received, WindowEvent);
      assert.equal(received?.type, "input");
      assert.isTrue(received?.bubbles);
    } finally {
      runtime.Event = originalEvent;
    }
  });
});
