import { assert } from "chai";
import {
  beginReaderFigureSelection,
  calculateCaptureRegion,
  cancelReaderFigureScreenshot,
  capturePageSelection,
  findPageElement,
  getReaderWindows,
  resolveReaderDocument,
} from "../src/modules/ui/ReaderFigureScreenshot.ts";
import { watchActivePdfSelection } from "../src/modules/ui/ReaderChatEntry.ts";
import {
  addImageAttachment,
  canAddImageAttachmentToDraft,
  isImageAttachmentDraftWithinLimits,
  hidePanel,
  showPanelWithImageAttachment,
  unregisterAll,
} from "../src/modules/ui/chat-panel/ChatPanelManager.ts";
import type { ImageAttachment } from "../src/types/chat.ts";

type FakeListener = (event: Record<string, any>) => void;

class FakeEventTarget {
  private readonly listeners = new Map<string, Set<FakeListener>>();

  addEventListener(type: string, listener: FakeListener): void {
    const listeners = this.listeners.get(type) || new Set<FakeListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: FakeListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type: string, event: Record<string, any> = {}): void {
    for (const listener of [...(this.listeners.get(type) || [])]) {
      listener(event);
    }
  }

  listenerCount(type: string): number {
    return this.listeners.get(type)?.size || 0;
  }
}

class FakeNode extends FakeEventTarget {
  readonly style: Record<string, string> = {};
  readonly attributes = new Map<string, string>();
  readonly children: FakeNode[] = [];
  readonly dataset: Record<string, string> = {};
  parent: FakeNode | null = null;
  textContent = "";
  tabIndex = -1;
  canvas: FakeCanvas | null = null;
  canvases: FakeCanvas[] = [];
  closestPage: FakeNode | null = null;

  constructor(
    readonly ownerDocument: FakeDocument,
    readonly tagName: string,
  ) {
    super();
  }

  appendChild(child: FakeNode): FakeNode {
    child.remove();
    child.parent = this;
    this.children.push(child);
    return child;
  }

  remove(): void {
    if (!this.parent) return;
    const index = this.parent.children.indexOf(this);
    if (index >= 0) this.parent.children.splice(index, 1);
    this.parent = null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  querySelector(selector: string): FakeCanvas | null {
    return selector.includes("canvas") ? this.canvases[0] || this.canvas : null;
  }

  querySelectorAll(selector: string): FakeCanvas[] {
    if (!selector.includes("canvas")) return [];
    return this.canvases.length
      ? [...this.canvases]
      : this.canvas
        ? [this.canvas]
        : [];
  }

  closest(selector: string): FakeNode | null {
    return selector.includes(".page") || selector.includes("data-page-number")
      ? this.closestPage
      : null;
  }

  focus(): void {}

  setPointerCapture(): void {}
}

class FakeCanvas extends FakeNode {
  width = 200;
  height = 200;
  bounds = {
    left: 0,
    top: 0,
    right: 100,
    bottom: 100,
    width: 100,
    height: 100,
  };
  readonly drawCalls: unknown[][] = [];

  constructor(ownerDocument: FakeDocument) {
    super(ownerDocument, "canvas");
  }

  getBoundingClientRect(): DOMRect {
    return this.bounds as DOMRect;
  }

  getContext(): { drawImage: (...args: unknown[]) => void } {
    return {
      drawImage: (...args: unknown[]) => this.drawCalls.push(args),
    };
  }

  toBlob(callback: (blob: Blob | null) => void, type?: string): void {
    this.ownerDocument.encodeCanvas(this, callback, type);
  }
}

class FakeWindow extends FakeEventTarget {
  readonly document = { hasFocus: () => false };
}

class FakeDocument extends FakeEventTarget {
  readonly documentElement = new FakeNode(this, "html");
  readonly head = new FakeNode(this, "head");
  readonly body = new FakeNode(this, "body");
  readonly defaultView = new FakeWindow();
  pointTarget: FakeNode | null = null;
  lastOutputCanvas: FakeCanvas | null = null;
  outputEncodeDimensions: Array<{ width: number; height: number }> = [];
  outputBlobSizer: ((width: number, height: number) => number) | null = null;
  deferOutputBlob = false;
  visibilityState: DocumentVisibilityState = "visible";
  selectionClearCount = 0;
  private readonly deferredBlobCallbacks: Array<() => void> = [];

