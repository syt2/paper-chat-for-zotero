import { assert } from "chai";
import packageManifest from "../package.json";
import {
  createPresentationToolDefinition,
  executePresentationCapability,
  mergePresentationPlanMetadata,
  resolvePresentationAuthor,
  resolvePresentationLanguage,
} from "../src/modules/presentation/PresentationCapability.ts";
import {
  getPresentationRenderer,
  resetPresentationRendererForTests,
} from "../src/modules/presentation/PresentationRendererLoader.ts";
import { PRESENTATION_RENDERER_GLOBAL } from "../src/modules/presentation/contracts.ts";
import { PresentationResolvedMediaDuplicateError } from "../src/modules/presentation/PresentationMediaResolver.ts";
import {
  filterBlockingPresentationQualityIssues,
  shouldUseStrictPresentationQualityGate,
  validatePresentationQuality,
} from "../src/modules/presentation/PresentationQualityGate.ts";
import { normalizePresentationRequestInput } from "../src/modules/presentation/PresentationRequestNormalizer.ts";

const VALID_REQUEST = {
  title: "Valid deck",
  slides: [
    {
      title: "Evidence supports the conclusion",
      metrics: [{ value: "24%", label: "relative improvement" }],
    },
  ],
};

describe("presentation capability", function () {
  it("does not couple presentation quality policy to build mode", function () {
    assert.notInclude(packageManifest.scripts.build, "NODE_ENV=production");
    assert.match(
      packageManifest.scripts["build:release"],
      /^NODE_ENV=production\s/,
    );
    assert.match(packageManifest.scripts.release, /^NODE_ENV=production\s/);
  });

  it("exposes one structured presentation tool", function () {
    const definition = createPresentationToolDefinition();

    assert.equal(definition.function.name, "presentation");
    assert.include(
      definition.function.description,
      "Provide only the current sourceItemKey",
    );
    assert.deepEqual(definition.function.parameters.required || [], []);
    assert.property(definition.function.parameters.properties, "sourceItemKey");
    assert.property(definition.function.parameters.properties, "language");
    assert.property(definition.function.parameters.properties, "instructions");
    assert.notProperty(definition.function.parameters.properties, "slides");
    assert.isBelow(
      JSON.stringify(definition.function.parameters).length,
      3_000,
    );
  });

  it("uses Zotero's interface locale unless the user explicitly overrides it", function () {
    const originalZotero = (globalThis as { Zotero?: unknown }).Zotero;
    try {
      (globalThis as { Zotero?: unknown }).Zotero = { locale: "zh_TW" };
      assert.equal(resolvePresentationLanguage(undefined), "zh-TW");
      assert.equal(resolvePresentationLanguage("auto"), "zh-TW");
      assert.equal(resolvePresentationLanguage("ja-JP"), "ja-JP");
    } finally {
      (globalThis as { Zotero?: unknown }).Zotero = originalZotero;
    }
  });

  it("formats missing cover authors from paper metadata in the deck locale", function () {
    assert.equal(
      resolvePresentationAuthor(
        ["Alex Krizhevsky", "Ilya Sutskever", "Geoffrey E. Hinton"],
        "zh-CN",
      ),
      "Alex Krizhevsky、Ilya Sutskever、Geoffrey E. Hinton",
    );
    assert.equal(
      resolvePresentationAuthor(["A", "B", "C", "D"], "en-US"),
      "A, B, C et al.",
    );
    assert.isUndefined(resolvePresentationAuthor([], "zh-CN"));
  });

  it("injects Zotero's display locale into the internal planner intent", async function () {
    const originalZotero = (globalThis as { Zotero?: unknown }).Zotero;
    const requests: any[] = [];
    try {
      (globalThis as { Zotero?: unknown }).Zotero = { locale: "zh_CN" };
      await executePresentationCapability(
        { sourceItemKey: "SBZ2M99R" },
        undefined,
        async (request) => {
          requests.push(request);
          return {
            title: "Incomplete internal deck",
            sourceItemKey: "SBZ2M99R",
            slides: [],
          } as any;
        },
        {
          metadata: { title: "ImageNet classification", year: 2012 },
          sections: [],
          fullText: "Figure 1 evidence",
          pages: [],
          pageCount: 0,
        } as any,
      );

      assert.lengthOf(requests, 2);
      assert.equal(requests[0].intent.language, "zh-CN");
      assert.equal(requests[1].intent.language, "zh-CN");
    } finally {
      (globalThis as { Zotero?: unknown }).Zotero = originalZotero;
    }
  });

  it("supplies a missing planner author from authoritative paper metadata", function () {
    const merged = mergePresentationPlanMetadata(
      {
        title: "AlexNet",
        slides: VALID_REQUEST.slides,
      },
      {
        sourceItemKey: "SBZ2M99R",
        language: "zh-CN",
      },
      {
        metadata: {
          title: "ImageNet classification",
          authors: ["Alex Krizhevsky", "Ilya Sutskever", "Geoffrey E. Hinton"],
          year: 2017,
        },
        sections: [],
        fullText: "Figure 1 evidence",
        pages: [],
        pageCount: 0,
      } as any,
    );

    assert.equal(
      merged.author,
      "Alex Krizhevsky、Ilya Sutskever、Geoffrey E. Hinton",
    );
    assert.equal(merged.language, "zh-CN");
    assert.equal(merged.sourceItemKey, "SBZ2M99R");

    const authored = mergePresentationPlanMetadata(
      {
        ...merged,
        sourceItemKey: "PLANNER-HALLUCINATION",
        author: "论文团队",
      },
      { sourceItemKey: "SBZ2M99R", language: "zh-CN" },
      {
        metadata: { authors: ["Different Author"] },
      } as any,
    );
    assert.equal(authored.author, "论文团队");
    assert.equal(authored.sourceItemKey, "SBZ2M99R");
  });

  it("preserves the resolved locale in the internal presentation schema", function () {
    const normalized = normalizePresentationRequestInput({
      ...VALID_REQUEST,
      language: "zh-CN",
    });

    assert.equal(normalized.language, "zh-CN");
    assert.deepEqual(validatePresentationQuality(normalized as any), []);
  });

  it("repairs an invalid internal plan once and permits fresh outer retries", async function () {
    const requests: any[] = [];
    const result = await executePresentationCapability(
      { sourceItemKey: "SBZ2M99R" },
      undefined,
      async (request) => {
        requests.push(request);
        return {
          title: "Incomplete internal deck",
          sourceItemKey: "SBZ2M99R",
          slides: [],
        } as any;
      },
      {
        metadata: { title: "ImageNet classification", year: 2012 },
        sections: [],
        fullText: "Figure 1 evidence",
        pages: [],
        pageCount: 0,
      } as any,
    );

    assert.lengthOf(requests, 2);
    assert.isUndefined(requests[0].repair);
    assert.include(
      requests[1].repair.issues.join("\n"),
      "Expected array length",
    );
    assert.include(
      result,
      "Presentation internal planning did not pass the quality contract",
    );
    assert.include(result, "Retryable: yes");
    assert.include(result, "Retry the presentation request");
    assert.notInclude(result, "Retry the presentation request once");
  });

  it("canonicalizes Terra-style overfilled slides before quality validation", function () {
    const figure1 = { page: 3, captionHint: "Figure 1:" };
    const figure2 = { page: 5, captionHint: "Figure 2:" };
    const overloaded = {
      title: "AlexNet",
      coverFigure: figure1,
      coverFigures: [figure1, figure2],
      slides: [
        "comparison",
        "process",
        "gallery",
        "ablation",
        "conclusion",
      ].map((layout, index) => ({
        layout: index === 0 ? Object(layout) : layout,
        title: `${layout} claim`,
        bullets: ["Evidence"],
        groups: [{ title: "Finding", bullets: ["Supported"] }],
        keyMessage: "Short claim",
        metrics: [{ value: "17.0%", label: "Top-5 error" }],
        figure: figure1,
        figures: [figure1, figure2],
        chart: {
          type: "bar",
          labels: ["A", "B"],
          values: [2, 1],
          series: [{ name: "Error", values: [2, 1] }],
        },
        table: { headers: ["A"], rows: [["1"]] },
        equation: { expression: "x = y" },
        matrix: {
          columns: ["A", "B"],
          rows: [
            { label: "One", cells: ["1", "2"] },
            { label: "Two", cells: ["3", "4"] },
          ],
        },
        timeline: [
          { label: "Scale" },
          { label: "Transfer" },
          { label: "Deployment" },
        ],
        callouts: [{ text: "One" }, { text: "Two" }],
        process: [{ title: "A" }, { title: "B" }, { title: "C" }],
        comparison: {
          left: { title: "Before", bullets: ["A"] },
          right: { title: "After", bullets: ["B"] },
        },
      })),
    };

    const normalized = normalizePresentationRequestInput(overloaded) as any;

    assert.deepEqual(normalized.coverFigure, figure1);
    assert.deepEqual(normalized.coverFigures, [figure1, figure2]);
    assert.notProperty(normalized.slides[0], "chart");
    assert.notProperty(normalized.slides[0], "bullets");
    assert.property(normalized.slides[0], "keyMessage");
    assert.lengthOf(normalized.slides[0].callouts, 1);
    assert.deepEqual(normalized.slides[1].figure, figure1);
    assert.notProperty(normalized.slides[1], "figures");
    assert.notProperty(normalized.slides[1], "bullets");
    assert.notProperty(normalized.slides[1], "keyMessage");
    assert.notProperty(normalized.slides[1], "metrics");
    assert.notProperty(normalized.slides[1], "equation");
    assert.lengthOf(normalized.slides[2].figures, 2);
    assert.deepEqual(normalized.slides[2].figures, [figure1, figure2]);
    assert.notProperty(normalized.slides[2], "metrics");
    assert.notProperty(normalized.slides[2], "bullets");
    assert.notProperty(normalized.slides[3], "table");
    assert.notProperty(normalized.slides[3], "bullets");
    assert.notProperty(normalized.slides[3].chart, "values");
    assert.deepEqual(normalized.slides[3].figure, figure1);
    assert.notProperty(normalized.slides[3], "figures");
    assert.notProperty(normalized.slides[4], "figure");
    assert.notProperty(normalized.slides[4], "matrix");
    assert.notProperty(normalized.slides[4], "bullets");
    assert.notProperty(normalized.slides[4], "keyMessage");
    assert.lengthOf(normalized.slides[4].timeline, 3);

    const inferredSource = normalizePresentationRequestInput({
      title: "Paper deck",
      coverFigure: {
        itemKey: "VJLWMUKJ",
        page: 2,
        captionHint: "Figure 1:",
      },
      slides: [{ title: "Evidence", metrics: [{ value: "1", label: "x" }] }],
    });
    assert.equal(inferredSource.sourceItemKey, "VJLWMUKJ");

    const normalizedFigure = normalizePresentationRequestInput({
      title: "Figure slide",
      slides: [
        {
          layout: "figure",
          title: "Architecture",
          figure: figure1,
          figures: [figure1, figure2],
          bullets: ["Visible narrative"],
          keyMessage: "Visible claim",
          metrics: [{ value: "60M", label: "parameters" }],
          callouts: [{ text: "Hidden callout" }],
          chart: { type: "bar", labels: ["A"], values: [1] },
          table: { headers: ["A"], rows: [["1"]] },
          equation: { expression: "x = y" },
          matrix: {
            columns: ["A", "B"],
            rows: [{ label: "One", cells: ["1", "2"] }],
          },
          timeline: [{ label: "A" }],
          process: [{ title: "A" }],
          comparison: {
            left: { title: "Before", bullets: ["A"] },
            right: { title: "After", bullets: ["B"] },
          },
          groups: [{ title: "Finding", bullets: ["Supported"] }],
        },
      ],
    }) as any;
    assert.deepEqual(normalizedFigure.slides[0].figure, figure1);
    assert.notProperty(normalizedFigure.slides[0], "figures");
    assert.property(normalizedFigure.slides[0], "bullets");
    assert.property(normalizedFigure.slides[0], "keyMessage");
    for (const hiddenField of [
      "metrics",
      "callouts",
      "chart",
      "table",
      "equation",
      "matrix",
      "timeline",
      "process",
      "comparison",
      "groups",
    ]) {
      assert.notProperty(normalizedFigure.slides[0], hiddenField);
    }

    const placeholder = normalizePresentationRequestInput({
      title: "Placeholder",
      slides: [
        {
          title: "Ablation",
          layout: "ablation",
          chart: { type: "bar", labels: ["A"], values: [1] },
          figure: {
            page: 3,
            caption: " ",
            captionHint: "Figure 1:",
            crop: { x: 0, y: 0, width: 0.02, height: 0.02 },
          },
        },
      ],
    }) as any;
    assert.notProperty(placeholder.slides[0], "figure");
  });

  it("repairs Terra matrices to one complete shared rectangle", function () {
    const normalized = normalizePresentationRequestInput({
      title: "Matrix repair",
      slides: [
        {
          title: "The comparison stays editable",
          layout: "matrix",
          matrix: {
            columns: ["Prior work", "AlexNet", "Unused"],
            rows: [
              {
                label: "Accuracy",
                cells: ["26.2%", "15.3%", "extra"],
              },
              { label: "Training", cells: ["CPU", "2 GPUs"] },
              {
                label: "Scale",
                cells: ["Small", "1.2M images", "extra"],
              },
            ],
            highlightColumn: 2,
          },
        },
      ],
    }) as any;

    assert.deepEqual(normalized.slides[0].matrix.columns, [
      "Prior work",
      "AlexNet",
    ]);
    assert.deepEqual(
      normalized.slides[0].matrix.rows.map((row: any) => row.cells),
      [
        ["26.2%", "15.3%"],
        ["CPU", "2 GPUs"],
        ["Small", "1.2M images"],
      ],
    );
    assert.notProperty(normalized.slides[0].matrix, "highlightColumn");
  });

  it("canonicalizes array-like values crossing the Zotero realm boundary", function () {
    const wrappedCallouts = {
      0: { text: "Keep this callout" },
      1: { text: "Drop this callout" },
      length: 2,
      [Symbol.toStringTag]: "Array",
    };
    const wrappedSlides = {
      0: {
        title: "Process slide",
        layout: "process",
        process: [{ title: "Input" }, { title: "Output" }],
        metrics: [{ value: "60M", label: "parameters" }],
        callouts: wrappedCallouts,
      },
      length: 1,
      [Symbol.toStringTag]: "Array",
    };

    const normalized = normalizePresentationRequestInput({
      title: "Wrapped deck",
      slides: wrappedSlides,
    }) as any;

    assert.lengthOf(normalized.slides, 1);
    assert.notProperty(normalized.slides[0], "metrics");
    assert.deepEqual(normalized.slides[0].callouts, [
      { text: "Keep this callout" },
    ]);
  });

  it("treats Terra placeholder modules as omitted without deleting real narrative", function () {
    const figure = { page: 3, captionHint: "Figure 1:" };
    const normalized = normalizePresentationRequestInput({
      title: "AlexNet",
      coverFigure: figure,
      coverFigures: [
        figure,
        {
          page: 4,
          caption: "placeholder",
          captionHint: "Figure 2:",
        },
      ],
      slides: [
        {
          title: "The benchmark improves",
          layout: "ablation",
          bullets: ["Top-5 error falls to 17.0%"],
          groups: [{ title: "placeholder", bullets: ["placeholder"] }],
          chart: { type: "bar", labels: ["CNN"], values: [17] },
          figure,
        },
        {
          title: "The filters become interpretable",
          layout: "gallery",
          bullets: ["ReLU converges faster"],
          groups: [{ title: "placeholder", bullets: ["placeholder"] }],
          figures: [figure, { page: 6, captionHint: "Figure 3:" }],
        },
        {
          title: "The remaining questions matter",
          layout: "conclusion",
          bullets: ["Training remains expensive"],
          keyMessage: "placeholder",
          figure,
          timeline: [
            { label: "1", milestone: "placeholder", detail: "placeholder" },
            { label: "2", milestone: "placeholder", detail: "placeholder" },
            { label: "3", milestone: "placeholder", detail: "placeholder" },
          ],
        },
      ],
    }) as any;

    assert.deepEqual(normalized.slides[0].bullets, [
      "Top-5 error falls to 17.0%",
    ]);
    assert.notProperty(normalized.slides[0], "groups");
    assert.deepEqual(normalized.slides[1].bullets, ["ReLU converges faster"]);
    assert.notProperty(normalized.slides[1], "groups");
    assert.deepEqual(normalized.slides[2].bullets, [
      "Training remains expensive",
    ]);
    assert.notProperty(normalized.slides[2], "keyMessage");
    assert.notProperty(normalized.slides[2], "timeline");
    assert.lengthOf(normalized.coverFigures, 1);
    assert.notInclude(JSON.stringify(normalized), "placeholder");
  });

  it("rejects placeholder sentinel text when quality validation is called directly", function () {
    const errors = validatePresentationQuality({
      title: "Research deck",
      slides: [
        {
          title: "Evidence supports the conclusion",
          keyMessage: "placeholder",
          metrics: [{ value: "24%", label: "relative improvement" }],
        },
      ],
    });

    assert.include(errors.join("\n"), "placeholder sentinel text");
  });

  it("drops Terra empty modules and deduplicates evidence figures", function () {
    const figure = { page: 3, captionHint: "Figure 1:" };
    const normalized = normalizePresentationRequestInput({
      title: "AlexNet",
      slides: [
        {
          title: "ReLU accelerates training",
          layout: "evidence",
          bullets: ["Training becomes practical", ""],
          figure,
          figures: [figure],
          chart: {
            type: "bar",
            labels: ["ReLU", "tanh"],
            values: [6, 1],
          },
          table: { headers: ["a"], rows: [["a"]] },
          matrix: {
            banner: "",
            columns: ["", ""],
            rows: [
              { label: "", cells: ["", ""] },
              { label: "", cells: ["", ""] },
            ],
          },
          timeline: [
            { label: "", milestone: "", detail: "" },
            { label: "", milestone: "", detail: "" },
            { label: "", milestone: "", detail: "" },
          ],
          process: [
            { title: "", detail: "" },
            { title: "", detail: "" },
            { title: "", detail: "" },
          ],
          comparison: {
            left: { title: "", bullets: [""] },
            right: { title: "", bullets: [""] },
          },
        },
        {
          title: "Limits remain",
          layout: "conclusion",
          bullets: ["Training is expensive"],
          figure,
          timeline: [
            { label: "", milestone: "", detail: "" },
            { label: "", milestone: "", detail: "" },
            { label: "", milestone: "", detail: "" },
          ],
        },
      ],
    }) as any;

    assert.deepEqual(normalized.slides[0].bullets, [
      "Training becomes practical",
    ]);
    assert.deepEqual(normalized.slides[0].figure, figure);
    assert.notProperty(normalized.slides[0], "figures");
    for (const emptyModule of [
      "table",
      "matrix",
      "timeline",
      "process",
      "comparison",
    ]) {
      assert.notProperty(normalized.slides[0], emptyModule);
    }
    assert.notProperty(normalized.slides[1], "timeline");
  });

  it("promotes two ultra-wide gallery figures and recovers the secondary crop on another slide", function () {
    const primary = {
      itemKey: "PAPER001",
      page: 3,
      captionHint: "Figure 1: Architecture",
      pixelWidth: 1_359,
      pixelHeight: 463,
    };
    const secondary = {
      itemKey: "PAPER001",
      page: 4,
      captionHint: "Figure 2: Filters",
      pixelWidth: 1_351,
      pixelHeight: 456,
    };
    const normalized = normalizePresentationRequestInput({
      title: "Readable paper deck",
      sourceItemKey: "PAPER001",
      coverFigure: {
        itemKey: "PAPER001",
        page: 1,
        captionHint: "Figure 0: Cover",
      },
      slides: [
        {
          title: "Research gap",
          layout: "comparison",
          comparison: {
            left: { title: "Before", bullets: ["Hand engineered"] },
            right: { title: "After", bullets: ["Learned features"] },
          },
        },
        {
          title: "Architecture and filters",
          layout: "gallery",
          keyMessage: "Both figures need projection-scale treatment.",
          figures: [primary, secondary],
        },
        {
          title: "Optimization evidence",
          layout: "evidence",
          chart: { type: "bar", labels: ["CNN"], values: [17] },
        },
        {
          title: "Ablation evidence",
          layout: "ablation",
          table: { headers: ["Method", "Error"], rows: [["CNN", "17%"]] },
        },
        {
          title: "Conclusion",
          layout: "conclusion",
          groups: [
            { title: "Finding 1", bullets: ["Evidence one"] },
            { title: "Finding 2", bullets: ["Evidence two"] },
            { title: "Finding 3", bullets: ["Evidence three"] },
          ],
          callouts: [
            { text: "Open question one" },
            { text: "Open question two" },
          ],
          timeline: [{ label: "Reproduce" }, { label: "Extend" }],
        },
      ],
    }) as any;

    assert.equal(normalized.slides[1].layout, "figure");
    assert.equal(normalized.slides[1].figure.captionHint, primary.captionHint);
    assert.notProperty(normalized.slides[1], "figures");
    assert.equal(
      normalized.slides[2].figure.captionHint,
      secondary.captionHint,
    );
  });

  it("promotes Terra comparison-first evidence slides instead of deleting their evidence", function () {
    const normalized = normalizePresentationRequestInput({
      title: "AlexNet",
      slides: [
        {
          title: "End-to-end learning replaces hand-engineered features",
          layout: "evidence",
          comparison: {
            left: {
              title: "Before AlexNet",
              bullets: ["Shallow pipelines", "Hand-engineered features"],
            },
            right: {
              title: "AlexNet",
              bullets: ["Deep learned hierarchy", "GPU-scale training"],
            },
          },
          metrics: [{ value: "17.0%", label: "Top-5 error" }],
        },
      ],
    }) as any;

    assert.equal(normalized.slides[0].layout, "comparison");
    assert.property(normalized.slides[0], "comparison");
    assert.deepEqual(normalized.slides[0].metrics, [
      { value: "17.0%", label: "Top-5 error" },
    ]);
  });

  it("keeps structural issues blocking while editorial quality is advisory by default", function () {
    const issues = [
      "/slides/0: evidence layout requires at least two evidence modules such as PDF figures, a chart, table, equation, matrix, or metrics.",
      "/slides/0: 940 visible characters exceed the 760-character budget for the evidence composition.",
      "/slides/0/table: every row must match the header count.",
    ];

    assert.deepEqual(
      filterBlockingPresentationQualityIssues(issues, true),
      issues,
    );
    assert.deepEqual(filterBlockingPresentationQualityIssues(issues, false), [
      "/slides/0/table: every row must match the header count.",
    ]);
  });

  it("uses an explicit test-only seam for strict editorial quality", function () {
    assert.isFalse(shouldUseStrictPresentationQualityGate());
    assert.isFalse(shouldUseStrictPresentationQualityGate({}));
    assert.isTrue(
      shouldUseStrictPresentationQualityGate({ strictQualityGate: true }),
    );

    const releaseIssues = [
      "/slides/0: evidence layout requires at least two evidence modules such as PDF figures, a chart, table, equation, matrix, or metrics.",
    ];
    assert.deepEqual(
      filterBlockingPresentationQualityIssues(
        releaseIssues,
        shouldUseStrictPresentationQualityGate(),
      ),
      [],
    );
  });

  it("does not turn future production planning diagnostics into accidental export blockers", function () {
    const futureDiagnostic = [
      "/slides/1: a newly added presentation-quality rule failed.",
    ];

    assert.deepEqual(
      filterBlockingPresentationQualityIssues(
        futureDiagnostic,
        shouldUseStrictPresentationQualityGate(),
      ),
      [],
    );
  });

  it("blocks only deterministic native-object data-shape failures in production", function () {
    const structuralIssues = [
      "/slides/0/chart: labels and values must have the same length.",
      "/slides/1/figures/0/crop: x+width and y+height must stay within 1.",
      "/slides/2/matrix: every row must contain exactly one cell per column.",
    ];
    const layoutPreferences = [
      "/slides/3: process layout requires process steps.",
      "/slides/4: statement layout cannot hide supplied visual evidence. Use auto, figure, data, process, matrix, timeline, comparison, gallery, ablation, or conclusion.",
      "/slides/5: gallery layout supports exactly two dominant paper figures. More figures create thumbnail grids instead of an editorial comparison.",
      "/slides/6: conclusion uses a fixed editorial structure: three findings, two open questions or limitations, and a three-to-four-step roadmap.",
    ];

    assert.deepEqual(
      filterBlockingPresentationQualityIssues(
        [...structuralIssues, ...layoutPreferences],
        false,
      ),
      structuralIssues,
    );
  });

  it("compresses dense evidence groups and expands numbered Terra conclusions", function () {
    const normalized = normalizePresentationRequestInput({
      title: "AlexNet",
      slides: [
        {
          title: "快速优化与正则化共同解决训练和过拟合",
          layout: "evidence",
          keyMessage:
            "ReLU达到25%训练误差快6倍；配合Dropout与数据增强抑制过拟合。",
          groups: [
            {
              title: "让大网络训练得动",
              bullets: ["ReLU加速收敛", "双GPU扩大容量", "第三条会被压缩"],
            },
            {
              title: "让大网络不过拟合",
              bullets: ["随机裁剪与翻转", "PCA颜色扰动", "Dropout抑制共适应"],
            },
            {
              title: "多余分组",
              bullets: ["不应进入窄栏"],
            },
          ],
          figure: { page: 3, captionHint: "Figure 1:" },
          metrics: [{ value: "6×", label: "更快" }],
        },
        {
          title: "AlexNet证明了深度、数据与算力的协同价值",
          layout: "conclusion",
          groups: [
            {
              title: "三项可复用的结论",
              bullets: [
                "01 大型监督式深度CNN可在高难度ImageNet上取得破纪录结果。 · 02 深度不可替代：移除任一中间卷积层，Top-1性能约损失2%。 · 03 扩大网络仍受GPU内存，训练时间与匹配标注数据的共同约束。",
              ],
            },
          ],
          figure: { page: 8, captionHint: "Figure 4:" },
        },
      ],
    }) as any;

    assert.lengthOf(normalized.slides[0].groups, 2);
    assert.deepEqual(
      normalized.slides[0].groups.map((group: any) => group.bullets.length),
      [2, 2],
    );
    assert.lengthOf(normalized.slides[1].groups, 3);
    assert.include(normalized.slides[1].groups[0].title, "大型监督式深度CNN");
    assert.equal(normalized.slides[1].groups[1].title, "深度不可替代");
    assert.include(normalized.slides[1].groups[2].title, "扩大网络仍受GPU内存");
  });

  it("keeps only fields rendered by split and summary layouts", function () {
    const figure = { page: 3, captionHint: "Figure 1:" };
    const normalized = normalizePresentationRequestInput({
      title: "Layout whitelist",
      slides: [
        {
          title: "Split",
          layout: "split",
          figure,
          bullets: ["Visible bullet"],
          keyMessage: "Visible message",
          groups: [{ title: "Hidden group", bullets: ["Hidden"] }],
          metrics: [{ value: "60M", label: "Hidden metric" }],
          process: [{ title: "Hidden process" }],
          callouts: [{ text: "Hidden callout" }],
        },
        {
          title: "Summary",
          layout: "summary",
          figure,
          bullets: ["Visible finding"],
          metrics: [{ value: "17%", label: "Visible metric" }],
          groups: [{ title: "Hidden group", bullets: ["Hidden"] }],
          process: [{ title: "Hidden process" }],
          callouts: [{ text: "Hidden callout" }],
        },
      ],
    }) as any;

    assert.deepEqual(normalized.slides[0].figure, figure);
    assert.notProperty(normalized.slides[0], "bullets");
    assert.equal(normalized.slides[0].keyMessage, "Visible message");
    assert.notProperty(normalized.slides[0], "groups");
    assert.notProperty(normalized.slides[0], "metrics");
    assert.notProperty(normalized.slides[0], "process");
    assert.notProperty(normalized.slides[0], "callouts");
    assert.deepEqual(normalized.slides[1].figure, figure);
    assert.deepEqual(normalized.slides[1].bullets, ["Visible finding"]);
    assert.deepEqual(normalized.slides[1].metrics, [
      { value: "17%", label: "Visible metric" },
    ]);
    assert.notProperty(normalized.slides[1], "groups");
    assert.notProperty(normalized.slides[1], "process");
    assert.notProperty(normalized.slides[1], "callouts");
  });

  it("rejects malformed specifications before touching the Zotero runtime", async function () {
    const missingSlides = await executePresentationCapability({
      title: "Missing slides",
      slides: null,
    });
    const mismatchedChart = await executePresentationCapability({
      title: "Bad chart",
      slides: [
        {
          title: "Slide",
          chart: {
            type: "bar",
            labels: ["A", "B"],
            values: [1],
          },
        },
      ],
    });
    const mismatchedTable = await executePresentationCapability({
      title: "Bad table",
      slides: [
        {
          title: "Slide",
          table: {
            headers: ["A", "B"],
            rows: [["only one cell"]],
          },
        },
      ],
    });

    assert.match(missingSlides, /^Error: Invalid presentation specification/);
    assert.include(missingSlides, "slides");
    assert.include(mismatchedChart, "labels and values");
    assert.include(mismatchedTable, "header count");
  });

  it("rejects text-wall decks and duplicate covers before rendering", async function () {
    const result = await executePresentationCapability(
      {
        title: "CRA Module Presentation",
        sourceItemKey: "VJLWMUKJ",
        slides: [
          {
            title: "CRA Module Presentation",
            bullets: ["Background", "Method", "Results"],
          },
          { title: "Method", bullets: ["A", "B"] },
          { title: "Results", bullets: ["A", "B"] },
          { title: "Conclusion", bullets: ["A", "B"] },
        ],
      },
      undefined,
      undefined,
      undefined,
      undefined,
      { strictQualityGate: true },
    );

    assert.match(result, /^Error: Presentation quality gate rejected/);
    assert.include(result, "must not duplicate the automatic cover");
    assert.include(result, "visual evidence");
    assert.include(result, "at least three real PDF figure placements");
  });

  it("enforces medium-density academic evidence without banning mixed visuals", function () {
    const errors = validatePresentationQuality({
      title: "Channel Reassessment Attention",
      sourceItemKey: "VJLWMUKJ",
      coverFigure: { page: 1, captionHint: "Fig. 0" },
      coverMetrics: [
        { value: "+1.47", label: "accuracy gain" },
        { value: "0", label: "extra inference cost" },
      ],
      slides: [
        {
          title: "Global pooling removes spatial evidence",
          layout: "comparison",
          comparison: {
            left: {
              title: "Global pooling",
              bullets: ["Spatial evidence collapses", "Weights stay uniform"],
            },
            right: {
              title: "Channel reassessment",
              bullets: ["Position remains visible", "Weights adapt by channel"],
            },
          },
          metrics: [{ value: "+1.47", label: "accuracy gain" }],
        },
        {
          title: "CRA restores position-sensitive channel weights",
          layout: "process",
          process: [
            { title: "Compress" },
            { title: "Reassess" },
            { title: "Refine" },
          ],
          figure: { page: 2, captionHint: "Fig. 1" },
        },
        {
          title: "The visual task adds one lightweight reassessment step",
          layout: "evidence",
          figures: [
            { page: 3, captionHint: "Fig. 2" },
            { page: 6, captionHint: "Fig. 6" },
          ],
        },
        {
          title: "Accuracy improves without extra inference cost",
          layout: "data",
          chart: {
            type: "bar",
            labels: ["Baseline", "CRA"],
            values: [21.3, 22.77],
          },
        },
        {
          title: "Evidence is positive while scale remains open",
          layout: "conclusion",
          groups: [
            { title: "Accuracy", bullets: ["CRA improves the baseline"] },
            { title: "Efficiency", bullets: ["Inference cost stays flat"] },
            { title: "Generality", bullets: ["Multiple datasets improve"] },
          ],
          callouts: [
            { label: "Open question", text: "Does the gain hold at scale?" },
            { label: "Limit", text: "Can transfer remain efficient?" },
          ],
          timeline: [
            { label: "ImageNet" },
            { label: "CIFAR" },
            { label: "Larger scale" },
          ],
        },
      ],
    });

    assert.deepEqual(errors, []);
  });

  it("asks the planner to complete a compact academic ablation table with paper evidence", function () {
    const errors = validatePresentationQuality({
      title: "Evidence allocation",
      sourceItemKey: "PAPER001",
      designSystem: "teal-green-academic-defense",
      coverFigure: { page: 1, captionHint: "Figure 0: Cover sample" },
      coverMetrics: [
        { value: "1.2M", label: "training images" },
        { value: "60M", label: "parameters" },
      ],
      slides: [
        {
          title: "The research gap is measurable",
          layout: "comparison",
          comparison: {
            left: { title: "Before", bullets: ["Small-scale evidence"] },
            right: { title: "After", bullets: ["Large-scale evidence"] },
          },
        },
        {
          title: "The method scales the representation",
          layout: "process",
          process: [
            { title: "Input" },
            { title: "Encode" },
            { title: "Predict" },
          ],
          figure: { page: 2, captionHint: "Figure 1: Architecture" },
        },
        {
          title: "Optimization improves convergence",
          layout: "figure",
          figure: { page: 3, captionHint: "Figure 2: Training curves" },
        },
        {
          title: "Each component reduces error",
          layout: "ablation",
          table: {
            headers: ["Component", "Top-1", "Top-5"],
            rows: [
              ["GPU split", "-1.7", "-1.2"],
              ["Normalization", "-1.4", "-1.2"],
              ["Overlap pooling", "-0.4", "-0.3"],
            ],
          },
          callouts: [{ text: "The controls are not additive." }],
        },
        {
          title: "The evidence supports three conclusions",
          layout: "conclusion",
          groups: [
            { title: "Finding one", bullets: ["Evidence one"] },
            { title: "Finding two", bullets: ["Evidence two"] },
            { title: "Finding three", bullets: ["Evidence three"] },
          ],
          callouts: [
            { text: "Open question one" },
            { text: "Open question two" },
          ],
          timeline: [
            { label: "Reproduce" },
            { label: "Extend" },
            { label: "Validate" },
          ],
        },
      ],
    } as any);

    assert.include(
      errors.join("\n"),
      "a compact academic ablation table needs one distinct non-table PDF figure",
    );
    assert.include(
      errors.join("\n"),
      "Reserve content evidence before choosing the cover hero",
    );
  });

  it("requires five content slides after a nested figure identifies a paper deck", function () {
    const normalized = normalizePresentationRequestInput({
      title: "Short paper deck",
      coverFigure: {
        itemKey: "VJLWMUKJ",
        page: 2,
        captionHint: "Figure 1:",
      },
      slides: Array.from({ length: 4 }, (_, index) => ({
        title: `Evidence claim ${index + 1}`,
        layout: "figure",
        figure: {
          itemKey: "VJLWMUKJ",
          page: index + 2,
          captionHint: `Figure ${index + 1}:`,
        },
      })),
    });
    const errors = validatePresentationQuality(normalized as any);

    assert.include(errors.join("\n"), "exactly five content slides");
  });

  it("rejects dense training plots outside a dedicated figure composition", function () {
    const galleryErrors = validatePresentationQuality({
      title: "Readable plot composition",
      slides: [
        {
          title: "Training dynamics separate the optimizers",
          layout: "gallery",
          keyMessage: "Axis labels must remain readable.",
          figures: [
            { page: 4, captionHint: "Figure 1: Training error curves" },
            { page: 5, captionHint: "Figure 2: CNN architecture" },
          ],
        },
      ],
    });
    const ablationErrors = validatePresentationQuality({
      title: "Readable ablation composition",
      slides: [
        {
          title: "A training curve cannot become a corner thumbnail",
          layout: "ablation",
          chart: {
            type: "bar",
            labels: ["Baseline", "AlexNet"],
            values: [25.8, 16.4],
          },
          figure: { page: 4, captionHint: "Figure 1: Training error curves" },
          callouts: [{ text: "The result remains traceable to the paper." }],
        },
      ],
    });

    assert.include(
      galleryErrors.join("\n"),
      "must use the dedicated figure layout",
    );
    assert.include(
      ablationErrors.join("\n"),
      "cannot be a gallery panel, ablation support",
    );
  });

  it("rejects layouts that would intentionally hide supplied evidence", function () {
    const errors = validatePresentationQuality({
      title: "Hidden evidence",
      slides: [
        {
          title: "A statement must not discard its figure",
          layout: "statement",
          figure: { itemKey: "VJLWMUKJ", page: 2, captionHint: "Fig. 1" },
        },
      ],
    });

    assert.include(errors.join("\n"), "cannot hide supplied visual evidence");
  });

  it("rejects editorial layouts when their dominant evidence is missing", function () {
    const base = {
      title: "Editorial validation",
      slides: [
        { title: "Valid visual", metrics: [{ value: "1", label: "x" }] },
      ],
    };
    const gallery = validatePresentationQuality({
      ...base,
      slides: [{ title: "Gallery", layout: "gallery" }],
    });
    const ablation = validatePresentationQuality({
      ...base,
      slides: [
        { title: "Ablation", layout: "ablation", bullets: ["Text only"] },
      ],
    });
    const conclusion = validatePresentationQuality({
      ...base,
      slides: [{ title: "Conclusion", layout: "conclusion" }],
    });

    assert.include(gallery.join("\n"), "gallery layout requires at least two");
    assert.include(ablation.join("\n"), "ablation layout requires");
    assert.include(conclusion.join("\n"), "conclusion layout requires");
  });

  it("rejects rasterized table heroes and dense editable ablation tables", function () {
    const galleryErrors = validatePresentationQuality({
      title: "Table screenshot gallery",
      slides: [
        {
          title: "Screenshots do not become visual evidence",
          layout: "gallery",
          keyMessage: "Rebuild the result as editable evidence.",
          figures: [
            { page: 4, captionHint: "Table 1: Main comparison" },
            { page: 5, captionHint: "Table 2: Ablation results" },
          ],
        },
      ],
    });
    const ablationErrors = validatePresentationQuality({
      title: "Dense ablation",
      slides: [
        {
          title: "One result should own the canvas",
          layout: "ablation",
          table: {
            headers: ["Model", "Top-1", "Top-5", "Params", "Compute"],
            rows: Array.from({ length: 6 }, (_, index) => [
              `Variant ${index + 1}`,
              "1",
              "2",
              "3",
              "4",
            ]),
          },
        },
      ],
    });

    assert.include(
      galleryErrors.join("\n"),
      "rasterized paper tables cannot be the primary visual",
    );
    assert.include(ablationErrors.join("\n"), "ablation table is too dense");
  });

  it("rejects layout combinations that would leave the primary canvas empty or hide supplied fields", function () {
    const timelineOnly = validatePresentationQuality({
      title: "Timeline-only ending",
      slides: [
        {
          title: "Conclusion",
          layout: "conclusion",
          timeline: [{ label: "A" }, { label: "B" }, { label: "C" }],
        },
      ],
    });
    const overloadedAblation = validatePresentationQuality({
      title: "Overloaded result",
      slides: [
        {
          title: "Result",
          layout: "ablation",
          chart: { type: "bar", labels: ["A"], values: [1] },
          table: { headers: ["A"], rows: [["1"]] },
        },
      ],
    });
    const underfilledFigureRail = validatePresentationQuality({
      title: "Underfilled evidence rail",
      slides: [
        {
          title: "ReLU reaches the same error six times faster",
          layout: "figure",
          figure: { page: 3, captionHint: "Figure 1:" },
          keyMessage: "The curve proves faster optimization.",
        },
      ],
    });

    assert.include(timelineOnly.join("\n"), "primary canvas empty");
    assert.include(
      overloadedAblation.join("\n"),
      "one dominant chart or table",
    );
    assert.include(
      underfilledFigureRail.join("\n"),
      "figure narrative rail cannot contain only one sentence",
    );
  });

  it("rejects a paper deck that repeats one composition on every slide", function () {
    const errors = validatePresentationQuality({
      title: "Repeated template",
      sourceItemKey: "VJLWMUKJ",
      slides: Array.from({ length: 5 }, (_, index) => ({
        title: `Claim ${index + 1} is supported by evidence`,
        layout: "evidence" as const,
        figure: { page: index + 1, captionHint: `Figure ${index + 1}` },
        equation: { expression: `x_${index + 1} = y_${index + 1}` },
      })),
    });

    assert.include(errors.join("\n"), "composition silhouette");
  });

  it("rejects full PDF pages and oversized claim titles in research decks", function () {
    const errors = validatePresentationQuality({
      title: "Research deck",
      sourceItemKey: "VJLWMUKJ",
      coverFigure: { page: 1, mode: "page" },
      slides: [
        {
          title:
            "This deliberately oversized academic claim title consumes the canvas before any evidence can be seen",
          layout: "gallery",
          figures: [
            { page: 2, mode: "page" },
            { page: 3, captionHint: "Figure 2:" },
          ],
        },
        {
          title: "Method evidence stays visible",
          layout: "process",
          process: [{ title: "Read" }, { title: "Train" }, { title: "Test" }],
          figure: { page: 4, captionHint: "Figure 3:" },
        },
        {
          title: "Results improve against the baseline",
          layout: "data",
          chart: { type: "bar", labels: ["A", "B"], values: [1, 2] },
          figure: { page: 5, captionHint: "Figure 4:" },
        },
        {
          title: "Open questions shape the next experiments",
          layout: "conclusion",
          groups: [{ title: "Finding", bullets: ["Supported"] }],
          timeline: [{ label: "A" }, { label: "B" }, { label: "C" }],
        },
      ],
    });

    assert.include(errors.join("\n"), "full PDF pages are not acceptable");
    assert.include(errors.join("\n"), "claim title is too long");
  });

  it("enforces unique figures, language consistency, a structured gap, and a complete conclusion", function () {
    const figure = (number: number, crop?: any) => ({
      page: number,
      captionHint: `Figure ${number}:`,
      crop,
    });
    const validDeck: any = {
      title: "A learned hierarchy changes large-scale vision",
      sourceItemKey: "VJLWMUKJ",
      coverFigure: figure(1),
      coverMetrics: [
        { value: "1.2M", label: "training images" },
        { value: "60M", label: "parameters" },
        { value: "−10.9 pt", label: "top-5 error gap" },
      ],
      slides: [
        {
          title: "Fixed features leave a measurable accuracy gap",
          layout: "comparison",
          comparison: {
            left: {
              title: "Handcrafted pipeline",
              bullets: ["Features are fixed", "Top-5 error is 26.2%"],
            },
            right: {
              title: "Learned hierarchy",
              bullets: ["Features train end to end", "Top-5 error is 15.3%"],
            },
          },
          metrics: [{ value: "−10.9 pt", label: "error gap" }],
        },
        {
          title: "Two GPUs make the deep architecture trainable",
          layout: "process",
          process: [{ title: "Input" }, { title: "Conv" }, { title: "Output" }],
          figure: figure(2),
        },
        {
          title: "Faster optimization preserves useful learned structure",
          layout: "evidence",
          figure: figure(3),
          figures: [figure(4)],
          equation: { expression: "f(x) = max(0, x)" },
        },
        {
          title: "The benchmark lead remains decisive under comparison",
          layout: "ablation",
          chart: {
            type: "bar",
            labels: ["AlexNet", "Previous best"],
            values: [15.3, 26.2],
          },
          groups: [
            { title: "Evidence", bullets: ["The gap is large"] },
            { title: "Limit", bullets: ["Ensembling costs compute"] },
          ],
        },
        {
          title: "Three findings define the next research direction",
          layout: "conclusion",
          groups: [
            { title: "Learn features", bullets: ["End-to-end learning wins"] },
            { title: "Train at scale", bullets: ["GPU capacity matters"] },
            {
              title: "Prove the gain",
              bullets: ["The benchmark gap is clear"],
            },
          ],
          callouts: [
            { label: "Open question", text: "Can deeper models cost less?" },
            { label: "Limit", text: "Does transfer hold beyond ImageNet?" },
          ],
          timeline: [
            { label: "Scale" },
            { label: "Transfer" },
            { label: "Video" },
          ],
        },
      ],
    };

    assert.deepEqual(validatePresentationQuality(validDeck), []);

    const sparseCover = structuredClone(validDeck);
    delete sparseCover.coverMetrics;
    assert.include(
      validatePresentationQuality(sparseCover).join("\n"),
      "requires two or three paper-grounded cover metrics",
    );

    const weakLateEvidence = structuredClone(validDeck);
    weakLateEvidence.slides[3] = {
      title: "A second figure repeats interpretation without a result view",
      layout: "figure",
      figure: figure(5),
    };
    assert.include(
      validatePresentationQuality(weakLateEvidence).join("\n"),
      "experimental or ablation half of a full paper deck",
    );

    const longCaptionGallery = structuredClone(validDeck);
    const longCaption =
      "Figure 3. This deliberately long original-language paper caption describes the complete experiment, dataset, architecture, optimization schedule, and evaluation protocol in source form.";
    longCaptionGallery.slides[2] = {
      title: "Two paper figures carry the optimization evidence",
      layout: "gallery",
      keyMessage:
        "The visible narrative stays concise while source captions remain traceable.",
      figures: [
        { page: 3, caption: longCaption, captionHint: longCaption },
        {
          page: 4,
          caption: longCaption.replace("Figure 3", "Figure 4"),
          captionHint: longCaption.replace("Figure 3", "Figure 4"),
        },
      ],
    };
    assert.notInclude(
      validatePresentationQuality(longCaptionGallery).join("\n"),
      "visible characters exceed",
    );

    const repeated = structuredClone(validDeck);
    repeated.slides[1].figure = figure(1);
    assert.include(
      validatePresentationQuality(repeated).join("\n"),
      "repeats the same paper Figure/Table",
    );

    const repeatedInsideGallery = structuredClone(validDeck);
    repeatedInsideGallery.slides[2].figures = [figure(3)];
    assert.include(
      validatePresentationQuality(repeatedInsideGallery).join("\n"),
      "repeats the same paper Figure/Table",
    );

    const nonOverlappingCrops = structuredClone(validDeck);
    nonOverlappingCrops.coverFigure = figure(1, {
      x: 0,
      y: 0,
      width: 0.45,
      height: 1,
    });
    nonOverlappingCrops.slides[1].figure = figure(1, {
      x: 0.55,
      y: 0,
      width: 0.45,
      height: 1,
    });
    assert.notInclude(
      validatePresentationQuality(nonOverlappingCrops).join("\n"),
      "repeats the same paper Figure/Table",
    );

    const mixedLanguage = structuredClone(validDeck);
    mixedLanguage.slides[2].title = "快速优化与正则化共同解决训练问题";
    assert.include(
      validatePresentationQuality(mixedLanguage).join("\n"),
      "otherwise English deck switches to a Chinese slide title",
    );

    const weakGap = structuredClone(validDeck);
    delete weakGap.slides[0].comparison;
    weakGap.slides[0].metrics = [{ value: "1.2M", label: "images" }];
    assert.include(
      validatePresentationQuality(weakGap).join("\n"),
      "research problem and gap must use structured comparison evidence",
    );

    const weakConclusion = structuredClone(validDeck);
    weakConclusion.slides[4].groups = [
      { title: "Summary", bullets: ["All findings in one block"] },
    ];
    weakConclusion.slides[4].callouts = [
      { label: "Limit", text: "Compute remains expensive." },
    ];
    delete weakConclusion.slides[4].timeline;
    const conclusionErrors =
      validatePresentationQuality(weakConclusion).join("\n");
    assert.include(conclusionErrors, "three distinct findings");
    assert.include(conclusionErrors, "at least two open questions");
    assert.include(
      conclusionErrors,
      "paper-grounded three-to-four-step roadmap timeline",
    );
  });

  it("returns a clear error when the lazy renderer bundle is unavailable", async function () {
    const runtime = globalThis as any;
    const previousZotero = runtime.Zotero;
    const previousServices = runtime.Services;
    const target: Record<string, unknown> = {};
    runtime.Zotero = { getMainWindow: () => target };
    runtime.Services = {
      scriptloader: { loadSubScript: () => undefined },
    };

    try {
      resetPresentationRendererForTests();
      const result = await executePresentationCapability(VALID_REQUEST);
      assert.match(result, /^Error: Presentation generation failed/);
      assert.include(result, "loaded without its public API");
    } finally {
      resetPresentationRendererForTests();
      runtime.Zotero = previousZotero;
      runtime.Services = previousServices;
    }
  });

  it("promotes a dense plot to a dedicated figure slide without destroying the first gap slide", function () {
    const denseGapFigure = {
      page: 3,
      captionHint: "Figure 1. Training error curves",
      caption: "图 1：训练误差曲线",
    };
    const denseEvidenceFigure = {
      page: 4,
      captionHint: "Figure 2. Validation loss curves",
      caption: "图 2：验证损失曲线",
    };
    const architectureFigure = {
      page: 5,
      captionHint: "Figure 3. AlexNet architecture",
      caption: "图 3：AlexNet 网络结构",
    };
    const qualitativeFigure = {
      page: 6,
      captionHint: "Figure 4. Qualitative results",
      caption: "图 4：定性结果",
    };
    const normalized = normalizePresentationRequestInput({
      title: "AlexNet 论文精读",
      sourceItemKey: "SBZ2M99R",
      coverFigure: {
        page: 7,
        captionHint: "Figure 5. Learned features",
      },
      slides: [
        {
          layout: "matrix",
          title: "研究缺口来自规模与算力的不匹配",
          matrix: {
            columns: ["传统方法", "AlexNet"],
            rows: [
              { label: "训练规模", cells: ["受限", "百万级"] },
              { label: "计算平台", cells: ["CPU", "GPU"] },
            ],
          },
          figure: denseGapFigure,
        },
        {
          layout: "evidence",
          title: "优化曲线显示训练过程稳定收敛",
          keyMessage: "曲线是本页的核心证据。",
          metrics: [{ value: "5", label: "卷积层" }],
          figure: denseEvidenceFigure,
        },
        {
          layout: "process",
          title: "网络结构将卷积与全连接层串联",
          process: [{ title: "卷积" }, { title: "池化" }, { title: "分类" }],
          figure: architectureFigure,
        },
        {
          layout: "ablation",
          title: "定性结果揭示模型学到可迁移表征",
          chart: {
            type: "bar",
            labels: ["基线", "AlexNet"],
            values: [1, 2],
          },
          figure: qualitativeFigure,
          callouts: [{ text: "结果与论文观察一致。" }],
        },
        {
          layout: "conclusion",
          title: "结论与后续研究方向",
          groups: [
            { title: "发现一", bullets: ["规模有效"] },
            { title: "发现二", bullets: ["深度有效"] },
            { title: "发现三", bullets: ["GPU 有效"] },
          ],
          callouts: [
            { text: "如何进一步扩展？" },
            { text: "泛化边界在哪里？" },
          ],
          timeline: [
            { label: "近期", milestone: "复现" },
            { label: "中期", milestone: "扩展" },
            { label: "长期", milestone: "迁移" },
          ],
        },
      ],
    }) as any;

    assert.equal(normalized.slides[0].layout, "matrix");
    assert.property(normalized.slides[0], "matrix");
    assert.notProperty(normalized.slides[0], "figure");
    assert.equal(normalized.slides[1].layout, "figure");
    assert.deepEqual(normalized.slides[1].figure, denseEvidenceFigure);
    assert.notProperty(normalized.slides[1], "metrics");
    assert.notInclude(
      validatePresentationQuality(normalized).join("\n"),
      "chart-like paper figure",
    );
  });

  it("recovers an anchored paper figure that layout canonicalization would otherwise discard", function () {
    const gapCandidate = {
      page: 3,
      captionHint: "Figure 1. GPU implementation",
      caption: "图 1：GPU 实现",
    };
    const methodFigure = {
      page: 4,
      captionHint: "Figure 2. AlexNet architecture",
      caption: "图 2：AlexNet 网络结构",
    };
    const resultFigure = {
      page: 5,
      captionHint: "Figure 3. Qualitative results",
      caption: "图 3：定性结果",
    };
    const normalized = normalizePresentationRequestInput({
      title: "AlexNet 论文精读",
      sourceItemKey: "SBZ2M99R",
      coverFigure: {
        page: 6,
        captionHint: "Figure 4. Learned features",
      },
      slides: [
        {
          layout: "comparison",
          title: "GPU 训练打破传统规模瓶颈",
          comparison: {
            left: { title: "传统训练", bullets: ["规模受限"] },
            right: { title: "GPU 训练", bullets: ["并行扩展"] },
          },
          figure: gapCandidate,
        },
        {
          layout: "process",
          title: "网络结构形成端到端特征层级",
          process: [{ title: "卷积" }, { title: "池化" }, { title: "分类" }],
          figure: methodFigure,
        },
        {
          layout: "evidence",
          title: "并行训练与网络深度共同提升效果",
          chart: {
            type: "bar",
            labels: ["基线", "AlexNet"],
            values: [1, 2],
          },
          metrics: [{ value: "2", label: "GPU" }],
          keyMessage: "两个机制共同支撑规模化训练。",
        },
        {
          layout: "figure",
          title: "定性结果展示可辨识视觉表征",
          figure: resultFigure,
        },
        {
          layout: "conclusion",
          title: "结论与后续研究方向",
          groups: [
            { title: "发现一", bullets: ["规模有效"] },
            { title: "发现二", bullets: ["深度有效"] },
            { title: "发现三", bullets: ["GPU 有效"] },
          ],
          callouts: [
            { text: "如何进一步扩展？" },
            { text: "泛化边界在哪里？" },
          ],
          timeline: [
            { label: "近期", milestone: "复现" },
            { label: "中期", milestone: "扩展" },
            { label: "长期", milestone: "迁移" },
          ],
        },
      ],
    }) as any;

    const contentFigures = normalized.slides.flatMap((slide: any) => [
      ...(slide.figure ? [slide.figure] : []),
      ...(slide.figures || []),
    ]);
    assert.lengthOf(contentFigures, 3);
    assert.deepInclude(contentFigures, gapCandidate);
    assert.equal(normalized.slides[0].layout, "comparison");
    assert.notProperty(normalized.slides[0], "figure");
    assert.deepEqual(normalized.slides[2].figure, gapCandidate);
    assert.notInclude(
      validatePresentationQuality(normalized).join("\n"),
      "at least three real PDF figure placements",
    );
  });

  it("does not invent paper figures when the planner supplied only two trusted candidates", function () {
    const normalized = normalizePresentationRequestInput({
      title: "AlexNet 论文精读",
      sourceItemKey: "SBZ2M99R",
      coverFigure: {
        page: 6,
        captionHint: "Figure 4. Learned features",
      },
      slides: [
        {
          layout: "matrix",
          title: "研究缺口来自规模瓶颈",
          matrix: {
            columns: ["传统方法", "AlexNet"],
            rows: [
              { label: "规模", cells: ["小", "大"] },
              { label: "算力", cells: ["CPU", "GPU"] },
            ],
          },
        },
        {
          layout: "process",
          title: "网络结构形成层级表征",
          process: [{ title: "卷积" }, { title: "池化" }, { title: "分类" }],
          figure: {
            page: 4,
            captionHint: "Figure 2. AlexNet architecture",
          },
        },
        {
          layout: "evidence",
          title: "实验结果支持规模化训练",
          chart: { type: "bar", labels: ["A", "B"], values: [1, 2] },
          metrics: [{ value: "2", label: "GPU" }],
        },
        {
          layout: "figure",
          title: "定性结果展示视觉表征",
          figure: {
            page: 5,
            captionHint: "Figure 3. Qualitative results",
          },
        },
        {
          layout: "conclusion",
          title: "结论与后续研究方向",
          groups: [
            { title: "发现一", bullets: ["规模有效"] },
            { title: "发现二", bullets: ["深度有效"] },
            { title: "发现三", bullets: ["GPU 有效"] },
          ],
          callouts: [
            { text: "如何进一步扩展？" },
            { text: "泛化边界在哪里？" },
          ],
          timeline: [
            { label: "近期", milestone: "复现" },
            { label: "中期", milestone: "扩展" },
            { label: "长期", milestone: "迁移" },
          ],
        },
      ],
    }) as any;

    const contentFigures = normalized.slides.flatMap((slide: any) => [
      ...(slide.figure ? [slide.figure] : []),
      ...(slide.figures || []),
    ]);
    assert.lengthOf(contentFigures, 2);
    assert.include(
      validatePresentationQuality(normalized).join("\n"),
      "at least three real PDF figure placements; found 2",
    );
  });

  it("reloads the isolated renderer bundle and clones requests into its realm", async function () {
    const runtime = globalThis as any;
    const previousZotero = runtime.Zotero;
    const previousServices = runtime.Services;
    const previousComponents = runtime.Components;
    const target: Record<string, unknown> = {};
    const loadedUrls: string[] = [];
    const rendererInputs: unknown[] = [];
    const cloneTargets: unknown[] = [];
    let generation = 0;
    runtime.Zotero = { getMainWindow: () => target };
    runtime.Services = {
      scriptloader: {
        loadSubScript: (url: string) => {
          loadedUrls.push(url);
          generation += 1;
          target[PRESENTATION_RENDERER_GLOBAL] = {
            generation,
            renderPresentation: async (serializedSpec: unknown) => {
              rendererInputs.push(serializedSpec);
              return new Uint8Array();
            },
          };
        },
      },
    };
    runtime.Components = {
      utils: {
        cloneInto: (value: unknown, cloneTarget: unknown) => {
          cloneTargets.push(cloneTarget);
          return JSON.parse(JSON.stringify(value));
        },
      },
    };

    try {
      const first = getPresentationRenderer() as any;
      const firstGeneration = (target[PRESENTATION_RENDERER_GLOBAL] as any)
        .generation;
      const second = getPresentationRenderer() as any;
      const secondGeneration = (target[PRESENTATION_RENDERER_GLOBAL] as any)
        .generation;
      assert.equal(firstGeneration, 1);
      assert.equal(secondGeneration, 2);
      assert.isFunction(first.renderPresentation);
      assert.isFunction(second.renderPresentation);
      await first.renderPresentation({ title: "Boundary probe", slides: [] });
      assert.deepEqual(rendererInputs, [
        { title: "Boundary probe", slides: [] },
      ]);
      assert.deepEqual(cloneTargets, [target]);
      assert.lengthOf(loadedUrls, 2);
      assert.match(loadedUrls[0], /paperchat-ppt-renderer\.js\?paperchat=/);
    } finally {
      resetPresentationRendererForTests();
      runtime.Zotero = previousZotero;
      runtime.Services = previousServices;
      runtime.Components = previousComponents;
    }
  });

  it("contains renderer failures without touching chat state", async function () {
    const runtime = globalThis as any;
    const previousZotero = runtime.Zotero;
    const previousServices = runtime.Services;
    const target: Record<string, unknown> = {
      [PRESENTATION_RENDERER_GLOBAL]: {
        renderPresentation: async () => {
          throw new Error("synthetic renderer failure");
        },
      },
    };
    runtime.Zotero = { getMainWindow: () => target };
    runtime.Services = {
      scriptloader: {
        loadSubScript: () => {
          target[PRESENTATION_RENDERER_GLOBAL] = {
            renderPresentation: async () => {
              throw new Error("synthetic renderer failure");
            },
          };
        },
      },
    };

    try {
      resetPresentationRendererForTests();
      const result = await executePresentationCapability(VALID_REQUEST);
      assert.include(result, "synthetic renderer failure");
    } finally {
      resetPresentationRendererForTests();
      runtime.Zotero = previousZotero;
      runtime.Services = previousServices;
    }
  });

  it("reports output failures without leaving a partial success result", async function () {
    const runtime = globalThis as any;
    const previousZotero = runtime.Zotero;
    const previousServices = runtime.Services;
    const previousIOUtils = runtime.IOUtils;
    const previousPathUtils = runtime.PathUtils;
    const target: Record<string, unknown> = {};
    runtime.Zotero = {
      DataDirectory: { dir: "/zotero-data" },
      getMainWindow: () => target,
    };
    runtime.Services = {
      scriptloader: {
        loadSubScript: () => {
          target[PRESENTATION_RENDERER_GLOBAL] = {
            renderPresentation: async () =>
              new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
          };
        },
      },
    };
    runtime.IOUtils = {
      makeDirectory: async () => {
        throw new Error("synthetic disk failure");
      },
    };
    runtime.PathUtils = {
      join: (...parts: string[]) => parts.join("/"),
      filename: (path: string) => path.split("/").pop(),
    };

    try {
      resetPresentationRendererForTests();
      const result = await executePresentationCapability(VALID_REQUEST);
      assert.match(result, /^Error: Presentation generation failed/);
      assert.include(result, "synthetic disk failure");
      assert.notInclude(result, '"status":"completed"');
    } finally {
      resetPresentationRendererForTests();
      runtime.Zotero = previousZotero;
      runtime.Services = previousServices;
      runtime.IOUtils = previousIOUtils;
      runtime.PathUtils = previousPathUtils;
    }
  });

  it("continues exporting when a presentation progress callback fails", async function () {
    const runtime = globalThis as any;
    const previousZotero = runtime.Zotero;
    const previousServices = runtime.Services;
    const previousIOUtils = runtime.IOUtils;
    const previousPathUtils = runtime.PathUtils;
    const target: Record<string, unknown> = {};
    const completedPhases: string[] = [];
    runtime.Zotero = {
      DataDirectory: { dir: "/zotero-data" },
      getMainWindow: () => target,
    };
    runtime.Services = {
      scriptloader: {
        loadSubScript: () => {
          target[PRESENTATION_RENDERER_GLOBAL] = {
            renderPresentation: async () =>
              new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
          };
        },
      },
    };
    runtime.IOUtils = {
      makeDirectory: async () => undefined,
      write: async () => undefined,
    };
    runtime.PathUtils = {
      join: (...parts: string[]) => parts.join("/"),
      filename: (path: string) => path.split("/").pop(),
    };

    try {
      resetPresentationRendererForTests();
      const result = await executePresentationCapability(
        VALID_REQUEST,
        undefined,
        undefined,
        undefined,
        async (update) => {
          if (update.pptxPath && update.isDraft) {
            throw new Error("synthetic checkpoint failure");
          }
          completedPhases.push(update.phase);
        },
      );
      const payload = JSON.parse(result);

      assert.equal(payload.status, "completed");
      assert.match(payload.path, /\.pptx$/u);
      assert.include(completedPhases, "completed");
    } finally {
      resetPresentationRendererForTests();
      runtime.Zotero = previousZotero;
      runtime.Services = previousServices;
      runtime.IOUtils = previousIOUtils;
      runtime.PathUtils = previousPathUtils;
    }
  });

  it("keeps the trusted library ID during duplicate-media repair", async function () {
    const runtime = globalThis as any;
    const previousZotero = runtime.Zotero;
    const previousServices = runtime.Services;
    const previousIOUtils = runtime.IOUtils;
    const previousPathUtils = runtime.PathUtils;
    const target: Record<string, unknown> = {};
    const libraryIDs: Array<number | undefined> = [];
    let resolveCalls = 0;
    runtime.Zotero = {
      DataDirectory: { dir: "/zotero-data" },
      getMainWindow: () => target,
    };
    runtime.Services = {
      scriptloader: {
        loadSubScript: () => {
          target[PRESENTATION_RENDERER_GLOBAL] = {
            renderPresentation: async () =>
              new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
          };
        },
      },
    };
    runtime.IOUtils = {
      makeDirectory: async () => undefined,
      write: async () => undefined,
    };
    runtime.PathUtils = {
      join: (...parts: string[]) => parts.join("/"),
      filename: (path: string) => path.split("/").pop(),
    };

    try {
      resetPresentationRendererForTests();
      const result = await executePresentationCapability(
        { sourceItemKey: "SHARED01" },
        undefined,
        async () => VALID_REQUEST as any,
        {
          metadata: { title: "Shared-library paper", year: 2026 },
          sections: [],
          fullText: "Synthetic evidence",
          pages: [],
          pageCount: 0,
        } as any,
        undefined,
        {
          mediaResolver: async (request, sourceLibraryID) => {
            libraryIDs.push(sourceLibraryID);
            resolveCalls += 1;
            if (resolveCalls === 1) {
              throw new PresentationResolvedMediaDuplicateError([
                "synthetic duplicate crop",
              ]);
            }
            return request as any;
          },
        },
        { itemKey: "SHARED01", libraryID: 5 },
      );
      const payload = JSON.parse(result);

      assert.oneOf(payload.status, ["completed", "completed_with_warnings"]);
      assert.deepEqual(libraryIDs, [5, 5]);
    } finally {
      resetPresentationRendererForTests();
      runtime.Zotero = previousZotero;
      runtime.Services = previousServices;
      runtime.IOUtils = previousIOUtils;
      runtime.PathUtils = previousPathUtils;
    }
  });

  it("returns the persisted PPTX when recovery attachment attempts throw", async function () {
    const runtime = globalThis as any;
    const previousZotero = runtime.Zotero;
    const previousServices = runtime.Services;
    const previousIOUtils = runtime.IOUtils;
    const previousPathUtils = runtime.PathUtils;
    const target: Record<string, unknown> = {};
    const writes: Array<{ path: string; bytes: Uint8Array }> = [];
    let attachmentAttempts = 0;
    const zotero = {
      DataDirectory: { dir: "/zotero-data" },
      getMainWindow: () => target,
    };
    Object.defineProperty(zotero, "Attachments", {
      get: () => {
        attachmentAttempts += 1;
        throw new Error("synthetic recovery attachment failure");
      },
    });
    runtime.Zotero = zotero;
    runtime.Services = {
      scriptloader: {
        loadSubScript: () => {
          target[PRESENTATION_RENDERER_GLOBAL] = {
            renderPresentation: async () =>
              new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
          };
        },
      },
    };
    runtime.IOUtils = {
      makeDirectory: async () => undefined,
      write: async (path: string, bytes: Uint8Array) => {
        writes.push({ path, bytes });
      },
    };
    runtime.PathUtils = {
      join: (...parts: string[]) => parts.join("/"),
      filename: (path: string) => path.split("/").pop(),
    };

    try {
      resetPresentationRendererForTests();
      const result = await executePresentationCapability(VALID_REQUEST);
      const payload = JSON.parse(result);
      const pptxWrite = writes.find(({ path }) => path.endsWith(".pptx"));

      assert.exists(pptxWrite);
      assert.equal(attachmentAttempts, 2);
      assert.equal(payload.status, "completed_with_warnings");
      assert.equal(payload.path, pptxWrite?.path);
      assert.equal(payload.draftPath, pptxWrite?.path);
      assert.equal(payload.attachmentStatus, "not_attached");
      assert.include(
        payload.attachmentWarning,
        "PPTX was generated and remains available",
      );
      assert.include(
        payload.attachmentWarning,
        "synthetic recovery attachment failure",
      );
    } finally {
      resetPresentationRendererForTests();
      runtime.Zotero = previousZotero;
      runtime.Services = previousServices;
      runtime.IOUtils = previousIOUtils;
      runtime.PathUtils = previousPathUtils;
    }
  });
});
