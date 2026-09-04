import { assert } from "chai";
import {
  buildProductPurchaseChildren,
  getInitialPaperChatProduct,
  getProductAnalyticsProps,
  updateUserDisplay,
} from "../src/modules/preferences/UserAuthUI";

class FakeElement {
  readonly style: Record<string, string> = {};
  textContent = "";
  private readonly attributes = new Map<string, string>();

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }
}

describe("PaperChat user auth preferences", function () {
  let originalAddon: unknown;

  beforeEach(function () {
    originalAddon = (globalThis as any).addon;
    const messages: Record<string, string> = {
      "paperchat-user-panel-logged-in": "Logged in: {username}",
      "paperchat-user-panel-balance": "Balance",
      "paperchat-user-panel-used": "Used",
      "paperchat-user-panel-logout-btn": "Log out",
      "paperchat-user-panel-not-logged-in": "Not logged in",
      "paperchat-user-panel-login-btn": "Log in",
    };
    (globalThis as any).addon = {
      data: {
        locale: {
          current: {
            formatMessagesSync: ([request]: Array<{
              id: string;
              args?: Record<string, unknown>;
            }>) => [
              {
                value: messages[request.id]?.replace(
                  "{username}",
                  String(request.args?.username ?? ""),
                ),
                attributes: null,
              },
            ],
          },
        },
      },
    };
  });

  afterEach(function () {
    (globalThis as any).addon = originalAddon;
  });

  it("replaces stale XUL text when the authenticated user changes", function () {
    const elements = new Map<string, FakeElement>();
    for (const id of [
      "pref-user-status",
      "pref-user-balance",
      "pref-user-used",
      "pref-login-btn",
      "pref-get-redeem-code-btn",
    ]) {
      elements.set(id, new FakeElement());
    }

    const status = elements.get("pref-user-status")!;
    const balance = elements.get("pref-user-balance")!;
    const used = elements.get("pref-user-used")!;
    const loginButton = elements.get("pref-login-btn")!;
    status.textContent = "Logged in: old-user";
    status.setAttribute("value", "Logged in: old-user");
    balance.textContent = "Balance: old";
    balance.setAttribute("value", "Balance: old");
    used.textContent = "Used: old";
    used.setAttribute("value", "Used: old");
    loginButton.textContent = "Old action";
    loginButton.setAttribute("label", "Old action");

    const doc = {
      getElementById: (id: string) => elements.get(id) ?? null,
    } as unknown as Document;
    let loggedIn = true;
    const authManager = {
      isLoggedIn: () => loggedIn,
      getUser: () => ({ username: "new-user" }),
      getSubscriptionUsageSummary: () => null,
      getBalance: () => ({ quota: 100_000 }),
      formatBalance: () => "100K",
      formatUsedQuota: () => "2K",
    } as any;

    updateUserDisplay(doc, authManager);

    assert.equal(status.textContent, "Logged in: new-user");
    assert.equal(balance.textContent, "Balance: 100K");
    assert.equal(used.textContent, "Used: 2K");
    assert.equal(loginButton.textContent, "Log out");
    assert.isNull(status.getAttribute("value"));
    assert.isNull(balance.getAttribute("value"));
    assert.isNull(used.getAttribute("value"));
    assert.isNull(loginButton.getAttribute("label"));

    loggedIn = false;
    updateUserDisplay(doc, authManager);

    assert.equal(status.textContent, "Not logged in");
    assert.equal(balance.textContent, "");
    assert.equal(used.textContent, "");
    assert.equal(loginButton.textContent, "Log in");
    assert.isNull(status.getAttribute("value"));
    assert.isNull(loginButton.getAttribute("label"));
  });

  it("uses the product SKU as the stable analytics item", function () {
    assert.deepEqual(
      getProductAnalyticsProps({
        sku: "newapi_subscription_plan_monthly",
        name: "Monthly Pro",
        money: "49.00",
        description: "Monthly subscription",
        quotaLabel: "1M / month",
      }),
      {
        item: "newapi_subscription_plan_monthly",
        sku: "newapi_subscription_plan_monthly",
        product_name: "Monthly Pro",
        product_category: "subscription",
        money: "49.00",
        quota_label: "1M / month",
      },
    );
  });

  it("classifies quota products and omits a missing quota label", function () {
    assert.deepEqual(
      getProductAnalyticsProps({
        sku: "quota_500k",
        name: "500K Credits",
        money: "29.90",
        description: "One-time quota",
        quotaLabel: null,
      }),
      {
        item: "quota_500k",
        sku: "quota_500k",
        product_name: "500K Credits",
        product_category: "quota",
        money: "29.90",
        quota_label: undefined,
      },
    );
  });

  it("shows subscriptions first and labels every quota product as permanent", function () {
    const products = [
      {
        sku: "quota_500k",
        name: "500K Credits",
        money: "29.90",
        description: "One-time quota",
        quotaLabel: "500K",
      },
      {
        sku: "quota_1m",
        name: "1M Credits",
        money: "49.90",
        description: "One-time quota",
        quotaLabel: "1M",
      },
      {
        sku: "newapi_subscription_plan_monthly",
        name: "Monthly Pro",
        money: "49.00",
        description: "Monthly subscription",
        quotaLabel: "1M / month",
      },
    ];
    const children = buildProductPurchaseChildren(products) as any[];

    assert.equal(
      getInitialPaperChatProduct(products)?.sku,
      "newapi_subscription_plan_monthly",
    );

    const picker = children.find(
      (child) => child.id === "paperchat-product-picker",
    );
    const tabs = picker.children.find(
      (child: any) => child.id === "paperchat-product-tabs",
    ).children;
    assert.deepEqual(
      tabs.map((tab: any) => tab.id),
      ["paperchat-product-tab-subscription", "paperchat-product-tab-quota"],
    );
    assert.equal(tabs[0].attributes["aria-selected"], "true");

    const subscriptionGrid = picker.children.find(
      (child: any) => child.id === "paperchat-product-grid-subscription",
    );
    const quotaGrid = picker.children.find(
      (child: any) => child.id === "paperchat-product-grid-quota",
    );
    assert.equal(subscriptionGrid.styles.display, "grid");
    assert.equal(quotaGrid.styles.display, "none");
    assert.equal(
      subscriptionGrid.children[0].attributes["aria-pressed"],
      "true",
    );
    assert.isFalse(
      subscriptionGrid.children[0].children[0].children.some(
        (child: any) =>
          child.attributes?.["data-product-badge"] === "permanent",
      ),
    );
    assert.isTrue(
      quotaGrid.children.every((product: any) =>
        product.children[0].children.some(
          (child: any) =>
            child.attributes?.["data-product-badge"] === "permanent" &&
            child.properties?.textContent === "永久有效期",
        ),
      ),
    );
  });

  it("falls back to Token quota when no subscription products exist", function () {
    const products = [
      {
        sku: "quota_500k",
        name: "500K Credits",
        money: "29.90",
        description: "One-time quota",
        quotaLabel: "500K",
      },
    ];
    const children = buildProductPurchaseChildren(products) as any[];
    const picker = children.find(
      (child) => child.id === "paperchat-product-picker",
    );
    const tabs = picker.children.find(
      (child: any) => child.id === "paperchat-product-tabs",
    ).children;
    const quotaGrid = picker.children.find(
      (child: any) => child.id === "paperchat-product-grid-quota",
    );

    assert.equal(getInitialPaperChatProduct(products)?.sku, "quota_500k");
    assert.isTrue(tabs[0].properties.disabled);
    assert.equal(tabs[0].attributes["aria-selected"], "false");
    assert.equal(tabs[1].attributes["aria-selected"], "true");
    assert.equal(quotaGrid.styles.display, "grid");
    assert.equal(quotaGrid.children[0].attributes["aria-pressed"], "true");
    assert.equal(
      quotaGrid.children[0].children[0].children[1].properties.textContent,
      "永久有效期",
    );
  });
});
