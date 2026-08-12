import { assert } from "chai";
import {
  estimateTextBoxHeight,
  estimateWrappedLineCount,
  layoutFigureCaption,
  layoutTimelineColumns,
  protectPresentationInlineTokens,
  protectPresentationQuantities,
  protectPresentationVisibleText,
  wrapMixedScriptTitle,
} from "../src/modules/presentation/renderer/PresentationTextLayout.ts";
import { resolvePresentationTableLayout } from "../src/modules/presentation/renderer/PresentationTableLayout.ts";

describe("presentation text layout", function () {
  it("keeps a concise caption intact", function () {
    const layout = layoutFigureCaption("Figure 2: CNN architecture.", 7.2);

    assert.equal(layout.text, "Figure 2: CNN architecture.");
    assert.equal(layout.height, 0.34);
  });

  it("turns a long narrow paper caption into a readable editorial caption", function () {
    const layout = layoutFigureCaption(
      "Figure 4: Eight test-set predictions and the six nearest training images in the final hidden-layer feature space, demonstrating semantic similarity despite large visual differences and several remaining fine-grained ambiguities.",
      3.66,
    );

    assert.match(layout.text, /^Figure 4:/);
    assert.notInclude(layout.text, "…");
    assert.match(layout.text, /[.]$/);
    assert.notInclude(layout.text, "remaining fine-grained ambiguities");
    assert.isAtLeast(layout.height, 0.48);
  });

  it("recognizes process details that need more than two lines", function () {
    const lines = estimateWrappedLineCount(
      "Conv3 uses 384 kernels; Conv4 uses 384 kernels; Conv5 uses 256 kernels and connects the two GPU streams before classification.",
      2.49,
      8.6,
    );

    assert.isAtLeast(lines, 3);
  });

  it("counts CJK wrapping and explicit newlines instead of treating them as one word", function () {
    const cjkLines = estimateWrappedLineCount(
      "大型监督式深度卷积神经网络在ImageNet数据集上显著降低分类错误率",
      2,
      18,
    );
    const explicitLines = estimateWrappedLineCount(
      "第一条结论\n第二条结论",
      8,
      18,
    );

    assert.isAtLeast(cjkLines, 4);
    assert.equal(explicitLines, 2);
    assert.isAtLeast(
      estimateTextBoxHeight("第一条结论\n第二条结论", 8, 18),
      0.58,
    );
  });

  it("moves a mixed-script scientific token intact to the next cover-title line", function () {
    const title = wrapMixedScriptTitle(
      "深度卷积网络如何改写ImageNet分类",
      8.8,
      46,
    );

    assert.equal(title, "深度卷积网络如何改写\nImageNet分类");
    assert.notInclude(title, "ImageN\net");
  });

  it("keeps a short CJK title word intact when balancing cover lines", function () {
    const title = wrapMixedScriptTitle(
      "AlexNet跨越算力边界，开启大规模视觉学习",
      8.8,
      46,
    );

    assert.include(title, "跨越");
    assert.notInclude(title, "跨\n越");
    assert.isAtLeast(title.split("\n").length, 2);
  });

  it("moves a scientific token down instead of leaving a two-character cover orphan", function () {
    const title = wrapMixedScriptTitle(
      "利用深度卷积神经网络进行 ImageNet 分类",
      8.8,
      46,
    );

    assert.include(title, "\nImageNet 分类");
    assert.notMatch(title, /ImageNet\n分类/u);
  });

  it("keeps scientific numbers attached to their units in CJK copy", function () {
    const protectedText = protectPresentationQuantities(
      "约 65 万神经元、6000 万参数、3GB 显存与 17.0% 错误率",
    );

    assert.include(protectedText, `${Array.from("65").join("\u2060")}\u00a0万`);
    assert.include(
      protectedText,
      `${Array.from("6000").join("\u2060")}\u00a0万`,
    );
    assert.include(protectedText, `3\u2060GB`);
    assert.include(
      protectedText,
      `${Array.from("17.0").join("\u2060")}\u2060%`,
    );
    assert.equal(
      protectedText.replace(/\u2060/g, "").replace(/\u00a0/g, " "),
      "约 65 万神经元、6000 万参数、3GB 显存与 17.0% 错误率",
    );
  });

  it("keeps grouped classifier counts intact inside CJK process titles", function () {
    const protectedText = protectPresentationQuantities(
      "3个全连接层→1,000路softmax",
    );

    assert.include(
      protectedText,
      `${Array.from("1,000").join("\u2060")}\u2060路`,
    );
    assert.equal(
      protectedText.replace(/\u2060/g, ""),
      "3个全连接层→1,000路softmax",
    );
  });

  it("keeps Latin scientific terms indivisible inside process copy", function () {
    const protectedText = protectPresentationInlineTokens(
      "使用 dropout 正则化并在 ImageNet 上训练",
    );

    assert.include(protectedText, Array.from("dropout").join("\u2060"));
    assert.include(protectedText, Array.from("ImageNet").join("\u2060"));
    assert.equal(
      protectedText.replace(/\u2060/g, ""),
      "使用 dropout 正则化并在 ImageNet 上训练",
    );
  });

  it("keeps short acronyms, hyphenated metrics, and evidence labels indivisible", function () {
    const protectedText = protectPresentationInlineTokens(
      "CNN reaches a lower Top-5 error in Table 1.",
    );

    assert.include(protectedText, Array.from("CNN").join("\u2060"));
    assert.include(protectedText, Array.from("Top-5").join("\u2060"));
    assert.include(protectedText, Array.from("Table\u00a01").join("\u2060"));
    assert.equal(
      protectedText.replace(/[\u2060\u00a0]/g, (value) =>
        value === "\u00a0" ? " " : "",
      ),
      "CNN reaches a lower Top-5 error in Table 1.",
    );
  });

  it("keeps mixed-case scientific terms indivisible in plain Latin copy", function () {
    const protectedText = protectPresentationVisibleText(
      "ReLU and ImageNet improve Top-5 error.",
    );

    assert.include(protectedText, Array.from("ReLU").join("\u2060"));
    assert.include(protectedText, Array.from("ImageNet").join("\u2060"));
    const ordinaryTitle = protectPresentationVisibleText(
      "Academic paper cover",
    );
    assert.equal(ordinaryTitle, "Academic paper cover");
    assert.equal(
      protectedText.replace(/\u2060/g, ""),
      "ReLU and ImageNet improve Top-5 error.",
    );
  });

  it("keeps closing CJK punctuation attached inside narrow conclusion copy", function () {
    const protectedText =
      protectPresentationVisibleText("启示：更大模型仍需更多标注数据。");

    assert.include(protectedText, `数据\u2060。`);
    assert.equal(
      protectedText.replace(/[\u2060\u00a0]/g, (value) =>
        value === "\u00a0" ? " " : "",
      ),
      "启示：更大模型仍需更多标注数据。",
    );
  });

  it("gives a three-step conclusion timeline readable equal-width columns", function () {
    const columns = layoutTimelineColumns(3);

    assert.lengthOf(columns, 3);
    assert.isAtLeast(columns[0].boxWidth, 3);
    assert.closeTo(columns[1].markerX, 6.66, 0.01);
    assert.isAbove(columns[2].boxX, columns[1].boxX);
  });

  it("lets a small academic table fill its dominant evidence region", function () {
    const compact = resolvePresentationTableLayout(5, 3, 4.88);
    const dense = resolvePresentationTableLayout(9, 6, 4.88);

    assert.equal(compact.fontSize, 13.5);
    assert.closeTo(compact.rowHeight, 4.88 / 6, 0.001);
    assert.isAbove(compact.rowHeight, 0.8);
    assert.equal(dense.fontSize, 9.5);
    assert.isAtMost(dense.rowHeight, 0.52);
  });
});
