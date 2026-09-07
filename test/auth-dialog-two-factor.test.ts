import { assert } from "chai";
import { showAuthDialog } from "../src/modules/ui/AuthDialog.ts";
import {
  AuthManager,
  destroyAuthManager,
} from "../src/modules/auth/AuthManager.ts";
import type { LoginInteraction } from "../src/types/auth.ts";

class AuthElement {
  style: Record<string, string> = {};
  attributes: Record<string, string> = {};
  handlers = new Map<string, Array<(event: any) => unknown>>();
  value = "";
  textContent = "";
  disabled = false;
  focused = false;
  parentElement?: AuthElement;
  tag = "";
  addEventListener(name: string, handler: (event: any) => unknown) {
    this.handlers.set(name, [...(this.handlers.get(name) || []), handler]);
  }
  setAttribute(name: string, value: string) {
    this.attributes[name] = value;
  }
  removeAttribute(name: string) {
    delete this.attributes[name];
  }
  focus() {
    this.focused = true;
  }
  async fire(name: string, event: unknown = {}) {
    if (this.disabled) return;
    for (const handler of this.handlers.get(name) || []) await handler(event);
  }
}

describe("auth dialog second-factor interaction", function () {
  const runtime = globalThis as any;
  let previous: Record<string, unknown>;
  let elements: Map<string, AuthElement>;
  let nodes: AuthElement[];
  let win: any;
  let originalLogin: typeof AuthManager.prototype.login;
  let originalRegister: typeof AuthManager.prototype.register;
  const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

  beforeEach(function () {
    previous = Object.fromEntries(
      ["Zotero", "ztoolkit", "addon", "Services", "AbortController"].map(
        (key) => [key, runtime[key]],
      ),
    );
    elements = new Map();
    nodes = [];
    const unload: Array<() => void> = [];
    win = {
      AbortController: runtime.AbortController,
      closed: false,
      outerWidth: 400,
      resizeTo: () => undefined,
      focus: () => undefined,
      openDialog: () => undefined,
      addEventListener: (name: string, handler: () => void) => {
        if (name === "unload") unload.push(handler);
      },
      close: () => {
        if (win.closed) return;
        win.closed = true;
        unload.forEach((handler) => handler());
      },
      document: {
        getElementById: (id: string) => elements.get(id),
        querySelector: (selector: string) => elements.get(selector.slice(1)),
        querySelectorAll: (tag: string) =>
          nodes.filter((node) => node.tag === tag),
      },
    };
    const addNode = (spec: any, parent?: AuthElement) => {
      const node = new AuthElement();
      node.tag = spec.tag;
      node.parentElement = parent;
      Object.assign(node, spec.properties);
      Object.assign(node.style, spec.styles);
      Object.assign(node.attributes, spec.attributes);
      if (spec.id) elements.set(spec.id, node);
      nodes.push(node);
      spec.children?.forEach((child: any) => addNode(child, node));
    };
    runtime.Services = undefined;
    runtime.Zotero = {
      getMainWindow: () => win,
      Prefs: { get: () => undefined },
      DataDirectory: { dir: "/test" },
    };
    runtime.addon = {
      data: {
        locale: {
          current: {
            formatMessagesSync: ([request]: any[]) => [
              { value: request.id, attributes: null },
            ],
          },
        },
      },
    };
    runtime.ztoolkit = {
      log: () => undefined,
      Dialog: class {
        window = win;
        setDialogData() {
          return this;
        }
        addCell(_row: number, _column: number, spec: unknown) {
          addNode(spec);
          return this;
        }
        getGlobal() {
          return undefined;
        }
        open() {
          return this;
        }
      },
    };
    originalLogin = AuthManager.prototype.login;
    originalRegister = AuthManager.prototype.register;
    // Match Zotero: DOM constructors live on the window, not the sandbox.
    runtime.AbortController = undefined;
  });

  it("shows initialization errors and allows a second submission", async function () {
    const Constructor = win.AbortController;
    win.AbortController = class {
      constructor() {
        throw new Error("Controller unavailable");
      }
    };
    let calls = 0;
    AuthManager.prototype.login = async () => {
      calls++;
      return { success: false, message: "Wrong credentials" };
    };
    const dialog = showAuthDialog();
    elements.get("auth-username")!.value = "user";
    elements.get("auth-password")!.value = "password";
    await elements.get("auth-submit-btn")!.fire("click");
    assert.equal(calls, 0);
    assert.equal(
      elements.get("auth-message")!.textContent,
      "Controller unavailable",
    );
    assert.isFalse(elements.get("auth-submit-btn")!.disabled);
    assert.isFalse(elements.get("auth-password")!.disabled);
    win.AbortController = Constructor;
    await elements.get("auth-submit-btn")!.fire("click");
    assert.equal(calls, 1);
    assert.equal(
      elements.get("auth-message")!.textContent,
      "Wrong credentials",
    );
    await elements.get("auth-submit-btn")!.fire("click");
    assert.equal(calls, 2);
    win.close();
    assert.isFalse(await dialog);
  });

  afterEach(function () {
    win.close();
    AuthManager.prototype.login = originalLogin;
    AuthManager.prototype.register = originalRegister;
    destroyAuthManager();
    Object.assign(runtime, previous);
  });

  it("submits registration without a sandbox AbortController and allows retry", async function () {
    let calls = 0;
    AuthManager.prototype.register = async (
      username,
      password,
      email,
      code,
    ) => {
      calls++;
      assert.deepEqual(
        [username, password, email, code],
        ["user", "password", "user@example.com", "123456"],
      );
      return { success: false, message: "Invalid verification code" };
    };
    const dialog = showAuthDialog("register");
    elements.get("auth-username")!.value = "user";
    elements.get("auth-password")!.value = "password";
    elements.get("auth-confirm-password")!.value = "password";
    elements.get("auth-email")!.value = "user@example.com";
    elements.get("auth-verification-code")!.value = "123456";
    await elements.get("auth-submit-btn")!.fire("click");
    assert.equal(calls, 1);
    assert.equal(
      elements.get("auth-message")!.textContent,
      "Invalid verification code",
    );
    assert.isFalse(elements.get("auth-submit-btn")!.disabled);
    await elements.get("auth-submit-btn")!.fire("click");
    assert.equal(calls, 2);
    win.close();
    assert.isFalse(await dialog);
  });

  it("keeps one login attempt through wrong-code retry and Enter submission", async function () {
    let calls = 0;
    AuthManager.prototype.login = async (_username, _password, interaction) => {
      calls++;
      assert.equal(await interaction!.requestTwoFactorCode(), "001234");
      assert.equal(
        await interaction!.requestTwoFactorCode("Wrong code"),
        "backup-code",
      );
      return { success: true, message: "OK" };
    };
    const dialog = showAuthDialog();
    elements.get("auth-username")!.value = "user";
    elements.get("auth-password")!.value = "password";
    const submitting = elements.get("auth-submit-btn")!.fire("click");
    await tick();
    assert.equal(elements.get("two-factor-field")!.style.display, "flex");
    assert.equal(elements.get("username-field")!.style.display, "none");
    assert.isTrue(elements.get("auth-two-factor-code")!.focused);
    assert.isTrue(elements.get("tab-register")!.disabled);
    elements.get("auth-two-factor-code")!.value = "001234";
    await elements.get("auth-submit-btn")!.fire("click");
    await tick();
    assert.equal(elements.get("auth-message")!.textContent, "Wrong code");
    assert.equal(elements.get("auth-two-factor-code")!.value, "");
    elements.get("auth-two-factor-code")!.value = "backup-code";
    let prevented = false;
    await elements.get("auth-two-factor-code")!.fire("keypress", {
      key: "Enter",
      preventDefault: () => {
        prevented = true;
      },
    });
    await submitting;
    assert.isTrue(await dialog);
    assert.isTrue(prevented);
    assert.equal(calls, 1);
    assert.equal(elements.get("auth-password")!.value, "");
  });

  it("returns to password login and cancels a pending challenge on close", async function () {
    const interactions: LoginInteraction[] = [];
    AuthManager.prototype.login = async (_username, _password, interaction) => {
      interactions.push(interaction!);
      assert.isNull(await interaction!.requestTwoFactorCode());
      return { success: false, message: "Cancelled" };
    };
    const dialog = showAuthDialog();
    elements.get("auth-username")!.value = "user";
    elements.get("auth-password")!.value = "password";
    const submitting = elements.get("auth-submit-btn")!.fire("click");
    await tick();
    await elements.get("auth-two-factor-back")!.fire("click");
    await submitting;
    assert.isTrue(interactions[0].signal.aborted);
    assert.equal(elements.get("two-factor-field")!.style.display, "none");
    assert.equal(elements.get("username-field")!.style.display, "flex");
    assert.isFalse(elements.get("auth-password")!.disabled);
    const resubmitting = elements.get("auth-submit-btn")!.fire("click");
    await tick();
    win.close();
    await resubmitting;
    assert.isTrue(interactions[1].signal.aborted);
    assert.isFalse(await dialog);
  });
});
