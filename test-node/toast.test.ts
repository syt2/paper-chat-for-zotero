import { assert } from "chai";
import { hideToast, showToast } from "../src/modules/ui/toast";

class FakeElement {
  readonly style: Record<string, string> = {};
  readonly children: FakeElement[] = [];
  readonly listeners: Array<() => void> = [];
  parentElement: FakeElement | null = null;
  textContent = "";

  constructor(readonly tagName: string) {}

  get isConnected(): boolean {
    return this.parentElement !== null;
  }

  appendChild(child: FakeElement): FakeElement {
    if (child.parentElement) {
      child.parentElement.children.splice(
        child.parentElement.children.indexOf(child),
        1,
      );
    }
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  addEventListener(type: string, listener: () => void): void {
    if (type === "click") {
      this.listeners.push(listener);
    }
  }

  setAttribute(): void {}

  click(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

class FakeDocument {
  readonly documentElement = new FakeElement("html");

  createElement(tag: string): FakeElement {
    return new FakeElement(tag);
  }
}

function asDocument(doc: FakeDocument): Document {
  return doc as unknown as Document;
}

function asElement(element: FakeElement): HTMLElement {
  return element as unknown as HTMLElement;
}

function stubMainWindow(doc?: FakeDocument): void {
  (
    globalThis as unknown as { Zotero: { getMainWindow: () => unknown } }
  ).Zotero = {
    getMainWindow: () => (doc ? { document: asDocument(doc) } : undefined),
  };
}

describe("panel toast", function () {
  it("reuses one element per document and keeps the last message", function () {
    stubMainWindow();
    const doc = new FakeDocument();
    const container = new FakeElement("div");

    showToast("first", {
      doc: asDocument(doc),
      container: asElement(container),
    });
    const toast = showToast("second", {
      doc: asDocument(doc),
      container: asElement(container),
    });

    assert.lengthOf(container.children, 1);
    assert.strictEqual(toast, container.children[0]);
    assert.equal(container.children[0].textContent, "second");
    hideToast(asDocument(doc));
  });

  it("mounts in the container the caller passes", function () {
    stubMainWindow();
    const doc = new FakeDocument();
    const first = new FakeElement("div");
    const second = new FakeElement("div");

    showToast("in panel", {
      doc: asDocument(doc),
      container: asElement(first),
    });
    showToast("in other window", {
      doc: asDocument(doc),
      container: asElement(second),
    });

    assert.lengthOf(first.children, 0);
    assert.lengthOf(second.children, 1);
    hideToast(asDocument(doc));
  });

  it("hides itself after the requested duration", async function () {
    stubMainWindow();
    const doc = new FakeDocument();
    const container = new FakeElement("div");

    const toast = showToast("auto hide", {
      doc: asDocument(doc),
      container: asElement(container),
      durationMs: 10,
    });
    assert.equal(toast?.style.opacity, "1");

    await new Promise((resolve) => setTimeout(resolve, 40));

    assert.equal(toast?.style.opacity, "0");
    assert.equal(toast?.style.pointerEvents, "none");
  });

  it("is dismissed early by a click", function () {
    stubMainWindow();
    const doc = new FakeDocument();
    const container = new FakeElement("div");

    const toast = showToast("click me", {
      doc: asDocument(doc),
      container: asElement(container),
      durationMs: 60_000,
    });
    (toast as unknown as FakeElement).click();

    assert.equal(toast?.style.opacity, "0");
  });

  it("falls back to the main window and survives having none", function () {
    const doc = new FakeDocument();
    stubMainWindow(doc);
    const target = asDocument(doc).documentElement;

    assert.isNotNull(showToast("main window"));
    assert.lengthOf((target as unknown as FakeElement).children, 1);

    stubMainWindow();
    assert.isNull(showToast("nowhere"));
    assert.isNull(showToast("   "));
  });
});
