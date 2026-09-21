import { assert } from "chai";

import {
  AuthManager,
  destroyAuthManager,
} from "../src/modules/auth/AuthManager.ts";

describe("AuthManager Zotero device login cancellation", function () {
  const runtime = globalThis as any;
  let previous: Record<string, unknown>;
  let launched: string[];
  let polls: number;
  let starts: number;
  const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

  beforeEach(function () {
    previous = Object.fromEntries(
      ["Zotero", "ztoolkit", "addon", "Services"].map((key) => [
        key,
        runtime[key],
      ]),
    );
    launched = [];
    polls = 0;
    starts = 0;
    runtime.Zotero = {
      launchURL: (url: string) => launched.push(url),
      Prefs: {
        get: () => undefined,
        set: () => undefined,
        clear: () => undefined,
      },
      DataDirectory: { dir: "/test" },
    };
    runtime.ztoolkit = { log: () => undefined };
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
  });

  afterEach(function () {
    destroyAuthManager();
    Object.assign(runtime, previous);
  });

  /** A bridge whose device login stays pending until the caller cancels it. */
  function stubPendingDeviceFlow(manager: AuthManager) {
    (manager as any).authService = {
      isZoteroLoginAvailable: async () => true,
      hasAuthenticationState: () => false,
      setUserId: () => undefined,
      clearSessionCookie: () => undefined,
      startZoteroDeviceLogin: async () => {
        starts += 1;
        return {
          success: true,
          message: "",
          data: {
            authorization_url: `https://www.zotero.org/oauth/authorize?x=${starts}`,
            device_token: `device-token-${starts}`,
            expires_in: 300,
          },
        };
      },
      pollZoteroDeviceLogin: async () => {
        polls += 1;
        return { success: true, message: "", status: 200, pending: true };
      },
    };
  }

  it("stops the poll loop and lets the next attempt start", async function () {
    this.timeout(10000);
    const manager = new AuthManager();
    stubPendingDeviceFlow(manager);
    const controller = new AbortController();
    const first = manager.loginWithZotero({ signal: controller.signal });
    await tick();
    assert.deepEqual(launched, ["https://www.zotero.org/oauth/authorize?x=1"]);
    assert.equal(
      manager.getZoteroAuthorizationUrl(),
      "https://www.zotero.org/oauth/authorize?x=1",
    );
    controller.abort();
    const firstResult = await first;
    assert.isFalse(firstResult.success);
    assert.equal(firstResult.message, "paperchat-auth-login-cancelled");
    assert.isNull(manager.getZoteroAuthorizationUrl());
    const pollsAfterCancel = polls;
    await new Promise((resolve) => setTimeout(resolve, 2500));
    // The cancelled flow must not keep polling the bridge.
    assert.equal(polls, pollsAfterCancel);
    // A cancelled attempt must not hold the interactive slot: the next click
    // starts a fresh device login instead of reporting "login cancelled".
    const secondController = new AbortController();
    const second = manager.loginWithZotero({ signal: secondController.signal });
    await tick();
    assert.equal(starts, 2);
    assert.equal(
      manager.getZoteroAuthorizationUrl(),
      "https://www.zotero.org/oauth/authorize?x=2",
    );
    secondController.abort();
    const secondResult = await second;
    assert.isFalse(secondResult.success);
    assert.equal(secondResult.message, "paperchat-auth-login-cancelled");
  });

  it("reports cancellation instead of a stale attempt when the signal is already aborted", async function () {
    const manager = new AuthManager();
    stubPendingDeviceFlow(manager);
    const controller = new AbortController();
    controller.abort();
    const result = await manager.loginWithZotero({ signal: controller.signal });
    assert.isFalse(result.success);
    assert.equal(result.message, "paperchat-auth-login-cancelled");
    assert.isEmpty(launched);
    assert.equal(starts, 0);
  });
});
