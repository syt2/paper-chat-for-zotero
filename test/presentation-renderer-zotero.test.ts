import JSZip from "jszip";
import {
  getPresentationRenderer,
  resetPresentationRendererForTests,
} from "../src/modules/presentation/PresentationRendererLoader.ts";
import { PRESENTATION_RENDERER_GLOBAL } from "../src/modules/presentation/contracts.ts";
import { executePresentationCapability } from "../src/modules/presentation/PresentationCapability.ts";
import { resolvePresentationMedia } from "../src/modules/presentation/PresentationMediaResolver.ts";
import { getDataPath } from "../src/utils/common.ts";

describe("presentation renderer Zotero runtime probe", function () {
  it("lazy-loads the bundled renderer and writes a valid PPTX with IOUtils", async function () {
    const runtime = globalThis as any;
    if (
      !runtime.Zotero?.getMainWindow ||
      !runtime.Services?.scriptloader ||
      !runtime.PathUtils ||
      !runtime.IOUtils
    ) {
      this.skip();
    }

    this.timeout(30_000);
    let stage = "reset renderer";
    let outputPath: string | undefined;
    let preserveOutput = false;
    const reportStage = (value: string) => {
      stage = value;
      (globalThis as any).debug?.(`presentation probe stage: ${value}`);
    };

    try {
      reportStage("reset renderer");
      resetPresentationRendererForTests();

      reportStage("verify unloaded state");
      const target = Zotero.getMainWindow() as Window & Record<string, unknown>;
      if (target[PRESENTATION_RENDERER_GLOBAL] !== undefined) {
        throw new Error("renderer global already exists after reset");
      }

      reportStage("load renderer bundle");
      const renderer = getPresentationRenderer();
      if (typeof renderer.renderPresentation !== "function") {
        throw new Error("renderer API is missing renderPresentation");
      }
      if (typeof target[PRESENTATION_RENDERER_GLOBAL] !== "object") {
        throw new Error("renderer global was not installed on the main window");
      }

      reportStage("render presentation");
      const pixel = {
        page: 1,
        mode: "page" as const,
        data: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        pixelWidth: 1,
        pixelHeight: 1,
      };
      const bytes = await renderer.renderPresentation({
        title: "PaperChat Zotero 运行时探针",
        subtitle: "Firefox 115 bundle + IOUtils",
        theme: "paperchat",
        coverFigure: pixel,
        slides: [
          {
            title: "Runtime verification",
            keyMessage: "Generated entirely inside the PaperChat XPI",
            bullets: ["No Kimi", "No Node, Python, Chrome, or backend"],
            figure: pixel,
            chart: {
              type: "bar",
              title: "Runtime dependencies",
              labels: ["External", "Bundled"],
              values: [0, 1],
            },
            notes: "Generated inside Zotero without Node, Python, or Chrome.",
          },
        ],
      });
      const configuredOutputPath = Zotero.Prefs.get(
        "extensions.zotero.paperchat.presentationProbeOutputPath",
        true,
      );
      outputPath =
        typeof configuredOutputPath === "string" && configuredOutputPath
          ? configuredOutputPath
          : PathUtils.join(
              Zotero.getTempDirectory().path,
              `paperchat-presentation-probe-${Date.now()}.pptx`,
            );
      preserveOutput = outputPath === configuredOutputPath;

      reportStage("create output directory");
      await IOUtils.makeDirectory(PathUtils.parent(outputPath), {
        createAncestors: true,
        ignoreExisting: true,
      });

      reportStage("write presentation");
      await IOUtils.write(outputPath, bytes);
      const diskBytes = await IOUtils.read(outputPath);
      if (diskBytes.length !== bytes.length) {
        throw new Error(
          `disk byte count ${diskBytes.length} does not match ${bytes.length}`,
        );
      }

      reportStage("read PPTX ZIP");
      const archive = await JSZip.loadAsync(diskBytes);
      if (!archive.files["ppt/slides/slide1.xml"]) {
        throw new Error("slide1.xml is missing");
      }
      if (!archive.files["ppt/notesSlides/notesSlide1.xml"]) {
        throw new Error("notesSlide1.xml is missing");
      }
      const imageParts = Object.keys(archive.files).filter((path) =>
        /^ppt\/media\/image[-\d]+\.png$/.test(path),
      );
      if (imageParts.length < 2) {
        throw new Error("bundled renderer dropped a supplied PNG image");
      }
    } catch (error) {
      const detail =
        error instanceof Error
          ? `${error.name}: ${error.message}\n${error.stack ?? ""}`
          : String(error);
      (globalThis as any).debug?.(
        `presentation probe error at ${stage}: ${detail}`,
      );
      throw new Error(`Presentation probe failed at ${stage}: ${detail}`);
    } finally {
      if (outputPath && !preserveOutput && (await IOUtils.exists(outputPath))) {
        await IOUtils.remove(outputPath);
      }
    }
  });

  it("executes the public presentation capability without an external runtime", async function () {
    const runtime = globalThis as any;
    if (!runtime.Zotero?.getMainWindow || !runtime.IOUtils) {
      this.skip();
    }

    this.timeout(30_000);
    const rawResult = await executePresentationCapability({
      title: "PaperChat 独立能力探针",
      subtitle: "One public capability, lazy renderer bundle",
      theme: "paperchat",
      fileName: "../paperchat:capability/probe",
      slides: [
        {
          title: "证据与结果",
          keyMessage: "PPTX 在 Zotero 内生成",
          bullets: ["不依赖 Kimi", "不依赖 Node、Python 或后端"],
          chart: {
            type: "bar",
            title: "Runtime dependencies",
            labels: ["External", "Bundled"],
            values: [0, 1],
          },
          notes: "Generated by the public PaperChat presentation capability.",
        },
      ],
    });
    if (rawResult.startsWith("Error:")) {
      throw new Error(rawResult);
    }

    const result = JSON.parse(rawResult) as {
      path: string;
      slideCount: number;
      editable: boolean;
      attachmentStatus: "attached" | "not_attached";
      attachmentItemID?: number;
      attachmentMode?: "child" | "top_level";
    };
    let importedAttachment: Zotero.Item | false | undefined;
    try {
      if (result.slideCount !== 2 || result.editable !== true) {
        throw new Error(`unexpected capability result: ${rawResult}`);
      }
      if (result.attachmentStatus !== "attached") {
        throw new Error(
          `capability did not create a Zotero attachment: ${rawResult}`,
        );
      }
      if (!result.attachmentItemID || result.attachmentMode !== "top_level") {
        throw new Error(
          `capability created an unexpected Zotero item: ${rawResult}`,
        );
      }
      importedAttachment = Zotero.Items.get(result.attachmentItemID);
      if (!importedAttachment?.isAttachment?.()) {
        throw new Error(`capability attachment is missing: ${rawResult}`);
      }
      const attachmentPath = await importedAttachment.getFilePathAsync?.();
      if (attachmentPath !== result.path) {
        throw new Error(
          `capability returned the wrong attachment path: ${rawResult}`,
        );
      }
      const bytes = await IOUtils.read(result.path);
      const archive = await JSZip.loadAsync(bytes);
      if (!archive.files["ppt/slides/slide2.xml"]) {
        throw new Error("generated capability deck is missing slide2.xml");
      }
      if (
        !Object.keys(archive.files).some((path) =>
          /^ppt\/charts\/chart\d+\.xml$/.test(path),
        )
      ) {
        throw new Error(
          "generated capability deck is missing an editable chart",
        );
      }
    } finally {
      if (importedAttachment) {
        await importedAttachment.eraseTx();
      } else if (await IOUtils.exists(result.path)) {
        await IOUtils.remove(result.path);
      }
    }
  });

  it("renders a PDF page through Zotero's bundled PDF.js module", async function () {
    const runtime = globalThis as any;
    const probeEnabled =
      runtime.Services?.env?.get("PAPERCHAT_PRESENTATION_PROBE") === "1";
    const pdfPath = runtime.Services?.env?.get(
      "PAPERCHAT_PRESENTATION_MEDIA_PROBE_PDF",
    );
    if (!probeEnabled || !pdfPath || !runtime.ChromeUtils || !runtime.IOUtils) {
      this.skip();
    }

    this.timeout(60_000);
    const mainWindow = runtime.Cu?.waiveXrays
      ? runtime.Cu.waiveXrays(runtime.Zotero.getMainWindow())
      : runtime.Zotero.getMainWindow();
    const FunctionConstructor = mainWindow.Function;
    assert.equal(typeof FunctionConstructor, "function");
    const createRenderer = FunctionConstructor(`
      "use strict";
      return async function renderPaperChatStandalonePdfPage(pdfPath) {
        let stage = "import PDF.js";
        let loadingTask;
        try {
          const pdfjs = await import("resource://zotero/reader/pdf/build/pdf.mjs");
          pdfjs.GlobalWorkerOptions.workerSrc = "resource://zotero/reader/pdf/build/pdf.worker.mjs";
          stage = "read PDF";
          const bytes = await IOUtils.read(pdfPath);
          stage = "load document";
          loadingTask = pdfjs.getDocument({
            data: bytes,
            ownerDocument: document,
            isOffscreenCanvasSupported: false,
            isImageDecoderSupported: false,
            useWorkerFetch: false
          });
          const pdfDocument = await loadingTask.promise;
          stage = "load page";
          const page = await pdfDocument.getPage(1);
          const viewport = page.getViewport({ scale: 1.25 });
          stage = "render page";
          const canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.round(viewport.width));
          canvas.height = Math.max(1, Math.round(viewport.height));
          const context = canvas.getContext("2d", { alpha: false });
          if (!context) throw new Error("Canvas 2D context is unavailable.");
          context.fillStyle = "#FFFFFF";
          context.fillRect(0, 0, canvas.width, canvas.height);
          await page.render({ canvasContext: context, viewport: viewport }).promise;
          stage = "encode page";
          return JSON.stringify({
            data: canvas.toDataURL("image/png"),
            width: canvas.width,
            height: canvas.height
          });
        } catch (error) {
          throw new Error("Standalone PDF.js render failed at " + stage + ": " + String(error));
        } finally {
          if (loadingTask && loadingTask.destroy) await loadingTask.destroy();
        }
      };
    `) as () => (path: string) => Promise<string>;
    const render = createRenderer();
    try {
      const encoded = await render(pdfPath);
      const result = JSON.parse(String(encoded));
      assert.match(result.data, /^data:image\/png;base64,/);
      assert.isAbove(result.data.length, 1_000);
      assert.isAbove(result.width, 100);
      assert.isAbove(result.height, 100);
    } catch (error) {
      const detail =
        error instanceof Error
          ? `${error.name}: ${error.message}\n${error.stack || ""}`
          : String(error);
      runtime.debug?.(`standalone PDF.js probe error: ${detail}`);
      throw new Error(`Standalone PDF.js probe failed: ${detail}`);
    }
  });

  it("extracts clean paper figures through the live Zotero PDF.js reader", async function () {
    const runtime = globalThis as any;
    const itemKeyPref =
      "extensions.zotero.paperchat.presentationMediaProbeItemKey";
    const configuredItemKey =
      runtime.Services?.env?.get(
        "PAPERCHAT_PRESENTATION_MEDIA_PROBE_ITEM_KEY",
      ) ||
      runtime.Services?.prefs?.getStringPref?.(itemKeyPref, "") ||
      runtime.Zotero?.Prefs?.get(itemKeyPref, true);
    const fixturePdfPath = runtime.Services?.env?.get(
      "PAPERCHAT_PRESENTATION_MEDIA_PROBE_PDF",
    );
    let importedAttachment: Zotero.Item | undefined;
    if (fixturePdfPath && (await IOUtils.exists(fixturePdfPath))) {
      importedAttachment = await Zotero.Attachments.importFromFile({
        file: fixturePdfPath,
        libraryID: Zotero.Libraries.userLibraryID,
      });
    }
    const localFixtureKey = "J2ZF8CYD";
    const localFixture = runtime.Zotero?.Items?.getByLibraryAndKey?.(
      runtime.Zotero?.Libraries?.userLibraryID,
      localFixtureKey,
    );
    const configuredFixture = configuredItemKey
      ? runtime.Zotero?.Items?.getByLibraryAndKey?.(
          runtime.Zotero?.Libraries?.userLibraryID,
          configuredItemKey,
        )
      : null;
    const itemKey =
      importedAttachment?.key ||
      (configuredFixture
        ? configuredItemKey
        : localFixture
          ? localFixtureKey
          : "");
    const figure4Page = itemKey === "8HZ4QAKN" ? 7 : 8;
    (globalThis as any).debug?.(
      `presentation media probe item key: ${String(itemKey || "<missing>")}`,
    );
    (globalThis as any).debug?.(
      `presentation media probe compartments: Cu=${typeof runtime.Cu}, cloneInto=${typeof runtime.Components?.utils?.cloneInto}, waiveXrays=${typeof runtime.Components?.utils?.waiveXrays}`,
    );
    if (!runtime.Zotero?.getMainWindow || !runtime.IOUtils || !itemKey) {
      this.skip();
    }

    this.timeout(60_000);
    let stage = "resolve presentation media";
    try {
      const resolved = await resolvePresentationMedia({
        title:
          "ImageNet Classification with Deep Convolutional Neural Networks",
        subtitle:
          "AlexNet established the scalable recipe for large-scale visual recognition",
        author: "PaperChat · Academic Research Brief",
        sourceItemKey: itemKey,
        theme: "academic",
        designSystem: "teal-green-academic-defense",
        coverFigure: {
          page: figure4Page,
          captionHint: "Figure 4 Left Eight ILSVRC-2010 test images",
        },
        coverMetrics: [
          { value: "1.2M", label: "training images" },
          { value: "60M", label: "parameters" },
          { value: "15.3%", label: "top-5 test error" },
        ],
        slides: [
          {
            section: "Problem · Scale",
            title:
              "ImageNet required a model large enough to learn visual hierarchy without collapsing under overfitting",
            layout: "comparison",
            keyMessage:
              "AlexNet paired unprecedented model capacity with a training recipe that kept optimization tractable.",
            comparison: {
              left: {
                title: "Handcrafted vision",
                bullets: [
                  "Separate feature engineering and classification",
                  "Limited capacity at ImageNet scale",
                ],
              },
              right: {
                title: "AlexNet",
                bullets: [
                  "End-to-end visual hierarchy",
                  "GPU training plus explicit regularization",
                ],
              },
            },
            metrics: [
              { value: "1.2M", label: "training images" },
              { value: "1,000", label: "classes" },
              { value: "60M", label: "parameters" },
            ],
          },
          {
            section: "Method · Architecture",
            title:
              "Five convolutional stages and three dense layers distribute representation learning across two GPUs",
            layout: "process",
            keyMessage:
              "The architecture scales depth and width while preserving a trainable computational path.",
            process: [
              { title: "Input", detail: "224 × 224 RGB" },
              { title: "Conv 1–2", detail: "Large receptive fields" },
              { title: "Conv 3–5", detail: "Hierarchical features" },
              { title: "FC 6–8", detail: "4,096 → 1,000" },
            ],
            bullets: [
              "ReLU accelerates convergence.",
              "Overlapping pooling reduces error.",
            ],
            metrics: [
              { value: "60M", label: "parameters" },
              { value: "650K", label: "neurons" },
            ],
            figure: {
              page: 5,
              captionHint:
                "Figure 2 An illustration of the architecture of our CNN",
              caption:
                "AlexNet splits convolutional computation across two GPUs before three fully connected layers.",
            },
          },
          {
            section: "Training · Regularization",
            title:
              "Data augmentation and dropout make the 60-million-parameter model trainable without severe overfitting",
            layout: "matrix",
            matrix: {
              banner:
                "The training recipe attacks optimization speed and generalization at different stages",
              columns: [
                "ReLU + GPUs",
                "Augmentation",
                "Dropout",
                "Weight decay",
              ],
              rows: [
                {
                  label: "Primary job",
                  cells: [
                    "Faster updates",
                    "More examples",
                    "Break co-adaptation",
                    "Control weights",
                  ],
                },
                {
                  label: "Applied to",
                  cells: [
                    "All layers",
                    "Input images",
                    "First two FC layers",
                    "All weights",
                  ],
                },
                {
                  label: "Reported effect",
                  cells: [
                    "6× convergence",
                    "2,048× expansion",
                    "Less overfit",
                    "Lower training error",
                  ],
                },
              ],
            },
            figure: {
              page: 6,
              captionHint: "Figure 3 96 convolutional kernels of size",
              caption:
                "The learned first-layer kernels show structured frequency and color selectivity.",
            },
            keyMessage:
              "No single regularizer is sufficient; the gains come from a coordinated training system.",
          },
          {
            section: "Results · Benchmark",
            title:
              "The seven-model ensemble cuts ILSVRC-2012 top-5 test error to 15.3%",
            layout: "ablation",
            chart: {
              type: "bar",
              orientation: "horizontal",
              title: "ILSVRC-2012 top-5 error · lower is better",
              labels: [
                "AlexNet ensemble",
                "Single CNN",
                "SIFT + FVs",
                "Previous best",
              ],
              values: [15.3, 16.4, 18.2, 26.2],
              xAxisTitle: "Top-5 error (%)",
              highlightIndex: 0,
            },
            callouts: [
              {
                label: "Benchmark result",
                text: "A single CNN reaches 18.2%; ensembling reduces the remaining error.",
                tone: "evidence",
              },
            ],
            metrics: [
              { value: "15.3%", label: "top-5 test error" },
              { value: "−10.9 pt", label: "vs. previous best" },
            ],
          },
          {
            section: "Conclusion · Legacy",
            title:
              "AlexNet established a scalable recipe, while compute cost and transfer breadth remained open",
            layout: "conclusion",
            groups: [
              {
                title: "Scale became trainable",
                bullets: [
                  "GPU convolution and ReLU enabled a 60M-parameter CNN.",
                ],
              },
              {
                title: "Regularization became a system",
                bullets: [
                  "Augmentation and dropout converted capacity into generalization.",
                ],
              },
              {
                title: "ImageNet shifted the field",
                bullets: ["The ensemble reached 15.3% top-5 test error."],
              },
            ],
            callouts: [
              {
                label: "Compute boundary",
                text: "Training required two GTX 580 GPUs for five to six days.",
                tone: "risk",
              },
              {
                label: "Transfer boundary",
                text: "Broader transfer and temporal supervision remained open.",
                tone: "neutral",
              },
            ],
            timeline: [
              { label: "Architecture", detail: "established" },
              { label: "Optimization", detail: "stabilized" },
              { label: "Insight", detail: "visualized" },
              { label: "Broad transfer", detail: "future validation" },
            ],
          },
        ],
      });
      stage = "render resolved media";
      const renderer = getPresentationRenderer();
      const bytes = await renderer.renderPresentation(resolved);
      const outputPref =
        "extensions.zotero.paperchat.presentationMediaProbeOutputPath";
      const configuredOutput =
        runtime.Services.env.get("PAPERCHAT_PRESENTATION_MEDIA_PROBE_OUTPUT") ||
        runtime.Services?.prefs?.getStringPref?.(outputPref, "") ||
        Zotero.Prefs.get(outputPref, true) ||
        (itemKey === localFixtureKey
          ? "/tmp/paperchat-alexnet-live-crop.pptx"
          : "");
      const outputPath =
        configuredOutput ||
        PathUtils.join(
          Zotero.getTempDirectory().path,
          `paperchat-presentation-media-probe-${Date.now()}.pptx`,
        );
      stage = "write media probe";
      await IOUtils.makeDirectory(PathUtils.parent(outputPath), {
        createAncestors: true,
        ignoreExisting: true,
      });
      await IOUtils.write(outputPath, bytes);
      (globalThis as any).debug?.(
        `presentation media probe output: ${outputPath}`,
      );
      if (!configuredOutput && (await IOUtils.exists(outputPath))) {
        await IOUtils.remove(outputPath);
      }
    } catch (error) {
      const detail =
        error instanceof Error
          ? `${error.name}: ${error.message}\n${error.stack || ""}`
          : String(error);
      (globalThis as any).debug?.(
        `presentation media probe error at ${stage}: ${detail}`,
      );
      throw new Error(`Presentation media probe failed at ${stage}: ${detail}`);
    } finally {
      if (importedAttachment) {
        await importedAttachment.eraseTx();
      }
    }
  });
});
