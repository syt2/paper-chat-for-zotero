import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assert } from "chai";
import { createChatContainer } from "../src/modules/ui/chat-panel/ChatPanelBuilder.ts";
import {
  applyThemeToContainer,
  darkTheme,
  lightTheme,
  updateCurrentTheme,
} from "../src/modules/ui/chat-panel/ChatPanelTheme.ts";
import { chatFontSize } from "../src/modules/ui/chat-panel/ChatPanelTypography.ts";

class FakeElement {
  readonly style: Record<string, string> = {};
  readonly attributes = new Map<string, string>();
  readonly children: FakeElement[] = [];
  parentElement: FakeElement | null = null;
  textContent = "";

  constructor(
    readonly ownerDocument: FakeDocument,
    readonly tagName: string,
  ) {}

  appendChild(child: FakeElement): FakeElement {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  addEventListener(): void {}

  getBoundingClientRect(): DOMRect {
    return {
      bottom: 0,
      height: 0,
      left: 0,
      right: 0,
      top: 0,
      width: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    };
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    const simpleSelectors = selector.split(",").map((part) => part.trim());
    const matches = (element: FakeElement): boolean =>
      simpleSelectors.some((part) => {
        if (part.startsWith("#") && !part.includes(" ")) {
          return element.getAttribute("id") === part.slice(1);
        }
        if (part.startsWith(".") && !part.includes(" ")) {
          return (element.getAttribute("class") || "")
            .split(/\s+/)
            .includes(part.slice(1));
        }
        return !part.includes(" ") && element.tagName === part.toLowerCase();
      });
    const result: FakeElement[] = [];
    const visit = (element: FakeElement): void => {
      for (const child of element.children) {
        if (matches(child)) result.push(child);
        visit(child);
      }
    };
    visit(this);
    return result;
  }
}

class FakeDocument {
  readonly documentElement = new FakeElement(this, "html");

  createElementNS(_namespace: string, tagName: string): FakeElement {
    return new FakeElement(this, tagName);
  }
}

describe("chat panel presentation toolbar entry", function () {
  const runtime = globalThis as Record<string, any>;
  let previousAddon: unknown;
  let previousZotero: unknown;

  beforeEach(function () {
    previousAddon = runtime.addon;
    previousZotero = runtime.Zotero;
    runtime.addon = {
      data: {
        locale: {
          current: {
            formatMessagesSync: (requests: Array<{ id: string }>) =>
              requests.map(({ id }) => ({ value: id, attributes: null })),
          },
        },
      },
    };
    runtime.Zotero = {
      Prefs: { get: () => false },
      getMainWindow: () => ({
        matchMedia: () => ({ matches: true }),
      }),
    };
  });

  afterEach(function () {
    runtime.addon = previousAddon;
    runtime.Zotero = previousZotero;
  });

  it("places the PPT action at the far right of the toolbar", function () {
    const doc = new FakeDocument();
    const container = createChatContainer(
      doc as unknown as Document,
      lightTheme,
    ) as unknown as FakeElement;
    const primary = container.querySelector("#chat-toolbar-primary-actions");
    const secondary = container.querySelector(
      "#chat-toolbar-secondary-actions",
    );
    const presentation = container.querySelector("#chat-generate-presentation");

    assert.isNotNull(primary);
    assert.isNotNull(secondary);
    assert.strictEqual(presentation?.parentElement, secondary);
    assert.equal(
      secondary?.children.at(-1)?.getAttribute("id"),
      "chat-generate-presentation",
    );
    assert.notInclude(primary?.children || [], presentation);
  });

  it("places the PDF screenshot action beside the existing upload action", function () {
    const doc = new FakeDocument();
    const container = createChatContainer(
      doc as unknown as Document,
      lightTheme,
    ) as unknown as FakeElement;
    const primary = container.querySelector("#chat-toolbar-primary-actions");
    const upload = container.querySelector("#chat-upload-file");
    const screenshot = container.querySelector("#chat-figure-screenshot-btn");

    assert.isNotNull(upload);
    assert.isNotNull(screenshot);
    assert.strictEqual(screenshot?.parentElement, primary);
    assert.equal(
      primary?.children.indexOf(screenshot as FakeElement),
      (primary?.children.indexOf(upload as FakeElement) ?? -1) + 1,
    );
    assert.equal(
      screenshot?.getAttribute("title"),
      "paperchat-chat-reader-figure-screenshot",
    );
    assert.equal(
      screenshot?.children[0]?.getAttribute("src"),
      "chrome://paperchat/content/icons/figure-screenshot.svg",
    );
  });

  it("updates the PPT button with the rest of the toolbar in dark mode", function () {
    const doc = new FakeDocument();
    const container = createChatContainer(
      doc as unknown as Document,
      lightTheme,
    ) as unknown as FakeElement;
    const presentation = container.querySelector("#chat-generate-presentation");
    const screenshot = container.querySelector("#chat-figure-screenshot-btn");

    updateCurrentTheme();
    applyThemeToContainer(container as unknown as HTMLElement);

    assert.equal(presentation?.style.background, darkTheme.buttonBg);
    assert.equal(presentation?.style.borderColor, darkTheme.inputBorderColor);
    assert.equal(presentation?.style.color, darkTheme.textPrimary);
    assert.equal(screenshot?.style.background, darkTheme.buttonBg);
    assert.equal(screenshot?.style.borderColor, darkTheme.inputBorderColor);
    assert.equal(screenshot?.style.color, darkTheme.textPrimary);
  });

  it("registers the panel as a Zotero UI root and scales readable input text", function () {
    let registeredRoot: FakeElement | null = null;
    runtime.Zotero.UIProperties = {
      registerRoot(root: FakeElement) {
        registeredRoot = root;
      },
    };

    const doc = new FakeDocument();
    const container = createChatContainer(
      doc as unknown as Document,
      lightTheme,
    ) as unknown as FakeElement;

    assert.strictEqual(registeredRoot, container);
    assert.equal(container.style.fontSize, chatFontSize(13));
    assert.equal(
      container.querySelector("#chat-message-input")?.style.fontSize,
      chatFontSize(14),
    );
    assert.equal(
      container.querySelector("#chat-history-search-input")?.style.fontSize,
      chatFontSize(12),
    );
  });

  it("keeps the next-question hint height flexible as its font scales", function () {
    const controllerPath = fileURLToPath(
      new URL(
        "../src/modules/ui/chat-panel/NextQuestionHintController.ts",
        import.meta.url,
      ),
    );
    const source = readFileSync(controllerPath, "utf8");
    const hintLayerSource = source.slice(
      source.indexOf("private createHintLayer"),
      source.indexOf("private syncNativePlaceholder"),
    );

    assert.include(hintLayerSource, "fontSize: chatFontSize(14)");
    assert.notInclude(hintLayerSource, 'height: "18px"');
  });

  it("uses the supplied presentation-screen geometry with the shared icon theme", function () {
    const iconPath = fileURLToPath(
      new URL("../addon/content/icons/presentation.svg", import.meta.url),
    );
    const icon = readFileSync(iconPath, "utf8");

    assert.include(icon, "M4 8H44");
    assert.include(icon, "M8 8H40V34H8V8Z");
    assert.include(icon, "M22 16L27 21L22 26");
    assert.include(icon, "M16 42L24 34L32 42");
    assert.include(icon, "@media (prefers-color-scheme: dark)");
    assert.include(icon, ".icon-stroke { stroke: #e0e0e0; }");
  });
});
