/**
 * MarkdownRenderer - Convert markdown to DOM elements (XHTML-safe)
 */

import MarkdownIt from "markdown-it";
import hljs from "highlight.js";
import { chatColors } from "../../../utils/colors";
import { HTML_NS } from "./types";
import { isDarkMode } from "./ChatPanelTheme";

// Initialize markdown-it with XHTML output
const md = new MarkdownIt({
  html: true,
  breaks: true,
  xhtmlOut: true,
  typographer: true,
  linkify: true,
});

/**
 * Render markdown content to DOM elements directly
 * This avoids XHTML parsing issues by building elements programmatically
 */
export function renderMarkdownToElement(
  element: HTMLElement,
  markdownContent: string,
): void {
  element.textContent = "";
  const doc = element.ownerDocument;
  if (!doc) return;

  const tokens = md.parse(markdownContent, {});
  const container = buildDOMFromTokens(doc, tokens);

  while (container.firstChild) {
    element.appendChild(container.firstChild);
  }
}

/**
 * Build DOM elements from markdown-it tokens
 */
export function buildDOMFromTokens(
  doc: Document,
  tokens: ReturnType<typeof md.parse>,
): HTMLElement {
  const container = doc.createElementNS(HTML_NS, "div") as HTMLElement;
  const stack: HTMLElement[] = [container];

  for (const token of tokens) {
    const parent = stack[stack.length - 1];

    switch (token.type) {
      case "paragraph_open": {
        const p = doc.createElementNS(HTML_NS, "p") as HTMLElement;
        parent.appendChild(p);
        stack.push(p);
        break;
      }
      case "paragraph_close":
        stack.pop();
        break;

      case "heading_open": {
        const h = doc.createElementNS(HTML_NS, token.tag) as HTMLElement;
        parent.appendChild(h);
        stack.push(h);
        break;
      }
      case "heading_close":
        stack.pop();
        break;

      case "bullet_list_open": {
        const ul = doc.createElementNS(HTML_NS, "ul") as HTMLElement;
        parent.appendChild(ul);
        stack.push(ul);
        break;
      }
      case "bullet_list_close":
        stack.pop();
        break;

      case "ordered_list_open": {
        const ol = doc.createElementNS(HTML_NS, "ol") as HTMLElement;
        parent.appendChild(ol);
        stack.push(ol);
        break;
      }
      case "ordered_list_close":
        stack.pop();
        break;

      case "list_item_open": {
        const li = doc.createElementNS(HTML_NS, "li") as HTMLElement;
        parent.appendChild(li);
        stack.push(li);
        break;
      }
      case "list_item_close":
        stack.pop();
        break;

      case "blockquote_open": {
        const bq = doc.createElementNS(HTML_NS, "blockquote") as HTMLElement;
        bq.style.borderLeft = `3px solid ${chatColors.blockquoteBorder}`;
        bq.style.paddingLeft = "10px";
        bq.style.margin = "10px 0";
        bq.style.color = chatColors.blockquoteText;
        parent.appendChild(bq);
        stack.push(bq);
        break;
      }
      case "blockquote_close":
        stack.pop();
        break;

      case "code_block":
      case "fence": {
        const pre = doc.createElementNS(HTML_NS, "pre") as HTMLElement;
        const code = doc.createElementNS(HTML_NS, "code") as HTMLElement;

        // Get language from fence info (e.g., ```javascript)
        const lang = token.info?.trim() || "";

        // Apply dark/light theme styles
        const dark = isDarkMode();
        pre.style.background = dark ? "#1e1e1e" : "#f6f8fa";
        pre.style.color = dark ? "#d4d4d4" : "#24292e";
        pre.style.padding = "12px";
        pre.style.borderRadius = "6px";
        pre.style.overflow = "auto";
        pre.style.fontSize = "13px";
        pre.style.fontFamily =
          "'SF Mono', Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace";
        pre.style.lineHeight = "1.45";
        pre.style.margin = "8px 0";

        // Try to highlight with language detection
        try {
          let highlighted: string;
          if (lang && hljs.getLanguage(lang)) {
            highlighted = hljs.highlight(token.content, {
              language: lang,
            }).value;
          } else {
            highlighted = hljs.highlightAuto(token.content).value;
          }
          // Safely convert highlight.js HTML to DOM elements
          renderHighlightedCode(doc, code, highlighted, dark);
        } catch {
          // Fallback to plain text if highlighting fails
          code.textContent = token.content;
        }

        pre.appendChild(code);
        parent.appendChild(pre);
        break;
      }

      case "hr": {
        const hr = doc.createElementNS(HTML_NS, "hr") as HTMLElement;
        hr.style.border = "none";
        hr.style.borderTop = `1px solid ${chatColors.hrBorder}`;
        hr.style.margin = "15px 0";
        parent.appendChild(hr);
        break;
      }

      case "table_open": {
        const table = doc.createElementNS(HTML_NS, "table") as HTMLElement;
        table.style.borderCollapse = "collapse";
        table.style.width = "100%";
        table.style.margin = "10px 0";
        table.style.fontSize = "12px";
        parent.appendChild(table);
        stack.push(table);
        break;
      }
      case "table_close":
        stack.pop();
        break;

      case "thead_open": {
        const thead = doc.createElementNS(HTML_NS, "thead") as HTMLElement;
        parent.appendChild(thead);
        stack.push(thead);
        break;
      }
      case "thead_close":
        stack.pop();
        break;

      case "tbody_open": {
        const tbody = doc.createElementNS(HTML_NS, "tbody") as HTMLElement;
        parent.appendChild(tbody);
        stack.push(tbody);
        break;
      }
      case "tbody_close":
        stack.pop();
        break;

      case "tr_open": {
        const tr = doc.createElementNS(HTML_NS, "tr") as HTMLElement;
        parent.appendChild(tr);
        stack.push(tr);
        break;
      }
      case "tr_close":
        stack.pop();
        break;

      case "th_open": {
        const th = doc.createElementNS(HTML_NS, "th") as HTMLElement;
        th.style.border = `1px solid ${chatColors.tableBorder}`;
        th.style.padding = "8px";
        th.style.background = chatColors.tableBg;
        th.style.fontWeight = "bold";
        th.style.textAlign = "left";
        parent.appendChild(th);
        stack.push(th);
        break;
      }
      case "th_close":
        stack.pop();
        break;

      case "td_open": {
        const td = doc.createElementNS(HTML_NS, "td") as HTMLElement;
        td.style.border = `1px solid ${chatColors.tableBorder}`;
        td.style.padding = "8px";
        parent.appendChild(td);
        stack.push(td);
        break;
      }
      case "td_close":
        stack.pop();
        break;

      case "inline":
        if (token.children) {
          renderInlineTokens(doc, parent, token.children);
        }
        break;

      case "softbreak":
        parent.appendChild(doc.createTextNode(" "));
        break;

      case "hardbreak":
        parent.appendChild(doc.createElementNS(HTML_NS, "br"));
        break;
    }
  }

  return container;
}

