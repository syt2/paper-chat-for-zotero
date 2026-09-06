import { assert } from "chai";
import { bindChatDisclosure } from "../src/modules/ui/chat-panel/ChatPanelChrome.ts";

type FakeEvent = {
  target: FakeElement;
  relatedTarget?: FakeElement | null;
  key?: string;
  defaultPrevented: boolean;
  propagationStopped: boolean;
  preventDefault(): void;
  stopPropagation(): void;
};

class FakeElement {
  parentElement: FakeElement | null = null;
  open = false;
  focusCount = 0;
  private listeners = new Map<string, Array<(event: FakeEvent) => void>>();

  constructor(readonly tagName: string) {}

  appendChild(child: FakeElement): void {
    child.parentElement = this;
  }

  contains(target: FakeElement | null): boolean {
    for (let node = target; node; node = node.parentElement) {
      if (node === this) return true;
    }
    return false;
  }

  closest(tagName: string): FakeElement | null {
    return this.tagName === tagName
      ? this
      : (this.parentElement?.closest(tagName) ?? null);
  }

  addEventListener(type: string, listener: (event: FakeEvent) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatch(
    type: string,
    details: { relatedTarget?: FakeElement | null; key?: string } = {},
  ): FakeEvent {
    const event: FakeEvent = {
      target: this,
      ...details,
      defaultPrevented: false,
      propagationStopped: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      stopPropagation() {
        this.propagationStopped = true;
      },
    };
    // Mouse, keyboard and focusin/out events used here bubble through the tree.
    this.bubble(type, event);
    return event;
  }

  private bubble(type: string, event: FakeEvent): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
    if (!event.propagationStopped) this.parentElement?.bubble(type, event);
  }

  focus(): void {
    this.focusCount += 1;
    this.dispatch("focusin");
  }
}

function createDisclosure() {
  const container = new FakeElement("div");
  const menu = new FakeElement("details");
  const trigger = new FakeElement("summary");
  const button = new FakeElement("button");
  const outside = new FakeElement("textarea");
  container.appendChild(menu);
  container.appendChild(outside);
  menu.appendChild(trigger);
  menu.appendChild(button);
  bindChatDisclosure(
    container as unknown as HTMLElement,
    menu as unknown as HTMLDetailsElement,
    trigger as unknown as HTMLElement,
  );
  menu.open = true;
  return { container, menu, trigger, button, outside };
}

describe("chat account disclosure interactions", function () {
  it("keeps the action reachable through focusout between pointer down and click", function () {
    const { container, menu, trigger, button } = createDisclosure();
    let actionCount = 0;
    button.addEventListener("click", () => {
      actionCount += 1;
    });

    button.dispatch("mousedown");
    trigger.dispatch("focusout", { relatedTarget: container });
    // Real macOS pointer clicks focus the panel before delivering the action.
    container.dispatch("focusin", { relatedTarget: trigger });
    // Closing details here removes the button before the browser delivers click.
    assert.isTrue(menu.open);
    button.dispatch("mouseup");
    button.dispatch("click");

    assert.equal(actionCount, 1);
    // The business action owns dismissal, including any asynchronous outcome.
    assert.isTrue(menu.open);
  });

  it("does not dismiss when keyboard focus moves to a menu action", function () {
    const { menu, trigger, button } = createDisclosure();
    trigger.dispatch("focusout", { relatedTarget: button });
    button.dispatch("focusin", { relatedTarget: trigger });
    assert.isTrue(menu.open);
  });

  it("keeps native disclosure open on focus changes until click or Escape", function () {
    const { menu, button, outside } = createDisclosure();
    outside.dispatch("focusin", { relatedTarget: button });
    assert.isTrue(menu.open);
  });

  it("dismisses on an outside click without swallowing the outside action", function () {
    const { menu, outside } = createDisclosure();
    let actionCount = 0;
    outside.addEventListener("click", () => {
      actionCount += 1;
    });
    outside.dispatch("click");
    assert.isFalse(menu.open);
    assert.equal(actionCount, 1);
  });

  it("dismisses on Escape and restores focus to the avatar trigger", function () {
    const { menu, trigger, button } = createDisclosure();
    const event = button.dispatch("keydown", { key: "Escape" });
    assert.isFalse(menu.open);
    assert.isTrue(event.defaultPrevented);
    assert.isTrue(event.propagationStopped);
    assert.equal(trigger.focusCount, 1);
  });

  it("leaves unrelated keys and Escape on an already closed menu alone", function () {
    const { menu, trigger, button } = createDisclosure();
    const enter = button.dispatch("keydown", { key: "Enter" });
    assert.isTrue(menu.open);
    assert.isFalse(enter.defaultPrevented);
    menu.open = false;
    const escape = button.dispatch("keydown", { key: "Escape" });
    assert.isFalse(escape.defaultPrevented);
    assert.equal(trigger.focusCount, 0);
  });
});
