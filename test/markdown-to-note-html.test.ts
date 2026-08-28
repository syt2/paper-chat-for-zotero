import { assert } from "chai";
import { markdownToNoteHtml } from "../src/utils/markdownToNoteHtml.ts";

describe("markdownToNoteHtml", function () {
  it("renders ordinary Markdown as Zotero note HTML", function () {
    const html = markdownToNoteHtml(
      "## 核心总结\n\n这是 **PaperChat**。\n\n- 结论一\n- 结论二\n\n---",
    );

    assert.include(html, "<h2>核心总结</h2>");
    assert.include(html, "<strong>PaperChat</strong>");
    assert.include(html, "<ul>");
    assert.match(html, /<hr\s*\/>/);
  });

  it("escapes raw HTML and does not embed remote images", function () {
    const html = markdownToNoteHtml(
      '<script>alert("x")</script>\n\n![plot](https://example.invalid/track.png)',
    );

    assert.notInclude(html, "<script>");
    assert.include(html, "&lt;script&gt;");
    assert.notInclude(html, "<img");
    assert.include(
      html,
      '<a href="https://example.invalid/track.png">plot</a>',
    );
  });

  it("only emits links for explicitly allowed destinations", function () {
    const html = markdownToNoteHtml(
      [
        "[web](https://example.com/paper)",
        "[email](mailto:author@example.com)",
        "[section](#results)",
        "[share](smb://server/share)",
        "[settings](x-apple.systempreferences:com.apple.preference.security)",
        "[chrome](chrome://global/content/)",
        "[resource](resource://zotero/)",
        "[action](zotero://select/library/items/ABC12345)",
        "![pixel](data:image/png;base64,AAAA)",
      ].join("\n\n"),
    );

    assert.include(html, 'href="https://example.com/paper"');
    assert.include(html, 'href="mailto:author@example.com"');
    assert.include(html, 'href="#results"');
    for (const scheme of [
      "smb:",
      "x-apple.systempreferences:",
      "chrome:",
      "resource:",
      "zotero:",
      "data:",
    ]) {
      assert.notInclude(html, `href="${scheme}`);
    }
    assert.notInclude(html, "<img");
  });

  it("emits editable Zotero inline math with escaped content", function () {
    const html = markdownToNoteHtml(
      "The update is $h'(t) = Ah(t) + Bx(t) \\quad \\text{if } x < y$.",
    );

    assert.include(html, '<span class="math">$h\'(t) = Ah(t) + Bx(t)');
    assert.include(html, "x &lt; y$</span>");
    assert.notInclude(html, "<i>h</i>");
  });

  it("emits display and bracket-delimited Zotero math blocks", function () {
    const dollars = markdownToNoteHtml("$$\ny = Ax + b\nz = Cy\n$$");
    const brackets = markdownToNoteHtml("\\[\ny = \\mathbb{R}^n\n\\]");

    assert.equal(dollars, '<pre class="math">$$y = Ax + b\nz = Cy$$</pre>');
    assert.equal(brackets, '<pre class="math">$$y = \\mathbb{R}^n$$</pre>');
  });

  it("lets display math interrupt a paragraph without a blank line", function () {
    const html = markdownToNoteHtml("Result:\n$$\nx\n$$\nConclusion.");

    assert.equal(
      html,
      '<p>Result:</p>\n<pre class="math">$$x$$</pre>\n<p>Conclusion.</p>',
    );
  });

  it("recognizes display math inside list items and blockquotes", function () {
    const list = markdownToNoteHtml("- Result:\n  $$\n  x\n  $$");
    const quote = markdownToNoteHtml("> Result:\n> $$\n> y\n> $$");

    assert.include(list, '<pre class="math">$$x$$</pre>');
    assert.notInclude(list, "<p>$$");
    assert.include(quote, '<pre class="math">$$y$$</pre>');
    assert.notInclude(quote, "<p>$$");
  });

  it("supports bracket-delimited inline math", function () {
    const html = markdownToNoteHtml("Use \\(x_t + y_t\\) here.");
    assert.include(html, '<span class="math">$x_t + y_t$</span>');
  });

  it("supports adjacent dollar-delimited inline formulas", function () {
    const html = markdownToNoteHtml("$x$$y$");

    assert.include(
      html,
      '<span class="math">$x$</span><span class="math">$y$</span>',
    );
  });

  it("keeps heading math literal for Zotero note schema compatibility", function () {
    const html = markdownToNoteHtml(
      "## Derivative $f'(x)$ and sequence $x--y...z$",
    );

    assert.equal(html, "<h2>Derivative $f'(x)$ and sequence $x--y...z$</h2>");
    assert.notInclude(html, 'class="math"');
  });

  it("leaves escaped, code, empty, and unclosed delimiters literal", function () {
    const html = markdownToNoteHtml(
      "Cost \\$5; code `$x$`; empty $$; unclosed $value.",
    );

    assert.include(html, "Cost $5");
    assert.include(html, "<code>$x$</code>");
    assert.notInclude(html, 'class="math"');
    assert.include(html, "unclosed $value");
  });

  it("does not turn multi-line inline delimiters into malformed math nodes", function () {
    const html = markdownToNoteHtml(
      "Inline $x +\ny$ stays text.\n\nBracket \\(a +\nb\\) also stays text.",
    );

    assert.notInclude(html, 'class="math"');
    assert.include(html, "$x +");
    assert.include(html, "y$");
    assert.include(html, "(a +");
    assert.include(html, "b)");
  });

  it("does not mistake ordinary currency amounts for inline math", function () {
    const html = markdownToNoteHtml(
      "The fee is $5 and the cap is $10; alternatives cost $20-$30.",
    );

    assert.notInclude(html, 'class="math"');
    assert.include(html, "$5");
    assert.include(html, "$10");
    assert.include(html, "$20-$30");
  });

  it("preserves leading indentation so an initial code block stays code", function () {
    const html = markdownToNoteHtml("    $x$\n\n    $$y$$");

    assert.include(html, "<pre><code>$x$\n\n$$y$$");
    assert.notInclude(html, 'class="math"');
  });
});
