import { assert } from "chai";
import JSZip from "jszip";
import { renderPresentation } from "../src/modules/presentation/renderer/PptxPresentationExporter.ts";
import {
  nextPresentationAnimationObjectName,
  parsePresentationAnimationObjectName,
} from "../src/modules/presentation/renderer/PresentationAnimationNames.ts";
import {
  MAX_ANIMATIONS_PER_SLIDE,
  planPresentationSlideAnimations,
  type PresentationAnimationTarget,
} from "../src/modules/presentation/renderer/PresentationAnimationPolicy.ts";
import {
  applyAnimationsToSlideXml,
  applyPresentationAnimations,
  applyPresentationAnimationsToSlideXml,
  buildTimingXml,
} from "../src/modules/presentation/renderer/PresentationPptxAnimations.ts";

const SIMPLE_SLIDE_PREFIX =
  '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">';

function namedShape(id: number, name: string): string {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/></p:sp>`;
}

function slideWithNamedShapes(names: readonly string[]): string {
  return `${SIMPLE_SLIDE_PREFIX}<p:cSld><p:spTree>${names
    .map((name, index) => namedShape(index + 4, name))
    .join(
      "",
    )}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr><p:transition><p:fade/></p:transition></p:sld>`;
}

describe("presentation element animations", function () {
  describe("policy", function () {
    it("allocates parseable slide-local semantic names", function () {
      const slide = {} as Parameters<
        typeof nextPresentationAnimationObjectName
      >[0];
      const first = nextPresentationAnimationObjectName(
        slide,
        "evidence-visual",
      );
      const second = nextPresentationAnimationObjectName(
        slide,
        "evidence-visual",
      );
      assert.equal(first, "paperchat.anim.evidence-visual.1");
      assert.equal(second, "paperchat.anim.evidence-visual.2");
      assert.deepEqual(parsePresentationAnimationObjectName(first), {
        role: "evidence-visual",
        ordinal: 1,
      });
      assert.isUndefined(parsePresentationAnimationObjectName("Image 1"));
    });

    it("keeps the animation policy bounded and prioritizes narrative anchors", function () {
      const targets = planPresentationSlideAnimations(
        [
          "paperchat.anim.evidence-visual.1",
          "paperchat.anim.key-message.1",
          "paperchat.anim.content-title.1",
          "paperchat.anim.chart.1",
          "paperchat.anim.evidence-visual.2",
        ],
        3,
      );
      assert.lengthOf(targets, MAX_ANIMATIONS_PER_SLIDE);
      assert.deepEqual(
        targets.map((target) => target.role),
        ["content-title", "key-message", "evidence-visual"],
      );
      assert.equal(targets[0].effect, "fade");
      assert.equal(targets[2].effect, "fly");
    });
  });

  describe("PPTX XML", function () {
    it("writes fade, fly, and zoom timing targets with legal root ordering", function () {
      const targets: (PresentationAnimationTarget & { spid: number })[] = [
        {
          name: "paperchat.anim.content-title.1",
          role: "content-title",
          ordinal: 1,
          effect: "fade",
          durationMs: 450,
          spid: 4,
        },
        {
          name: "paperchat.anim.evidence-visual.1",
          role: "evidence-visual",
          ordinal: 1,
          effect: "fly",
          durationMs: 550,
          direction: "fromLeft",
          spid: 5,
        },
        {
          name: "paperchat.anim.chart.1",
          role: "chart",
          ordinal: 1,
          effect: "zoom",
          durationMs: 600,
          spid: 6,
        },
      ];
      const timing = buildTimingXml(targets);
      assert.include(timing, 'presetID="10"');
      assert.include(timing, 'presetID="2"');
      assert.include(timing, 'presetID="23"');
      assert.include(timing, 'filter="fade"');
      assert.include(timing, "<p:attrName>ppt_x</p:attrName>");
      assert.include(timing, "<p:attrName>ppt_w</p:attrName>");
      assert.include(timing, '<p:bldP spid="4"');
      assert.include(timing, '<p:bldP spid="6"');
    });

    it("resolves semantic names to shape ids and preserves transitions", function () {
      const xml = slideWithNamedShapes([
        "paperchat.anim.content-title.1",
        "paperchat.anim.evidence-visual.1",
      ]);
      const patched = applyPresentationAnimationsToSlideXml(xml, 3);
      assert.lengthOf(patched.match(/<p:timing\b/gu) || [], 1);
      assert.include(patched, '<p:spTgt spid="4"/>');
      assert.include(patched, '<p:spTgt spid="5"/>');
      assert.isBelow(
        patched.indexOf("<p:transition"),
        patched.indexOf("<p:timing"),
      );
      assert.isBelow(
        patched.indexOf("</p:cSld>"),
        patched.indexOf("<p:transition"),
      );
    });

    it("does not duplicate timing when a slide already has timing XML", function () {
      const xml = `${slideWithNamedShapes([
        "paperchat.anim.content-title.1",
      ]).replace("</p:sld>", "<p:timing><p:tnLst/></p:timing></p:sld>")}`;
      assert.equal(applyPresentationAnimationsToSlideXml(xml), xml);
    });

    it("skips ambiguous semantic names without blocking other static content", function () {
      const xml = `${SIMPLE_SLIDE_PREFIX}<p:cSld><p:spTree>${namedShape(
        4,
        "paperchat.anim.content-title.1",
      )}${namedShape(5, "paperchat.anim.content-title.1")}</p:spTree></p:cSld></p:sld>`;
      const result = applyAnimationsToSlideXml(xml, 1);
      assert.lengthOf(result.warnings, 1);
      assert.equal(result.injectedAnimations, 0);
      assert.notInclude(result.xml, "<p:timing");
    });

    it("fails open per slide when timing insertion cannot parse the slide root", async function () {
      const archive = new JSZip();
      const malformed = `${SIMPLE_SLIDE_PREFIX}${namedShape(
        4,
        "paperchat.anim.content-title.1",
      )}</p:sld>`;
      archive.file("ppt/slides/slide1.xml", malformed);
      const input = await archive.generateAsync({ type: "uint8array" });
      const result = await applyPresentationAnimations(input);
      const output = await JSZip.loadAsync(result.bytes);
      assert.include(result.warnings.join("\n"), "slide 1");
      assert.equal(
        await output.files["ppt/slides/slide1.xml"].async("string"),
        malformed,
      );
    });
  });

  describe("exporter integration", function () {
    it("writes timing for generated semantic elements without changing static export", async function () {
      const bytes = await renderPresentation({
        title: "Animation integration",
        slides: [
          { title: "First evidence", keyMessage: "A grounded finding" },
          { title: "Second evidence", keyMessage: "A second finding" },
        ],
      });
      const archive = await JSZip.loadAsync(bytes);
      for (const path of [
        "ppt/slides/slide1.xml",
        "ppt/slides/slide2.xml",
        "ppt/slides/slide3.xml",
      ]) {
        const xml = await archive.files[path].async("string");
        assert.lengthOf(xml.match(/<p:transition\b/gu) || [], 1);
        assert.lengthOf(xml.match(/<p:timing\b/gu) || [], 1);
        assert.include(xml, "paperchat.anim.");
      }
    });
  });
});
