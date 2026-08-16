import { assert } from "chai";
import JSZip from "jszip";
import type { RenderablePresentationRequest } from "../src/modules/presentation/PresentationSchema.ts";
import { renderPresentation } from "../src/modules/presentation/renderer/PptxPresentationExporter.ts";
import {
  resolveLayout,
  resolveTheme,
} from "../src/modules/presentation/renderer/PresentationDesignSystem.ts";
import { applyDefaultFadeTransitionToSlideXml } from "../src/modules/presentation/renderer/PresentationPptxTransitions.ts";
import { resolvePresentationThemeBlueprint } from "../src/modules/presentation/renderer/PresentationThemeBlueprint.ts";
import {
  extractPictureExtents,
  verifyRenderedPresentation,
} from "../src/modules/presentation/renderer/PresentationRenderVerifier.ts";

const REQUIRED_ENTRIES = [
  "[Content_Types].xml",
  "ppt/presentation.xml",
  "ppt/slides/slide1.xml",
  "ppt/slides/slide2.xml",
  "ppt/notesSlides/notesSlide1.xml",
  "ppt/notesSlides/notesSlide2.xml",
] as const;

function normalizePresentationText(value: string): string {
  return value.replace(/[\u2060\ufeff]/g, "").replace(/\u00a0/g, " ");
}

function extractTextShapeExtent(
  xml: string,
  marker: string,
): { x: number; y: number; w: number; h: number } | undefined {
  const shape = Array.from(xml.matchAll(/<p:sp>[\s\S]*?<\/p:sp>/g)).find(
    (match) => normalizePresentationText(match[0]).includes(marker),
  )?.[0];
  if (!shape) return undefined;
  const offset = shape.match(/<a:off\s+x="(\d+)"\s+y="(\d+)"\s*\/>/);
  const extent = shape.match(/<a:ext\s+cx="(\d+)"\s+cy="(\d+)"\s*\/>/);
  if (!offset || !extent) return undefined;
  return {
    x: Number(offset[1]),
    y: Number(offset[2]),
    w: Number(extent[1]),
    h: Number(extent[2]),
  };
}

function extractGraphicFrameExtent(
  xml: string,
  marker: string,
): { x: number; y: number; w: number; h: number } | undefined {
  const frame = Array.from(
    xml.matchAll(/<p:graphicFrame>[\s\S]*?<\/p:graphicFrame>/g),
  ).find((match) => normalizePresentationText(match[0]).includes(marker))?.[0];
  if (!frame) return undefined;
  const offset = frame.match(/<a:off\s+x="(\d+)"\s+y="(\d+)"\s*\/>/);
  const extent = frame.match(/<a:ext\s+cx="(\d+)"\s+cy="(\d+)"\s*\/>/);
  if (!offset || !extent) return undefined;
  return {
    x: Number(offset[1]),
    y: Number(offset[2]),
    w: Number(extent[1]),
    h: Number(extent[2]),
  };
}

function extractLineShapeExtentByColor(
  xml: string,
  color: string,
): { x: number; y: number; w: number; h: number } | undefined {
  const shape = Array.from(xml.matchAll(/<p:sp>[\s\S]*?<\/p:sp>/g)).find(
    (match) =>
      match[0].includes('<a:prstGeom prst="line">') &&
      match[0].includes(`<a:srgbClr val="${color}"`),
  )?.[0];
  if (!shape) return undefined;
  const offset = shape.match(/<a:off\s+x="(\d+)"\s+y="(\d+)"\s*\/>/);
  const extent = shape.match(/<a:ext\s+cx="(\d+)"\s+cy="(\d+)"\s*\/>/);
  if (!offset || !extent) return undefined;
  return {
    x: Number(offset[1]),
    y: Number(offset[2]),
    w: Number(extent[1]),
    h: Number(extent[2]),
  };
}

function extractSlideText(xml: string): string {
  return normalizePresentationText(
    Array.from(xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g), (match) =>
      match[1]
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">"),
    ).join(" "),
  );
}

