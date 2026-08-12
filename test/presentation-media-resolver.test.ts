import { assert } from "chai";
import {
  __setStandalonePdfPageRendererForTests,
  applyPresentationCropWidthHint,
  clampPresentationCrop,
  convertPresentationPdfPoint,
  derivePresentationCaptionCrop,
  extractPresentationCaptionSnapshotInReaderRealm,
  measureCanvasInkRatio,
  normalizePresentationViewportPoint,
  resolvePresentationMedia,
  resolvePresentationSourceAuthor,
  resolvePresentationSourceYear,
  resolvePresentationViewportScale,
  resolvePresentationViewportTransform,
  selectCaptionAnchoredCrop,
  validateResolvedPresentationMedia,
} from "../src/modules/presentation/PresentationMediaResolver.ts";

describe("presentation media resolver", function () {
  it("rejects two different gallery anchors that resolve to identical pixels", function () {
    const sharedData = "data:image/png;base64,c2FtZS1jcm9w";
    const issues = validateResolvedPresentationMedia({
      title: "Resolved duplicate gallery",
      slides: [
        {
          title: "Two captions collapse to one crop",
          layout: "gallery",
          figures: [
            {
              page: 5,
              captionHint: "Figure 4: test images",
              data: sharedData,
              pixelWidth: 900,
              pixelHeight: 520,
            },
            {
              page: 5,
              captionHint: "Figure 4: nearest training images",
              data: sharedData,
              pixelWidth: 900,
              pixelHeight: 520,
            },
          ],
        },
      ],
    });

    assert.lengthOf(issues, 1);
    assert.include(issues[0], "same cropped image");
    assert.include(issues[0], "gallery must use different anchored");
  });

  it("anchors a right-column crop to the printed caption instead of the page midpoint", function () {
    const crop = derivePresentationCaptionCrop(
      {
        text: "Figure 1: ReLU curve",
        x: 690,
        y: 1_000,
        width: 290,
        height: 22,
      },
      1_224,
      1_584,
    );

    assert.isAtLeast(crop.x, 678);
    assert.isBelow(crop.width, 575);
    assert.isAtMost(crop.x + crop.width, 1_170);
    assert.isAtMost(crop.y + crop.height, 978);
  });

  it("keeps a wrapped full-width research caption from clipping a wide architecture figure", function () {
    const crop = derivePresentationCaptionCrop(
      {
        text: "Figure 2: An illustration of the architecture of our CNN, explicitly showing the delineation of responsibilities",
        x: 210,
        y: 620,
        width: 720,
        height: 22,
      },
      1_224,
      1_584,
    );

    assert.isBelow(crop.x, 80);
    assert.isAbove(crop.width, 1_050);
    assert.isAtMost(crop.x + crop.width, 1_180);
    assert.isAtMost(crop.y + crop.height, 600);
  });

  it("uses merged reader-realm caption geometry when PDF.js splits the figure label", async function () {
    const runtime = globalThis as any;
    const previousZotero = runtime.Zotero;
    const previousApplication = runtime.PDFViewerApplication;
    const cropArguments: number[][] = [];
    class FakeImage {
      onload?: () => void;
      onerror?: () => void;
      naturalWidth = 1_468;
      naturalHeight = 1_900;
      width = 1_468;
      height = 1_900;

      set src(_value: string) {
        queueMicrotask(() => this.onload?.());
      }
    }
    const createCanvas = () => ({
      width: 0,
      height: 0,
      getContext: () => ({
        fillStyle: "",
        fillRect: () => undefined,
        drawImage: (...args: unknown[]) => {
          if (args.length >= 5) {
            cropArguments.push(args.slice(1, 5).map(Number));
          }
        },
        getImageData: () => ({
          data: new Proxy([] as number[], {
            get: (_target, property) => {
              if (property === "length") return Number.MAX_SAFE_INTEGER;
              const index = Number(property);
              if (!Number.isFinite(index)) return undefined;
              return index % 4 === 3 ? 255 : 0;
            },
          }),
        }),
      }),
      toDataURL: () => "data:image/png;base64,ZmFrZQ==",
    });
    const ownerDocument = {
      defaultView: { Image: FakeImage },
      createElement: () => createCanvas(),
    };
    const captionItems = [
      {
        str: "Figure 2:",
        width: 36,
        height: 10,
        transform: [1, 0, 0, 10, 108, 568],
      },
      {
        str: "An illustration of the architecture of our CNN, explicitly showing the delineation of responsibilities between the two GPUs.",
        width: 430,
        height: 10,
        transform: [1, 0, 0, 10, 148, 568],
      },
    ];
    const pdfPage = {
      getViewport: ({ scale }: { scale: number }) => ({
        width: 612 * scale,
        height: 792 * scale,
        scale,
        transform: [scale, 0, 0, -scale, 0, 792 * scale],
        convertToViewportPoint: (x: number, y: number) => [
          x * scale,
          (792 - y) * scale,
        ],
      }),
      getTextContent: async () => ({ items: captionItems }),
    };
    const pdfDocument = { numPages: 9, getPage: async () => pdfPage };
    const attachment = {
      id: 42,
      key: "SPLITCAP",
      isPDFAttachment: () => true,
      getFilePathAsync: async () => null,
    };
    const reader = {
      itemID: 42,
      _isReaderInitialized: true,
      _iframeWindow: {
        document: ownerDocument,
        Function,
        PDFViewerApplication: { pdfDocument },
      },
    };
    runtime.PDFViewerApplication = { pdfDocument };
    runtime.Zotero = {
      Libraries: { userLibraryID: 1 },
      Items: { getByLibraryAndKey: () => attachment },
      getMainWindow: () => ({
        document: ownerDocument,
        Zotero_Tabs: { selectedID: "reader" },
      }),
      Reader: {
        getByTabID: () => reader,
        _readers: [reader],
        open: async () => reader,
      },
    };
    let standaloneRenderCalls = 0;
    __setStandalonePdfPageRendererForTests(async () => {
      standaloneRenderCalls += 1;
      return {
        data: "data:image/png;base64,ZmFrZQ==",
        width: 1_468,
        height: 1_900,
        scale: 1_468 / 612,
        transform: [1_468 / 612, 0, 0, -(1_468 / 612), 0, 1_900],
        inkRatio: 0.2,
        sampledPixels: 60_000,
      };
    });

    try {
      const resolved = await resolvePresentationMedia({
        title: "Split caption geometry",
        sourceItemKey: attachment.key,
        slides: [
          {
            title: "The complete architecture spans both GPUs",
            figure: {
              page: 5,
              mode: "figure",
              captionHint: "Figure 2: An illustration of the architecture",
            },
          },
        ],
      });

      assert.isAbove(
        cropArguments.at(-1)?.[2] || 0,
        1_200,
        "the full-width merged caption must keep the architecture's right half inside the candidate crop",
      );
      assert.include(
        resolved.slides[0].figure?.cropTrace || "",
        "captionText=figure2anillustration",
      );
      const resolvedAgain = await resolvePresentationMedia({
        title: "Split caption geometry repair",
        sourceItemKey: attachment.key,
        slides: [
          {
            title: "A later visual repair reuses the rendered PDF page",
            figure: {
              page: 5,
              mode: "figure",
              captionHint: "Figure 2: An illustration of the architecture",
            },
          },
        ],
      });
      assert.equal(
        resolvedAgain.slides[0].figure?.data,
        "data:image/png;base64,ZmFrZQ==",
      );
      assert.equal(
        standaloneRenderCalls,
        1,
        "outer presentation repairs should reuse a successful PDF page render",
      );
    } finally {
      __setStandalonePdfPageRendererForTests(null);
      runtime.Zotero = previousZotero;
      runtime.PDFViewerApplication = previousApplication;
    }
  });

  it("falls back to a valid explicit crop when refined geometry is non-finite", function () {
    const crop = clampPresentationCrop(
      { x: 0, y: 120, width: 1_336, height: Number.NaN },
      1_336,
      1_900,
      { x: 26.72, y: 76, width: 1_282.56, height: 1_216 },
    );

    assert.deepEqual(crop, {
      x: 26.72,
      y: 76,
      width: 1_282.56,
      height: 1_216,
    });
  });

  it("prefers the caption region over a broad model crop when pixel refinement is implausibly shallow", function () {
    const candidate = {
      x: 64,
      y: 120,
      width: 1_220,
      height: 520,
    };
    const selected = selectCaptionAnchoredCrop(
      { x: 20, y: 260, width: 1_360, height: 42 },
      candidate,
      { x: 28, y: 18, width: 1_350, height: 1_805 },
      1_409,
      1_900,
    );

    assert.deepEqual(selected, candidate);
  });

  it("keeps a finite caption region even when a scientific diagram is unusually wide", function () {
    const candidate = { x: 60, y: 180, width: 1_280, height: 120 };
    const selected = selectCaptionAnchoredCrop(
      { x: 40, y: 200, width: 1_320, height: 36 },
      candidate,
      { x: 28, y: 18, width: 1_350, height: 1_805 },
      1_409,
      1_900,
    );

    assert.deepEqual(selected, candidate);
  });

  it("keeps a compact refined paper figure instead of falling back to a body-text candidate", function () {
    const candidate = { x: 730, y: 360, width: 668, height: 456 };
    const refined = { x: 842, y: 612, width: 318, height: 118 };
    const selected = selectCaptionAnchoredCrop(
      refined,
      candidate,
      { x: 44, y: 80, width: 1_380, height: 1_368 },
      1_468,
      1_900,
    );

    assert.deepEqual(selected, refined);
  });

  it("reads the cover year from the Zotero paper behind an attachment", function () {
    const runtime = globalThis as any;
    const previousZotero = runtime.Zotero;
    const parent = {
      getField: (field: string) => (field === "year" ? "2017" : ""),
    };
    const attachment = {
      parentItemID: 99,
      isAttachment: () => true,
      isNote: () => false,
      getField: () => "",
    };
    runtime.Zotero = {
      Libraries: { userLibraryID: 1 },
      Items: {
        getByLibraryAndKey: () => attachment,
        get: (id: number) => (id === 99 ? parent : null),
      },
    };

    try {
      assert.equal(resolvePresentationSourceYear("SBZ2M99R"), "2017");
    } finally {
      runtime.Zotero = previousZotero;
    }
  });

  it("resolves presentation metadata from a group library item", function () {
    const runtime = globalThis as any;
    const previousZotero = runtime.Zotero;
    const paper = {
      getField: (field: string) => (field === "year" ? "2024" : ""),
      getCreators: () => [{ name: "Group Author" }],
      isAttachment: () => false,
      isNote: () => false,
    };
    runtime.Zotero = {
      Libraries: {
        userLibraryID: 1,
        getAll: () => [{ libraryID: 1 }, { libraryID: 5 }],
      },
      Items: {
        getByLibraryAndKey: (libraryID: number, key: string) =>
          libraryID === 5 && key === "GROUP001" ? paper : null,
      },
    };

    try {
      assert.equal(resolvePresentationSourceYear("GROUP001"), "2024");
      assert.equal(
        resolvePresentationSourceAuthor("GROUP001", "en-US"),
        "Group Author",
      );
    } finally {
      runtime.Zotero = previousZotero;
    }
  });

  it("reads cover authors from a directly selected Zotero paper", function () {
    const runtime = globalThis as any;
    const previousZotero = runtime.Zotero;
    const paper = {
      isAttachment: () => false,
      isNote: () => false,
      getCreators: () => [
        { firstName: "Alex", lastName: "Krizhevsky" },
        { firstName: "Ilya", lastName: "Sutskever" },
        { name: "Geoffrey E. Hinton" },
      ],
    };
    runtime.Zotero = {
      Libraries: { userLibraryID: 1 },
      Items: { getByLibraryAndKey: () => paper },
    };

    try {
      assert.equal(
        resolvePresentationSourceAuthor("SBZ2M99R", "zh-CN"),
        "Alex Krizhevsky、Ilya Sutskever、Geoffrey E. Hinton",
      );
    } finally {
      runtime.Zotero = previousZotero;
    }
  });

  it("reads cover authors from the parent paper behind an attachment", function () {
    const runtime = globalThis as any;
    const previousZotero = runtime.Zotero;
    const parent = {
      getCreators: () => [
        { firstName: "Alex", lastName: "Krizhevsky" },
        { firstName: "Ilya", lastName: "Sutskever" },
        { firstName: "Geoffrey E.", lastName: "Hinton" },
        { name: "ImageNet Research Group" },
      ],
    };
    const attachment = {
      parentItemID: 99,
      isAttachment: () => true,
      isNote: () => false,
    };
    runtime.Zotero = {
      Libraries: { userLibraryID: 1 },
      Items: {
        getByLibraryAndKey: () => attachment,
        get: (id: number) => (id === 99 ? parent : null),
      },
    };

    try {
      assert.equal(
        resolvePresentationSourceAuthor("SBZ2M99R", "en-US"),
        "Alex Krizhevsky, Ilya Sutskever, Geoffrey E. Hinton et al.",
      );
    } finally {
      runtime.Zotero = previousZotero;
    }
  });

  it("preserves an explicit planner author and omits missing creators", async function () {
    const runtime = globalThis as any;
    const previousZotero = runtime.Zotero;
    const paper = {
      isAttachment: () => false,
      isNote: () => false,
      getCreators: () => [],
      getField: () => "",
    };
    runtime.Zotero = {
      Libraries: { userLibraryID: 1 },
      Items: { getByLibraryAndKey: () => paper },
    };

    try {
      assert.isUndefined(resolvePresentationSourceAuthor("SBZ2M99R", "zh-CN"));
      const explicit = await resolvePresentationMedia({
        title: "Author precedence",
        sourceItemKey: "SBZ2M99R",
        language: "zh-CN",
        author: "论文团队",
        slides: [],
      });
      assert.equal(explicit.author, "论文团队");

      const missing = await resolvePresentationMedia({
        title: "No invented author",
        sourceItemKey: "SBZ2M99R",
        language: "zh-CN",
        slides: [],
      });
      assert.notProperty(missing, "author");
    } finally {
      runtime.Zotero = previousZotero;
    }
  });

  it("prefers the Zotero bibliographic year over a planner-inferred year", async function () {
    const runtime = globalThis as any;
    const previousZotero = runtime.Zotero;
    const paper = {
      isAttachment: () => false,
      isNote: () => false,
      getField: (field: string) => (field === "year" ? "2017" : ""),
    };
    runtime.Zotero = {
      Libraries: { userLibraryID: 1 },
      Items: {
        getByLibraryAndKey: () => paper,
      },
    };

    try {
      const resolved = await resolvePresentationMedia({
        title: "AlexNet",
        sourceItemKey: "SBZ2M99R",
        year: "2010",
        slides: [],
      } as any);

      assert.equal(resolved.year, "2017");
    } finally {
      runtime.Zotero = previousZotero;
    }
  });

  it("normalizes invalid cross-realm PDF viewport coordinates", function () {
    assert.deepEqual(
      normalizePresentationViewportPoint(
        { 0: new Number(Number.NaN), 1: undefined },
        42,
        84,
      ),
      [42, 84],
    );
    assert.deepEqual(
      normalizePresentationViewportPoint(
        { 0: new Number(120), 1: new Number(240) },
        42,
        84,
      ),
      [120, 240],
    );
  });

  it("uses one PDF viewport transform for all caption geometry points", function () {
    const viewport = {
      width: 600,
      height: 800,
      transform: [2, 0, 0, -2, 0, 1_600],
      convertToViewportPoint: () =>
        [Number.NaN, Number.NaN] as [number, number],
    };

    assert.deepEqual(
      convertPresentationPdfPoint(viewport, 40, 160),
      [80, 1_280],
    );
    assert.deepEqual(
      convertPresentationPdfPoint(viewport, 340, 160),
      [680, 1_280],
    );
  });

  it("reads a Firefox Xray viewport matrix even when it has no iterable length", function () {
    const viewport = {
      width: 612,
      height: 792,
      transform: {
        0: 1,
        1: 0,
        2: 0,
        3: -1,
        4: 0,
        5: 792,
      },
    };

    assert.deepEqual(
      resolvePresentationViewportTransform(viewport),
      [1, 0, 0, -1, 0, 792],
    );
    const point = convertPresentationPdfPoint(viewport, 108, 568.276);
    assert.equal(point[0], 108);
    assert.closeTo(point[1], 223.724, 0.000001);
  });

  it("reconstructs a standard PDF.js transform when Xray hides the matrix and method", function () {
    const viewport = {
      width: 612,
      height: 792,
      scale: 1,
      rotation: 0,
    };

    assert.deepEqual(
      resolvePresentationViewportTransform(viewport),
      [1, 0, 0, -1, 0, 792],
    );
    assert.deepEqual(
      convertPresentationPdfPoint(viewport, 333.921, 511.507),
      [333.921, 280.493],
    );
  });

  it("extracts caption coordinates inside the PDF reader realm before Xray wrapping", async function () {
    const runtime = globalThis as any;
    const previousApplication = runtime.PDFViewerApplication;
    runtime.PDFViewerApplication = {
      pdfDocument: {
        getPage: async () => ({
          getViewport: () => ({
            width: 612,
            height: 792,
            convertToViewportPoint: (x: number, y: number) => [x, 792 - y],
          }),
          getTextContent: async () => ({
            items: [
              {
                str: "Figure 2: An illustration of the architecture",
                width: 260,
                height: 12,
                transform: [1, 0, 0, 12, 108, 568.276],
              },
            ],
          }),
        }),
      },
    };

    try {
      const snapshot = await extractPresentationCaptionSnapshotInReaderRealm(
        { Function } as any,
        5,
      );
      assert.equal(snapshot?.viewportWidth, 612);
      assert.equal(snapshot?.viewportHeight, 792);
      assert.equal(snapshot?.items[0].x, 108);
      assert.closeTo(snapshot?.items[0].y || 0, 223.724, 0.000001);
      assert.equal(snapshot?.items[0].width, 260);
      assert.equal(snapshot?.items[0].height, 12);
    } finally {
      runtime.PDFViewerApplication = previousApplication;
    }
  });

  it("uses uniform PDF scaling when a cross-realm viewport omits its height", function () {
    assert.deepEqual(
      resolvePresentationViewportScale(600, undefined, 1_200, 1_600),
      [2, 2],
    );
    assert.deepEqual(
      resolvePresentationViewportScale(undefined, 800, 1_200, 1_600),
      [2, 2],
    );
    assert.deepEqual(
      resolvePresentationViewportScale(
        undefined,
        undefined,
        1_468,
        1_900,
        2.398989898989899,
      ),
      [2.398989898989899, 2.398989898989899],
    );
  });

  it("uses only the explicit crop width to widen an anchored full-page figure", function () {
    assert.deepEqual(
      applyPresentationCropWidthHint(
        { x: 30, y: 120, width: 668, height: 456 },
        { x: 44, y: 80, width: 1_380, height: 1_368 },
        1_468,
      ),
      { x: 44, y: 120, width: 1_380, height: 456 },
    );
    assert.deepEqual(
      applyPresentationCropWidthHint(
        { x: 730, y: 120, width: 668, height: 456 },
        { x: 44, y: 80, width: 920, height: 1_368 },
        1_468,
      ),
      { x: 730, y: 120, width: 668, height: 456 },
    );
  });

  it("waits for a newly opened reader and falls back from reader-realm rendering", async function () {
    const runtime = globalThis as any;
    const previousZotero = runtime.Zotero;
    let directRenderCalls = 0;
    const createCanvas = () => ({
      width: 0,
      height: 0,
      getContext: () => ({
        fillStyle: "",
        fillRect: () => undefined,
        drawImage: () => undefined,
        getImageData: () => ({
          data: new Proxy([] as number[], {
            get: (_target, property) => {
              if (property === "length") return Number.MAX_SAFE_INTEGER;
              const index = Number(property);
              if (!Number.isFinite(index)) return undefined;
              return index % 4 === 3 ? 255 : 0;
            },
          }),
        }),
      }),
      toDataURL: () => "data:image/png;base64,ZmFrZQ==",
    });
    const ownerDocument = { createElement: () => createCanvas() };
    const pdfPage = {
      getViewport: ({ scale }: { scale: number }) => ({
        width: 600 * scale,
        height: 800 * scale,
        convertToViewportPoint: (x: number, y: number) => [
          x * scale,
          (800 - y) * scale,
        ],
      }),
      getTextContent: async () => ({ items: [] }),
      render: () => {
        directRenderCalls += 1;
        return { promise: Promise.resolve() };
      },
    };
    const pdfDocument = {
      numPages: 1,
      getPage: async () => pdfPage,
    };
    const reader: Record<string, unknown> = {
      itemID: 42,
      _isReaderInitialized: false,
    };
    const attachment = {
      id: 42,
      key: "DELAYED1",
      isPDFAttachment: () => true,
    };
    runtime.Zotero = {
      Libraries: { userLibraryID: 1 },
      Items: { getByLibraryAndKey: () => attachment },
      getMainWindow: () => ({
        document: ownerDocument,
        Zotero_Tabs: { selectedID: "library" },
      }),
      Reader: {
        getByTabID: () => null,
        _readers: [],
        open: async () => {
          setTimeout(() => {
            reader._isReaderInitialized = true;
            reader._iframeWindow = {
              document: ownerDocument,
              Function: (() => () => async () => {
                throw new Error("reader-realm renderer unavailable");
              }) as unknown as FunctionConstructor,
              PDFViewerApplication: { pdfDocument },
            };
          }, 20);
          return reader;
        },
      },
    };

    try {
      const resolved = await resolvePresentationMedia({
        title: "Delayed reader",
        sourceItemKey: attachment.key,
        slides: [
          {
            title: "The reader becomes available asynchronously",
            figure: { page: 1, mode: "page" },
          },
        ],
      });

      assert.equal(
        resolved.slides[0].figure?.data,
        "data:image/png;base64,ZmFrZQ==",
      );
      assert.equal(directRenderCalls, 1);
    } finally {
      runtime.Zotero = previousZotero;
    }
  });

  it("keeps the direct PDF.js fallback canvas in the reader compartment", async function () {
    const runtime = globalThis as any;
    const previousZotero = runtime.Zotero;
    const previousCu = runtime.Cu;
    let mainCanvasCreations = 0;
    let directRenderCalls = 0;
    const context = {
      fillStyle: "",
      fillRect: () => undefined,
      drawImage: () => undefined,
      getImageData: () => ({
        data: new Proxy([] as number[], {
          get: (_target, property) => {
            if (property === "length") return Number.MAX_SAFE_INTEGER;
            const index = Number(property);
            if (!Number.isFinite(index)) return undefined;
            return index % 4 === 3 ? 255 : 0;
          },
        }),
      }),
    };
    const rawReaderCanvas = {
      width: 0,
      height: 0,
      getContext: () => context,
      toDataURL: () => "data:image/png;base64,ZmFrZQ==",
    };
    const wrappedReaderCanvas = new Proxy(rawReaderCanvas, {
      get: (target, property, receiver) => {
        if (property === "getContext") {
          throw new Error('Permission denied to access property "getContext"');
        }
        return Reflect.get(target, property, receiver);
      },
      set: (target, property, value, receiver) =>
        Reflect.set(target, property, value, receiver),
    });
    const readerDocument = {
      createElement: () => wrappedReaderCanvas,
    };
    const pdfPage = {
      getViewport: ({ scale }: { scale: number }) => ({
        width: 600 * scale,
        height: 800 * scale,
        convertToViewportPoint: (x: number, y: number) => [
          x * scale,
          (800 - y) * scale,
        ],
      }),
      getTextContent: async () => ({ items: [] }),
      render: (options: { canvas: unknown; canvasContext: unknown }) => {
        directRenderCalls += 1;
        assert.equal(options.canvas, rawReaderCanvas);
        assert.equal(options.canvasContext, context);
        return { promise: Promise.resolve() };
      },
    };
    const pdfDocument = { numPages: 1, getPage: async () => pdfPage };
    const reader = {
      itemID: 42,
      _isReaderInitialized: true,
      _iframeWindow: {
        document: readerDocument,
        Function: (() => () => async () => {
          throw new Error("reader-realm renderer unavailable");
        }) as unknown as FunctionConstructor,
        PDFViewerApplication: { pdfDocument },
      },
    };
    const attachment = {
      id: 42,
      key: "COMPART1",
      isPDFAttachment: () => true,
    };
    runtime.Cu = {
      waiveXrays: (value: unknown) =>
        value === wrappedReaderCanvas ? rawReaderCanvas : value,
    };
    runtime.Zotero = {
      Libraries: { userLibraryID: 1 },
      Items: { getByLibraryAndKey: () => attachment },
      getMainWindow: () => ({
        document: {
          createElement: () => {
            mainCanvasCreations += 1;
            return {
              getContext: () => {
                throw new Error("main-window canvas crossed into PDF.js");
              },
            };
          },
        },
        Zotero_Tabs: { selectedID: "reader" },
      }),
      Reader: {
        getByTabID: () => reader,
        _readers: [reader],
        open: async () => reader,
      },
    };

    try {
      const resolved = await resolvePresentationMedia({
        title: "Reader-compartment canvas",
        sourceItemKey: attachment.key,
        slides: [
          {
            title: "The direct renderer stays in the reader realm",
            figure: { page: 1, mode: "page" },
          },
        ],
      });

      assert.equal(
        resolved.slides[0].figure?.data,
        "data:image/png;base64,ZmFrZQ==",
      );
      assert.equal(directRenderCalls, 1);
      assert.equal(mainCanvasCreations, 0);
    } finally {
      runtime.Zotero = previousZotero;
      runtime.Cu = previousCu;
    }
  });

  it("prefers Zotero's native reader renderer over cross-realm page.render", async function () {
    const runtime = globalThis as any;
    const previousZotero = runtime.Zotero;
    let regionRenderCalls = 0;
    let directRenderCalls = 0;
    let readerRealmCalls = 0;
    class FakeImage {
      onload?: () => void;
      onerror?: () => void;
      naturalWidth = 1_200;
      naturalHeight = 1_600;
      width = 1_200;
      height = 1_600;

      set src(_value: string) {
        queueMicrotask(() => this.onload?.());
      }
    }
    const createCanvas = () => ({
      width: 0,
      height: 0,
      getContext: () => ({
        fillStyle: "",
        fillRect: () => undefined,
        drawImage: () => undefined,
        getImageData: () => ({
          data: new Proxy([] as number[], {
            get: (_target, property) => {
              if (property === "length") return Number.MAX_SAFE_INTEGER;
              const index = Number(property);
              if (!Number.isFinite(index)) return undefined;
              return index % 4 === 3 ? 255 : 0;
            },
          }),
        }),
      }),
      toDataURL: () => "data:image/png;base64,ZmFrZQ==",
    });
    const readerDocument = {
      defaultView: { Image: FakeImage },
      createElement: () => createCanvas(),
    };
    const pdfPage = {
      view: [0, 0, 600, 800],
      getViewport: ({ scale }: { scale: number }) => ({
        width: 600 * scale,
        height: 800 * scale,
        convertToViewportPoint: (x: number, y: number) => [
          x * scale,
          (800 - y) * scale,
        ],
      }),
      getTextContent: async () => ({ items: [] }),
      render: () => {
        directRenderCalls += 1;
        return { promise: Promise.resolve() };
      },
    };
    const pdfDocument = { numPages: 1, getPage: async () => pdfPage };
    const reader = {
      itemID: 42,
      _isReaderInitialized: true,
      _internalReader: {
        _primaryView: {
          _pdfRenderer: {
            renderRegionCrops: async (pageIndex: number, rects: number[][]) => {
              regionRenderCalls += 1;
              assert.equal(pageIndex, 0);
              assert.deepEqual(rects, [[0, 0, 600, 800]]);
              return ["data:image/png;base64,bmF0aXZl"];
            },
          },
        },
      },
      _iframeWindow: {
        document: readerDocument,
        Function: (() => () => async () => {
          readerRealmCalls += 1;
          throw new Error("reader-realm renderer should not run");
        }) as unknown as FunctionConstructor,
        PDFViewerApplication: { pdfDocument },
      },
    };
    const attachment = {
      id: 42,
      key: "NATIVE01",
      isPDFAttachment: () => true,
    };
    runtime.Zotero = {
      Libraries: { userLibraryID: 1 },
      Items: { getByLibraryAndKey: () => attachment },
      getMainWindow: () => ({ Zotero_Tabs: { selectedID: "reader" } }),
      Reader: {
        getByTabID: () => reader,
        _readers: [reader],
        open: async () => reader,
      },
    };

    try {
      const resolved = await resolvePresentationMedia({
        title: "Native reader renderer",
        sourceItemKey: attachment.key,
        slides: [
          {
            title: "Zotero renders the page inside its own reader",
            figure: { page: 1, mode: "page" },
          },
        ],
      });

      assert.equal(
        resolved.slides[0].figure?.data,
        "data:image/png;base64,ZmFrZQ==",
      );
      assert.include(
        resolved.slides[0].figure?.cropTrace || "",
        "render=zotero-region-renderer",
      );
      assert.equal(regionRenderCalls, 1);
      assert.equal(readerRealmCalls, 0);
      assert.equal(directRenderCalls, 0);
    } finally {
      runtime.Zotero = previousZotero;
    }
  });

  it("renders and crops a real-paper figure through Zotero's PDF.js reader", async function () {
    const runtime = globalThis as any;
    const previousZotero = runtime.Zotero;
    let drawCalls = 0;
    const cropArguments: number[][] = [];
    const createCanvas = () => {
      const context = {
        fillStyle: "",
        fillRect: () => undefined,
        drawImage: (...args: unknown[]) => {
          drawCalls += 1;
          if (args.length >= 5) {
            cropArguments.push(args.slice(1, 5).map(Number));
          }
        },
        getImageData: () => ({
          data: new Proxy([] as number[], {
            get: (_target, property) => {
              if (property === "length") return Number.MAX_SAFE_INTEGER;
              const index = Number(property);
              if (!Number.isFinite(index)) return undefined;
              return index % 4 === 3 ? 255 : 0;
            },
          }),
        }),
      };
      return {
        width: 0,
        height: 0,
        getContext: () => context,
        toDataURL: () => "data:image/png;base64,ZmFrZQ==",
      };
    };
    const ownerDocument = { createElement: () => createCanvas() };
    const pdfPage = {
      getViewport: ({ scale }: { scale: number }) => ({
        width: 600 * scale,
        height: 800 * scale,
        convertToViewportPoint: (x: number, y: number) => [
          x * scale,
          (800 - y) * scale,
        ],
      }),
      getTextContent: async () => ({
        items: [
          {
            str: "As discussed in Figure 6, the model focuses on targets",
            width: 340,
            height: 12,
            transform: [1, 0, 0, 12, 40, 600],
          },
          {
            str: "Fig. 6. Grad-CAM visualization results",
            width: 280,
            height: 12,
            transform: [1, 0, 0, 12, 40, 160],
          },
        ],
      }),
      render: () => ({ promise: Promise.resolve() }),
    };
    const pdfDocument = {
      numPages: 9,
      getPage: async () => pdfPage,
    };
    const reader = {
      itemID: 42,
      _isReaderInitialized: true,
      _iframeWindow: {
        document: ownerDocument,
        PDFViewerApplication: { pdfDocument },
      },
    };
    const attachment = {
      id: 42,
      key: "VJLWMUKJ",
      isPDFAttachment: () => true,
    };
    runtime.Zotero = {
      Libraries: { userLibraryID: 1 },
      Items: {
        getByLibraryAndKey: (_libraryID: number, key: string) =>
          key === attachment.key ? attachment : null,
      },
      getMainWindow: () => ({ Zotero_Tabs: { selectedID: "reader" } }),
      Reader: {
        getByTabID: () => reader,
        _readers: [reader],
        open: async () => reader,
      },
    };

    try {
      const resolved = await resolvePresentationMedia({
        title: "CRA",
        sourceItemKey: attachment.key,
        slides: [
          {
            title: "CRA focuses on the target object",
            figure: {
              page: 5,
              captionHint:
                "Figure 6 Grad CAM visualization of attention results",
            },
          },
          {
            title: "Missing captions fall back without aborting the deck",
            figure: {
              page: 5,
              captionHint: "A caption that is not present on this page",
            },
          },
        ],
      });

      assert.equal(
        resolved.slides[0].figure?.data,
        "data:image/png;base64,ZmFrZQ==",
      );
      assert.isAbove(resolved.slides[0].figure?.pixelWidth || 0, 80);
      assert.isBelow(resolved.slides[0].figure?.pixelHeight || 0, 1_900);
      assert.isAbove(resolved.slides[1].figure?.pixelWidth || 0, 80);
      assert.equal(
        drawCalls,
        2,
        "expected fuzzy caption and fallback crops to both render",
      );
      assert.isAbove(
        cropArguments[0]?.[1] || 0,
        500,
        "the crop should anchor to the printed caption, not an earlier body-text mention",
      );
    } finally {
      runtime.Zotero = previousZotero;
    }
  });

  it("finds an anchored caption on a neighboring PDF page", async function () {
    const runtime = globalThis as any;
    const previousZotero = runtime.Zotero;
    const createCanvas = () => ({
      width: 0,
      height: 0,
      getContext: () => ({
        fillStyle: "",
        fillRect: () => undefined,
        drawImage: () => undefined,
        getImageData: () => ({
          data: new Proxy([] as number[], {
            get: (_target, property) => {
              if (property === "length") return Number.MAX_SAFE_INTEGER;
              const index = Number(property);
              if (!Number.isFinite(index)) return undefined;
              return index % 4 === 3 ? 255 : 0;
            },
          }),
        }),
      }),
      toDataURL: () => "data:image/png;base64,ZmFrZQ==",
    });
    const makePage = (caption?: string) => ({
      getViewport: ({ scale }: { scale: number }) => ({
        width: 600 * scale,
        height: 800 * scale,
        convertToViewportPoint: (x: number, y: number) => [
          x * scale,
          (800 - y) * scale,
        ],
      }),
      getTextContent: async () => ({
        items: caption
          ? [
              {
                str: caption,
                width: 330,
                height: 12,
                transform: [1, 0, 0, 12, 40, 160],
              },
            ]
          : [
              {
                str: "The extracted text index reports Figure 2 here.",
                width: 300,
                height: 12,
                transform: [1, 0, 0, 12, 40, 500],
              },
            ],
      }),
      render: () => ({ promise: Promise.resolve() }),
    });
    const pages = new Map([
      [4, makePage()],
      [5, makePage("Figure 2: The two-GPU architecture")],
    ]);
    const requestedPages: number[] = [];
    const pdfDocument = {
      numPages: 9,
      getPage: async (pageNumber: number) => {
        requestedPages.push(pageNumber);
        return pages.get(pageNumber) || makePage();
      },
    };
    const reader = {
      itemID: 42,
      _isReaderInitialized: true,
      _iframeWindow: {
        document: { createElement: () => createCanvas() },
        PDFViewerApplication: { pdfDocument },
      },
    };
    const attachment = {
      id: 42,
      key: "VJLWMUKJ",
      isPDFAttachment: () => true,
    };
    runtime.Zotero = {
      Libraries: { userLibraryID: 1 },
      Items: { getByLibraryAndKey: () => attachment },
      getMainWindow: () => ({ Zotero_Tabs: { selectedID: "reader" } }),
      Reader: {
        getByTabID: () => reader,
        _readers: [reader],
        open: async () => reader,
      },
    };

    try {
      const resolved = await resolvePresentationMedia({
        title: "Neighbor scan",
        sourceItemKey: attachment.key,
        slides: [
          {
            title: "The architecture splits computation across two GPUs",
            figure: {
              page: 4,
              mode: "figure",
              captionHint: "Figure 2:",
            },
          },
        ],
      });

      assert.equal(resolved.slides[0].figure?.page, 5);
      assert.include(requestedPages, 4);
      assert.include(requestedPages, 5);
    } finally {
      runtime.Zotero = previousZotero;
    }
  });

  it("prefers a formal right-column caption over an earlier body reference and same-baseline left text", async function () {
    const runtime = globalThis as any;
    const previousZotero = runtime.Zotero;
    const cropArguments: number[][] = [];
    const createCanvas = () => ({
      width: 0,
      height: 0,
      getContext: () => ({
        fillStyle: "",
        fillRect: () => undefined,
        drawImage: (...args: unknown[]) => {
          if (args.length >= 5) {
            cropArguments.push(args.slice(1, 5).map(Number));
          }
        },
        getImageData: () => ({
          data: new Proxy([] as number[], {
            get: (_target, property) => {
              if (property === "length") return Number.MAX_SAFE_INTEGER;
              const index = Number(property);
              if (!Number.isFinite(index)) return undefined;
              return index % 4 === 3 ? 255 : 0;
            },
          }),
        }),
      }),
      toDataURL: () => "data:image/png;base64,ZmFrZQ==",
    });
    const pdfPage = {
      getViewport: ({ scale }: { scale: number }) => ({
        width: 600 * scale,
        height: 800 * scale,
        transform: [scale, 0, 0, -scale, 0, 800 * scale],
        convertToViewportPoint: (x: number, y: number) => [
          x * scale,
          (800 - y) * scale,
        ],
      }),
      getTextContent: async () => ({
        items: [
          {
            str: "Figure 1, which shows the number of iterations required",
            width: 220,
            height: 12,
            transform: [1, 0, 0, 12, 40, 260],
          },
          {
            str: "Unrelated body text in the left column",
            width: 280,
            height: 12,
            transform: [1, 0, 0, 12, 40, 220],
          },
          {
            str: "Figure 1: ReLU training curve",
            width: 210,
            height: 12,
            transform: [1, 0, 0, 12, 330, 220],
          },
        ],
      }),
      render: () => ({ promise: Promise.resolve() }),
    };
    const attachment = {
      id: 42,
      key: "VJLWMUKJ",
      isPDFAttachment: () => true,
    };
    const reader = {
      itemID: 42,
      _isReaderInitialized: true,
      _iframeWindow: {
        document: { createElement: () => createCanvas() },
        PDFViewerApplication: {
          pdfDocument: { numPages: 3, getPage: async () => pdfPage },
        },
      },
    };
    runtime.Zotero = {
      Libraries: { userLibraryID: 1 },
      Items: { getByLibraryAndKey: () => attachment },
      getMainWindow: () => ({ Zotero_Tabs: { selectedID: "reader" } }),
      Reader: {
        getByTabID: () => reader,
        _readers: [reader],
        open: async () => reader,
      },
    };

    try {
      await resolvePresentationMedia({
        title: "Column-aware crop",
        sourceItemKey: attachment.key,
        slides: [
          {
            title: "ReLU accelerates training",
            figure: {
              page: 3,
              mode: "figure",
              captionHint: "Figure 1:",
              crop: { x: 0.05, y: 0.02, width: 0.9, height: 0.55 },
            },
          },
        ],
      });

      assert.isAbove(
        cropArguments.at(-1)?.[0] || 0,
        280,
        "the caption-derived crop should stay in the right PDF column",
      );
      assert.isBelow(
        cropArguments.at(-1)?.[2] || Number.MAX_SAFE_INTEGER,
        800,
        "a mismatched broad explicit crop should not override the anchored figure",
      );
    } finally {
      runtime.Zotero = previousZotero;
    }
  });

  it("anchors a table caption embedded after same-baseline left-column text", async function () {
    const runtime = globalThis as any;
    const previousZotero = runtime.Zotero;
    const cropArguments: number[][] = [];
    const createCanvas = () => ({
      width: 0,
      height: 0,
      getContext: () => ({
        fillStyle: "",
        fillRect: () => undefined,
        drawImage: (...args: unknown[]) => {
          if (args.length >= 5) {
            cropArguments.push(args.slice(1, 5).map(Number));
          }
        },
        getImageData: () => ({
          data: new Proxy([] as number[], {
            get: (_target, property) => {
              if (property === "length") return Number.MAX_SAFE_INTEGER;
              const index = Number(property);
              if (!Number.isFinite(index)) return undefined;
              return index % 4 === 3 ? 255 : 0;
            },
          }),
        }),
      }),
      toDataURL: () => "data:image/png;base64,ZmFrZQ==",
    });
    const pdfPage = {
      getViewport: ({ scale }: { scale: number }) => ({
        width: 600 * scale,
        height: 800 * scale,
        transform: [scale, 0, 0, -scale, 0, 800 * scale],
        convertToViewportPoint: (x: number, y: number) => [
          x * scale,
          (800 - y) * scale,
        ],
      }),
      getTextContent: async () => ({
        items: [
          {
            str: "validation and test error rates interchangeably Table 1: Comparison of results on ILSVRC-",
            width: 520,
            height: 12,
            transform: [1, 0, 0, 12, 40, 220],
          },
          {
            str: "2010 test set. In italics are best results achieved by others.",
            width: 250,
            height: 12,
            transform: [1, 0, 0, 12, 330, 205],
          },
        ],
      }),
      render: () => ({ promise: Promise.resolve() }),
    };
    const attachment = {
      id: 42,
      key: "VJLWMUKJ",
      isPDFAttachment: () => true,
    };
    const reader = {
      itemID: 42,
      _isReaderInitialized: true,
      _iframeWindow: {
        document: { createElement: () => createCanvas() },
        PDFViewerApplication: {
          pdfDocument: { numPages: 7, getPage: async () => pdfPage },
        },
      },
    };
    runtime.Zotero = {
      Libraries: { userLibraryID: 1 },
      Items: { getByLibraryAndKey: () => attachment },
      getMainWindow: () => ({ Zotero_Tabs: { selectedID: "reader" } }),
      Reader: {
        getByTabID: () => reader,
        _readers: [reader],
        open: async () => reader,
      },
    };

    try {
      const resolved = await resolvePresentationMedia({
        title: "Embedded table caption",
        sourceItemKey: attachment.key,
        slides: [
          {
            title: "AlexNet decisively lowers ImageNet error",
            figure: {
              page: 7,
              mode: "figure",
              captionHint:
                "Table 1: Comparison of results on ILSVRC2010 test set. In italics are best results achieved by others.",
            },
          },
        ],
      });

      assert.match(
        resolved.slides[0].figure?.data || "",
        /^data:image\/png;base64,/,
      );
      assert.isAbove(
        cropArguments.at(-1)?.[0] || 0,
        180,
        "the embedded caption should project the crop toward the right column",
      );
    } finally {
      runtime.Zotero = previousZotero;
    }
  });

  it("reuses the anchored caption geometry when a scaled second text extraction is empty", async function () {
    const runtime = globalThis as any;
    const previousZotero = runtime.Zotero;
    let textExtractionCount = 0;
    const createCanvas = () => ({
      width: 0,
      height: 0,
      getContext: () => ({
        fillStyle: "",
        fillRect: () => undefined,
        drawImage: () => undefined,
        getImageData: () => ({
          data: new Proxy([] as number[], {
            get: (_target, property) => {
              if (property === "length") return Number.MAX_SAFE_INTEGER;
              const index = Number(property);
              if (!Number.isFinite(index)) return undefined;
              return index % 4 === 3 ? 255 : 0;
            },
          }),
        }),
      }),
      toDataURL: () => "data:image/png;base64,ZmFrZQ==",
    });
    const pdfPage = {
      getViewport: ({ scale }: { scale: number }) => ({
        width: 600 * scale,
        height: 800 * scale,
        transform: [scale, 0, 0, -scale, 0, 800 * scale],
        convertToViewportPoint: (x: number, y: number) => [
          x * scale,
          (800 - y) * scale,
        ],
      }),
      getTextContent: async () => {
        textExtractionCount += 1;
        return {
          items:
            textExtractionCount === 1
              ? [
                  {
                    str: "Figure 3: 96 convolutional kernels",
                    width: 210,
                    height: 12,
                    transform: [1, 0, 0, 12, 340, 220],
                  },
                ]
              : [],
        };
      },
      render: () => ({ promise: Promise.resolve() }),
    };
    const attachment = {
      id: 42,
      key: "VJLWMUKJ",
      isPDFAttachment: () => true,
    };
    const reader = {
      itemID: 42,
      _isReaderInitialized: true,
      _iframeWindow: {
        document: { createElement: () => createCanvas() },
        PDFViewerApplication: {
          pdfDocument: { numPages: 3, getPage: async () => pdfPage },
        },
      },
    };
    runtime.Zotero = {
      Libraries: { userLibraryID: 1 },
      Items: { getByLibraryAndKey: () => attachment },
      getMainWindow: () => ({ Zotero_Tabs: { selectedID: "reader" } }),
      Reader: {
        getByTabID: () => reader,
        _readers: [reader],
        open: async () => reader,
      },
    };

    try {
      const resolved = await resolvePresentationMedia({
        title: "Stable caption geometry",
        sourceItemKey: attachment.key,
        slides: [
          {
            title: "Learned kernels reveal specialization",
            figure: {
              page: 3,
              mode: "figure",
              captionHint: "Figure 3:",
            },
          },
        ],
      });

      assert.match(
        resolved.slides[0].figure?.data || "",
        /^data:image\/png;base64,/,
      );
      assert.equal(
        textExtractionCount,
        1,
        "a formal caption should be located once and scaled onto the rendered canvas",
      );
    } finally {
      runtime.Zotero = previousZotero;
    }
  });

  it("defers a missing explicit caption to the visual-review fallback", async function () {
    const runtime = globalThis as any;
    const previousZotero = runtime.Zotero;
    const createCanvas = () => ({
      width: 0,
      height: 0,
      getContext: () => ({
        fillStyle: "",
        fillRect: () => undefined,
        drawImage: () => undefined,
        getImageData: () => ({
          data: new Proxy([] as number[], {
            get: (_target, property) => {
              if (property === "length") return Number.MAX_SAFE_INTEGER;
              const index = Number(property);
              if (!Number.isFinite(index)) return undefined;
              return index % 4 === 3 ? 255 : 0;
            },
          }),
        }),
      }),
      toDataURL: () => "data:image/png;base64,ZmFrZQ==",
    });
    const pdfPage = {
      getViewport: ({ scale }: { scale: number }) => ({
        width: 600 * scale,
        height: 800 * scale,
        convertToViewportPoint: (x: number, y: number) => [
          x * scale,
          (800 - y) * scale,
        ],
      }),
      getTextContent: async () => ({
        items: [
          {
            str: "The body refers to Figure 4, but its caption is elsewhere.",
            width: 320,
            height: 12,
            transform: [1, 0, 0, 12, 40, 500],
          },
        ],
      }),
      render: () => ({ promise: Promise.resolve() }),
    };
    const pdfDocument = { numPages: 9, getPage: async () => pdfPage };
    const reader = {
      itemID: 42,
      _isReaderInitialized: true,
      _iframeWindow: {
        document: { createElement: () => createCanvas() },
        PDFViewerApplication: { pdfDocument },
      },
    };
    const attachment = {
      id: 42,
      key: "VJLWMUKJ",
      isPDFAttachment: () => true,
    };
    runtime.Zotero = {
      Libraries: { userLibraryID: 1 },
      Items: { getByLibraryAndKey: () => attachment },
      getMainWindow: () => ({ Zotero_Tabs: { selectedID: "reader" } }),
      Reader: {
        getByTabID: () => reader,
        _readers: [reader],
        open: async () => reader,
      },
    };

    try {
      const resolved = await resolvePresentationMedia({
        title: "Visual-review fallback",
        sourceItemKey: attachment.key,
        slides: [
          {
            title: "The visual must be reviewed",
            figure: { page: 5, captionHint: "Figure 4:" },
          },
        ],
      });
      assert.match(
        resolved.slides[0].figure?.data || "",
        /^data:image\/png;base64,/,
      );
      assert.include(
        resolved.slides[0].figure?.cropTrace || "",
        "selected=caption-missing-fallback",
      );
    } finally {
      runtime.Zotero = previousZotero;
    }
  });

  it("distinguishes an empty white render from a canvas with real ink", function () {
    const makeCanvas = (pixels: number[]) => ({
      width: 2,
      height: 2,
      getContext: () => ({
        getImageData: () => ({ data: new Uint8ClampedArray(pixels) }),
      }),
    });
    const whitePixel = [255, 255, 255, 255];
    const blank = makeCanvas([
      ...whitePixel,
      ...whitePixel,
      ...whitePixel,
      ...whitePixel,
    ]);
    const inked = makeCanvas([
      ...whitePixel,
      0,
      0,
      0,
      255,
      ...whitePixel,
      ...whitePixel,
    ]);

    assert.equal(measureCanvasInkRatio(blank as any), 0);
    assert.equal(measureCanvasInkRatio(inked as any), 0.25);
  });

  it("rejects data:, immediately and reports the output canvas dimensions", async function () {
    const runtime = globalThis as any;
    const previousZotero = runtime.Zotero;
    const createCanvas = () => ({
      width: 0,
      height: 0,
      getContext: () => ({
        fillStyle: "",
        fillRect: () => undefined,
        drawImage: () => undefined,
        getImageData: () => ({
          data: new Proxy([] as number[], {
            get: (_target, property) => {
              if (property === "length") return Number.MAX_SAFE_INTEGER;
              const index = Number(property);
              if (!Number.isFinite(index)) return undefined;
              return index % 4 === 3 ? 255 : 0;
            },
          }),
        }),
      }),
      toDataURL: () => "data:,",
    });
    const pdfPage = {
      getViewport: ({ scale }: { scale: number }) => ({
        width: 600 * scale,
        height: 800 * scale,
        convertToViewportPoint: (x: number, y: number) => [
          x * scale,
          (800 - y) * scale,
        ],
      }),
      getTextContent: async () => ({ items: [] }),
      render: () => ({ promise: Promise.resolve() }),
    };
    const attachment = {
      id: 42,
      key: "VJLWMUKJ",
      isPDFAttachment: () => true,
    };
    const reader = {
      itemID: 42,
      _isReaderInitialized: true,
      _iframeWindow: {
        document: { createElement: () => createCanvas() },
        PDFViewerApplication: {
          pdfDocument: { numPages: 1, getPage: async () => pdfPage },
        },
      },
    };
    runtime.Zotero = {
      Libraries: { userLibraryID: 1 },
      Items: { getByLibraryAndKey: () => attachment },
      getMainWindow: () => ({ Zotero_Tabs: { selectedID: "reader" } }),
      Reader: {
        getByTabID: () => reader,
        _readers: [reader],
        open: async () => reader,
      },
    };

    try {
      let message = "";
      try {
        await resolvePresentationMedia({
          title: "Invalid canvas encoding",
          sourceItemKey: attachment.key,
          slides: [
            {
              title: "Invalid image data is rejected",
              figure: { page: 1, mode: "page" },
            },
          ],
        });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      assert.include(message, "invalid figure data");
      assert.match(message, /canvas=\d+×\d+/);
      assert.include(message, "prefix=data:,");
    } finally {
      runtime.Zotero = previousZotero;
    }
  });
});
