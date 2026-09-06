import { assert } from "chai";
import {
  parseBalanceNumber,
  updateAnimatedBalance,
  type BalanceFlowElement,
} from "../src/modules/ui/chat-panel/AnimatedBalance.ts";

class TestElement {
  isConnected = true;
  visible = true;
  style = {};
  children: TestElement[] = [];
  parentElement: TestElement | null = null;
  attributes = new Map<string, string>();
  private text = "";
  constructor(readonly ownerDocument: TestDocument) {}
  set textContent(text: string) {
    this.text = text;
    this.children.forEach((child) => {
      child.parentElement = null;
    });
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
    child.parentElement = this;
    this.children.push(child);
  }
  querySelector() {
    return (
      this.children.find((child) =>
        child.attributes.has("data-balance-label"),
      ) || null
    );
  }
}

class TestFlow extends TestElement {
  updates: Array<Parameters<BalanceFlowElement["updateBalance"]>> = [];
  updateBalance(...args: Parameters<BalanceFlowElement["updateBalance"]>) {
    this.updates.push(args);
  }
}

class TestDocument {
  reduced = false;
  flows: TestFlow[] = [];
  defaultView = {
    CSS: { registerProperty: (() => {}) as (() => void) | undefined },
    matchMedia: () => ({ matches: this.reduced }),
    PaperChatNumberFlowBundle: {
      create: () => {
        const flow = new TestFlow(this);
        this.flows.push(flow);
        return flow;
      },
    },
  };
  createElementNS() {
    return new TestElement(this);
  }
}

function fixture() {
  const doc = new TestDocument();
  const element = new TestElement(doc);
  const update = (label: string, value?: number) =>
    updateAnimatedBalance(element as unknown as HTMLElement, label, value);
  return { doc, element, update };
}

describe("NumberFlow chat balance", function () {
  it("preserves decimal precision, signs and compact-unit labels", function () {
    for (const [label, number, decimals, prefix, suffix] of [
      ["余额 999", 999, 0, "余额 ", ""],
      ["余额 1.0K", 1, 1, "余额 ", "K"],
      ["订阅额度: 12.30M", 12.3, 2, "订阅额度: ", "M"],
      ["余额 -0.5", -0.5, 1, "余额 ", ""],
    ]) {
      assert.deepEqual(parseBalanceNumber(label as string), {
        number,
        decimals,
        prefix,
        suffix,
      });
    }
    assert.isNull(parseBalanceNumber("登录/注册"));
  });

  it("does not animate initial values or unchanged formatted numbers", function () {
    const { doc, element, update } = fixture();
    update("余额 12.3K", 12300);
    update("余额 12.3K", 12320);
    assert.lengthOf(doc.flows, 1);
    assert.lengthOf(doc.flows[0].updates, 1);
    assert.isFalse(doc.flows[0].updates[0][5]);
    assert.equal(element.textContent, "余额 12.3K");
    assert.equal(doc.flows[0].attributes.get("aria-hidden"), "true");
  });

  it("animates toward the raw quota direction across decimal and unit boundaries", function () {
    const { doc, element, update } = fixture();
    update("余额 999", 999);
    update("余额 1.0K", 1000);
    assert.deepEqual(doc.flows[0].updates.at(-1), [
      1,
      1,
      "余额 ",
      "K",
      1,
      true,
    ]);
    update("余额 999", 999);
    assert.deepEqual(doc.flows[0].updates.at(-1), [
      999,
      0,
      "余额 ",
      "",
      -1,
      true,
    ]);
    assert.equal(element.textContent, "余额 999");
  });

  it("reuses one NumberFlow instance for rapid successive updates", function () {
    const { doc, update } = fixture();
    update("余额 9", 9);
    update("余额 10", 10);
    update("余额 11", 11);
    assert.lengthOf(doc.flows, 1);
    assert.equal(doc.flows[0].updates.at(-1)?.[0], 11);
  });

  it("discards the old renderer at logout and starts the next account without animation", function () {
    const { doc, element, update } = fixture();
    update("余额 9", 9);
    update("余额 8", 8);
    const oldFlow = doc.flows[0];
    update("登录/注册");
    assert.equal(element.textContent, "登录/注册");
    assert.isNull(oldFlow.parentElement);
    update("余额 20", 20);
    assert.lengthOf(doc.flows, 2);
    assert.isFalse(doc.flows[1].updates[0][5]);
  });

  it("renders ordinary text without loading NumberFlow on Zotero 7", function () {
    const { doc, element, update } = fixture();
    doc.defaultView.CSS.registerProperty = undefined;
    update("余额 9", 9);
    update("余额 10", 10);
    assert.equal(element.textContent, "余额 10");
    assert.isEmpty(doc.flows);
  });

  it("falls back to the current label after a renderer failure", function () {
    const originalToolkit = (globalThis as { ztoolkit?: unknown }).ztoolkit;
    (globalThis as { ztoolkit?: unknown }).ztoolkit = { log: () => {} };
    try {
      const { doc, element, update } = fixture();
      update("余额 9", 9);
      doc.flows[0].updateBalance = () => {
        throw new Error("animation unavailable");
      };
      update("余额 10", 10);
      assert.equal(element.textContent, "余额 10");
      update("余额 11", 11);
      assert.equal(element.textContent, "余额 11");
      assert.lengthOf(doc.flows, 1, "Do not repeatedly load a failed renderer");
      update("登录/注册");
      assert.equal(element.textContent, "登录/注册");
    } finally {
      (globalThis as { ztoolkit?: unknown }).ztoolkit = originalToolkit;
    }
  });

  it("disables motion for hidden, detached, and reduced-motion views", function () {
    const { doc, element, update } = fixture();
    update("余额 9", 9);
    doc.reduced = true;
    update("余额 10", 10);
    doc.reduced = false;
    element.visible = false;
    update("余额 11", 11);
    element.visible = true;
    element.isConnected = false;
    update("余额 12", 12);
    assert.isTrue(doc.flows[0].updates.every((args) => !args[5]));
  });
});