/**
 * Render inline tokens (text, bold, italic, code, links, etc.)
 */
export function renderInlineTokens(
  doc: Document,
  parent: HTMLElement,
  tokens: ReturnType<typeof md.parse>,
): void {
  const stack: HTMLElement[] = [parent];

  for (const token of tokens) {
    const current = stack[stack.length - 1];

    switch (token.type) {
      case "text":
        current.appendChild(doc.createTextNode(token.content));
        break;

      case "strong_open": {
        const strong = doc.createElementNS(HTML_NS, "strong") as HTMLElement;
        current.appendChild(strong);
        stack.push(strong);
        break;
      }
      case "strong_close":
        stack.pop();
        break;

      case "em_open": {
        const em = doc.createElementNS(HTML_NS, "em") as HTMLElement;
        current.appendChild(em);
        stack.push(em);
        break;
      }
      case "em_close":
        stack.pop();
        break;

      case "s_open": {
        const s = doc.createElementNS(HTML_NS, "s") as HTMLElement;
        current.appendChild(s);
        stack.push(s);
        break;
      }
      case "s_close":
        stack.pop();
        break;

      case "code_inline": {
        const codeInline = doc.createElementNS(HTML_NS, "code") as HTMLElement;
        codeInline.style.background = chatColors.codeInlineBg;
        codeInline.style.padding = "2px 6px";
        codeInline.style.borderRadius = "3px";
        codeInline.style.fontFamily = "monospace";
        codeInline.style.fontSize = "0.9em";
        codeInline.textContent = token.content;
        current.appendChild(codeInline);
        break;
      }

      case "link_open": {
        const a = doc.createElementNS(HTML_NS, "a") as HTMLAnchorElement;
        const href = token.attrGet("href");
        if (href) a.href = href;
        a.style.color = chatColors.markdownLink;
        a.style.textDecoration = "underline";
        current.appendChild(a);
        stack.push(a);
        break;
      }
      case "link_close":
        stack.pop();
        break;

      case "softbreak":
        current.appendChild(doc.createTextNode(" "));
        break;

      case "hardbreak":
        current.appendChild(doc.createElementNS(HTML_NS, "br"));
        break;
    }
  }
}