describe("presentation PPTX exporter probe", function () {
  it("writes one root-level fade transition to every exported slide", async function () {
    const bytes = await renderPresentation({
      title: "Fade transition",
      slides: [{ title: "Evidence", keyMessage: "A grounded finding" }],
    });
    const archive = await JSZip.loadAsync(bytes);
    for (const path of ["ppt/slides/slide1.xml", "ppt/slides/slide2.xml"]) {
      const xml = await archive.files[path].async("string");
      assert.lengthOf(xml.match(/<p:transition\b/gu) || [], 1);
      assert.include(xml, '<p:transition spd="fast" advClick="1"><p:fade/>');
      const commonSlideEnd = xml.indexOf("</p:cSld>");
      const colorMapEnd = xml.indexOf("</p:clrMapOvr>");
      const transitionIndex = xml.indexOf("<p:transition");
      const timingIndex = xml.indexOf("<p:timing");
      const extensionIndex = xml.indexOf("<p:extLst");
      assert.isAbove(transitionIndex, Math.max(commonSlideEnd, colorMapEnd));
      if (timingIndex >= 0) assert.isBelow(transitionIndex, timingIndex);
      if (extensionIndex >= 0) assert.isBelow(transitionIndex, extensionIndex);
    }
  });

  it("replaces an existing transition without disturbing slide timing", function () {
    const xml =
      '<p:sld xmlns:p="p"><p:cSld><p:spTree/></p:cSld><p:clrMapOvr><p:masterClrMapping/></p:clrMapOvr><p:transition><p:push/></p:transition><p:timing><p:tnLst/></p:timing></p:sld>';
    const patched = applyDefaultFadeTransitionToSlideXml(xml);
    assert.lengthOf(patched.match(/<p:transition\b/gu) || [], 1);
    assert.include(patched, "<p:fade/>");
    assert.notInclude(patched, "<p:push/>");
    assert.isBelow(
      patched.indexOf("</p:clrMapOvr>"),
      patched.indexOf("<p:transition"),
    );
    assert.isBelow(
      patched.indexOf("<p:transition"),
      patched.indexOf("<p:timing"),
    );
  });

  it("resolves distinct palettes and blueprints for all academic presets", function () {
    const expectedAccents = {
      "teal-green-academic-defense": "009682",
      "blue-line-courseware": "4285F4",
      "deep-blue-atlas": "49B7D0",
      "paper-white-courseware": "F5987E",
      "pastel-derivation": "0064E0",
      "wine-red-data": "E69138",
    } as const;
    for (const [designSystem, accent] of Object.entries(expectedAccents)) {
      const request = {
        title: "Academic preset",
        designSystem: designSystem as keyof typeof expectedAccents,
        slides: [],
      };
      assert.equal(resolveTheme(request).accent, accent);
      assert.equal(resolvePresentationThemeBlueprint(request).id, designSystem);
    }
  });

  it("localizes renderer-owned labels from the resolved Zotero locale", async function () {
    const bytes = await renderPresentation({
      title: "论文解读",
      language: "zh-CN",
      slides: [
        {
          title: "结论与下一步研究",
          layout: "conclusion",
          groups: [
            { title: "主要发现一", bullets: ["论文证据支持该结论"] },
            { title: "主要发现二", bullets: ["方法改善了实验结果"] },
            { title: "主要发现三", bullets: ["局限仍需进一步验证"] },
          ],
          callouts: [
            { label: "开放问题", text: "结论能否推广到更大规模？" },
            { label: "局限", text: "计算成本能否进一步降低？" },
          ],
          timeline: [{ label: "复现" }, { label: "扩展" }, { label: "验证" }],
        },
      ],
    });

    const archive = await JSZip.loadAsync(bytes);
    const coverSlide =
      await archive.files["ppt/slides/slide1.xml"].async("string");
    const conclusionSlide =
      await archive.files["ppt/slides/slide2.xml"].async("string");
    const coverText = extractSlideText(coverSlide);
    const conclusionText = extractSlideText(conclusionSlide);

    assert.include(coverText, "PAPERCHAT · 研究简报");
    assert.notInclude(coverText, "RESEARCH BRIEF");
    assert.include(conclusionText, "三项核心发现");
    assert.include(conclusionText, "两项边界 / 开放问题");
    assert.include(conclusionText, "下一步研究路线");
    assert.include(conclusionText, "结论");
    assert.notInclude(conclusionText, "WHAT THE PAPER ESTABLISHES");
    assert.notInclude(conclusionText, "OPEN QUESTIONS");
    assert.notInclude(conclusionText, "RESEARCH MILESTONES");
  });

  it("keeps dark-editorial matrix row labels readable", async function () {
    const bytes = await renderPresentation({
      title: "Readable dark matrix",
      designSystem: "dark-editorial",
      slides: [
        {
          title: "The comparison remains legible",
          layout: "matrix",
          matrix: {
            columns: ["Constraint", "Response"],
            rows: [
              {
                label: "Supervision scale",
                cells: ["Millions of labels", "Train a high-capacity CNN"],
              },
            ],
          },
        },
      ],
    });

    const archive = await JSZip.loadAsync(bytes);
    const slide = await archive.files["ppt/slides/slide2.xml"].async("string");
    const rowLabelCell = Array.from(
      slide.matchAll(/<a:tc>[\s\S]*?<\/a:tc>/g),
    ).find((match) => match[0].includes("Supervision scale"))?.[0];

    assert.isString(rowLabelCell);
    assert.include(rowLabelCell!, 'a:srgbClr val="F7F4EC"');
    assert.include(rowLabelCell!, 'a:srgbClr val="182B31"');
    assert.notInclude(rowLabelCell!, 'a:srgbClr val="E8ECEF"');
  });

  it("reads actual OOXML picture extents for visual quality checks", function () {
    const extents = extractPictureExtents(
      '<p:pic><p:spPr><a:xfrm><a:off x="914400" y="1828800"/><a:ext cx="2743200" cy="1371600"/></a:xfrm></p:spPr></p:pic>',
    );
    assert.deepEqual(extents, [
      { x: 914_400, y: 1_828_800, w: 2_743_200, h: 1_371_600 },
    ]);
  });

  it("reports a severely undersized CJK narrative text box without aborting export", async function () {
    const archive = new JSZip();
    archive.file(
      "ppt/slides/slide1.xml",
      '<p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree><a:t>Overflow contract</a:t></p:spTree></p:cSld></p:sld>',
    );
    const marker =
      "大型监督式深度卷积神经网络通过更深层次结构显著降低ImageNet分类错误率，同时训练仍受算力和数据规模约束。";
    const textShape = `<p:sp><p:spPr><a:xfrm><a:off x="914400" y="1828800"/><a:ext cx="1828800" cy="182880"/></a:xfrm></p:spPr><p:txBody><a:p><a:r><a:rPr sz="1800"/><a:t>${marker}</a:t></a:r></a:p></p:txBody></p:sp>`;
    archive.file(
      "ppt/slides/slide2.xml",
      `<p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree><a:t>Slide title</a:t>${textShape}</p:spTree></p:cSld></p:sld>`,
    );
    const bytes = await archive.generateAsync({ type: "uint8array" });

    const warnings = await verifyRenderedPresentation(bytes, {
      title: "Overflow contract",
      slides: [
        {
          title: "Slide title",
          layout: "split",
          keyMessage: marker,
        },
      ],
    });

    assert.match(warnings.join("\n"), /inspect the rendered slide/);
  });

  it("warns instead of aborting for a borderline single-line narrative box", async function () {
    const archive = new JSZip();
    archive.file(
      "ppt/slides/slide1.xml",
      '<p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree><a:t>Borderline text contract</a:t></p:spTree></p:cSld></p:sld>',
    );
    const marker = "在两块 NVIDIA GTX 580 3GB GPU 上，训练约90轮需5—6天。";
    const textShape = `<p:sp><p:spPr><a:xfrm><a:off x="914400" y="1828800"/><a:ext cx="8229600" cy="109728"/></a:xfrm></p:spPr><p:txBody><a:p><a:r><a:rPr sz="800"/><a:t>${marker}</a:t></a:r></a:p></p:txBody></p:sp>`;
    archive.file(
      "ppt/slides/slide2.xml",
      `<p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree><a:t>Slide title</a:t>${textShape}</p:spTree></p:cSld></p:sld>`,
    );
    const bytes = await archive.generateAsync({ type: "uint8array" });

    const warnings = await verifyRenderedPresentation(bytes, {
      title: "Borderline text contract",
      slides: [
        {
          title: "Slide title",
          layout: "split",
          keyMessage: marker,
        },
      ],
    });

    assert.match(warnings.join("\n"), /inspect the rendered slide/);
  });

  it("reports paper gallery thumbnails without rejecting the PPTX", async function () {
    const archive = new JSZip();
    archive.file(
      "ppt/slides/slide1.xml",
      '<p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree><a:t>Visual contract</a:t></p:spTree></p:cSld></p:sld>',
    );
    const tinyPicture =
      '<p:pic><p:spPr><a:xfrm><a:off x="91440" y="91440"/><a:ext cx="91440" cy="91440"/></a:xfrm></p:spPr></p:pic>';
    archive.file(
      "ppt/slides/slide2.xml",
      `<p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree><a:t>Evidence gallery</a:t>${tinyPicture}${tinyPicture}</p:spTree></p:cSld></p:sld>`,
    );
    const bytes = await archive.generateAsync({ type: "uint8array" });
    const pixel = {
      page: 1,
      mode: "figure" as const,
      data: "data:image/png;base64,AA==",
      pixelWidth: 640,
      pixelHeight: 360,
    };
    const warnings = await verifyRenderedPresentation(bytes, {
      title: "Visual contract",
      sourceItemKey: "PAPER1",
      slides: [
        {
          title: "Evidence gallery",
          layout: "gallery",
          figures: [pixel, pixel],
        },
      ],
    });
    assert.match(warnings.join("\n"), /occupy only/);
  });

  it("reports deterministic OOXML verification defects without blocking runtime export", async function () {
    const archive = new JSZip();
    archive.file(
      "ppt/slides/slide1.xml",
      '<p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree><a:t>Verification contract</a:t></p:spTree></p:cSld></p:sld>',
    );
    archive.file(
      "ppt/slides/slide2.xml",
      '<p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree><a:t>Result chart</a:t></p:spTree></p:cSld></p:sld>',
    );
    const bytes = await archive.generateAsync({ type: "uint8array" });
    const spec: RenderablePresentationRequest = {
      title: "Verification contract",
      slides: [
        {
          title: "Result chart",
          chart: {
            type: "bar",
            labels: ["A", "B"],
            values: [1, 2],
          },
        },
      ],
    };

    const warnings = await verifyRenderedPresentation(bytes, spec);
    assert.include(warnings.join("\n"), "chart relationship missing");

    let strictError: unknown;
    try {
      await verifyRenderedPresentation(bytes, spec, { strict: true });
    } catch (error) {
      strictError = error;
    }
    assert.instanceOf(strictError, Error);
    assert.include(
      (strictError as Error).message,
      "chart relationship missing",
    );
  });

  it("omits unusable resolved images in runtime exports but keeps a strict renderer seam", async function () {
    const spec = {
      title: "Invalid image fallback",
      slides: [
        {
          title: "The narrative still exports",
          keyMessage:
            "The media object is unusable, but the deck remains useful.",
          figure: {
            page: 3,
            data: "not-an-image",
            pixelWidth: 640,
            pixelHeight: 360,
          },
        },
      ],
    } as RenderablePresentationRequest;

    const bytes = await renderPresentation(spec);
    const archive = await JSZip.loadAsync(bytes);
    const slideXml =
      await archive.files["ppt/slides/slide2.xml"].async("string");
    assert.include(slideXml, "The narrative still exports");
    assert.notInclude(slideXml, "<p:pic>");

    let strictError: unknown;
    try {
      await renderPresentation(spec, { strictValidation: true });
    } catch (error) {
      strictError = error;
    }
    assert.instanceOf(strictError, Error);
    assert.include((strictError as Error).message, "invalid figure data");
  });

  it("accepts a single ultra-wide figure that fills the width at 20% slide area", async function () {
    const archive = new JSZip();
    archive.file(
      "ppt/slides/slide1.xml",
      '<p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree><a:t>Wide figure contract</a:t></p:spTree></p:cSld></p:sld>',
    );
    const widePicture =
      '<p:pic><p:spPr><a:xfrm><a:off x="914400" y="2286000"/><a:ext cx="10058400" cy="1691640"/></a:xfrm></p:spPr></p:pic>';
    archive.file(
      "ppt/slides/slide2.xml",
      `<p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree><a:t>Architecture spans the model</a:t>${widePicture}</p:spTree></p:cSld></p:sld>`,
    );
    const bytes = await archive.generateAsync({ type: "uint8array" });

    await verifyRenderedPresentation(bytes, {
      title: "Wide figure contract",
      sourceItemKey: "PAPER1",
      slides: [
        {
          title: "Architecture spans the model",
          layout: "figure",
          figure: {
            page: 5,
            mode: "figure",
            data: "data:image/png;base64,AA==",
            pixelWidth: 1_000,
            pixelHeight: 300,
          },
        },
      ],
    });
  });

  it("allows a normal-aspect figure at 20% so the PNG reviewer can judge it", async function () {
    const archive = new JSZip();
    archive.file(
      "ppt/slides/slide1.xml",
      '<p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree><a:t>Normal figure contract</a:t></p:spTree></p:cSld></p:sld>',
    );
    const undersizedPicture =
      '<p:pic><p:spPr><a:xfrm><a:off x="914400" y="2286000"/><a:ext cx="10058400" cy="1691640"/></a:xfrm></p:spPr></p:pic>';
    archive.file(
      "ppt/slides/slide2.xml",
      `<p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree><a:t>Evidence remains too small</a:t>${undersizedPicture}</p:spTree></p:cSld></p:sld>`,
    );
    const bytes = await archive.generateAsync({ type: "uint8array" });
    await verifyRenderedPresentation(bytes, {
      title: "Normal figure contract",
      sourceItemKey: "PAPER1",
      slides: [
        {
          title: "Evidence remains too small",
          layout: "figure",
          figure: {
            page: 3,
            mode: "figure",
            data: "data:image/png;base64,AA==",
            pixelWidth: 800,
            pixelHeight: 500,
          },
        },
      ],
    });
  });

  it("reports a normal figure that collapses into a true thumbnail", async function () {
    const archive = new JSZip();
    archive.file(
      "ppt/slides/slide1.xml",
      '<p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree><a:t>Thumbnail floor</a:t></p:spTree></p:cSld></p:sld>',
    );
    const tinyPicture =
      '<p:pic><p:spPr><a:xfrm><a:off x="914400" y="2286000"/><a:ext cx="3657600" cy="1371600"/></a:xfrm></p:spPr></p:pic>';
    archive.file(
      "ppt/slides/slide2.xml",
      `<p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree><a:t>Evidence is a thumbnail</a:t>${tinyPicture}</p:spTree></p:cSld></p:sld>`,
    );
    const bytes = await archive.generateAsync({ type: "uint8array" });
    const warnings = await verifyRenderedPresentation(bytes, {
      title: "Thumbnail floor",
      sourceItemKey: "PAPER1",
      slides: [
        {
          title: "Evidence is a thumbnail",
          layout: "figure",
          figure: {
            page: 3,
            mode: "figure",
            data: "data:image/png;base64,AA==",
            pixelWidth: 800,
            pixelHeight: 500,
          },
        },
      ],
    });
    assert.match(warnings.join("\n"), /recommended minimum is 12%/);
  });

  it("reports paper covers whose requested hero renders as a thumbnail", async function () {
    const archive = new JSZip();
    const tinyPicture =
      '<p:pic><p:spPr><a:xfrm><a:off x="91440" y="91440"/><a:ext cx="91440" cy="91440"/></a:xfrm></p:spPr></p:pic>';
    archive.file(
      "ppt/slides/slide1.xml",
      `<p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree><a:t>Cover contract</a:t>${tinyPicture}</p:spTree></p:cSld></p:sld>`,
    );
    archive.file(
      "ppt/slides/slide2.xml",
      '<p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree><a:t>Evidence</a:t></p:spTree></p:cSld></p:sld>',
    );
    const bytes = await archive.generateAsync({ type: "uint8array" });
    const warnings = await verifyRenderedPresentation(bytes, {
      title: "Cover contract",
      sourceItemKey: "PAPER1",
      coverFigure: {
        page: 1,
        mode: "figure",
        data: "data:image/png;base64,AA==",
        pixelWidth: 640,
        pixelHeight: 360,
      },
      slides: [{ title: "Evidence" }],
    });
    assert.match(warnings.join("\n"), /cover.*occupy only/i);
  });

  it("gives a medium-aspect paper cover enough visual area", async function () {
    const pixel = {
      page: 1,
      mode: "figure" as const,
      data: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      pixelWidth: 668,
      pixelHeight: 456,
      caption: "Figure 1: Evidence",
    };

    const bytes = await renderPresentation({
      title: "Medium-aspect cover contract",
      subtitle: "A real paper figure should remain visually dominant",
      sourceItemKey: "PAPER1",
      coverFigure: pixel,
      slides: [{ title: "Evidence", layout: "statement", bullets: ["Claim"] }],
    });

    const archive = await JSZip.loadAsync(bytes);
    const coverXml =
      await archive.files["ppt/slides/slide1.xml"].async("string");
    const extents = extractPictureExtents(coverXml);
    const renderedArea = extents.reduce(
      (total, extent) => total + extent.w * extent.h,
      0,
    );
    const slideArea = 13.333 * 914_400 * 7.5 * 914_400;
    assert.isAtLeast(renderedArea / slideArea, 0.22);
  });

  it("uses an editorial academic cover collage and a concise evidence line", async function () {
    const data =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const hero = {
      page: 5,
      mode: "figure" as const,
      data,
      pixelWidth: 800,
      pixelHeight: 500,
      caption: "Figure 2: Architecture",
    };
    const support = {
      page: 3,
      mode: "figure" as const,
      data,
      pixelWidth: 800,
      pixelHeight: 200,
      caption: "Figure 1: Training curve",
    };

    const bytes = await renderPresentation({
      title: "Ultra-wide cover contract",
      subtitle:
        "The architecture stays complete while a second figure adds density",
      sourceItemKey: "PAPER1",
      theme: "academic",
      designSystem: "teal-green-academic-defense",
      visualTuning: { layout: "editorial-collage" },
      coverFigure: hero,
      coverFigures: [hero, support],
      slides: [
        {
          title: "Evidence",
          layout: "statement",
          bullets: ["Claim"],
          metrics: [
            { value: "17.0%", label: "top-5 error" },
            { value: "8.7 pp", label: "improvement" },
          ],
        },
      ],
    });

    const archive = await JSZip.loadAsync(bytes);
    const coverXml =
      await archive.files["ppt/slides/slide1.xml"].async("string");
    const extents = extractPictureExtents(coverXml);
    assert.lengthOf(extents, 2);
    assert.include(coverXml, "17.0%");
    assert.include(normalizePresentationText(coverXml), "top-5 error");
    assert.include(coverXml, "8.7 pp");
    assert.include(coverXml, "improvement");
    const renderedArea = extents.reduce(
      (total, extent) => total + extent.w * extent.h,
      0,
    );
    const slideArea = 13.333 * 914_400 * 7.5 * 914_400;
    assert.isAtLeast(renderedArea / slideArea, 0.22);
  });

  it("deduplicates semantically identical cover crops before rendering a collage", async function () {
    const data =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const hero = {
      page: 5,
      mode: "figure" as const,
      data,
      pixelWidth: 985,
      pixelHeight: 292,
      captionHint: "Figure 2:",
      caption: "Figure 2: AlexNet architecture across two GPUs.",
    };
    const duplicateCrop = {
      ...hero,
      pixelWidth: 1040,
      pixelHeight: 318,
      caption: "Figure 2: Architecture of the CNN.",
    };
    const bytes = await renderPresentation({
      title: "AlexNet cover dedupe",
      sourceItemKey: "PAPER1",
      visualTuning: { layout: "editorial-collage" },
      coverFigure: hero,
      coverFigures: [hero, duplicateCrop],
      slides: [{ title: "Evidence", metrics: [{ value: "1", label: "x" }] }],
    });

    const archive = await JSZip.loadAsync(bytes);
    const coverXml =
      await archive.files["ppt/slides/slide1.xml"].async("string");
    assert.lengthOf(extractPictureExtents(coverXml), 1);
  });

  it("keeps research metrics on a single ultra-wide academic cover", async function () {
    const data =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const bytes = await renderPresentation({
      title: "AlexNet: Deep CNNs reshape ImageNet",
      subtitle: "Contribution, method, evidence, and limits",
      sourceItemKey: "PAPER1",
      theme: "academic",
      designSystem: "teal-green-academic-defense",
      coverFigure: {
        page: 5,
        mode: "figure",
        data,
        pixelWidth: 987,
        pixelHeight: 292,
        caption: "Figure 2: Architecture",
      },
      slides: [
        {
          title: "Evidence",
          layout: "statement",
          bullets: ["Claim"],
          metrics: [
            { value: "17.0%", label: "top-5 error" },
            { value: "60M", label: "parameters" },
            { value: "1.2M", label: "training images" },
          ],
        },
      ],
    });

    const archive = await JSZip.loadAsync(bytes);
    const coverXml =
      await archive.files["ppt/slides/slide1.xml"].async("string");
    assert.include(coverXml, "17.0%");
    assert.include(coverXml, "60M");
    assert.include(coverXml, "1.2M");
    const subtitle = extractTextShapeExtent(
      coverXml,
      "Contribution, method, evidence, and limits",
    );
    const focusRule = extractLineShapeExtentByColor(coverXml, "F0A81D");
    assert.isDefined(subtitle);
    assert.isDefined(focusRule);
    assert.isBelow(
      focusRule!.y,
      subtitle!.y,
      "the cover focus rule should introduce the subtitle, not strike through it",
    );
  });

  it("promotes an ultra-wide qualitative figure to a material cover hero", async function () {
    const data =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const bytes = await renderPresentation({
      title: "AlexNet reshapes ImageNet recognition",
      subtitle: "Evidence, architecture, and the training system",
      sourceItemKey: "PAPER1",
      coverFigure: {
        page: 8,
        mode: "figure",
        data,
        pixelWidth: 966,
        pixelHeight: 380,
        caption:
          "Figure 4: predictions and nearest-neighbor retrievals reveal semantic structure.",
      },
      slides: [{ title: "Evidence", metrics: [{ value: "1", label: "x" }] }],
    });

    const archive = await JSZip.loadAsync(bytes);
    const coverXml =
      await archive.files["ppt/slides/slide1.xml"].async("string");
    const [hero] = extractPictureExtents(coverXml);
    assert.closeTo(hero.x / 914_400, 4.54, 0.02);
    assert.closeTo(hero.y / 914_400, 3.14, 0.02);
    assert.closeTo(hero.w / 914_400, 8.42, 0.02);
    assert.closeTo(hero.h / 914_400, 3.31, 0.04);
    assert.notInclude(
      coverXml,
      'a:srgbClr val="F4FAFD"',
      "an ultra-wide cover hero should read as one image band, not a pale card",
    );
    assert.notMatch(coverXml, /<a:srcRect[^>]+[lrtb]="[1-9]\d*"/);
    const slideArea = 13.333 * 914_400 * 7.5 * 914_400;
    assert.isAtLeast((hero.w * hero.h) / slideArea, 0.27);
  });

  it("uses the restrained academic cover for paper decks by default", async function () {
    const data =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const bytes = await renderPresentation({
      title: "Academic paper cover",
      subtitle: "The evidence remains prominent without becoming a poster",
      sourceItemKey: "PAPER1",
      coverFigure: {
        page: 4,
        mode: "figure",
        data,
        pixelWidth: 1600,
        pixelHeight: 900,
        caption: "Figure 4: Qualitative result",
      },
      slides: [{ title: "Evidence", metrics: [{ value: "1", label: "x" }] }],
    });

    const archive = await JSZip.loadAsync(bytes);
    const coverXml =
      await archive.files["ppt/slides/slide1.xml"].async("string");
    const [hero] = extractPictureExtents(coverXml);
    assert.closeTo(hero.x / 914_400, 7.08, 0.01);
    assert.closeTo(hero.y / 914_400, 1.71, 0.02);
    assert.closeTo(hero.w / 914_400, 5.9, 0.01);
    assert.closeTo(hero.h / 914_400, 3.32, 0.02);
    assert.include(coverXml, "Academic paper cover");
    assert.notInclude(coverXml, 'a:srgbClr val="0B0C0D"');
  });

  it("gives a figure narrative enough width for stable CJK wrapping", async function () {
    const data =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const bytes = await renderPresentation({
      title: "训练系统",
      slides: [
        {
          title: "快速优化与正则化解决不同问题",
          layout: "figure",
          figure: {
            page: 3,
            mode: "figure",
            data,
            pixelWidth: 420,
            pixelHeight: 345,
            caption: "Figure 1: training error",
          },
          keyMessage: "ReLU 将达到同一训练误差的时间缩短约 6 倍。",
          bullets: ["Dropout 以 0.5 概率随机失活，抑制神经元共适应。"],
        },
      ],
    });

    const archive = await JSZip.loadAsync(bytes);
    const slideXml =
      await archive.files["ppt/slides/slide2.xml"].async("string");
    const bullet = extractTextShapeExtent(slideXml, "Dropout");
    assert.isDefined(bullet);
    assert.isAtLeast((bullet?.w || 0) / 914_400, 3);
  });

  it("promotes a quantified figure claim into a direct evidence annotation", async function () {
    const data =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const bytes = await renderPresentation({
      title: "训练系统",
      slides: [
        {
          title: "ReLU 将达到同一训练误差的迭代数缩短六倍",
          layout: "figure",
          figure: {
            page: 3,
            mode: "figure",
            data,
            pixelWidth: 420,
            pixelHeight: 345,
            caption: "Figure 1: training error",
          },
          keyMessage: "该图证明优化速度提升，但不报告测试集错误率。",
          bullets: ["实线为 ReLU，虚线为 tanh；比较目标为 25% 训练错误率。"],
        },
      ],
    });

    const archive = await JSZip.loadAsync(bytes);
    const slide = await archive.files["ppt/slides/slide2.xml"].async("string");
    const metricShape = Array.from(
      slide.matchAll(/<p:sp>[\s\S]*?<\/p:sp>/g),
    ).find((match) =>
      normalizePresentationText(match[0]).includes("<a:t>六倍</a:t>"),
    )?.[0];

    assert.isString(metricShape);
    assert.include(metricShape!, 'sz="3000"');
  });

  it("aspect-fits a wide paper figure instead of leaving blank bands inside a fixed frame", async function () {
    const data =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const bytes = await renderPresentation({
      title: "定性证据",
      slides: [
        {
          title: "高层特征保留语义邻域",
          layout: "figure",
          figure: {
            page: 8,
            mode: "figure",
            data,
            pixelWidth: 966,
            pixelHeight: 380,
            caption: "Figure 4: qualitative predictions and neighbors",
          },
          keyMessage: "近邻检索揭示语义结构，同时暴露细粒度歧义。",
          bullets: ["代表性样例应在演示距离保持可读。"],
        },
      ],
    });

    const archive = await JSZip.loadAsync(bytes);
    const slide = await archive.files["ppt/slides/slide2.xml"].async("string");
    const [figure] = extractPictureExtents(slide);

    assert.closeTo(figure.h / 914_400, 4.5, 0.06);
    assert.isAtLeast(figure.w / 914_400, 11.3);
    assert.isAbove(figure.y / 914_400, 1.5);
    assert.isBelow((figure.y + figure.h) / 914_400, 6.5);
  });

  it("keeps callout quantities in non-breaking OOXML text", async function () {
    const data =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const bytes = await renderPresentation({
      title: "Quantity wrapping regression",
      designSystem: "teal-green-academic-defense",
      slides: [
        {
          title: "模型规模",
          layout: "process",
          process: [{ title: "输入" }, { title: "训练" }, { title: "输出" }],
          figure: {
            page: 5,
            mode: "figure",
            data,
            pixelWidth: 1_200,
            pixelHeight: 420,
            caption: "Figure 2: Architecture",
          },
          callouts: [{ label: "规模", text: "约 65 万神经元与 3GB 显存" }],
        },
      ],
    });

    const archive = await JSZip.loadAsync(bytes);
    const slideXml =
      await archive.files["ppt/slides/slide2.xml"].async("string");
    assert.match(slideXml, /6(?:&#8288;|\u2060)5(?:&#160;|\u00a0)万/u);
    assert.match(slideXml, /3(?:&#8288;|\u2060)G(?:&#8288;|\u2060)B/u);
    const warnings = await verifyRenderedPresentation(bytes, {
      title: "Quantity wrapping regression",
      designSystem: "teal-green-academic-defense",
      slides: [
        {
          title: "模型规模",
          layout: "process",
          process: [{ title: "输入" }, { title: "训练" }, { title: "输出" }],
          figure: {
            page: 5,
            mode: "figure",
            data,
            pixelWidth: 1_200,
            pixelHeight: 420,
            caption: "Figure 2: Architecture",
          },
          callouts: [{ label: "规模", text: "约 65 万神经元与 3GB 显存" }],
        },
      ],
    });
    assert.notMatch(warnings.join("\n"), /renderer omitted/u);
  });

  it("keeps an embedded Latin paper name intact on a CJK dark cover", async function () {
    const bytes = await renderPresentation({
      title: "深度卷积网络如何改写ImageNet分类",
      language: "zh-CN",
      designSystem: "dark-editorial",
      slides: [{ title: "证据" }],
    });

    const archive = await JSZip.loadAsync(bytes);
    const coverXml =
      await archive.files["ppt/slides/slide1.xml"].async("string");
    const coverText = extractSlideText(coverXml);

    assert.include(coverText, "深度卷积网络如何改写");
    assert.include(coverText, "ImageNet分类");
    assert.match(
      normalizePresentationText(coverXml),
      /深度卷积网络如何改写<\/a:t>[\s\S]*?<a:p>[\s\S]*?ImageNet分类/,
    );
  });

  it("reports OOXML that silently drops a requested evidence field", async function () {
    const archive = new JSZip();
    archive.file(
      "ppt/slides/slide1.xml",
      '<p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree><a:t>Verifier probe</a:t></p:spTree></p:cSld></p:sld>',
    );
    archive.file(
      "ppt/slides/slide2.xml",
      '<p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree><a:t>Evidence slide</a:t></p:spTree></p:cSld></p:sld>',
    );
    const bytes = await archive.generateAsync({ type: "uint8array" });
    const warnings = await verifyRenderedPresentation(bytes, {
      title: "Verifier probe",
      slides: [
        {
          title: "Evidence slide",
          metrics: [{ value: "+10.9 pp", label: "winning margin" }],
        },
      ],
    });
    assert.match(warnings.join("\n"), /renderer omitted/);
  });

  it("accepts gallery eyebrows and complete editorial paper captions", async function () {
    const data =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const firstCaption =
      "Figure 3: 96 convolutional kernels of size 11×11×3 learned by the first convolutional layer on the 224×224×3 input images. The learned filters reveal oriented edges, color opponency, and frequency-selective structures across the complete bank of first-layer features.";
    const secondCaption =
      "Figure 4: (Left) Eight ILSVRC-2010 test images and the five labels considered most probable by our model.";

    const bytes = await renderPresentation({
      title: "AlexNet verifier regression",
      sourceItemKey: "PAPER1",
      slides: [
        {
          eyebrow: "从小数据集到百万级视觉识别",
          title: "ImageNet scale made learned visual features decisive",
          layout: "gallery",
          keyMessage: "Real paper evidence should own the canvas.",
          figures: [
            {
              page: 5,
              mode: "figure",
              data,
              pixelWidth: 640,
              pixelHeight: 360,
              caption: firstCaption,
            },
            {
              page: 6,
              mode: "figure",
              data,
              pixelWidth: 640,
              pixelHeight: 360,
              caption: "Figure 4：模型预测与语义相近的 ImageNet 图像",
              captionHint: secondCaption,
            },
          ],
        },
      ],
    });

    const archive = await JSZip.loadAsync(bytes);
    const slide = await archive.files["ppt/slides/slide2.xml"].async("string");
    const visibleText = extractSlideText(slide);
    assert.include(visibleText, "从小数据集到百万级视觉识别");
    assert.include(visibleText, "Figure 3: 96 convolutional kernels");
    assert.notInclude(visibleText, firstCaption);
    assert.notInclude(visibleText, "…");
  });

  it("reports a gallery whose visible caption was actually removed", async function () {
    const data =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const caption =
      "Figure 3: 96 convolutional kernels of size 11×11×3 learned by the first convolutional layer on the 224×224×3 input images.";
    const spec = {
      title: "Caption removal regression",
      sourceItemKey: "PAPER1",
      slides: [
        {
          title: "The gallery must retain its evidence labels",
          layout: "gallery" as const,
          figures: [
            {
              page: 5,
              mode: "figure" as const,
              data,
              pixelWidth: 640,
              pixelHeight: 360,
              caption,
            },
            {
              page: 6,
              mode: "figure" as const,
              data,
              pixelWidth: 640,
              pixelHeight: 360,
              caption: "Figure 4: Qualitative ImageNet predictions.",
            },
          ],
        },
      ],
    };
    const validBytes = await renderPresentation(spec);
    const archive = await JSZip.loadAsync(validBytes);
    const slidePath = "ppt/slides/slide2.xml";
    const slide = await archive.files[slidePath].async("string");
    const captionShape = Array.from(
      slide.matchAll(/<p:sp>[\s\S]*?<\/p:sp>/g),
    ).find((match) => extractSlideText(match[0]).includes("Figure 3:"))?.[0];
    assert.isString(captionShape);
    archive.file(
      slidePath,
      slide.replace(
        captionShape!,
        captionShape!.replace(
          /<a:t>[\s\S]*?<\/a:t>/u,
          "<a:t>Caption intentionally removed</a:t>",
        ),
      ),
    );
    const brokenBytes = await archive.generateAsync({ type: "uint8array" });

    const warnings = await verifyRenderedPresentation(brokenBytes, spec);
    assert.match(warnings.join("\n"), /renderer omitted.*Figure 3/i);
  });

  it("selects editorial auto layouts from evidence semantics instead of page parity", function () {
    const pixel = {
      page: 1,
      mode: "page" as const,
      data: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      pixelWidth: 1,
      pixelHeight: 1,
    };
    assert.equal(
      resolveLayout({ title: "Gallery", figures: [pixel, pixel] }, 0),
      "gallery",
    );
    assert.equal(
      resolveLayout(
        {
          title: "Ablation",
          chart: { type: "bar", labels: ["A"], values: [1] },
          callouts: [{ text: "Limit", tone: "risk" }],
        },
        7,
      ),
      "ablation",
    );
    assert.equal(
      resolveLayout(
        {
          title: "Conclusion",
          groups: [{ title: "Finding", bullets: ["Supported"] }],
          timeline: [{ label: "A" }, { label: "B" }, { label: "C" }],
        },
        2,
      ),
      "conclusion",
    );
  });

  it("derives a quiet academic footer when the model omits section labels", async function () {
    const bytes = await renderPresentation({
      title: "Academic navigation probe",
      slides: [
        {
          title: "The baseline leaves a measurable gap",
          layout: "comparison",
          comparison: {
            left: { title: "Baseline", bullets: ["Manual pipeline"] },
            right: { title: "Method", bullets: ["Learned pipeline"] },
          },
        },
        {
          title: "The method follows a reproducible sequence",
          layout: "process",
          process: [
            { title: "Input" },
            { title: "Transform" },
            { title: "Output" },
          ],
        },
      ],
    });

    const archive = await JSZip.loadAsync(bytes);
    const comparison =
      await archive.files["ppt/slides/slide2.xml"].async("string");
    const process =
      await archive.files["ppt/slides/slide3.xml"].async("string");
    assert.include(comparison, ">PROBLEM<");
    assert.include(process, ">METHOD<");
    assert.notInclude(comparison, ">METHOD<");
    assert.notInclude(process, ">PROBLEM<");
  });

  it("creates an editable OOXML package with slides and speaker notes", async function () {
    const bytes = await renderPresentation({
      title: "PaperChat 技术可行性",
      subtitle: "中文 / English · editable PPTX",
      slides: [
        {
          title: "Renderer capability probe",
          keyMessage: "可编辑 PPTX · 插件内生成",
          bullets: ["Gecko runtime", "Valid OOXML ZIP", "Speaker notes"],
          notes: "PaperChat speaker notes probe",
        },
      ],
    });

    assert.isAbove(bytes.length, 10_000);
    assert.deepEqual(Array.from(bytes.slice(0, 4)), [0x50, 0x4b, 0x03, 0x04]);

    const archive = await JSZip.loadAsync(bytes);
    for (const path of REQUIRED_ENTRIES) {
      assert.property(archive.files, path);
    }

    const firstSlide =
      await archive.files["ppt/slides/slide1.xml"].async("string");
    const secondNotes =
      await archive.files["ppt/notesSlides/notesSlide2.xml"].async("string");
    assert.include(
      normalizePresentationText(firstSlide),
      "PaperChat 技术可行性",
    );
    assert.include(normalizePresentationText(firstSlide), "中文 / English");
    assert.include(secondNotes, "PaperChat speaker notes probe");
  });

  it("normalizes cross-realm string wrappers before embedding figures", async function () {
    const rawData =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const pixel = {
      page: 1,
      mode: "page" as const,
      data: new String(rawData) as unknown as string,
      pixelWidth: 1,
      pixelHeight: 1,
    };
    const bytes = await renderPresentation({
      title: "Cross-realm image probe",
      coverFigure: pixel,
      slides: [{ title: "Image evidence", figure: pixel }],
    });
    const archive = await JSZip.loadAsync(bytes);
    const coverXml =
      await archive.files["ppt/slides/slide1.xml"].async("string");
    const contentXml =
      await archive.files["ppt/slides/slide2.xml"].async("string");
    assert.include(coverXml, "<p:pic>");
    assert.include(contentXml, "<p:pic>");
  });

  it("rebuilds a wrapped presentation graph inside the renderer realm", async function () {
    const rawData =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const wrappedFigure = new Proxy(
      {
        page: 1,
        mode: "page" as const,
        data: new String(rawData) as unknown as string,
        pixelWidth: 1,
        pixelHeight: 1,
      },
      {},
    );
    const wrappedSlides = new Proxy(
      [{ title: "Wrapped graph", figure: wrappedFigure }],
      {},
    );
    const bytes = await renderPresentation(
      new Proxy(
        {
          title: "Compartment graph probe",
          coverFigure: wrappedFigure,
          slides: wrappedSlides,
        },
        {},
      ),
    );
    const archive = await JSZip.loadAsync(bytes);
    const coverXml =
      await archive.files["ppt/slides/slide1.xml"].async("string");
    const contentXml =
      await archive.files["ppt/slides/slide2.xml"].async("string");
    assert.include(coverXml, "<p:pic>");
    assert.include(contentXml, "<p:pic>");
  });

  it("renders a general editable deck with chart, table, and notes", async function () {
    const bytes = await renderPresentation({
      title: "研究结论汇报",
      subtitle: "PaperChat editable deck",
      author: "PaperChat Test",
      theme: "academic",
      slides: [
        {
          title: "关键结果",
          keyMessage: "主要指标提升 24%",
          bullets: ["样本量覆盖三个数据集", "结果在稳健性检验中保持一致"],
          chart: {
            type: "bar",
            title: "指标对比",
            labels: ["Baseline", "Method"],
            values: [71, 95],
          },
          notes: "Explain the evaluation protocol.",
          source: "Paper, Figure 3",
        },
        {
          title: "实验摘要",
          bullets: ["所有结果均可编辑"],
          table: {
            headers: ["Dataset", "Score"],
            rows: [
              ["A", "0.91"],
              ["B", "0.88"],
            ],
          },
        },
      ],
    });

    const archive = await JSZip.loadAsync(bytes);
    assert.property(archive.files, "ppt/slides/slide3.xml");
    assert.isTrue(
      Object.keys(archive.files).some((path) =>
        /^ppt\/charts\/chart\d+\.xml$/.test(path),
      ),
      "expected an editable chart part",
    );
    assert.isTrue(
      Object.keys(archive.files).some((path) =>
        /^ppt\/embeddings\/Microsoft_Excel_Worksheet\d+\.xlsx$/.test(path),
      ),
      "expected embedded chart data",
    );
    const slide = await archive.files["ppt/slides/slide2.xml"].async("string");
    const notes =
      await archive.files["ppt/notesSlides/notesSlide2.xml"].async("string");
    assert.include(normalizePresentationText(slide), "主要指标提升 24%");
    assert.include(notes, "Explain the evaluation protocol.");
  });

  it("renders multi-evidence, matrix, timeline, equation, and cover hero layouts", async function () {
    const pixel = {
      page: 1,
      mode: "page" as const,
      data: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      pixelWidth: 1,
      pixelHeight: 1,
    };
    const bytes = await renderPresentation({
      title: "Channel Reassessment Attention",
      subtitle: "Evidence-first academic briefing",
      theme: "academic",
      coverFigures: [pixel, { ...pixel, page: 2 }, { ...pixel, page: 3 }],
      slides: [
        {
          title: "Spatial evidence changes which channels matter",
          layout: "evidence",
          keyMessage:
            "Global pooling erases position before channel weighting.",
          groups: [
            {
              title: "Observed failure",
              bullets: ["Different positions contribute different evidence."],
            },
          ],
          figures: [pixel, { ...pixel, page: 2 }],
          equation: {
            label: "Channel descriptor",
            expression: "z_c = 1/(H × W) · Σ x_c(i,j)",
            explanation: "The spatial average is compact but position-blind.",
          },
        },
        {
          title: "The method separates compression from reassessment",
          layout: "matrix",
          matrix: {
            banner: "Four operations preserve a lightweight inference path",
            columns: ["Compress", "Reassess", "Refine", "Embed"],
            rows: [
              {
                label: "Spatial cue",
                cells: ["avg+max", "depthwise", "gate", "scale"],
              },
              { label: "Cost", cells: ["low", "low", "low", "none"] },
              {
                label: "Output",
                cells: ["map", "weight", "response", "feature"],
              },
            ],
            highlightColumn: 1,
          },
          keyMessage:
            "The reassessment stage is the only new spatial operator.",
        },
        {
          title: "Accuracy improves at nearly unchanged FLOPs",
          layout: "evidence",
          chart: {
            type: "bar",
            title: "ImageNet top-1 error",
            labels: ["Baseline", "SE", "CRA"],
            values: [24.0, 23.0, 22.77],
          },
          metrics: [
            { value: "22.77%", label: "top-1 error" },
            { value: "4.11G", label: "FLOPs" },
          ],
          callouts: [
            {
              label: "Result",
              text: "CRA reaches the lowest error.",
              tone: "evidence",
            },
          ],
        },
        {
          title: "Evidence is strong, but larger-scale transfer remains open",
          layout: "timeline",
          figures: [pixel],
          groups: [
            {
              title: "Supported",
              bullets: [
                "ImageNet and CIFAR improve.",
                "Grad-CAM tightens around objects.",
              ],
            },
          ],
          callouts: [
            {
              label: "Open",
              text: "Larger pretrained regimes remain untested.",
              tone: "risk",
            },
          ],
          timeline: [
            { label: "ImageNet", milestone: "validated" },
            { label: "CIFAR", milestone: "validated" },
            { label: "Detection", milestone: "supported" },
            { label: "Larger scale", detail: "future validation" },
          ],
        },
      ],
    });

    const archive = await JSZip.loadAsync(bytes);
    assert.property(archive.files, "ppt/slides/slide5.xml");
    assert.isAtLeast(
      Object.keys(archive.files).filter((path) =>
        /^ppt\/media\/image[-\d]+\.png$/.test(path),
      ).length,
      3,
    );
    const evidenceSlide =
      await archive.files["ppt/slides/slide2.xml"].async("string");
    const matrixSlide =
      await archive.files["ppt/slides/slide3.xml"].async("string");
    const timelineSlide =
      await archive.files["ppt/slides/slide5.xml"].async("string");
    assert.include(evidenceSlide, "CHANNEL DESCRIPTOR");
    assert.include(matrixSlide, "Compress");
    assert.include(timelineSlide, "Larger scale");
    assert.include(
      timelineSlide,
      "<a:blip",
      "timeline slides should render supplied PDF figures",
    );
  });

  it("renders editorial gallery, horizontal ablation, and a single-mode conclusion", async function () {
    const pixel = {
      page: 1,
      mode: "page" as const,
      data: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      pixelWidth: 1,
      pixelHeight: 1,
    };
    const bytes = await renderPresentation({
      title: "Editorial academic deck",
      author: "Krizhevsky, Sutskever &amp; Hinton",
      theme: "academic",
      coverFigures: [pixel, { ...pixel, page: 2 }],
      slides: [
        {
          title: "Two qualitative figures establish the mechanism",
          layout: "gallery",
          keyMessage: "The evidence should dominate the canvas.",
          figures: [pixel, { ...pixel, page: 2 }],
        },
        {
          title: "The main component contributes the largest gain",
          layout: "ablation",
          figure: { ...pixel, page: 3, caption: "Qualitative failure modes" },
          chart: {
            type: "bar",
            orientation: "horizontal",
            labels: ["Full model", "No prior", "No fusion"],
            values: [88, 76, 81],
          },
          callouts: [
            { text: "Cross-region transfer remains open.", tone: "risk" },
          ],
          metrics: [
            { value: "88%", label: "full model" },
            { value: "+12 pt", label: "main gain" },
          ],
        },
        {
          title: "Three findings are supported while scale remains open",
          layout: "conclusion",
          groups: [
            { title: "Accuracy", bullets: ["Supported"] },
            { title: "Robustness", bullets: ["Supported"] },
            { title: "Scale", bullets: ["Open"] },
          ],
          callouts: [
            {
              label: "Scale",
              text: "Does the gain survive at larger scale?",
            },
            {
              label: "Efficiency",
              text: "Can the same result require less compute?",
            },
          ],
          timeline: [
            { label: "Accuracy", milestone: "supported" },
            { label: "Robustness", milestone: "supported" },
            { label: "Scale", detail: "future work" },
          ],
        },
      ],
    });

    const archive = await JSZip.loadAsync(bytes);
    const gallerySlide =
      await archive.files["ppt/slides/slide2.xml"].async("string");
    const coverSlide =
      await archive.files["ppt/slides/slide1.xml"].async("string");
    const ablationSlide =
      await archive.files["ppt/slides/slide3.xml"].async("string");
    const conclusionSlide =
      await archive.files["ppt/slides/slide4.xml"].async("string");
    const chartPath = Object.keys(archive.files).find((path) =>
      /^ppt\/charts\/chart\d+\.xml$/.test(path),
    );
    assert.isString(chartPath);
    const chartXml = await archive.files[chartPath!].async("string");
    assert.include(gallerySlide, "The evidence should dominate the canvas.");
    assert.include(ablationSlide, "Qualitative failure modes");
    assert.include(ablationSlide, "<a:blip");
    assert.include(
      normalizePresentationText(conclusionSlide),
      "THREE CORE FINDINGS",
    );
    assert.include(
      normalizePresentationText(conclusionSlide),
      "TWO BOUNDARIES / OPEN QUESTIONS",
    );
    assert.include(conclusionSlide, "Scale");
    assert.include(conclusionSlide, "EFFICIENCY");
    assert.include(conclusionSlide, "Does the gain survive at larger scale?");
    assert.include(
      conclusionSlide,
      "Can the same result require less compute?",
    );
    assert.include(
      normalizePresentationText(conclusionSlide),
      "NEXT RESEARCH STEPS",
    );
    assert.include(conclusionSlide, "future work");
    assert.notInclude(conclusionSlide, "<a:tbl>");
    assert.notInclude(conclusionSlide, 'prst="roundRect"');
    assert.notInclude(coverSlide, "&amp;amp;");
    assert.match(chartXml, /barDir val="bar"/);
    assert.include(chartXml, '<c:roundedCorners val="0"/>');
    assert.include(chartXml, 'formatCode="0.0#"');
    assert.include(chartXml, "<c:manualLayout>");
  });

  it("keeps wrapped single-series bars restrained and gives true grouped charts a direct legend", async function () {
    const bytes = await renderPresentation({
      title: "Chart semantics",
      slides: [
        {
          title: "A wrapped single series is still one measurement",
          layout: "data",
          chart: {
            type: "bar",
            orientation: "horizontal",
            labels: ["A", "B", "C"],
            series: [{ name: "Top-5 error", values: [28.2, 25.7, 17] }],
            highlightIndex: 2,
          },
        },
        {
          title: "Two measurements remain distinguishable",
          layout: "data",
          chart: {
            type: "bar",
            orientation: "horizontal",
            labels: ["Sparse coding", "SIFT + FVs", "CNN"],
            series: [
              { name: "Top-1", values: [47.1, 45.7, 37.5] },
              { name: "Top-5", values: [28.2, 25.7, 17] },
            ],
          },
        },
      ],
    });

    const archive = await JSZip.loadAsync(bytes);
    const chartPaths = Object.keys(archive.files)
      .filter((path) => /^ppt\/charts\/chart\d+\.xml$/.test(path))
      .sort();
    assert.lengthOf(chartPaths, 2);
    const singleXml = await archive.files[chartPaths[0]].async("string");
    const groupedXml = await archive.files[chartPaths[1]].async("string");
    const groupedSlide =
      await archive.files["ppt/slides/slide3.xml"].async("string");

    assert.include(singleXml, '<c:varyColors val="0"/>');
    assert.include(singleXml, 'a:srgbClr val="D97941"');
    assert.include(singleXml, 'a:srgbClr val="AEB7BB"');
    assert.include(groupedXml, '<c:varyColors val="0"/>');
    assert.include(groupedXml, 'a:srgbClr val="245C73"');
    assert.include(groupedXml, 'a:srgbClr val="D6A13D"');
    assert.include(normalizePresentationText(groupedSlide), "Top-1");
    assert.include(normalizePresentationText(groupedSlide), "Top-5");
  });

  it("keeps cover captions and four-stage process copy readable", async function () {
    const data =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const longCaption =
      "Figure 4: Eight test-set predictions and the six nearest training images in the final hidden-layer feature space, demonstrating semantic similarity despite large visual differences and several remaining fine-grained ambiguities that should remain in notes rather than overflow the cover.";
    const bytes = await renderPresentation({
      title: "Readable process contract",
      coverFigure: {
        page: 8,
        mode: "figure",
        data,
        pixelWidth: 1_320,
        pixelHeight: 456,
        caption: longCaption,
      },
      slides: [
        {
          title: "Four stages remain readable",
          layout: "process",
          process: [
            {
              title: "输入与增强",
              detail: "随机裁剪和颜色扰动扩大训练样本覆盖范围。",
            },
            {
              title: "卷积特征提取",
              detail: "五层卷积逐步学习边缘、纹理和高级视觉语义。",
            },
            {
              title: "全连接分类",
              detail: "Dropout 抑制共同适应并降低过拟合风险。",
            },
            {
              title: "集成预测",
              detail: "多个模型输出共同形成最终类别概率。",
            },
          ],
        },
      ],
    });

    const archive = await JSZip.loadAsync(bytes);
    const coverSlide =
      await archive.files["ppt/slides/slide1.xml"].async("string");
    const processSlide =
      await archive.files["ppt/slides/slide2.xml"].async("string");
    const coverText = extractSlideText(coverSlide);
    assert.include(coverText, "Figure 4:");
    assert.notInclude(coverText, "…");
    assert.match(coverText, /feature space[.]?/);
    assert.notInclude(coverText, "overflow the cover");

    const titleExtent = extractTextShapeExtent(processSlide, "卷积特征提取");
    const detailExtent = extractTextShapeExtent(
      processSlide,
      "五层卷积逐步学习边缘、纹理和高级视觉语义。",
    );
    assert.isDefined(titleExtent);
    assert.isDefined(detailExtent);
    assert.isAtLeast(titleExtent?.h || 0, 0.32 * 914_400);
    assert.isAtLeast(detailExtent?.h || 0, 0.34 * 914_400);
  });

  it("keeps a long cover author line clear of the bibliographic year", async function () {
    const data =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const author = "Alex Krizhevsky、Ilya Sutskever、Geoffrey E. Hinton";
    const bytes = await renderPresentation({
      title: "ImageNet分类的深度卷积神经网络",
      language: "zh-CN",
      designSystem: "teal-green-academic-defense",
      author,
      year: "2017",
      coverFigure: {
        page: 8,
        mode: "figure",
        data,
        pixelWidth: 1_320,
        pixelHeight: 456,
        caption: "Figure 4: ImageNet predictions and nearest neighbors.",
      },
      slides: [
        { title: "研究证据", metrics: [{ value: "6x", label: "speed" }] },
      ],
    });

    const archive = await JSZip.loadAsync(bytes);
    const coverSlide =
      await archive.files["ppt/slides/slide1.xml"].async("string");
    const authorBox = extractTextShapeExtent(coverSlide, author);
    const yearBox = extractTextShapeExtent(coverSlide, "2017");

    assert.isDefined(authorBox);
    assert.isDefined(yearBox);
    assert.isAtMost(authorBox!.x + authorBox!.w, yearBox!.x);
  });

  it("separates a process narrative from its paper figure and caption", async function () {
    const data =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const calloutText =
      "两块GPU只在特定层通信；五个卷积层和三个全连接层共同控制显存与训练时间。";
    const bytes = await renderPresentation({
      title: "Process spacing contract",
      designSystem: "dark-editorial",
      slides: [
        {
          title: "双GPU流水线保持可训练性",
          layout: "process",
          process: [
            { title: "输入" },
            { title: "双GPU卷积" },
            { title: "全连接" },
            { title: "分类" },
          ],
          callouts: [{ label: "训练关键", text: calloutText }],
          figure: {
            page: 5,
            mode: "figure",
            data,
            pixelWidth: 668,
            pixelHeight: 456,
            caption: "图2：论文中的双GPU CNN架构",
          },
        },
      ],
    });

    const archive = await JSZip.loadAsync(bytes);
    const processSlide =
      await archive.files["ppt/slides/slide2.xml"].async("string");
    const narrative = extractTextShapeExtent(processSlide, calloutText);
    const [figure] = extractPictureExtents(processSlide);
    const stageTitleShape = Array.from(
      processSlide.matchAll(/<p:sp>[\s\S]*?<\/p:sp>/g),
    ).find((match) =>
      normalizePresentationText(match[0]).includes("双GPU卷积"),
    )?.[0];

    assert.isDefined(narrative);
    assert.isDefined(figure);
    assert.isString(stageTitleShape);
    assert.include(stageTitleShape!, 'sz="1550"');
    assert.notInclude(stageTitleShape!, 'sz="1800"');
    assert.isAtLeast(
      (figure?.x || 0) - ((narrative?.x || 0) + (narrative?.w || 0)),
      0.34 * 914_400,
    );
  });

  it("keeps only two readable ablation limitations instead of overflowing", async function () {
    const pixel = {
      page: 8,
      mode: "figure" as const,
      data: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      pixelWidth: 1_321,
      pixelHeight: 456,
      caption: "Figure 4: Qualitative evidence",
    };
    const bytes = await renderPresentation({
      title: "Dense ablation contract",
      coverFigure: pixel,
      slides: [
        {
          title: "The model lowers top-5 error",
          layout: "ablation",
          chart: {
            type: "bar",
            orientation: "horizontal",
            labels: ["AlexNet", "Baseline"],
            values: [17, 25.7],
          },
          figure: pixel,
          metrics: [
            { value: "37.5%", label: "top-1" },
            { value: "17.0%", label: "top-5" },
            { value: "15.3%", label: "ensemble" },
          ],
          keyMessage: "VISIBLE_ABLATION_CONCLUSION",
          groups: [
            { title: "HIDDEN_OVERFLOW_GROUP", bullets: ["Redundant detail"] },
          ],
          callouts: [
            {
              label: "Experiment conclusion",
              text: "VISIBLE_EXPERIMENT_CALLOUT shows the strongest result but still depends on an expensive ensemble.",
              tone: "evidence",
            },
            {
              label: "Evidence boundary",
              text: "VISIBLE_LIMIT_CALLOUT explains that visual similarity does not guarantee the correct class label.",
              tone: "risk",
            },
            {
              label: "Ablation finding",
              text: "VISIBLE_DEPTH_CALLOUT records that removing a convolutional layer reduces accuracy.",
              tone: "focus",
            },
          ],
        },
      ],
    });

    const archive = await JSZip.loadAsync(bytes);
    const ablationSlide =
      await archive.files["ppt/slides/slide2.xml"].async("string");
    assert.notInclude(ablationSlide, "VISIBLE_ABLATION_CONCLUSION");
    assert.include(ablationSlide, "VISIBLE_EXPERIMENT_CALLOUT");
    assert.include(ablationSlide, "VISIBLE_LIMIT_CALLOUT");
    assert.notInclude(ablationSlide, "VISIBLE_DEPTH_CALLOUT");
    assert.notInclude(ablationSlide, "HIDDEN_OVERFLOW_GROUP");
    assert.notInclude(ablationSlide, "37.5%");
    assert.include(ablationSlide, "Figure 4: Qualitative evidence");
    assert.include(ablationSlide, "<a:blip");
    const experiment = extractTextShapeExtent(
      ablationSlide,
      "VISIBLE_EXPERIMENT_CALLOUT",
    );
    const limit = extractTextShapeExtent(
      ablationSlide,
      "VISIBLE_LIMIT_CALLOUT",
    );
    assert.isDefined(experiment);
    assert.isDefined(limit);
    assert.isAtMost((experiment?.y || 0) + (experiment?.h || 0), limit?.y || 0);
  });

  it("uses authored metrics as a second evidence tier on a chart-only result", async function () {
    const bytes = await renderPresentation({
      title: "Chart result hierarchy",
      slides: [
        {
          title: "The ensemble establishes a new benchmark",
          layout: "ablation",
          chart: {
            type: "bar",
            orientation: "horizontal",
            labels: ["Ensemble", "Single model", "Previous best"],
            values: [15.3, 18.2, 26.2],
          },
          metrics: [
            { value: "15.3%", label: "top-5 error" },
            { value: "−10.9 pt", label: "vs. previous best" },
          ],
          callouts: [
            {
              label: "Interpretation",
              text: "Ensembling reduces the remaining error.",
            },
          ],
        },
      ],
    });

    const archive = await JSZip.loadAsync(bytes);
    const slideXml =
      await archive.files["ppt/slides/slide2.xml"].async("string");
    const firstMetric = extractTextShapeExtent(slideXml, "15.3%");
    const interpretation = extractTextShapeExtent(
      slideXml,
      "Ensembling reduces the remaining error.",
    );
    assert.isDefined(firstMetric);
    assert.isDefined(interpretation);
    assert.isAtMost(
      (firstMetric?.y || 0) + (firstMetric?.h || 0),
      interpretation?.y || 0,
    );
  });

  it("renders the fixed conclusion contract and removes competing modules", async function () {
    const pixel = {
      page: 1,
      mode: "page" as const,
      data: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      pixelWidth: 668,
      pixelHeight: 456,
      caption: "Source evidence",
    };
    const bytes = await renderPresentation({
      title: "Conclusion field contract",
      slides: [
        {
          title: "Three findings define the research direction",
          layout: "conclusion",
          keyMessage: "HIDDEN_CONCLUSION_MESSAGE",
          figure: pixel,
          callouts: [
            {
              label: "Open question",
              text: "Can deeper models cost less?",
              tone: "focus",
            },
            {
              label: "Limit",
              text: "Does transfer hold beyond ImageNet?",
              tone: "risk",
            },
          ],
          groups: [
            { title: "Learn features", bullets: ["End-to-end learning wins"] },
            { title: "Train at scale", bullets: ["GPU capacity matters"] },
            {
              title: "Prove the gain",
              bullets: ["The benchmark gap is clear"],
            },
          ],
          timeline: [
            { label: "Scale", milestone: "deeper" },
            { label: "Transfer", milestone: "broader" },
            { label: "Video", detail: "next evidence" },
          ],
        },
      ],
    });

    const archive = await JSZip.loadAsync(bytes);
    const conclusionSlide =
      await archive.files["ppt/slides/slide2.xml"].async("string");
    assert.notInclude(conclusionSlide, "HIDDEN_CONCLUSION_MESSAGE");
    assert.notInclude(conclusionSlide, "<a:blip");
    assert.include(conclusionSlide, "Learn features");
    assert.include(conclusionSlide, "Train at scale");
    assert.include(conclusionSlide, "Prove the gain");
    assert.include(conclusionSlide, "Can deeper models cost less?");
    assert.include(
      normalizePresentationText(conclusionSlide),
      "Does transfer hold beyond ImageNet?",
    );
    assert.include(
      normalizePresentationText(conclusionSlide),
      "NEXT RESEARCH STEPS",
    );
    assert.include(conclusionSlide, "next evidence");
    const thirdFinding = extractTextShapeExtent(
      conclusionSlide,
      "The benchmark gap is clear",
    );
    assert.isDefined(thirdFinding);
    assert.isAtMost(
      (thirdFinding?.y || 0) + (thirdFinding?.h || 0),
      4.96 * 914_400,
      "conclusion findings must end above the roadmap divider",
    );
    const roadmapDetail = extractTextShapeExtent(
      conclusionSlide,
      "next evidence",
    );
    assert.isDefined(roadmapDetail);
    assert.isAtLeast(roadmapDetail?.w || 0, 3 * 914_400);
    assert.isAtLeast(roadmapDetail?.h || 0, 0.6 * 914_400);
  });

  it("never keeps a conclusion figure and preserves a stable roadmap", async function () {
    const pixel = {
      page: 1,
      mode: "page" as const,
      data: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      pixelWidth: 668,
      pixelHeight: 456,
      caption: "Source evidence",
    };
    const bytes = await renderPresentation({
      title: "Adaptive conclusion contract",
      slides: [
        {
          title: "The final evidence remains visually substantial",
          layout: "conclusion",
          figure: pixel,
          groups: [
            { title: "Architecture", bullets: ["Supported"] },
            { title: "Optimization", bullets: ["Supported"] },
            { title: "Evaluation", bullets: ["Supported"] },
          ],
          callouts: [
            { label: "Question", text: "Can the model become cheaper?" },
            { label: "Limit", text: "Will transfer remain reliable?" },
          ],
          timeline: [
            { label: "Data", milestone: "scale" },
            { label: "Model", milestone: "depth" },
            { label: "Impact", milestone: "adoption" },
          ],
        },
      ],
    });

    const archive = await JSZip.loadAsync(bytes);
    const conclusionSlide =
      await archive.files["ppt/slides/slide2.xml"].async("string");
    assert.deepEqual(extractPictureExtents(conclusionSlide), []);
    assert.include(conclusionSlide, "Architecture");
    assert.include(conclusionSlide, "Optimization");
    assert.include(conclusionSlide, "Evaluation");
    assert.include(conclusionSlide, "Data");
    assert.include(conclusionSlide, "Model");
    assert.include(conclusionSlide, "Impact");
  });

  it("renders comparison metrics/callouts and process callouts instead of discarding them", async function () {
    const pixel = {
      page: 1,
      mode: "page" as const,
      data: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      pixelWidth: 640,
      pixelHeight: 360,
      caption: "Source evidence",
    };
    const bytes = await renderPresentation({
      title: "Field consumption",
      language: "en-US",
      theme: "academic",
      slides: [
        {
          title: "The new system outperforms the baseline",
          layout: "comparison",
          comparison: {
            left: { title: "Baseline", bullets: ["Handcrafted features"] },
            right: { title: "Method", bullets: ["Learned features"] },
          },
          metrics: [{ value: "+10.9 pt", label: "winning margin" }],
          callouts: [
            { label: "Meaning", text: "The benchmark gap is decisive." },
          ],
          keyMessage: "The learned representation changes the benchmark.",
        },
        {
          title: "The training recipe is reproducible",
          layout: "process",
          process: [
            { title: "Input" },
            { title: "Train" },
            { title: "Evaluate" },
          ],
          figure: pixel,
          callouts: [
            {
              label: "Recipe",
              text: "Momentum 0.9 and weight decay 0.0005 stabilize training.",
              tone: "neutral",
            },
          ],
        },
      ],
    });
    const archive = await JSZip.loadAsync(bytes);
    const comparison =
      await archive.files["ppt/slides/slide2.xml"].async("string");
    const process =
      await archive.files["ppt/slides/slide3.xml"].async("string");
    assert.include(comparison, "+10.9");
    assert.include(comparison, "The benchmark gap is decisive.");
    const comparisonKeyMessage = extractTextShapeExtent(
      comparison,
      "The learned representation changes the benchmark.",
    );
    assert.exists(comparisonKeyMessage);
    assert.isAtMost(
      comparisonKeyMessage!.y + comparisonKeyMessage!.h,
      5.22 * 914_400,
      "comparison key message must stay above the bottom evidence row",
    );
    assert.include(process, "Momentum 0.9");
    assert.include(process, "<a:blip");
  });

  it("turns a comparison callout into a full-width academic takeaway band", async function () {
    const bytes = await renderPresentation({
      title: "AlexNet",
      language: "zh-CN",
      theme: "academic",
      slides: [
        {
          title: "固定特征触及性能天花板",
          layout: "comparison",
          comparison: {
            left: { title: "传统流水线", bullets: ["人工固定特征"] },
            right: { title: "端到端学习", bullets: ["直接学习层级表示"] },
          },
          metrics: [{ value: "−10.9 pt", label: "领先上一名" }],
          callouts: [
            {
              label: "核心转变",
              text: "可学习的层级表示取代了人工设计的特征流水线。",
            },
          ],
        },
      ],
    });
    const archive = await JSZip.loadAsync(bytes);
    const comparison =
      await archive.files["ppt/slides/slide2.xml"].async("string");
    const takeaway = extractTextShapeExtent(
      comparison,
      "可学习的层级表示取代了人工设计的特征流水线。",
    );
    assert.include(comparison, "核心转变");
    assert.exists(takeaway);
    assert.isAbove(
      takeaway!.w,
      9 * 914_400,
      "comparison takeaway should read as one full-width conclusion band",
    );
    assert.isAbove(
      takeaway!.y,
      6.1 * 914_400,
      "comparison takeaway should close the evidence composition near the footer",
    );
  });

  it("canonicalizes overfilled Terra slides again inside the renderer realm", async function () {
    const pixel = {
      page: 1,
      mode: "page" as const,
      data: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      pixelWidth: 640,
      pixelHeight: 360,
    };
    const bytes = await renderPresentation({
      title: "Renderer canonicalization",
      coverFigure: pixel,
      slides: [
        {
          title: "Process layout keeps only visible modules",
          layout: "process",
          figure: pixel,
          process: [
            { title: "Input", detail: "Read evidence" },
            { title: "Output", detail: "Build argument" },
          ],
          metrics: [{ value: "HIDDEN_PROCESS_METRIC", label: "Hidden metric" }],
          bullets: ["HIDDEN_PROCESS_BULLET"],
          keyMessage: "HIDDEN_PROCESS_MESSAGE",
          callouts: [
            { text: "VISIBLE_PROCESS_CALLOUT" },
            { text: "HIDDEN_SECOND_CALLOUT" },
          ],
        },
        {
          title: "Figure layout keeps its narrative",
          layout: "figure",
          figure: pixel,
          bullets: ["VISIBLE_FIGURE_BULLET"],
          keyMessage: "VISIBLE_FIGURE_MESSAGE",
          process: [{ title: "HIDDEN_FIGURE_PROCESS" }],
          metrics: [{ value: "HIDDEN_FIGURE_METRIC", label: "Hidden metric" }],
        },
        {
          title: "Ablation layout keeps one narrative system",
          layout: "ablation",
          chart: {
            type: "bar",
            labels: ["A", "B"],
            values: [2, 1],
          },
          groups: [
            {
              title: "VISIBLE_GROUP",
              bullets: [
                "VISIBLE_FINDING：一条较长的中文结论需要至少两行空间而不能留下孤立句号。",
              ],
            },
          ],
          bullets: ["HIDDEN_DUPLICATE_BULLET"],
          keyMessage: "VISIBLE_ABLATION_MESSAGE",
        },
        {
          title: "Split layout keeps its visible fields",
          layout: "split",
          figure: pixel,
          bullets: ["VISIBLE_SPLIT_BULLET"],
          keyMessage: "VISIBLE_SPLIT_MESSAGE",
          groups: [{ title: "HIDDEN_SPLIT_GROUP", bullets: ["Hidden"] }],
          metrics: [{ value: "HIDDEN_SPLIT_METRIC", label: "Hidden" }],
          process: [{ title: "HIDDEN_SPLIT_PROCESS" }],
          callouts: [{ text: "HIDDEN_SPLIT_CALLOUT" }],
        },
      ],
    });

    const archive = await JSZip.loadAsync(bytes);
    const processSlide =
      await archive.files["ppt/slides/slide2.xml"].async("string");
    const figureSlide =
      await archive.files["ppt/slides/slide3.xml"].async("string");
    const ablationSlide =
      await archive.files["ppt/slides/slide4.xml"].async("string");
    const splitSlide =
      await archive.files["ppt/slides/slide5.xml"].async("string");
    assert.include(processSlide, "VISIBLE_PROCESS_CALLOUT");
    assert.notInclude(processSlide, "HIDDEN_PROCESS_METRIC");
    assert.notInclude(processSlide, "HIDDEN_PROCESS_BULLET");
    assert.notInclude(processSlide, "HIDDEN_PROCESS_MESSAGE");
    assert.notInclude(processSlide, "HIDDEN_SECOND_CALLOUT");
    assert.include(figureSlide, "VISIBLE_FIGURE_BULLET");
    assert.include(figureSlide, "VISIBLE_FIGURE_MESSAGE");
    assert.notInclude(figureSlide, "HIDDEN_FIGURE_PROCESS");
    assert.notInclude(figureSlide, "HIDDEN_FIGURE_METRIC");
    assert.include(ablationSlide, "VISIBLE_GROUP");
    assert.include(normalizePresentationText(ablationSlide), "VISIBLE_FINDING");
    const visibleFinding = extractTextShapeExtent(
      ablationSlide,
      "VISIBLE_FINDING",
    );
    assert.isDefined(visibleFinding);
    assert.isAtLeast(visibleFinding?.h || 0, 0.58 * 914_400);
    assert.notInclude(ablationSlide, "VISIBLE_ABLATION_MESSAGE");
    assert.notInclude(ablationSlide, "HIDDEN_DUPLICATE_BULLET");
    assert.notInclude(splitSlide, "VISIBLE_SPLIT_BULLET");
    assert.include(splitSlide, "VISIBLE_SPLIT_MESSAGE");
    assert.notInclude(splitSlide, "HIDDEN_SPLIT_GROUP");
    assert.notInclude(splitSlide, "HIDDEN_SPLIT_METRIC");
    assert.notInclude(splitSlide, "HIDDEN_SPLIT_PROCESS");
    assert.notInclude(splitSlide, "HIDDEN_SPLIT_CALLOUT");
  });

  it("keeps an ultra-wide process figure above the rendered-area minimum", async function () {
    const data =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const cover = {
      page: 1,
      mode: "figure" as const,
      data,
      pixelWidth: 668,
      pixelHeight: 456,
      caption: "Figure 1: Evidence",
    };
    const pixel = {
      page: 5,
      mode: "figure" as const,
      data,
      pixelWidth: 1_359,
      pixelHeight: 160,
      caption: "Figure 2: Architecture",
    };
    const bytes = await renderPresentation({
      title: "Ultra-wide process contract",
      sourceItemKey: "PAPER1",
      coverFigure: cover,
      slides: [
        {
          title: "The architecture defines the training process",
          layout: "process",
          figure: pixel,
          process: [
            { title: "Input" },
            { title: "Features" },
            { title: "Prediction" },
          ],
          callouts: [{ text: "Two GPUs divide the model." }],
        },
      ],
    });

    const archive = await JSZip.loadAsync(bytes);
    const slideXml =
      await archive.files["ppt/slides/slide2.xml"].async("string");
    const extents = extractPictureExtents(slideXml);
    const renderedArea = extents.reduce(
      (total, extent) => total + extent.w * extent.h,
      0,
    );
    const slideArea = 13.333 * 914_400 * 7.5 * 914_400;
    assert.isAtLeast(renderedArea / slideArea, 0.15);
    assert.isBelow(renderedArea / slideArea, 0.18);
  });

  it("accepts a medium process figure at the scene-aligned area minimum", async function () {
    const data =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const pixel = {
      page: 3,
      mode: "figure" as const,
      data,
      pixelWidth: 668,
      pixelHeight: 456,
      caption: "Figure 1: Training curve",
    };
    const bytes = await renderPresentation({
      title: "Medium process contract",
      sourceItemKey: "PAPER1",
      coverFigure: pixel,
      slides: [
        {
          title: "The training curve supports the process",
          layout: "process",
          figure: pixel,
          process: [
            { title: "Input" },
            { title: "Train" },
            { title: "Evaluate" },
          ],
          callouts: [{ text: "The curve anchors the interpretation." }],
        },
      ],
    });

    const archive = await JSZip.loadAsync(bytes);
    const slideXml =
      await archive.files["ppt/slides/slide2.xml"].async("string");
    const extents = extractPictureExtents(slideXml);
    const renderedArea = extents.reduce(
      (total, extent) => total + extent.w * extent.h,
      0,
    );
    const slideArea = 13.333 * 914_400 * 7.5 * 914_400;
    assert.isAtLeast(renderedArea / slideArea, 0.12);
    assert.isBelow(renderedArea / slideArea, 0.2);
  });

  it("promotes a sparse wide-figure narrative into a full canvas and speaker notes", async function () {
    const data =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const cover = {
      page: 1,
      mode: "figure" as const,
      data,
      pixelWidth: 668,
      pixelHeight: 456,
      caption: "Figure 1: Evidence",
    };
    const figure = {
      page: 5,
      mode: "figure" as const,
      data,
      pixelWidth: 915,
      pixelHeight: 300,
      caption: "Figure 2: Architecture",
    };
    const spec: RenderablePresentationRequest = {
      title: "Wide narrative figure contract",
      sourceItemKey: "PAPER1",
      coverFigure: cover,
      slides: [
        {
          title: "The architecture supports the central claim",
          layout: "figure",
          figure,
          keyMessage: "A concise interpretation remains beside the evidence.",
        },
      ],
    };
    const bytes = await renderPresentation(spec);

    const archive = await JSZip.loadAsync(bytes);
    const slideXml =
      await archive.files["ppt/slides/slide2.xml"].async("string");
    const notesXml =
      await archive.files["ppt/notesSlides/notesSlide2.xml"].async("string");
    const extents = extractPictureExtents(slideXml);
    const renderedArea = extents.reduce(
      (total, extent) => total + extent.w * extent.h,
      0,
    );
    const slideArea = 13.333 * 914_400 * 7.5 * 914_400;
    assert.closeTo(extents[0].w / 914_400, 11.95, 0.02);
    assert.isAtLeast(renderedArea / slideArea, 0.45);
    assert.isBelow(renderedArea / slideArea, 0.49);
    assert.notInclude(slideXml, "A concise interpretation remains beside");
    assert.include(notesXml, "A concise interpretation remains beside");
    const verificationWarnings = await verifyRenderedPresentation(bytes, spec);
    assert.notMatch(
      verificationWarnings.join("\n"),
      /omitted or shortened.*concise interpretation/i,
    );
  });

  it("keeps figures in supported layouts and drops incompatible comparison figures", async function () {
    const pixel = {
      page: 1,
      mode: "page" as const,
      data: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      pixelWidth: 640,
      pixelHeight: 360,
      caption: "Real PDF evidence",
    };
    const bytes = await renderPresentation({
      title: "Mixed evidence layouts",
      designSystem: "teal-green-academic-defense",
      slides: [
        {
          title: "The method diagram grounds the process",
          layout: "process",
          process: [
            { title: "Input" },
            { title: "Transform" },
            { title: "Output" },
          ],
          figure: pixel,
          keyMessage: "The source figure remains visible.",
        },
        {
          title: "The matrix stays connected to source evidence",
          layout: "matrix",
          matrix: {
            columns: ["A", "B"],
            rows: [
              { label: "Signal", cells: ["1", "2"] },
              { label: "Cost", cells: ["low", "high"] },
            ],
          },
          figure: { ...pixel, page: 2 },
        },
        {
          title: "Both sides retain their visual examples",
          layout: "comparison",
          comparison: {
            left: { title: "Before", bullets: ["Baseline"] },
            right: { title: "After", bullets: ["Proposed"] },
          },
          figures: [pixel, { ...pixel, page: 2 }],
        },
        {
          title: "The summary closes with visual evidence",
          layout: "summary",
          bullets: ["Finding one", "Finding two", "Finding three"],
          figure: { ...pixel, page: 3 },
          keyMessage: "The conclusion remains evidence-led.",
        },
      ],
    });

    const archive = await JSZip.loadAsync(bytes);
    for (const slideNumber of [2, 3, 5]) {
      const slideXml =
        await archive.files[`ppt/slides/slide${slideNumber}.xml`].async(
          "string",
        );
      assert.include(
        slideXml,
        "<a:blip",
        `slide ${slideNumber} should retain its supplied PDF figure`,
      );
    }
    const comparisonSlide =
      await archive.files["ppt/slides/slide4.xml"].async("string");
    assert.include(comparisonSlide, "Before");
    assert.include(comparisonSlide, "After");
    assert.notInclude(comparisonSlide, "<a:blip");
  });

  it("composes academic table results as one full-width evidence stage", async function () {
    const pixel = {
      page: 7,
      mode: "figure" as const,
      data: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      pixelWidth: 1_240,
      pixelHeight: 420,
      caption: "Figure 3: learned convolutional filters",
    };
    const keyMessage =
      "Dropout可抑制明显过拟合，但会使收敛所需迭代次数约翻倍。";
    const bytes = await renderPresentation({
      title: "Academic results stage",
      designSystem: "teal-green-academic-defense",
      slides: [
        {
          title: "多项训练与结构设计均带来可测的误差收益",
          layout: "evidence",
          keyMessage,
          table: {
            headers: ["设计", "对照条件", "Top-1误差变化", "Top-5误差变化"],
            rows: [
              [
                "双GPU分工",
                "单GPU、卷积核减半",
                "↓ 1.7个百分点",
                "↓ 1.2个百分点",
              ],
              [
                "局部响应归一化",
                "移除响应归一化",
                "↓ 1.4个百分点",
                "↓ 1.2个百分点",
              ],
              ["重叠池化", "非重叠池化", "↓ 0.4个百分点", "↓ 0.3个百分点"],
            ],
            highlightRow: 0,
          },
          figure: pixel,
        },
        {
          title: "CNN将Top-5误差降至17.0%",
          layout: "evidence",
          table: {
            headers: ["模型", "Top-1误差", "Top-5误差"],
            rows: [
              ["Sparse coding", "47.1%", "28.2%"],
              ["SIFT + FVs", "45.7%", "25.7%"],
              ["CNN", "37.5%", "17.0%"],
            ],
            highlightRow: 2,
          },
          callouts: [
            {
              label: "定性边界",
              text: "部分预测分歧来自照片主体本身的语义歧义。",
            },
          ],
        },
      ],
    });

    const archive = await JSZip.loadAsync(bytes);
    const mixedSlide =
      await archive.files["ppt/slides/slide2.xml"].async("string");
    const tableOnlySlide =
      await archive.files["ppt/slides/slide3.xml"].async("string");
    const claim = extractTextShapeExtent(mixedSlide, "Dropout可抑制明显过拟合");
    const [figure] = extractPictureExtents(mixedSlide);
    const boundary = extractTextShapeExtent(tableOnlySlide, "部分预测分歧来自");
    const resultTable = extractGraphicFrameExtent(tableOnlySlide, "模型");

    assert.isDefined(claim);
    assert.isDefined(figure);
    assert.isDefined(boundary);
    assert.isDefined(resultTable);
    assert.isAtMost(claim!.x, 0.8 * 914_400);
    assert.isAtLeast(claim!.w, 3.8 * 914_400);
    assert.isAtLeast(figure!.w, 6.3 * 914_400);
    assert.isAtMost(resultTable!.x, 1.0 * 914_400);
    assert.isAtLeast(boundary!.w, 10 * 914_400);
    assert.isAbove(boundary!.y, resultTable!.y + resultTable!.h);
  });
});
