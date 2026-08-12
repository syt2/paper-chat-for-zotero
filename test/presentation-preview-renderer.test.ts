import { assert } from "chai";
import PptxGenJS from "pptxgenjs";
import { renderPresentationSlideSvgs } from "../src/modules/presentation/renderer/PresentationPreviewRenderer.ts";

describe("presentation preview renderer", function () {
  it("renders the same PptxGenJS scene into a visual-review SVG", function () {
    const presentation = new PptxGenJS();
    presentation.layout = "LAYOUT_WIDE";
    const slide = presentation.addSlide();
    slide.background = { color: "0B0C0D" };
    slide.addShape(presentation.ShapeType.rect, {
      x: 0.5,
      y: 0.5,
      w: 4,
      h: 1.2,
      fill: { color: "EAF5F3" },
      line: { color: "009B84" },
    });
    slide.addText("Evidence owns the canvas", {
      x: 0.7,
      y: 0.7,
      w: 3.6,
      h: 0.7,
      fontSize: 28,
      bold: true,
      color: "102128",
    });
    slide.addImage({
      data: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=",
      x: 5,
      y: 0.8,
      w: 2,
      h: 2,
    });
    slide.addChart(
      presentation.ChartType.bar,
      [{ name: "Error", labels: ["Prior", "AlexNet"], values: [26.2, 15.3] }],
      {
        x: 0.8,
        y: 2.2,
        w: 5.2,
        h: 2.6,
        barDir: "bar",
        chartColors: ["009B84", "E26A00"],
      },
    );
    slide.addTable(
      [
        ["Model", "Top-5"],
        ["AlexNet", "15.3%"],
      ],
      { x: 7.4, y: 3.2, w: 4.4, h: 1.4 },
    );

    const [svg] = renderPresentationSlideSvgs(presentation);

    assert.include(svg, 'viewBox="0 0 1600 900"');
    assert.include(svg, '<rect width="100%" height="100%" fill="#0B0C0D"/>');
    assert.include(svg, "Evidence owns the");
    assert.include(svg, "canvas");
    assert.include(svg, "data:image/png;base64");
    assert.include(svg, "Prior");
    assert.include(svg, "AlexNet");
    assert.include(svg, "15.3%");
  });

  it("previews cover-sized images at their final PPTX extent", function () {
    const presentation = new PptxGenJS();
    presentation.layout = "LAYOUT_WIDE";
    const slide = presentation.addSlide();
    slide.addImage({
      data: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=",
      x: 7.7,
      y: 3.63,
      w: 966 / 96,
      h: 380 / 96,
      sizing: { type: "cover", w: 4.86, h: 2.71 },
    });

    const [svg] = renderPresentationSlideSvgs(presentation);
    const image = svg.match(
      /<image[^>]+width="([\d.]+)"[^>]+height="([\d.]+)"[^>]+preserveAspectRatio="([^"]+)"/,
    );

    assert.isNotNull(image);
    assert.closeTo(Number(image?.[1]), (4.86 / 13.333) * 1600, 0.1);
    assert.closeTo(Number(image?.[2]), (2.71 / 7.5) * 900, 0.1);
    assert.equal(image?.[3], "xMidYMid slice");
  });
});