/**
 * Highlight.js color themes for syntax highlighting
 */
const highlightColors = {
  light: {
    keyword: "#d73a49", // red - if, const, return
    string: "#032f62", // dark blue - "strings"
    number: "#005cc5", // blue - 123
    comment: "#6a737d", // gray - // comments
    function: "#6f42c1", // purple - function names
    class: "#6f42c1", // purple - class names
    variable: "#e36209", // orange - variables
    operator: "#d73a49", // red - =, +, -
    punctuation: "#24292e", // black - {, }, (, )
    property: "#005cc5", // blue - object properties
    builtin: "#005cc5", // blue - built-in functions
    attr: "#22863a", // green - attributes
    tag: "#22863a", // green - HTML tags
    selector: "#6f42c1", // purple - CSS selectors
    type: "#d73a49", // red - type names
    literal: "#005cc5", // blue - true, false, null
    meta: "#6a737d", // gray - meta info
    regexp: "#032f62", // dark blue - regex
    symbol: "#e36209", // orange - symbols
  },
  dark: {
    keyword: "#ff7b72", // red - if, const, return
    string: "#a5d6ff", // light blue - "strings"
    number: "#79c0ff", // blue - 123
    comment: "#8b949e", // gray - // comments
    function: "#d2a8ff", // purple - function names
    class: "#d2a8ff", // purple - class names
    variable: "#ffa657", // orange - variables
    operator: "#ff7b72", // red - =, +, -
    punctuation: "#c9d1d9", // light gray - {, }, (, )
    property: "#79c0ff", // blue - object properties
    builtin: "#79c0ff", // blue - built-in functions
    attr: "#7ee787", // green - attributes
    tag: "#7ee787", // green - HTML tags
    selector: "#d2a8ff", // purple - CSS selectors
    type: "#ff7b72", // red - type names
    literal: "#79c0ff", // blue - true, false, null
    meta: "#8b949e", // gray - meta info
    regexp: "#a5d6ff", // light blue - regex
    symbol: "#ffa657", // orange - symbols
  },
} as const;

/**
 * Map highlight.js class names to color keys
 */
