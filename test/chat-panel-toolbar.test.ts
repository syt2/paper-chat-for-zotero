import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assert } from "chai";
import { createChatContainer } from "../src/modules/ui/chat-panel/ChatPanelBuilder.ts";
import {
  applyThemeToContainer,
  darkTheme,
  getCurrentTheme,
  lightTheme,
  updateCurrentTheme,
} from "../src/modules/ui/chat-panel/ChatPanelTheme.ts";
import { chatFontSize } from "../src/modules/ui/chat-panel/ChatPanelTypography.ts";

import {
  updateConversationNoteSummaryButton,
  updatePresentationButtonAvailability,
  updateUserBarDisplay,
  refreshCheckinDisplay,
} from "../src/modules/ui/chat-panel/ChatPanelEvents.ts";
import { getProviderManager } from "../src/modules/providers/ProviderManager.ts";
import { getSubscriptionUsageTooltip } from "../src/modules/ui/chat-panel/ChatPanelChrome.ts";
import type { SubscriptionUsageSummary } from "../src/types/auth.ts";

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

  removeAttribute(name: string): void {
    this.attributes.delete(name);
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
  let previousToolkit: unknown;
  let previousTheme: ReturnType<typeof getCurrentTheme>;

  beforeEach(function () {
    previousTheme = getCurrentTheme();
    previousAddon = runtime.addon;
    previousZotero = runtime.Zotero;
    previousToolkit = runtime.ztoolkit;
    runtime.ztoolkit = { log: () => {} };
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
    runtime.Zotero.getMainWindow = () => ({
      matchMedia: () => ({ matches: previousTheme === darkTheme }),
    });
    updateCurrentTheme();
    runtime.addon = previousAddon;
    runtime.Zotero = previousZotero;
    runtime.ztoolkit = previousToolkit;
  });

  it("updates account warnings and the header login action when authentication or provider changes", function () {
    const container = createChatContainer(
      new FakeDocument() as unknown as Document,
      lightTheme,
    );
    const manager = getProviderManager();
    const original = manager.getActiveProviderId;
    let provider = "paperchat";
    let loggedIn = true;
    const auth = {
      isLoggedIn: () => loggedIn,
      getUser: () => ({ username: "reader" }),
      getBalance: () => ({ quota: 100, usedQuota: 0 }),
      formatBalance: () => "100",
      getSubscriptionUsageSummary: () => null,
    };
    manager.getActiveProviderId = () => provider;
    try {
      const warning = container.querySelector(
        "#chat-balance-warning",
      ) as HTMLElement;
      const account = container.querySelector(
        "#chat-header-account",
      ) as HTMLElement;
      const menu = container.querySelector(
        "#chat-account-menu",
      ) as HTMLDetailsElement;
      const caption = container.querySelector(
        "#chat-header-account-caption",
      ) as HTMLButtonElement;
      assert.equal(caption.tagName.toLowerCase(), "button");
      assert.equal(caption.getAttribute("type"), "button");
      updateUserBarDisplay(container, auth);
      assert.equal(warning.style.display, "block");
      assert.equal(account.style.display, "flex");
      assert.isFalse(caption.disabled);
      assert.equal(caption.getAttribute("data-low-balance"), "true");
      menu.open = true;
      provider = "openai";
      updateUserBarDisplay(container, auth);
      assert.equal(account.style.display, "none");
      assert.equal(warning.style.display, "none");
      assert.isFalse(menu.open);
      assert.isTrue(caption.disabled);
      provider = "paperchat";
      updateUserBarDisplay(container, auth);
      assert.equal(account.style.display, "flex");
      assert.equal(warning.style.display, "block");
      loggedIn = false;
      updateUserBarDisplay(container, auth);
      assert.equal(account.style.display, "flex");
      assert.equal(caption.textContent, "paperchat-user-panel-login-btn");
      assert.isFalse(caption.disabled);
      assert.equal(warning.style.display, "none");
      assert.equal(
        (container.querySelector("#chat-checkin-btn") as HTMLElement).style
          .display,
        "none",
      );
      provider = "openai";
      updateUserBarDisplay(container, auth);
      assert.equal(account.style.display, "none");
      assert.isTrue(caption.disabled);
    } finally {
      manager.getActiveProviderId = original;
    }
  });

  it("keeps header subscription and wallet visibility aligned with the original user bar", function () {
    const container = createChatContainer(
      new FakeDocument() as unknown as Document,
      lightTheme,
    );
    const manager = getProviderManager();
    const original = manager.getActiveProviderId;
    let provider = "paperchat";
    let loggedIn = true;
    let usage: SubscriptionUsageSummary | null = {
      amountTotal: 1_000_000,
      amountUsed: 989_999,
      amountRemaining: 10_001,
      amountTotalLabel: "1.0M",
      amountUsedLabel: "990.0K",
      percentUsed: 98.9999,
    };
    const auth = {
      isLoggedIn: () => loggedIn,
      getUser: () => ({ username: "reader" }),
      getBalance: () => ({ quota: 100, usedQuota: 0 }),
      formatBalance: () => "100",
      getSubscriptionUsageSummary: () => usage,
    };
    manager.getActiveProviderId = () => provider;
    const subscription = container.querySelector(
      "#chat-user-subscription",
    ) as HTMLElement;
    const header = container.querySelector(
      "#chat-header-account",
    ) as HTMLElement;
    const wallet = container.querySelector(
      "#chat-header-account-caption",
    ) as HTMLButtonElement;
    const menuWallet = container.querySelector(
      "#chat-user-balance",
    ) as HTMLElement;
    const warning = container.querySelector(
      "#chat-balance-warning",
    ) as HTMLElement;
    try {
      assert.equal(subscription.parentElement, header);
      updateUserBarDisplay(container, auth);
      assert.equal(subscription.style.display, "flex");
      assert.equal(subscription.getAttribute("role"), "button");
      assert.equal(subscription.getAttribute("tabindex"), "0");
      assert.equal(wallet.style.display, "none");
      assert.equal(menuWallet.style.display, "none");
      assert.equal(warning.style.display, "none");
      usage = {
        ...usage,
        amountUsed: 990_000,
        amountRemaining: 10_000,
        percentUsed: 99,
      };
      updateUserBarDisplay(container, auth);
      assert.notEqual(wallet.style.display, "none");
      assert.isFalse(wallet.disabled);
      assert.equal(menuWallet.getAttribute("role"), "button");
      assert.notEqual(menuWallet.style.display, "none");
      assert.equal(warning.style.display, "block");
      assert.equal(
        subscription.getAttribute("data-subscription-limit-clickable"),
        "true",
      );
      assert.equal(
        (
          container.querySelector(
            "#chat-user-subscription-progress-fill",
          ) as HTMLElement
        ).style.width,
        "99%",
      );
      provider = "deepseek";
      updateUserBarDisplay(container, auth);
      assert.equal(header.style.display, "none");
      assert.equal(warning.style.display, "none");
      provider = "paperchat";
      usage = null;
      updateUserBarDisplay(container, auth);
      assert.equal(header.style.display, "flex");
      assert.equal(subscription.style.display, "none");
      assert.isNull(subscription.getAttribute("aria-label"));
      assert.isNull(subscription.getAttribute("tabindex"));
      assert.isNull(
        subscription.getAttribute("data-subscription-limit-clickable"),
      );
      assert.notEqual(wallet.style.display, "none");
      loggedIn = false;
      updateUserBarDisplay(container, auth);
      assert.isFalse(wallet.disabled);
      assert.equal(subscription.style.display, "none");
      assert.equal(warning.style.display, "none");
    } finally {
      manager.getActiveProviderId = original;
    }
  });

  it("lists one tooltip line per current plan with quotas, reset and expiry dates", function () {
    runtime.addon.data.locale.current.formatMessagesSync = (requests: any[]) =>
      requests.map(({ id, args }) => ({
        value: args
          ? "count" in args
            ? `${id}: ${args.count}`
            : Object.values(args).join(" | ")
          : id,
        attributes: null,
      }));
    const usage: SubscriptionUsageSummary = {
      amountTotal: 4_005_000,
      amountUsed: 0,
      amountRemaining: 4_005_000,
      amountTotalLabel: "4.0M",
      amountUsedLabel: "0",
      percentUsed: 0,
      details: [
        {
          planId: 6,
          amountTotalLabel: "5.0K",
          amountUsedLabel: "0",
          amountRemainingLabel: "5.0K",
          nextResetTime: Date.UTC(2026, 8, 7) / 1000,
          endTime: Date.UTC(2027, 8, 6) / 1000,
        },
        {
          planId: 7,
          amountTotalLabel: "4.0M",
          amountUsedLabel: "0",
          amountRemainingLabel: "4.0M",
          nextResetTime: 0,
          endTime: 0,
        },
      ],
    };
    const now = Date.UTC(2026, 8, 6);
    const lines = getSubscriptionUsageTooltip(usage, now).split("\n");
    assert.lengthOf(lines, 2);
    assert.include(lines[0], "6 | 5.0K | 5.0K | 0");
    assert.include(lines[0], "paperchat-chat-subscription-in-days: 1");
    assert.include(lines[0], "paperchat-chat-subscription-in-days: 365");
    assert.include(lines[1], "7 | 4.0M | 4.0M | 0");
    assert.include(lines[1], "paperchat-chat-subscription-no-reset");
    assert.include(lines[1], "paperchat-chat-subscription-unknown-expiry");
    for (const [remaining, expected] of [
      [1_000, "minutes: 1"],
      [59_000, "minutes: 1"],
      [120_000, "minutes: 2"],
      [3_600_000, "hours: 1"],
      [7_200_000, "hours: 2"],
      [86_400_000, "days: 1"],
      [0, "time-reached"],
      [-60_000, "time-reached"],
    ] as const) {
      usage.details![0].nextResetTime = (now + remaining) / 1000;
      assert.include(
        getSubscriptionUsageTooltip(usage, now),
        `paperchat-chat-subscription-${expected.startsWith("time") ? "" : "in-"}${expected}`,
      );
    }
  });

  it("does not restore the exposed check-in button after logout during a refresh", async function () {
    const container = createChatContainer(
      new FakeDocument() as unknown as Document,
      lightTheme,
    );
    let loggedIn = true;
    let finish!: (value: {
      success: boolean;
      enabled: boolean;
      checkedInToday: boolean;
      checkinCount: number;
    }) => void;
    const pending = refreshCheckinDisplay(container, {
      isLoggedIn: () => loggedIn,
      fetchCheckinStatus: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    });
    loggedIn = false;
    finish({
      success: true,
      enabled: true,
      checkedInToday: false,
      checkinCount: 0,
    });
    await pending;
    assert.equal(
      (container.querySelector("#chat-checkin-btn") as HTMLElement).style
        .display,
      "none",
    );
  });

  it("groups note and PPT actions in the second tools section", function () {
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

  it("keeps add, model and send inside the composer and utilities outside", function () {
    const container = createChatContainer(
      new FakeDocument() as unknown as Document,
      lightTheme,
    ) as unknown as FakeElement;
    const composer = container.querySelector("#chat-composer");
    const bar = container.querySelector("#chat-input-bottom-bar");
    const selector = container.querySelector("#chat-model-selector-btn");
    const tools = container.querySelector("#chat-tools-menu");
    assert.strictEqual(bar?.parentElement, composer);
    assert.strictEqual(bar?.children[0], tools);
    assert.strictEqual(bar?.children[1], selector?.parentElement);
    assert.equal(bar?.children[2]?.getAttribute("id"), "chat-send-button");
    assert.equal(tools?.tagName, "details");
    assert.equal(tools?.children[0]?.getAttribute("id"), "chat-tools-trigger");
    const footer = container.querySelector("#chat-footer");
    assert.strictEqual(footer?.parentElement, composer?.parentElement);
    assert.deepEqual(
      footer?.children.map((child) => child.getAttribute("id")),
      ["chat-session-actions", "chat-utility-actions"],
    );
    const utilities = container.querySelector("#chat-utility-actions");
    assert.deepEqual(
      utilities?.children.map((child) => child.getAttribute("id")),
      ["chat-model-selector-help", "chat-settings-btn", "chat-panel-mode-btn"],
    );
  });

  it("updates the PPT button when the visible library selection changes", function () {
    let selected: unknown[] = [];
    runtime.Zotero.getMainWindow = () => ({
      Zotero_Tabs: { selectedID: "library", selectedType: "library" },
    });
    runtime.Zotero.getActiveZoteroPane = () => ({
      getSelectedItems: () => selected,
    });
    const pdf = {
      key: "PDF",
      libraryID: 1,
      isAttachment: () => true,
      isPDFAttachment: () => true,
    };
    const container = createChatContainer(
      new FakeDocument() as unknown as Document,
      lightTheme,
    );
    const button = container.querySelector(
      "#chat-generate-presentation",
    ) as HTMLButtonElement;
    updatePresentationButtonAvailability(container);
    assert.isTrue(button.disabled);
    assert.equal(button.title, "paperchat-presentation-select-source");
    selected = [pdf];
    updatePresentationButtonAvailability(container);
    assert.isFalse(button.disabled);
    selected = [pdf, pdf];
    updatePresentationButtonAvailability(container);
    assert.isTrue(button.disabled);
    selected = [];
    updatePresentationButtonAvailability(container);
    assert.isTrue(button.disabled);
  });

  it("keeps the note menu item visible while disabling unavailable actions", function () {
    const container = createChatContainer(
      new FakeDocument() as unknown as Document,
      lightTheme,
    );
    const note = container.querySelector(
      "#chat-summarize-conversation-note",
    ) as HTMLButtonElement;
    const messages = [
      { id: "one", role: "user" as const, content: "Hello", timestamp: 1 },
    ];
    updateConversationNoteSummaryButton(container, [], "empty", true);
    assert.equal(note.style.display, "inline-flex");
    assert.isTrue(note.disabled);
    updateConversationNoteSummaryButton(container, messages, "one", true);
    assert.isFalse(note.disabled);
    updateConversationNoteSummaryButton(container, messages, "one", false);
    assert.isTrue(note.disabled);
    assert.equal(note.style.display, "inline-flex");
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
