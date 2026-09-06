import { assert } from "chai";
import { updateAnimatedBalance } from "../src/modules/ui/chat-panel/AnimatedBalance.ts";

class TestAnimation {
  cancelled = false;
  finish!: () => void;
  reject!: (reason: Error) => void;
  finished = new Promise<void>((resolve, reject) => {
    this.finish = resolve;
    this.reject = reject;
  });
  constructor(readonly frames: Keyframe[]) {}
  cancel() {
    this.cancelled = true;
    this.reject(new Error("cancelled"));
  }
}

class TestDocument {
  reduced = false;
  animations: TestAnimation[] = [];
  defaultView = { matchMedia: () => ({ matches: this.reduced }) };
  createElementNS() {
    return new TestElement(this);
  }
}

class TestElement {
  isConnected = true;
  visible = true;
  style = {};
  children: TestElement[] = [];
  attributes = new Map<string, string>();
  private text = "";
  constructor(readonly ownerDocument: TestDocument) {}
  set textContent(text: string) {
    this.text = text;
    this.children = [];
  }
  get textContent(): string {
    return this.text + this.children.map((child) => child.textContent).join("");
  }
  setAttribute(key: string, value: string) {
    this.attributes.set(key, value);
  }
  getClientRects() {
    return this.visible ? [{}] : [];
  }
  appendChild(child: TestElement) {
    this.children.push(child);
  }
  animate(frames: Keyframe[]) {
    const animation = new TestAnimation(frames);
    this.ownerDocument.animations.push(animation);
    return animation;
  }
}

function fixture() {
  const doc = new TestDocument();
  const element = new TestElement(doc);
  const update = (label: string, value?: number) =>
    updateAnimatedBalance(element as unknown as HTMLElement, label, value);
  const finish = async () => {
    doc.animations.forEach((animation) => animation.finish());
    await Promise.resolve();
    await Promise.resolve();
  };
  return { doc, element, update, finish };
}

describe("animated chat balance", function () {
  it("shows the initial balance immediately and leaves unchanged text alone", function () {
    const { doc, element, update } = fixture();
    update("余额 12.3K", 12300);
    update("余额 12.3K", 12320);
    assert.equal(element.textContent, "余额 12.3K");
    assert.isEmpty(doc.animations);
  });

  it("rolls changed digits upward and preserves the accessible target", async function () {
    const { doc, element, update, finish } = fixture();
    update("余额 12.3K", 12300);
    update("余额 12.8K", 12800);
    assert.lengthOf(doc.animations, 2);
    assert.equal(doc.animations[1].frames[0].transform, "translateY(100%)");
    assert.equal(element.children[0].textContent, "余额 12.8K");
    assert.equal(element.children[1].attributes.get("aria-hidden"), "true");
    await finish();
    assert.equal(element.textContent, "余额 12.8K");
    assert.isEmpty(element.children);
  });

  it("uses the actual quota direction across compact-unit boundaries", async function () {
    const { doc, element, update, finish } = fixture();
    update("Balance 999.9K", 999900);
    update("Balance 1.0M", 1000000);
    assert.equal(doc.animations[1].frames[0].transform, "translateY(100%)");
    await finish();
    assert.equal(element.textContent, "Balance 1.0M");
  });

  it("rolls down for a decrease, including a negative balance", async function () {
    const { doc, element, update, finish } = fixture();
    update("余额 2", 2);
    update("余额 -1", -1);
    assert.equal(doc.animations[1].frames[0].transform, "translateY(-100%)");
    await finish();
    assert.equal(element.textContent, "余额 -1");
  });

  it("cancels old transitions when a newer balance arrives", async function () {
    const { doc, element, update, finish } = fixture();
    update("余额 9", 9);
    update("余额 10", 10);
    const old = [...doc.animations];
    update("余额 11", 11);
    assert.isTrue(old.every((animation) => animation.cancelled));
    await finish();
    assert.equal(element.textContent, "余额 11");
  });

  it("never restores account information after logout during a transition", async function () {
    const { element, update, finish } = fixture();
    update("余额 9", 9);
    update("余额 8", 8);
    update("登录/注册");
    await finish();
    assert.equal(element.textContent, "登录/注册");
  });

  it("updates immediately with reduced motion", function () {
    const { doc, element, update } = fixture();
    update("余额 9", 9);
    doc.reduced = true;
    update("余额 10", 10);
    assert.equal(element.textContent, "余额 10");
    assert.isEmpty(doc.animations);
  });

  it("does not animate a hidden account menu", function () {
    const { doc, element, update } = fixture();
    update("余额 9", 9);
    element.visible = false;
    update("余额 10", 10);
    assert.equal(element.textContent, "余额 10");
    assert.isEmpty(doc.animations);
  });

  it("does not animate a detached panel", function () {
    const { doc, element, update } = fixture();
    update("余额 9", 9);
    element.isConnected = false;
    update("余额 10", 10);
    assert.equal(element.textContent, "余额 10");
    assert.isEmpty(doc.animations);
  });
});
