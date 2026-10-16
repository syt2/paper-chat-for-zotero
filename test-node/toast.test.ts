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
    const previousParent = child.parentElement;
    if (previousParent) {
      previousParent.children.splice(previousParent.children.indexOf(child), 1);
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

describe("toast", function () {
  it("reuses one element per mount point and keeps the last message", function () {
    stubMainWindow();
    const doc = new FakeDocument();
    const container = asElement(new FakeElement("div"));

    showToast("first", { doc: asDocument(doc), container });
    const toast = showToast("second", { doc: asDocument(doc), container });

    const host = container as unknown as FakeElement;
    assert.lengthOf(host.children, 1);
    assert.strictEqual(toast, asElement(host.children[0]));
    assert.equal(host.children[0].textContent, "second");
    hideToast(toast);
  });

  it("gives each container its own toast when it is asked to mount inside one", function () {
    stubMainWindow();
    const doc = new FakeDocument();
    const panel = asElement(new FakeElement("div"));
    const other = asElement(new FakeElement("div"));

    const inPanel = showToast("in panel", {
      doc: asDocument(doc),
      container: panel,
      positioning: "container",
    });

    assert.equal(inPanel?.style.position, "absolute");
    const panelHost = panel as unknown as FakeElement;
    const otherHost = other as unknown as FakeElement;
    assert.lengthOf(panelHost.children, 1);
    // The panel shares the main window's document, so a toast pinned to the
    // viewport lands over the wrong pane: the container must be made a
    // containing block for the toast.
    assert.equal(panelHost.style.position, "relative");

    showToast("over the window", {
      doc: asDocument(doc),
      container: other,
      positioning: "viewport",
    });
    assert.lengthOf(otherHost.children, 1);
    assert.equal(otherHost.style.position, undefined);
  });

  it("hides itself after the requested duration", async function () {
    stubMainWindow();
    const doc = new FakeDocument();
    const container = asElement(new FakeElement("div"));

    const toast = showToast("auto hide", {
      doc: asDocument(doc),
      container,
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
    const container = asElement(new FakeElement("div"));

    const toast = showToast("click me", {
      doc: asDocument(doc),
      container,
      durationMs: 60_000,
    });
    (toast as unknown as FakeElement).click();

    assert.equal(toast?.style.opacity, "0");
  });

  it("falls back to the main window and survives having none", function () {
    const doc = new FakeDocument();
    stubMainWindow(doc);
    const toast = showToast("main window");

    assert.isNotNull(toast);
    assert.lengthOf(
      (asDocument(doc).documentElement as unknown as FakeElement).children,
      1,
    );
    assert.equal(toast?.style.position, "fixed");

    stubMainWindow();
    assert.isNull(showToast("nowhere"));
    assert.isNull(showToast("   "));
  });
});
