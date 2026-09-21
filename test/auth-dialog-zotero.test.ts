import { assert } from "chai";

import { showAuthDialog } from "../src/modules/ui/AuthDialog.ts";
import {
  AuthManager,
  destroyAuthManager,
} from "../src/modules/auth/AuthManager.ts";
import type { ZoteroLoginInteraction } from "../src/types/auth.ts";

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

describe("auth dialog Zotero login", function () {
  const runtime = globalThis as any;
  let previous: Record<string, unknown>;
  let elements: Map<string, AuthElement>;
  let nodes: AuthElement[];
  let win: any;
  let launched: string[];
  let originalLoginWithZotero: typeof AuthManager.prototype.loginWithZotero;
  let originalIsZoteroLoginAvailable: typeof AuthManager.prototype.isZoteroLoginAvailable;
  let originalLogin: typeof AuthManager.prototype.login;
  let originalRegister: typeof AuthManager.prototype.register;
  let originalSendVerificationCode: typeof AuthManager.prototype.sendVerificationCode;
  let originalResetPassword: typeof AuthManager.prototype.resetPassword;
  const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

  beforeEach(function () {
    previous = Object.fromEntries(
      ["Zotero", "ztoolkit", "addon", "Services", "AbortController"].map(
        (key) => [key, runtime[key]],
      ),
    );
    elements = new Map();
    nodes = [];
    launched = [];
    const unload: Array<() => void> = [];
    win = {
      AbortController: runtime.AbortController,
      closed: false,
      outerWidth: 400,
      sizeToContent: () => undefined,
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
      launchURL: (url: string) => launched.push(url),
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
    originalLoginWithZotero = AuthManager.prototype.loginWithZotero;
    originalIsZoteroLoginAvailable =
      AuthManager.prototype.isZoteroLoginAvailable;
    originalLogin = AuthManager.prototype.login;
    originalRegister = AuthManager.prototype.register;
    originalSendVerificationCode = AuthManager.prototype.sendVerificationCode;
    originalResetPassword = AuthManager.prototype.resetPassword;
    AuthManager.prototype.isZoteroLoginAvailable = async () => true;
    // Match Zotero: DOM constructors live on the window, not the sandbox.
    runtime.AbortController = undefined;
  });

  afterEach(function () {
    win.close();
    AuthManager.prototype.loginWithZotero = originalLoginWithZotero;
    AuthManager.prototype.isZoteroLoginAvailable =
      originalIsZoteroLoginAvailable;
    AuthManager.prototype.login = originalLogin;
    AuthManager.prototype.register = originalRegister;
    AuthManager.prototype.sendVerificationCode = originalSendVerificationCode;
    AuthManager.prototype.resetPassword = originalResetPassword;
    destroyAuthManager();
    Object.assign(runtime, previous);
  });

  /** A device login that only settles when the dialog cancels it. */
  function stubPendingZoteroLogin(interactions: ZoteroLoginInteraction[]) {
    AuthManager.prototype.loginWithZotero = async (interaction) => {
      interactions.push(interaction!);
      interaction!.onAuthorizationURL?.(
        "https://www.zotero.org/oauth/authorize?oauth_token=t1",
      );
      return new Promise<{ success: boolean; message: string }>((resolve) => {
        interaction!.signal!.addEventListener("abort", () =>
          resolve({ success: false, message: "auth-login-cancelled" }),
        );
      });
    };
  }

  it("keeps Cancel available while a device login waits and aborts it", async function () {
    const interactions: ZoteroLoginInteraction[] = [];
    stubPendingZoteroLogin(interactions);
    const dialog = showAuthDialog();
    await tick();
    assert.equal(elements.get("zotero-oauth-field")!.style.display, "flex");
    const starting = elements.get("zotero-oauth-btn")!.fire("click");
    await tick();
    assert.equal(interactions.length, 1);
    assert.isEmpty(launched);
    assert.isFalse(elements.get("auth-cancel-btn")!.disabled);
    // Waiting for the browser must not take the password form hostage.
    assert.isFalse(elements.get("auth-submit-btn")!.disabled);
    assert.equal(
      elements.get("zotero-oauth-label")!.textContent,
      "paperchat-auth-zotero-reopen",
    );
    await elements.get("auth-cancel-btn")!.fire("click");
    await starting;
    assert.isTrue(interactions[0].signal!.aborted);
    assert.isFalse(await dialog);
  });

  it("aborts a waiting device login when the dialog closes", async function () {
    const interactions: ZoteroLoginInteraction[] = [];
    stubPendingZoteroLogin(interactions);
    const dialog = showAuthDialog();
    await tick();
    const starting = elements.get("zotero-oauth-btn")!.fire("click");
    await tick();
    win.close();
    await starting;
    assert.isTrue(interactions[0].signal!.aborted);
    assert.isFalse(await dialog);
  });

  it("reopens the consent page instead of starting a second device flow", async function () {
    const interactions: ZoteroLoginInteraction[] = [];
    stubPendingZoteroLogin(interactions);
    const dialog = showAuthDialog();
    await tick();
    const starting = elements.get("zotero-oauth-btn")!.fire("click");
    await tick();
    // The dialog re-opens the consent page that AuthManager already recorded.
    await elements.get("zotero-oauth-btn")!.fire("click");
    assert.equal(interactions.length, 1);
    assert.deepEqual(launched, [
      "https://www.zotero.org/oauth/authorize?oauth_token=t1",
    ]);
    await elements.get("auth-cancel-btn")!.fire("click");
    await starting;
    assert.isFalse(await dialog);
  });

  it("offers the Zotero entry point on the register tab", async function () {
    AuthManager.prototype.loginWithZotero = async () => ({
      success: false,
      message: "unused",
    });
    const dialog = showAuthDialog("register");
    await tick();
    assert.equal(elements.get("zotero-oauth-field")!.style.display, "flex");
    assert.equal(
      elements.get("zotero-oauth-label")!.textContent,
      "paperchat-auth-zotero-login",
    );
    win.close();
    assert.isFalse(await dialog);
  });

  it("returns to a usable state after the device flow times out", async function () {
    let attempts = 0;
    AuthManager.prototype.loginWithZotero = async () => {
      attempts++;
      return {
        success: false,
        message: "auth-zotero-authorization-timeout",
      };
    };
    const dialog = showAuthDialog();
    await tick();
    await elements.get("zotero-oauth-btn")!.fire("click");
    assert.equal(
      elements.get("auth-message")!.textContent,
      "auth-zotero-authorization-timeout",
    );
    assert.equal(
      elements.get("zotero-oauth-label")!.textContent,
      "paperchat-auth-zotero-login",
    );
    assert.isFalse(elements.get("auth-submit-btn")!.disabled);
    await elements.get("zotero-oauth-btn")!.fire("click");
    assert.equal(attempts, 2);
    win.close();
    assert.isFalse(await dialog);
  });

  it("lets the password form take over while Zotero waits", async function () {
    const interactions: ZoteroLoginInteraction[] = [];
    stubPendingZoteroLogin(interactions);
    let credentials: unknown[] | null = null;
    AuthManager.prototype.login = async (username, password) => {
      credentials = [username, password];
      return { success: false, message: "wrong password" };
    };
    const dialog = showAuthDialog();
    await tick();
    const starting = elements.get("zotero-oauth-btn")!.fire("click");
    await tick();
    assert.equal(interactions.length, 1);

    // The whole point of the wait state: the other controls keep working.
    assert.isFalse(elements.get("auth-submit-btn")!.disabled);
    assert.isFalse(elements.get("auth-username")!.disabled);
    assert.isFalse(elements.get("auth-password")!.disabled);
    assert.isFalse(elements.get("send-code-btn")!.disabled);
    assert.isFalse(elements.get("tab-register")!.disabled);
    assert.isFalse(elements.get("forgot-password-link")!.disabled);

    elements.get("auth-username")!.value = "user";
    elements.get("auth-password")!.value = "password";
    await elements.get("auth-submit-btn")!.fire("click");
    await starting;
    assert.deepEqual(credentials, ["user", "password"]);
    // Superseding the device flow must release it, not leave it polling.
    assert.isTrue(interactions[0].signal!.aborted);
    assert.equal(elements.get("auth-message")!.textContent, "wrong password");
    assert.equal(
      elements.get("zotero-oauth-label")!.textContent,
      "paperchat-auth-zotero-login",
    );
    assert.isFalse(elements.get("auth-submit-btn")!.disabled);
    win.close();
    assert.isFalse(await dialog);
  });

  it("keeps the Zotero wait alive when the password form is rejected", async function () {
    const interactions: ZoteroLoginInteraction[] = [];
    stubPendingZoteroLogin(interactions);
    let calls = 0;
    AuthManager.prototype.login = async () => {
      calls++;
      return { success: false, message: "unused" };
    };
    const dialog = showAuthDialog();
    await tick();
    const starting = elements.get("zotero-oauth-btn")!.fire("click");
    await tick();
    elements.get("auth-username")!.value = "user";
    // No password: the form rejects before it can claim the device flow.
    await elements.get("auth-submit-btn")!.fire("click");
    assert.equal(calls, 0);
    assert.isFalse(interactions[0].signal!.aborted);
    assert.equal(
      elements.get("auth-message")!.textContent,
      "paperchat-auth-error-password-required",
    );
    assert.equal(
      elements.get("zotero-oauth-label")!.textContent,
      "paperchat-auth-zotero-reopen",
    );
    await elements.get("auth-cancel-btn")!.fire("click");
    await starting;
    assert.isFalse(await dialog);
  });

  it("submits the password form with Enter while Zotero waits", async function () {
    const interactions: ZoteroLoginInteraction[] = [];
    stubPendingZoteroLogin(interactions);
    let credentials: unknown[] | null = null;
    AuthManager.prototype.login = async (username, password) => {
      credentials = [username, password];
      return { success: false, message: "wrong password" };
    };
    const dialog = showAuthDialog();
    await tick();
    const starting = elements.get("zotero-oauth-btn")!.fire("click");
    await tick();
    elements.get("auth-username")!.value = "user";
    elements.get("auth-password")!.value = "password";
    let prevented = false;
    await elements.get("auth-username")!.fire("keypress", {
      key: "Enter",
      preventDefault: () => {
        prevented = true;
      },
    });
    await starting;
    assert.isTrue(prevented);
    assert.deepEqual(credentials, ["user", "password"]);
    assert.isTrue(interactions[0].signal!.aborted);
    win.close();
    assert.isFalse(await dialog);
  });

  it("keeps the Zotero entry point working after a tab switch while waiting", async function () {
    const interactions: ZoteroLoginInteraction[] = [];
    stubPendingZoteroLogin(interactions);
    let registration: unknown[] | null = null;
    AuthManager.prototype.register = async (
      username,
      password,
      email,
      code,
    ) => {
      registration = [username, password, email, code];
      return { success: false, message: "invalid verification code" };
    };
    const dialog = showAuthDialog();
    await tick();
    const starting = elements.get("zotero-oauth-btn")!.fire("click");
    await tick();

    await elements.get("tab-register")!.fire("click");
    // The wait survives the switch, and the entry point stays on both tabs.
    assert.equal(elements.get("zotero-oauth-field")!.style.display, "flex");
    assert.equal(
      elements.get("zotero-oauth-label")!.textContent,
      "paperchat-auth-zotero-reopen",
    );
    assert.isFalse(interactions[0].signal!.aborted);

    elements.get("auth-username")!.value = "new-user";
    elements.get("auth-password")!.value = "password";
    elements.get("auth-confirm-password")!.value = "password";
    elements.get("auth-email")!.value = "user@example.com";
    elements.get("auth-verification-code")!.value = "123456";
    await elements.get("auth-submit-btn")!.fire("click");
    await starting;
    assert.deepEqual(registration, [
      "new-user",
      "password",
      "user@example.com",
      "123456",
    ]);
    assert.isTrue(interactions[0].signal!.aborted);
    win.close();
    assert.isFalse(await dialog);
  });

  it("keeps the verification-code and reset-password entries working while Zotero waits", async function () {
    const interactions: ZoteroLoginInteraction[] = [];
    stubPendingZoteroLogin(interactions);
    const codes: string[] = [];
    const resets: string[] = [];
    AuthManager.prototype.sendVerificationCode = async (email) => {
      codes.push(email);
      return { success: true, message: "sent" };
    };
    AuthManager.prototype.resetPassword = async (email) => {
      resets.push(email);
      return { success: true, message: "sent" };
    };
    const dialog = showAuthDialog("register");
    await tick();
    const starting = elements.get("zotero-oauth-btn")!.fire("click");
    await tick();

    elements.get("auth-email")!.value = "user@example.com";
    await elements.get("send-code-btn")!.fire("click");
    assert.deepEqual(codes, ["user@example.com"]);
    assert.equal(
      elements.get("auth-message")!.textContent,
      "paperchat-auth-code-sent",
    );

    await elements.get("tab-login")!.fire("click");
    elements.get("auth-username")!.value = "user";
    await elements.get("forgot-password-link")!.fire("click");
    assert.deepEqual(resets, ["user"]);
    assert.equal(
      elements.get("auth-message")!.textContent,
      "paperchat-auth-reset-email-sent",
    );

    // Neither entry point may disturb the waiting device login.
    assert.isFalse(interactions[0].signal!.aborted);
    assert.equal(
      elements.get("zotero-oauth-label")!.textContent,
      "paperchat-auth-zotero-reopen",
    );
    await elements.get("auth-cancel-btn")!.fire("click");
    await starting;
    assert.isFalse(await dialog);
  });
});
