import { assert } from "chai";
import { updateUserDisplay } from "../src/modules/preferences/UserAuthUI";

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
});