const classToColorKey: Record<string, keyof typeof highlightColors.light> = {
  "hljs-keyword": "keyword",
  "hljs-string": "string",
  "hljs-number": "number",
  "hljs-comment": "comment",
  "hljs-function": "function",
  "hljs-class": "class",
  "hljs-variable": "variable",
  "hljs-operator": "operator",
  "hljs-punctuation": "punctuation",
  "hljs-property": "property",
  "hljs-built_in": "builtin",
  "hljs-attr": "attr",
  "hljs-tag": "tag",
  "hljs-selector-tag": "selector",
  "hljs-selector-class": "selector",
  "hljs-selector-id": "selector",
  "hljs-type": "type",
  "hljs-literal": "literal",
  "hljs-meta": "meta",
  "hljs-regexp": "regexp",
  "hljs-symbol": "symbol",
  "hljs-title": "function",
  "hljs-title.function_": "function",
  "hljs-title.class_": "class",
  "hljs-params": "variable",
  "hljs-name": "tag",
  "hljs-attribute": "attr",
  "hljs-doctag": "keyword",
  "hljs-template-variable": "variable",
  "hljs-template-tag": "tag",
  "hljs-subst": "variable",
  "hljs-section": "function",
  "hljs-link": "string",
  "hljs-bullet": "punctuation",
  "hljs-addition": "attr",
  "hljs-deletion": "keyword",
  "hljs-quote": "comment",
  "hljs-selector-attr": "attr",
  "hljs-selector-pseudo": "selector",
  "hljs-strong": "keyword",
  "hljs-emphasis": "comment",
  "hljs-code": "string",
};

/**
 * Safely render highlight.js HTML output to DOM elements
 * This parses the HTML string and builds DOM elements manually to avoid innerHTML
 */
function renderHighlightedCode(
  doc: Document,
  parent: HTMLElement,
  html: string,
  dark: boolean,
): void {
  const colors = dark ? highlightColors.dark : highlightColors.light;

  // Simple regex-based parser for highlight.js output
  // highlight.js only outputs: text, <span class="hljs-xxx">text</span>, and nested spans
  let pos = 0;
  const len = html.length;

  while (pos < len) {
    // Check for span tag
    if (html.startsWith("<span", pos)) {
      const classMatch = html.slice(pos).match(/^<span class="([^"]+)">/);
      if (classMatch) {
        const className = classMatch[1];
        const openTagEnd = pos + classMatch[0].length;

        // Find the matching closing tag (handle nesting)
        let depth = 1;
        let closePos = openTagEnd;
        while (depth > 0 && closePos < len) {
          if (html.startsWith("<span", closePos)) {
            depth++;
            const innerMatch = html.slice(closePos).match(/^<span[^>]*>/);
            closePos += innerMatch ? innerMatch[0].length : 5;
          } else if (html.startsWith("</span>", closePos)) {
            depth--;
            if (depth > 0) closePos += 7;
          } else {
            closePos++;
          }
        }

        // Extract inner content and create span
        const innerHtml = html.slice(openTagEnd, closePos);
        const span = doc.createElementNS(HTML_NS, "span") as HTMLElement;

        // Apply color based on class
        const colorKey = classToColorKey[className];
        if (colorKey && colors[colorKey]) {
          span.style.color = colors[colorKey];
        }

        // Recursively render inner content
        renderHighlightedCode(doc, span, innerHtml, dark);
        parent.appendChild(span);

        pos = closePos + 7; // Skip past </span>
        continue;
      }
    }

    // Check for HTML entities
    if (html[pos] === "&") {
      const entityMatch = html
        .slice(pos)
        .match(/^&(amp|lt|gt|quot|#39|#x27|nbsp);/);
      if (entityMatch) {
        const entity = entityMatch[1];
        let char = "";
        switch (entity) {
          case "amp":
            char = "&";
            break;
          case "lt":
            char = "<";
            break;
          case "gt":
            char = ">";
            break;
          case "quot":
            char = '"';
            break;
          case "#39":
          case "#x27":
            char = "'";
            break;
          case "nbsp":
            char = "\u00A0";
            break;
          default:
            char = entityMatch[0];
        }
        parent.appendChild(doc.createTextNode(char));
        pos += entityMatch[0].length;
        continue;
      }
    }

    // Regular text - collect until next tag or entity
    let textEnd = pos;
    while (textEnd < len && html[textEnd] !== "<" && html[textEnd] !== "&") {
      textEnd++;
    }
    if (textEnd > pos) {
      parent.appendChild(doc.createTextNode(html.slice(pos, textEnd)));
      pos = textEnd;
    } else {
      // Single character that's not part of a tag or entity
      parent.appendChild(doc.createTextNode(html[pos]));
      pos++;
    }
  }
}