  createElement(tagName: string): FakeNode {
    if (tagName === "canvas") {
      this.lastOutputCanvas = new FakeCanvas(this);
      return this.lastOutputCanvas;
    }
    return new FakeNode(this, tagName);
  }

  elementFromPoint(): FakeNode | null {
    return this.pointTarget;
  }

  querySelector(selector: string): FakeNode | null {
    return selector.includes("#viewer") || selector.includes(".textLayer")
      ? this.documentElement
      : null;
  }

  getSelection(): {
    rangeCount: number;
    removeAllRanges: () => void;
    toString: () => string;
  } {
    return {
      rangeCount: 0,
      removeAllRanges: () => {
        this.selectionClearCount += 1;
      },
      toString: () => "",
    };
  }

  encodeCanvas(
    canvas: FakeCanvas,
    callback: (blob: Blob | null) => void,
    type = "image/png",
  ): void {
    const width = canvas.width;
    const height = canvas.height;
    this.outputEncodeDimensions.push({ width, height });
    const size = this.outputBlobSizer?.(width, height) ?? 3;
    const bytes = this.outputBlobSizer
      ? new Uint8Array(size)
      : new Uint8Array([0x70, 0x6e, 0x67]);
    const resolve = () =>
      callback(new Blob([bytes], { type: type || "image/png" }));
    if (this.deferOutputBlob) {
      this.deferredBlobCallbacks.push(resolve);
    } else {
      resolve();
    }
  }

