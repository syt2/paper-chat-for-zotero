import { assert } from "chai";
import {
  chatFontSize,
  registerChatTypographyRoot,
} from "../src/modules/ui/chat-panel/ChatPanelTypography.ts";

describe("chat panel typography", function () {
  const runtime = globalThis as Record<string, any>;
  let previousZotero: unknown;

  beforeEach(function () {
    previousZotero = runtime.Zotero;
  });

  afterEach(function () {
    runtime.Zotero = previousZotero;
  });

  it("preserves the existing 13px hierarchy while following Zotero's font variable", function () {
    assert.equal(chatFontSize(13), "var(--zotero-font-size, 13px)");
    assert.equal(
      chatFontSize(12),
      "calc(var(--zotero-font-size, 13px) * 0.923077)",
    );
    assert.equal(
      chatFontSize(14),
      "calc(var(--zotero-font-size, 13px) * 1.076923)",
    );
  });

  it("rejects invalid sizes instead of emitting broken CSS", function () {
    assert.throws(() => chatFontSize(Number.NaN), RangeError);
    assert.throws(() => chatFontSize(-1), RangeError);
    assert.equal(chatFontSize(0), "0px");
  });

  it("registers each panel root with Zotero's native UI properties", function () {
    const container = {} as HTMLElement;
    let registeredRoot: HTMLElement | null = null;
    runtime.Zotero = {
      UIProperties: {
        registerRoot(root: HTMLElement) {
          registeredRoot = root;
        },
      },
    };

    assert.isTrue(registerChatTypographyRoot(container));
    assert.strictEqual(registeredRoot, container);
  });

  it("keeps the pixel fallback when the native API is unavailable or fails", function () {
    runtime.Zotero = {};
    assert.isFalse(registerChatTypographyRoot({} as HTMLElement));

    runtime.Zotero = {
      UIProperties: {
        registerRoot() {
          throw new Error("not ready");
        },
      },
    };
    assert.isFalse(registerChatTypographyRoot({} as HTMLElement));
  });
});