  resolveNextOutputBlob(): void {
    this.deferredBlobCallbacks.shift()?.();
  }
}

function fakeEvent(values: Record<string, any>): Record<string, any> {
  return {
    defaultPrevented: false,
    propagationStopped: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopPropagation() {
      this.propagationStopped = true;
    },
    ...values,
  };
}

function createReaderWindow(options: {
  hasPage?: boolean;
  hasCanvas?: boolean;
}): Window {
  const document = {
    querySelector(selector: string) {
      if (selector.includes("canvas")) {
        return options.hasCanvas ? { tagName: "CANVAS" } : null;
      }
      if (selector.includes("data-page-number") || selector.includes(".page")) {
        return options.hasPage ? { tagName: "DIV" } : null;
      }
      return null;
    },
  };
  return { document } as Window;
}

function createPage(doc: FakeDocument, pageNumber = "3") {
  const page = new FakeNode(doc, "div");
  page.setAttribute("data-page-number", pageNumber);
  page.closestPage = page;
  page.canvas = new FakeCanvas(doc);
  page.canvases = [page.canvas];
  const target = new FakeNode(doc, "span");
  target.closestPage = page;
  doc.pointTarget = target;
  return { page, target, canvas: page.canvas };
}

async function flushAsyncWork(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function createBase64Image(byteLength: number): ImageAttachment {
  return {
    type: "base64",
    data: Buffer.alloc(byteLength).toString("base64"),
    mimeType: "image/png",
  };
}

describe("reader figure screenshot", function () {
  afterEach(function () {
    cancelReaderFigureScreenshot();
  });

  it("prefers the PDF.js window containing rendered page canvases", function () {
    const outer = createReaderWindow({ hasPage: false, hasCanvas: false });
    const primary = createReaderWindow({ hasPage: true, hasCanvas: false });
    const inner = createReaderWindow({ hasPage: true, hasCanvas: true });
    const reader = {
      _iframeWindow: outer,
      _internalReader: {
        _lastView: { _iframeWindow: inner },
        _primaryView: { _iframeWindow: primary },
      },
    } as _ZoteroTypes.ReaderInstance;

    assert.deepEqual(getReaderWindows(reader), [inner, primary, outer]);
    assert.equal(resolveReaderDocument(reader), inner.document);
  });

  it("deduplicates reader windows and finds the owning page", function () {
    const readerWindow = createReaderWindow({ hasPage: true, hasCanvas: true });
    const reader = {
      _iframeWindow: readerWindow,
      _internalReader: {
        _lastView: { _iframeWindow: readerWindow },
      },
    } as _ZoteroTypes.ReaderInstance;
    const doc = new FakeDocument();
    const { page, target } = createPage(doc);

    assert.deepEqual(getReaderWindows(reader), [readerWindow]);
    assert.equal(findPageElement(target as unknown as Element), page);
  });

  it("maps CSS coordinates to source pixels and accepts reverse drags", function () {
    const bounds = {
      left: 100,
      top: 50,
      right: 500,
      bottom: 250,
      width: 400,
      height: 200,
    };

    assert.deepEqual(
      calculateCaptureRegion(bounds, 800, 400, 350, 175, 150, 75),
      {
        sourceX: 100,
        sourceY: 50,
        sourceWidth: 400,
        sourceHeight: 200,
        outputWidth: 400,
        outputHeight: 200,
        cssLeft: 150,
        cssTop: 75,
        cssWidth: 200,
        cssHeight: 100,
      },
    );
  });

  it("clamps a cross-page drag to the starting page canvas", function () {
    const bounds = {
      left: 100,
      top: 50,
      right: 500,
      bottom: 250,
      width: 400,
      height: 200,
    };
    const region = calculateCaptureRegion(bounds, 800, 400, 200, 100, 900, 400);

    assert.include(region, {
      sourceX: 200,
      sourceY: 100,
      sourceWidth: 600,
      sourceHeight: 300,
      cssWidth: 300,
      cssHeight: 150,
    });
  });

  it("rejects tiny/zero canvases and bounds oversized output", function () {
    const bounds = {
      left: 0,
      top: 0,
      right: 1000,
      bottom: 1000,
      width: 1000,
      height: 1000,
    };

    assert.isNull(calculateCaptureRegion(bounds, 1000, 1000, 0, 0, 7, 20));
    assert.isNull(calculateCaptureRegion(bounds, 0, 1000, 0, 0, 20, 20));
    const large = calculateCaptureRegion(
      bounds,
      10_000,
      10_000,
      0,
      0,
      1000,
      1000,
    );
    assert.equal(large?.outputWidth, 1000);
    assert.equal(large?.outputHeight, 1000);
    assert.isAtMost(
      (large?.outputWidth || 0) * (large?.outputHeight || 0),
      1_000_000,
    );
  });

  it("crops to PNG with the calculated draw coordinates and page name", async function () {
    const doc = new FakeDocument();
    const { page, canvas } = createPage(doc, "3");
    canvas.width = 800;
    canvas.height = 400;
    canvas.bounds = {
      left: 100,
      top: 50,
      right: 500,
      bottom: 250,
      width: 400,
      height: 200,
    };

    const image = await capturePageSelection(
      page as unknown as HTMLElement,
      150,
      75,
      350,
      175,
    );

    assert.deepEqual(image, {
      type: "base64",
      data: "cG5n",
      mimeType: "image/png",
      name: "figure-screenshot-page-3.png",
    });
    assert.deepEqual(
      doc.lastOutputCanvas?.drawCalls[0]?.slice(1),
      [100, 50, 400, 200, 0, 0, 400, 200],
    );
    assert.equal(doc.lastOutputCanvas?.width, 0);
    assert.equal(doc.lastOutputCanvas?.height, 0);
  });

  it("encodes PDF blobs with constructors from the owning document realm", async function () {
    const doc = new FakeDocument();
    const { page } = createPage(doc);
    let ownerArrayCalls = 0;
    let ownerCharCalls = 0;
    const ownerWindow = doc.defaultView as unknown as {
      Uint8Array?: typeof Uint8Array;
      String?: typeof String;
    };
    const OwnerUint8Array = class extends Uint8Array {
      constructor(buffer: ArrayBuffer) {
        super(buffer);
        ownerArrayCalls += 1;
      }
    };
    ownerWindow.Uint8Array = OwnerUint8Array as unknown as typeof Uint8Array;
    ownerWindow.String = {
      fromCharCode: (...codes: number[]) => {
        ownerCharCalls += 1;
        return String.fromCharCode(...codes);
      },
    } as unknown as typeof String;

    const image = await capturePageSelection(
      page as unknown as HTMLElement,
      0,
      0,
      100,
      100,
    );

    assert.equal(image?.data, "cG5n");
    assert.isAbove(ownerArrayCalls, 0);
    assert.isAbove(ownerCharCalls, 0);
  });

  it("composites the PDF.js detail canvas over the base canvas", async function () {
    const doc = new FakeDocument();
    const { page, canvas } = createPage(doc);
    canvas.width = 200;
    canvas.height = 200;
    const detailCanvas = new FakeCanvas(doc);
    detailCanvas.width = 400;
    detailCanvas.height = 400;
    detailCanvas.bounds = {
      left: 25,
      top: 25,
      right: 75,
      bottom: 75,
      width: 50,
      height: 50,
    };
    page.canvases = [canvas, detailCanvas];

    const image = await capturePageSelection(
      page as unknown as HTMLElement,
      0,
      0,
      100,
      100,
    );

    assert.isNotNull(image);
    assert.lengthOf(doc.lastOutputCanvas?.drawCalls || [], 2);
    assert.strictEqual(doc.lastOutputCanvas?.drawCalls[0]?.[0], canvas);
    assert.deepEqual(
      doc.lastOutputCanvas?.drawCalls[0]?.slice(1),
      [0, 0, 200, 200, 0, 0, 800, 800],
    );
    assert.strictEqual(doc.lastOutputCanvas?.drawCalls[1]?.[0], detailCanvas);
    assert.deepEqual(
      doc.lastOutputCanvas?.drawCalls[1]?.slice(1),
      [0, 0, 400, 400, 200, 200, 400, 400],
    );
  });

  it("iteratively shrinks high-entropy PNG output below one MiB", async function () {
    const doc = new FakeDocument();
    const { page, canvas } = createPage(doc);
    canvas.width = 1000;
    canvas.height = 1000;
    canvas.bounds = {
      left: 0,
      top: 0,
      right: 1000,
      bottom: 1000,
      width: 1000,
      height: 1000,
    };
    doc.outputBlobSizer = (width, height) => width * height * 4;

    const image = await capturePageSelection(
      page as unknown as HTMLElement,
      0,
      0,
      1000,
      1000,
    );

    assert.isNotNull(image);
    assert.isAbove(doc.outputEncodeDimensions.length, 1);
    assert.isAtMost(
      Buffer.from(image?.data || "", "base64").byteLength,
      1024 * 1024,
    );
  });

  it("bounds each pending image, the draft byte total, and image count", function () {
    const oneMiB = createBase64Image(1024 * 1024);
    const tiny = createBase64Image(1);

    assert.isTrue(canAddImageAttachmentToDraft([], oneMiB));
    assert.isTrue(isImageAttachmentDraftWithinLimits([oneMiB]));
    assert.isFalse(
      canAddImageAttachmentToDraft([], createBase64Image(1024 * 1024 + 1)),
    );
    assert.isFalse(
      canAddImageAttachmentToDraft([], {
        type: "base64",
        data: "not base64",
        mimeType: "image/png",
      }),
    );
    assert.isFalse(
      canAddImageAttachmentToDraft(
        Array.from({ length: 4 }, () => oneMiB),
        tiny,
      ),
    );
    assert.isFalse(
      canAddImageAttachmentToDraft(
        Array.from({ length: 6 }, () => tiny),
        tiny,
      ),
    );
    assert.isFalse(
      isImageAttachmentDraftWithinLimits(Array.from({ length: 7 }, () => tiny)),
    );
  });

  it("rejects every URL image at the draft boundary", function () {
    for (const data of [
      "https://example.test/image.png",
      "javascript:alert(1)",
      "file:///tmp/image.png",
      "chrome://paperchat/content/image.png",
    ]) {
      const image: ImageAttachment = {
        type: "url",
        data,
        mimeType: "image/png",
      };
      assert.isFalse(canAddImageAttachmentToDraft([], image), data);
      assert.isFalse(isImageAttachmentDraftWithinLimits([image]), data);
    }
  });

  it("rolls back a captured image when the chat panel cannot open", async function () {
    const runtime = globalThis as Record<string, any>;
    const previousZotero = runtime.Zotero;
    const previousToolkit = runtime.ztoolkit;
    runtime.Zotero = {
      Prefs: { get: () => "floating" },
      getMainWindow: () => ({
        document: { getElementById: () => null },
        screenX: 0,
        screenY: 0,
        outerWidth: 1200,
        outerHeight: 800,
        openDialog: () => null,
      }),
    };
    runtime.ztoolkit = { log: () => {} };
    const tiny = createBase64Image(1);

    try {
      for (let index = 0; index < 5; index++) {
        assert.isTrue(addImageAttachment(tiny));
      }
      assert.isFalse(showPanelWithImageAttachment(tiny));
      assert.isTrue(
        addImageAttachment(tiny),
        "the failed panel open must not consume the sixth image slot",
      );
      assert.isFalse(addImageAttachment(tiny));
    } finally {
      await unregisterAll();
      runtime.Zotero = previousZotero;
      runtime.ztoolkit = previousToolkit;
    }
  });

  it("clamps the marquee and emits one pending-image payload", async function () {
    const doc = new FakeDocument();
    const mainWindow = new FakeWindow();
    createPage(doc);
    const captured: unknown[] = [];
    const session = beginReaderFigureSelection(doc as unknown as Document, {
      promptText: "Select a region",
      mainWindow: mainWindow as unknown as Window,
      onCapture: (image) => captured.push(image),
    });
    const overlay = doc.body.children.find((node) =>
      node.attributes.has("data-paperchat-figure-screenshot-overlay"),
    );
    const marquee = doc.body.children.find((node) =>
      node.attributes.has("data-paperchat-figure-screenshot-marquee"),
    );

    assert.isNotNull(session);
    overlay?.dispatch(
      "pointerdown",
      fakeEvent({
        button: 0,
        isPrimary: true,
        pointerId: 7,
        clientX: 20,
        clientY: 20,
      }),
    );
    overlay?.dispatch(
      "pointermove",
      fakeEvent({ pointerId: 7, clientX: 180, clientY: 160 }),
    );
    assert.include(marquee?.style || {}, {
      left: "20px",
      top: "20px",
      width: "80px",
      height: "80px",
      display: "block",
    });
    overlay?.dispatch(
      "pointerup",
      fakeEvent({ pointerId: 7, clientX: 180, clientY: 160 }),
    );
    await flushAsyncWork();

    assert.lengthOf(captured, 1);
    assert.deepInclude(captured[0], {
      type: "base64",
      mimeType: "image/png",
      name: "figure-screenshot-page-3.png",
    });
    assert.lengthOf(doc.body.children, 0);
    assert.lengthOf(doc.head.children, 0);
    assert.equal(doc.defaultView.listenerCount("pagehide"), 0);
    assert.equal(doc.listenerCount("visibilitychange"), 0);
  });

  it("keeps the encoding cancellable after pointer-up", async function () {
    const doc = new FakeDocument();
    createPage(doc);
    doc.deferOutputBlob = true;
    const captured: unknown[] = [];
    const session = beginReaderFigureSelection(doc as unknown as Document, {
      promptText: "Select a region",
      onCapture: (image) => captured.push(image),
    });
    const overlay = doc.body.children.find((node) =>
      node.attributes.has("data-paperchat-figure-screenshot-overlay"),
    );

    overlay?.dispatch(
      "pointerdown",
      fakeEvent({
        button: 0,
        isPrimary: true,
        pointerId: 9,
        clientX: 10,
        clientY: 10,
      }),
    );
    overlay?.dispatch(
      "pointerup",
      fakeEvent({ pointerId: 9, clientX: 80, clientY: 80 }),
    );
    assert.equal(doc.defaultView.listenerCount("pagehide"), 1);
    session?.cancel();
    doc.resolveNextOutputBlob();
    await flushAsyncWork();

    assert.isEmpty(captured);
    assert.lengthOf(doc.body.children, 0);
    assert.equal(doc.defaultView.listenerCount("pagehide"), 0);
  });

  it("revalidates the active reader before attaching deferred output", async function () {
    const doc = new FakeDocument();
    createPage(doc);
    doc.deferOutputBlob = true;
    const captured: unknown[] = [];
    let contextActive = true;
    beginReaderFigureSelection(doc as unknown as Document, {
      promptText: "Select a region",
      isContextActive: () => contextActive,
      onCapture: (image) => captured.push(image),
    });
    const overlay = doc.body.children.find((node) =>
      node.attributes.has("data-paperchat-figure-screenshot-overlay"),
    );

    overlay?.dispatch(
      "pointerdown",
      fakeEvent({
        button: 0,
        isPrimary: true,
        pointerId: 11,
        clientX: 10,
        clientY: 10,
      }),
    );
    overlay?.dispatch(
      "pointerup",
      fakeEvent({ pointerId: 11, clientX: 80, clientY: 80 }),
    );
    contextActive = false;
    doc.resolveNextOutputBlob();
    await flushAsyncWork();

    assert.isEmpty(captured);
    assert.equal(doc.defaultView.listenerCount("pagehide"), 0);
  });

  it("drops a deferred image after reader lifecycle changes", async function () {
    for (const lifecycle of ["pagehide", "visibilitychange"] as const) {
      const doc = new FakeDocument();
      createPage(doc);
      doc.deferOutputBlob = true;
      const captured: unknown[] = [];
      beginReaderFigureSelection(doc as unknown as Document, {
        promptText: "Select a region",
        onCapture: (image) => captured.push(image),
      });
      const overlay = doc.body.children.find((node) =>
        node.attributes.has("data-paperchat-figure-screenshot-overlay"),
      );

      overlay?.dispatch(
        "pointerdown",
        fakeEvent({
          button: 0,
          isPrimary: true,
          pointerId: 10,
          clientX: 10,
          clientY: 10,
        }),
      );
      overlay?.dispatch(
        "pointerup",
        fakeEvent({ pointerId: 10, clientX: 80, clientY: 80 }),
      );
      assert.equal(doc.defaultView.listenerCount("pagehide"), 1, lifecycle);
      assert.equal(doc.listenerCount("visibilitychange"), 1, lifecycle);

      if (lifecycle === "pagehide") {
        doc.defaultView.dispatch("pagehide");
      } else {
        doc.visibilityState = "hidden";
        doc.dispatch("visibilitychange");
      }
      doc.resolveNextOutputBlob();
      await flushAsyncWork();

      assert.isEmpty(captured, lifecycle);
      assert.equal(doc.defaultView.listenerCount("pagehide"), 0, lifecycle);
      assert.equal(doc.listenerCount("visibilitychange"), 0, lifecycle);
    }
  });

  it("cancels the overlay when the active reader document changes", function () {
    const runtime = globalThis as Record<string, any>;
    const previousZotero = runtime.Zotero;
    const firstDoc = new FakeDocument();
    const secondDoc = new FakeDocument();
    createPage(firstDoc);
    createPage(secondDoc);
    let activeReader: Record<string, any> | null = {
      _internalReader: {
        _lastView: { _iframeWindow: { document: firstDoc } },
      },
    };
    runtime.Zotero = {
      getMainWindow: () => ({ Zotero_Tabs: { selectedID: "reader-tab" } }),
      Reader: { getByTabID: () => activeReader },
    };

    try {
      watchActivePdfSelection();
      beginReaderFigureSelection(firstDoc as unknown as Document, {
        promptText: "Select a region",
        onCapture: () => {},
      });
      assert.lengthOf(firstDoc.body.children, 3);

      activeReader = {
        _internalReader: {
          _lastView: { _iframeWindow: { document: secondDoc } },
        },
      };
      watchActivePdfSelection();
      assert.lengthOf(firstDoc.body.children, 0);
    } finally {
      activeReader = null;
      watchActivePdfSelection();
      runtime.Zotero = previousZotero;
    }
  });

  it("continues cleanup when a dead wrapper throws", function () {
    const doc = new FakeDocument();
    const mainWindow = new FakeWindow();
    createPage(doc);
    const session = beginReaderFigureSelection(doc as unknown as Document, {
      promptText: "Select a region",
      mainWindow: mainWindow as unknown as Window,
      onCapture: () => {},
    });
    const overlay = doc.body.children.find((node) =>
      node.attributes.has("data-paperchat-figure-screenshot-overlay"),
    );
    if (overlay) {
      overlay.removeEventListener = () => {
        throw new Error("dead wrapper");
      };
    }

    assert.doesNotThrow(() => session?.cancel());
    assert.lengthOf(doc.body.children, 0);
    assert.lengthOf(doc.head.children, 0);
    assert.equal(mainWindow.listenerCount("keydown"), 0);
  });

  it("cleans every overlay/listener on Escape, unload, and repeated start", function () {
    const firstDoc = new FakeDocument();
    const secondDoc = new FakeDocument();
    const mainWindow = new FakeWindow();
    createPage(firstDoc);
    createPage(secondDoc);
    const options = {
      promptText: "Select a region",
      mainWindow: mainWindow as unknown as Window,
      onCapture: () => {},
    };

    const first = beginReaderFigureSelection(
      firstDoc as unknown as Document,
      options,
    );
    assert.isNotNull(first);
    assert.lengthOf(firstDoc.body.children, 3);
    assert.equal(mainWindow.listenerCount("keydown"), 1);

    const second = beginReaderFigureSelection(
      secondDoc as unknown as Document,
      options,
    );
    assert.isNotNull(second);
    assert.lengthOf(firstDoc.body.children, 0);
    assert.lengthOf(secondDoc.body.children, 3);
    assert.equal(mainWindow.listenerCount("keydown"), 1);

    mainWindow.dispatch("keydown", fakeEvent({ key: "Escape" }));
    assert.lengthOf(secondDoc.body.children, 0);
    assert.lengthOf(secondDoc.head.children, 0);
    assert.equal(mainWindow.listenerCount("keydown"), 0);

    beginReaderFigureSelection(secondDoc as unknown as Document, options);
    assert.lengthOf(secondDoc.body.children, 3);
    secondDoc.defaultView.dispatch("pagehide");
    assert.lengthOf(secondDoc.body.children, 0);
    assert.equal(secondDoc.defaultView.listenerCount("pagehide"), 0);

    secondDoc.visibilityState = "visible";
    beginReaderFigureSelection(secondDoc as unknown as Document, options);
    assert.lengthOf(secondDoc.body.children, 3);
    secondDoc.visibilityState = "hidden";
    secondDoc.dispatch("visibilitychange");
    assert.lengthOf(secondDoc.body.children, 0);
    assert.equal(secondDoc.listenerCount("visibilitychange"), 0);
  });

  it("cancels an active selection when the chat panel is hidden", function () {
    const runtime = globalThis as Record<string, any>;
    const previousZotero = runtime.Zotero;
    const previousToolkit = runtime.ztoolkit;
    const doc = new FakeDocument();
    const mainDocument = {
      querySelector: () => null,
      getElementById: () => null,
    };
    createPage(doc);
    beginReaderFigureSelection(doc as unknown as Document, {
      promptText: "Select a region",
      onCapture: () => {},
    });
    assert.lengthOf(doc.body.children, 3);

    runtime.Zotero = {
      getMainWindow: () => ({
        document: mainDocument,
        Zotero_Tabs: { selectedType: "reader" },
      }),
    };
    runtime.ztoolkit = { log: () => {} };
    try {
      hidePanel();
      assert.lengthOf(doc.body.children, 0);
      assert.lengthOf(doc.head.children, 0);
      assert.equal(doc.defaultView.listenerCount("pagehide"), 0);
      assert.equal(doc.listenerCount("visibilitychange"), 0);
    } finally {
      runtime.Zotero = previousZotero;
      runtime.ztoolkit = previousToolkit;
    }
  });
});
