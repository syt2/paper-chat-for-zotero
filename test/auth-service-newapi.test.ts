import { assert } from "chai";
import { AuthManager } from "../src/modules/auth/AuthManager";
import { AuthService } from "../src/modules/auth/AuthService";

interface HttpCall {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
}

interface StoredCookie {
  name: string;
  path: string;
  value: string;
}

const mockChannelIds = new Map<string, number>();
let nextMockChannelId = 0;

function registerHttpChannel(
  url: string,
  options: { requestObserver?: (xhr: unknown) => void },
): number {
  const channelId = ++nextMockChannelId;
  mockChannelIds.set(url, channelId);
  options.requestObserver?.({
    channel: { QueryInterface: () => ({ channelId }) },
  });
  return channelId;
}

describe("AuthService NewAPI authentication", function () {
  it("uses subscriptions for both totals and per-plan details, excluding historical records", function () {
    const manager = Object.create(AuthManager.prototype) as any;
    const plan = (
      planId: number,
      total: number,
      status = "active",
      used = 0,
    ) => ({
      subscription: {
        plan_id: planId,
        amount_total: total,
        amount_used: used,
        status,
        next_reset_time: 1788710400,
        end_time: 1791258934,
      },
    });
    manager.state = {
      subscription: {
        subscriptions: [plan(6, 5000), plan(7, 4_000_000)],
        all_subscriptions: [
          plan(6, 5000),
          plan(7, 4_000_000),
          plan(1, 15_000_000, "expired"),
        ],
      },
    };
    const usage = manager.getSubscriptionUsageSummary();
    assert.equal(usage.amountTotal, 4_005_000);
    assert.equal(usage.amountRemaining, 4_005_000);
    assert.deepEqual(usage.details, [
      {
        planId: 6,
        amountTotalLabel: "5.0K",
        amountUsedLabel: "0",
        amountRemainingLabel: "5.0K",
        nextResetTime: 1788710400,
        endTime: 1791258934,
      },
      {
        planId: 7,
        amountTotalLabel: "4.0M",
        amountUsedLabel: "0",
        amountRemainingLabel: "4.0M",
        nextResetTime: 1788710400,
        endTime: 1791258934,
      },
    ]);
    manager.state.subscription.subscriptions = [
      plan(6, 5000, "active", 6000),
      plan(1, 15_000_000, "expired"),
    ];
    const exhausted = manager.getSubscriptionUsageSummary();
    assert.equal(exhausted.amountRemaining, 0);
    assert.equal(exhausted.percentUsed, 100);
    assert.lengthOf(exhausted.details, 1);
    assert.equal(exhausted.details[0].amountRemainingLabel, "0");
    manager.state.subscription.subscriptions = [];
    assert.isNull(manager.getSubscriptionUsageSummary());
  });
  let originalZotero: unknown;
  let originalZtoolkit: unknown;
  let originalServices: unknown;
  let originalCi: unknown;
  let originalAddon: unknown;

  beforeEach(function () {
    mockChannelIds.clear();
    originalZotero = (globalThis as any).Zotero;
    originalZtoolkit = (globalThis as any).ztoolkit;
    originalServices = (globalThis as any).Services;
    originalCi = (globalThis as any).Ci;
    (globalThis as any).Ci = { nsIHttpChannel: {} };
    originalAddon = (globalThis as any).addon;
    (globalThis as any).ztoolkit = { log: () => undefined };
    (globalThis as any).addon = {
      data: {
        locale: {
          current: {
            formatMessagesSync: () => [
              { value: "localized fallback", attributes: null },
            ],
          },
        },
      },
    };
  });

  afterEach(function () {
    (globalThis as any).Zotero = originalZotero;
    (globalThis as any).ztoolkit = originalZtoolkit;
    (globalThis as any).Services = originalServices;
    (globalThis as any).Ci = originalCi;
    (globalThis as any).addon = originalAddon;
  });

  it("bypasses cached wallet and subscription balances on every refresh", async function () {
    let serverQuota = 58000;
    let serverUsed = 0;
    (globalThis as any).Zotero = {
      HTTP: {
        request: async (
          _method: string,
          url: string,
          options: { noCache?: boolean },
        ) => ({
          status: 200,
          response: {
            success: true,
            data: url.endsWith("/subscription/self")
              ? {
                  subscriptions: [
                    {
                      subscription: {
                        amount_used: options.noCache ? serverUsed : 0,
                      },
                    },
                  ],
                }
              : { quota: options.noCache ? serverQuota : 58000 },
          },
        }),
      },
    };
    const service = new AuthService("https://paperchat.test");
    assert.equal((await service.getUserInfo()).data?.quota, 58000);
    serverQuota = 0;
    serverUsed = 10000;
    assert.equal((await service.getUserInfo()).data?.quota, 0);
    assert.equal(
      (await service.getSubscriptionSelf()).data?.subscriptions?.[0]
        .subscription.amount_used,
      10000,
    );
  });

  it("uses the dashboard bearer token for user APIs and the new logout route", async function () {
    const calls: HttpCall[] = [];
    const logs: string[] = [];
    (globalThis as any).ztoolkit = {
      log: (...args: unknown[]) => logs.push(args.map(String).join(" ")),
    };
    const responses = [
      {
        success: true,
        message: "",
        data: {
          access_token: " dashboard-token ",
          user: { id: 123 },
        },
      },
      { success: true, message: "", data: [] },
      { success: true, message: "" },
    ];
    installHttpMock(calls, responses);
    const service = new AuthService("https://paperchat.test");

    const login = await service.login({
      username: "user",
      password: "super-secret-password",
    });
    const pricing = await service.getPricing();
    const logout = await service.logout();

    assert.isTrue(login.success);
    assert.isTrue(pricing.success);
    assert.isTrue(logout.success);
    assert.equal(service.getUserId(), null);
    assert.equal(calls[1].headers.Authorization, "Bearer dashboard-token");
    assert.equal(calls[1].headers["New-Api-User"], "123");
    assert.equal(calls[2].url, "https://paperchat.test/api/user/auth/logout");
    assert.equal(calls[2].headers.Authorization, "Bearer dashboard-token");
    assert.notInclude(logs.join("\n"), "super-secret-password");
    assert.notInclude(logs.join("\n"), "dashboard-token");
  });

  it("verifies legacy 2FA with the pending cookie, retries explicitly, and does not log codes", async function () {
    const jar = installCookieServices();
    const calls: HttpCall[] = [];
    const logs: string[] = [];
    (globalThis as any).ztoolkit = {
      log: (...args: unknown[]) => logs.push(args.map(String).join(" ")),
    };
    installHttpMock(
      calls,
      [
        { success: true, data: { require_2fa: true } },
        { success: false, message: "Incorrect verification code" },
        { success: true, data: { id: 123 } },
      ],
      [],
      (index) => {
        if (index === 0)
          jar.emitSetCookie(
            "https://paperchat.test/api/user/login",
            "session=pending-cookie; Path=/",
          );
        if (index === 2)
          jar.emitSetCookie(
            "https://paperchat.test/api/user/login/2fa",
            "session=verified-cookie; Path=/",
          );
      },
    );
    const service = new AuthService("https://paperchat.test");
    const prompts: Array<string | undefined> = [];
    const result = await service.login(
      { username: "user", password: "password-secret" },
      {
        signal: new AbortController().signal,
        requestTwoFactorCode: async (error) => {
          assert.isNull(
            service.getUserId(),
            "a challenge must not authenticate the user",
          );
          prompts.push(error);
          return prompts.length === 1 ? "001234" : "backup-secret-code";
        },
      },
    );
    assert.isTrue(result.success);
    assert.deepEqual(prompts, [undefined, "Incorrect verification code"]);
    assert.equal(service.getUserId(), 123);
    assert.equal(service.getSessionToken(), "verified-cookie");
    assert.equal(calls[1].headers.Cookie, "session=pending-cookie");
    assert.deepEqual(
      calls.slice(1).map((call) => call.body),
      [{ code: "001234" }, { code: "backup-secret-code" }],
    );
    assert.notInclude(logs.join("\n"), "001234");
    assert.notInclude(logs.join("\n"), "backup-secret-code");
    service.destroy();
  });

  it("supports flow-token verification and retains the resulting dashboard session", async function () {
    const jar = installCookieServices();
    const calls: HttpCall[] = [];
    const logs: string[] = [];
    (globalThis as any).ztoolkit = {
      log: (...args: unknown[]) => logs.push(args.map(String).join(" ")),
    };
    installHttpMock(
      calls,
      [
        {
          success: true,
          data: {
            require_verification: true,
            flow_token: "private-flow",
            expires_at: Math.floor(Date.now() / 1000) + 120,
            methods: [{ method: "2fa", available: true }],
          },
        },
        {
          success: true,
          data: {
            access_token: "verified-access",
            user: { id: 321 },
            session: { sid: "verified-sid" },
          },
        },
      ],
      [],
      (index) => {
        if (index === 1)
          jar.emitSetCookie(
            "https://paperchat.test/api/user/login/verify",
            "new_api_refresh=verified-refresh; Path=/api/user/auth",
          );
      },
    );
    const service = new AuthService("https://paperchat.test");
    const result = await service.login(
      { username: "user", password: "pass" },
      {
        signal: new AbortController().signal,
        requestTwoFactorCode: async () => "009876",
      },
    );
    assert.isTrue(result.success);
    assert.equal(calls[1].url, "https://paperchat.test/api/user/login/verify");
    assert.deepEqual(calls[1].body, {
      code: "009876",
      flow_token: "private-flow",
      method: "2fa",
    });
    assert.isTrue(service.hasDashboardAccessToken());
    assert.isTrue(service.hasDashboardRefreshCookie());
    assert.equal(service.getUserId(), 321);
    assert.notInclude(logs.join("\n"), "private-flow");
    assert.notInclude(logs.join("\n"), "009876");
    service.destroy();
  });

  it("clears pending cookies when 2FA requires interaction or the user cancels", async function () {
    const jar = installCookieServices();
    const calls: HttpCall[] = [];
    installHttpMock(
      calls,
      [
        { success: true, data: { require_2fa: true } },
        { success: true, data: { require_2fa: true } },
      ],
      [],
      () =>
        jar.emitSetCookie(
          "https://paperchat.test/api/user/login",
          "session=pending-cookie; Path=/",
        ),
    );
    const service = new AuthService("https://paperchat.test");
    const background = await service.login({
      username: "user",
      password: "pass",
    });
    assert.isFalse(background.success);
    assert.equal(background.code, "AUTH_2FA_REQUIRED");
    assert.isFalse(service.hasAuthenticationState());
    const cancelled = await service.login(
      { username: "user", password: "pass" },
      {
        signal: new AbortController().signal,
        requestTwoFactorCode: async () => null,
      },
    );
    assert.isFalse(cancelled.success);
    assert.isFalse(service.hasAuthenticationState());
    assert.isUndefined(jar.find("session", "/"));
    assert.lengthOf(
      calls,
      2,
      "neither case should submit a verification request",
    );
    service.destroy();
  });

  it("ignores a successful verification response arriving after dialog cancellation", async function () {
    const calls: HttpCall[] = [];
    const controller = new AbortController();
    installHttpMock(
      calls,
      [
        { success: true, data: { require_2fa: true } },
        { success: true, data: { id: 123, access_token: "late-access" } },
      ],
      [],
      (index) => {
        if (index === 1) controller.abort();
      },
    );
    const service = new AuthService("https://paperchat.test");
    const result = await service.login(
      { username: "user", password: "pass" },
      {
        signal: controller.signal,
        requestTwoFactorCode: async () => "012345",
      },
    );
    assert.isFalse(result.success);
    assert.isNull(service.getUserId());
    assert.isFalse(service.hasAuthenticationState());
    service.destroy();
  });

  it("does not submit an expired verification flow", async function () {
    const calls: HttpCall[] = [];
    installHttpMock(calls, [
      {
        success: true,
        data: {
          require_verification: true,
          flow_token: "expired-flow",
          expires_at: 1,
          methods: [{ method: "2fa", available: true }],
        },
      },
    ]);
    const service = new AuthService("https://paperchat.test");
    const result = await service.login(
      { username: "user", password: "pass" },
      {
        signal: new AbortController().signal,
        requestTwoFactorCode: async () => "012345",
      },
    );
    assert.isFalse(result.success);
    assert.equal(result.code, "AUTH_2FA_EXPIRED");
    assert.lengthOf(calls, 1);
    service.destroy();
  });

  it("sends the rc.26 flow token to login/2fa and saves credentials only after verification", async function () {
    const calls: HttpCall[] = [];
    installHttpMock(calls, [
      { success: true, data: { require_2fa: true, flow_token: "rc26-flow" } },
      {
        success: true,
        data: { user: { id: 123 }, access_token: "verified-access" },
      },
    ]);
    const prefs = new Map<string, unknown>();
    (globalThis as any).Zotero.Prefs = {
      set: (key: string, value: unknown) => prefs.set(key, value),
    };
    const service = new AuthService("https://paperchat.test");
    const manager = Object.create(AuthManager.prototype) as any;
    manager.environmentGeneration = 0;
    manager.state = { isLoggedIn: false };
    manager.authService = service;
    const completed: string[] = [];
    manager.refreshUserInfo = async () => completed.push("user");
    manager.ensurePluginToken = async () => completed.push("token");
    manager.fetchAndSetDefaultModel = async () => completed.push("models");
    manager.saveState = () => completed.push("save");
    manager.notifyLoginStatusChange = () => undefined;
    manager.startModelRefreshTimer = () => undefined;
    manager.syncLocalLanguagePreference = async () => undefined;
    const result = await manager.login("user", "saved-password", {
      signal: new AbortController().signal,
      requestTwoFactorCode: async () => {
        assert.isFalse(manager.state.isLoggedIn);
        assert.isFalse(prefs.has("extensions.zotero.paperchat.loginPassword"));
        assert.deepEqual(completed, []);
        assert.isFalse(
          await manager.autoRelogin(),
          "background refresh must not consume the interactive challenge",
        );
        return "012345";
      },
    });
    assert.isTrue(result.success);
    assert.isTrue(manager.state.isLoggedIn);
    assert.equal(calls[1].url, "https://paperchat.test/api/user/login/2fa");
    assert.deepEqual(calls[1].body, {
      code: "012345",
      flow_token: "rc26-flow",
    });
    assert.deepEqual(completed, ["user", "token", "models", "save"]);
    assert.isString(prefs.get("extensions.zotero.paperchat.loginPassword"));
    assert.notInclude(JSON.stringify([...prefs]), "012345");
    service.destroy();
  });

  it("clears account state when login is cancelled after verification but before initialization finishes", async function () {
    const prefs = new Map<string, unknown>();
    (globalThis as any).Zotero = {
      Prefs: { set: (key: string, value: unknown) => prefs.set(key, value) },
    };
    const controller = new AbortController();
    let revoked = 0;
    let tokenSetup = 0;
    const manager = Object.create(AuthManager.prototype) as any;
    manager.environmentGeneration = 0;
    manager.state = { isLoggedIn: false };
    manager.authService = {
      hasAuthenticationState: () => false,
      clearSessionCookie: () => undefined,
      setUserId: () => undefined,
      getUserId: () => 123,
      getSessionToken: () => "verified-session",
      login: async () => ({ success: true }),
      logout: async () => {
        revoked++;
        return { success: true };
      },
    };
    manager.refreshUserInfo = async () => {
      manager.state.user = { id: 123 };
      controller.abort();
    };
    manager.ensurePluginToken = async () => {
      tokenSetup++;
    };
    manager.notifyLoginStatusChange = () => undefined;
    manager.notifyUserInfoUpdate = () => undefined;
    const result = await manager.login("user", "pass", {
      signal: controller.signal,
      requestTwoFactorCode: async () => null,
    });
    assert.isFalse(result.success);
    assert.equal(revoked, 1);
    assert.equal(tokenSetup, 0);
    assert.isFalse(manager.state.isLoggedIn);
    assert.isNull(manager.state.user);
    assert.isNull(manager.state.userId);
    assert.equal(prefs.get("extensions.zotero.paperchat.apiKey"), "");
    assert.equal(prefs.get("extensions.zotero.paperchat.loginPassword"), "");
  });

  it("allows login immediately after cancellation without an older attempt releasing the new login guard", async function () {
    (globalThis as any).Zotero = { Prefs: { set: () => undefined } };
    const manager = Object.create(AuthManager.prototype) as any;
    manager.environmentGeneration = 0;
    manager.authService = {
      logout: async () => ({ success: true }),
      setUserId: () => undefined,
      clearSessionCookie: () => undefined,
    };
    manager.notifyLoginStatusChange = () => undefined;
    manager.notifyUserInfoUpdate = () => undefined;
    const finishes: Array<
      (result: { success: boolean; message: string }) => void
    > = [];
    manager.performInteractiveLogin = () =>
      new Promise((resolve) => finishes.push(resolve));
    const controller = new AbortController();
    const first = manager.login("user", "pass", {
      signal: controller.signal,
      requestTwoFactorCode: async () => null,
    });
    controller.abort();
    const second = manager.login("user", "pass");
    assert.lengthOf(finishes, 2);
    finishes[0]({ success: false, message: "cancelled" });
    await first;
    assert.isFalse((await manager.login("user", "pass")).success);
    assert.lengthOf(finishes, 2);
    finishes[1]({ success: true, message: "ok" });
    assert.isTrue((await second).success);
  });

  it("does not repeatedly submit a saved password when background recovery requires 2FA", async function () {
    (globalThis as any).Zotero = {
      Prefs: {
        get: (key: string) =>
          key.endsWith(".username")
            ? "user"
            : key.endsWith(".loginPassword")
              ? btoa("pass")
              : undefined,
      },
      DataDirectory: { dir: "/test" },
    };
    let calls = 0;
    const manager = Object.create(AuthManager.prototype) as any;
    manager.environmentGeneration = 0;
    manager.authService = {
      hasDashboardRefreshCookie: () => false,
      clearSessionCookie: () => undefined,
      login: async () => {
        calls++;
        return { success: false, code: "AUTH_2FA_REQUIRED" };
      },
    };
    assert.isFalse(await manager.autoRelogin());
    assert.isFalse(await manager.autoRelogin());
    assert.equal(calls, 1);
  });

  it("lets an interactive login supersede an in-flight password fallback", async function () {
    let finishBackground!: (value: unknown) => void;
    let requests = 0;
    (globalThis as any).Zotero = {
      HTTP: {
        request: async () => {
          requests++;
          if (requests === 1)
            return new Promise((resolve) => {
              finishBackground = resolve;
            });
          return {
            status: 200,
            response:
              requests === 2
                ? { success: true, data: { require_2fa: true } }
                : { success: true, data: { id: 321 } },
          };
        },
      },
    };
    const service = new AuthService("https://paperchat.test");
    const background = service.login({
      username: "old-user",
      password: "old-pass",
    });
    const interactive = await service.login(
      { username: "user", password: "pass" },
      {
        signal: new AbortController().signal,
        requestTwoFactorCode: async () => "012345",
      },
    );
    assert.isTrue(interactive.success);
    finishBackground({
      status: 200,
      response: { success: true, data: { id: 123 } },
    });
    assert.isFalse((await background).success);
    assert.equal(service.getUserId(), 321);
    service.destroy();
  });

  it("falls back to the legacy logout route on older NewAPI versions", async function () {
    const calls: HttpCall[] = [];
    installHttpMock(
      calls,
      [
        { success: true, message: "", data: { id: 123 } },
        { success: false, message: "not found" },
        { success: true, message: "" },
      ],
      [200, 404, 200],
    );
    const service = new AuthService("https://paperchat.test");

    await service.login({ username: "user", password: "pass" });
    const logout = await service.logout();

    assert.isTrue(logout.success);
    assert.deepEqual(
      calls.slice(1).map((call) => [call.method, call.url]),
      [
        ["POST", "https://paperchat.test/api/user/auth/logout"],
        ["GET", "https://paperchat.test/api/user/logout"],
      ],
    );
  });

  it("clears local authentication before remote logout settles", async function () {
    const cookieJar = installCookieServices([
      { name: "session", path: "/", value: "legacy-session" },
      {
        name: "new_api_refresh",
        path: "/api/user/auth",
        value: "refresh-secret",
      },
    ]);
    let resolveLogout!: (value: unknown) => void;
    let sentHeaders: Record<string, string> = {};
    (globalThis as any).Zotero = {
      HTTP: {
        request: (
          _method: string,
          _url: string,
          options: { headers: Record<string, string> },
        ) => {
          sentHeaders = options.headers;
          return new Promise((resolve) => {
            resolveLogout = resolve;
          });
        },
      },
    };
    const service = new AuthService("https://paperchat.test");
    service.restoreSessionFromCookieJar();
    service.setUserId(123);
    const logout = service.logout();

    assert.isFalse(service.hasAuthenticationState());
    assert.isNull(service.getUserId());
    assert.include(sentHeaders.Cookie, "new_api_refresh=refresh-secret");
    assert.include(sentHeaders.Cookie, "session=legacy-session");
    assert.isUndefined(cookieJar.find("session", "/"));
    assert.isUndefined(cookieJar.find("new_api_refresh", "/api/user/auth"));
    resolveLogout({
      status: 503,
      response: { success: false, message: "offline" },
    });
    assert.isFalse((await logout).success);
    service.destroy();
  });

  it("does not restore authentication from a login that completes after logout", async function () {
    let resolveLogin!: (value: unknown) => void;
    (globalThis as any).Zotero = {
      HTTP: {
        request: (_method: string, url: string) =>
          url.endsWith("/login")
            ? new Promise((resolve) => {
                resolveLogin = resolve;
              })
            : Promise.resolve({ status: 200, response: { success: true } }),
      },
    };
    const service = new AuthService("https://paperchat.test");
    const login = service.login({ username: "user", password: "pass" });
    await service.logout();
    resolveLogin({
      status: 200,
      response: {
        success: true,
        data: {
          access_token: "stale-token",
          user: { id: 123 },
        },
      },
    });
    assert.isFalse((await login).success);
    assert.isFalse(service.hasAuthenticationState());
    assert.isNull(service.getUserId());
  });

  it("preserves a new login when an older logout falls back to the legacy endpoint", async function () {
    let resolveLogout!: (value: unknown) => void;
    const calls: HttpCall[] = [];
    const service = new AuthService("https://paperchat.test");
    service.setUserId(123);
    service.setDashboardAccessToken("old-token");
    (globalThis as any).Zotero = {
      HTTP: {
        request: (
          method: string,
          url: string,
          options: { headers: Record<string, string> },
        ) => {
          calls.push({ method, url, headers: options.headers });
          if (url.endsWith("/auth/logout"))
            return new Promise((resolve) => {
              resolveLogout = resolve;
            });
          return Promise.resolve({
            status: 200,
            response: {
              success: true,
              data: {
                access_token: "new-token",
                user: { id: 456 },
              },
            },
          });
        },
      },
    };
    const logout = service.logout();
    await service.login({ username: "new-user", password: "pass" });
    resolveLogout({ status: 404, response: { success: false } });
    assert.isTrue((await logout).success);
    assert.equal(calls[2].headers.Authorization, "Bearer old-token");
    assert.equal(calls[2].headers["New-Api-User"], "123");
    assert.equal(service.getUserId(), 456);
    assert.isTrue(service.hasDashboardAccessToken());
  });

  it("ignores an old logout cookie response after a new login", async function () {
    const cookieJar = installCookieServices();
    const sid = "90d7cf27-e1eb-48bd-ae85-0f39ab0fd966";
    let resolveLogout!: (value: unknown) => void;
    (globalThis as any).Zotero = {
      HTTP: {
        request: (
          _method: string,
          url: string,
          options: { requestObserver?: (xhr: unknown) => void },
        ) => {
          registerHttpChannel(url, options);
          if (url.endsWith("/logout"))
            return new Promise((resolve) => {
              resolveLogout = resolve;
            });
          if (url.endsWith("/login"))
            cookieJar.emitSetCookie(
              url,
              `new_api_refresh=${sid}.new-secret; Path=/api/user/auth`,
            );
          return Promise.resolve({
            status: 200,
            response: {
              success: true,
              data: {
                access_token: "new-token",
                session: { sid },
                user: { id: 456 },
              },
            },
          });
        },
      },
    };
    const service = new AuthService("https://paperchat.test");
    const logout = service.logout();
    await service.login({ username: "new-user", password: "pass" });
    cookieJar.emitSetCookie(
      "https://paperchat.test/api/user/auth/logout",
      "new_api_refresh=; Path=/api/user/auth; Max-Age=0",
    );
    resolveLogout({ status: 200, response: { success: true } });
    await logout;
    await service.refreshDashboardSession();
    assert.isTrue(service.hasDashboardRefreshCookie());
    assert.equal(
      cookieJar.find("new_api_refresh", "/api/user/auth")?.value,
      `${sid}.new-secret`,
    );
    service.destroy();
  });

  it("does not apply a pre-logout refresh cookie to the next login", async function () {
    const cookieJar = installCookieServices([
      {
        name: "new_api_refresh",
        path: "/api/user/auth",
        value: "old-session.secret",
      },
    ]);
    let resolveRefresh!: (value: unknown) => void;
    let resolveLogin!: (value: unknown) => void;
    let oldRefreshChannel = 0;
    (globalThis as any).Zotero = {
      HTTP: {
        request: (
          _method: string,
          url: string,
          options: { requestObserver?: (xhr: unknown) => void },
        ) => {
          const channelId = registerHttpChannel(url, options);
          if (url.endsWith("/refresh")) {
            oldRefreshChannel = channelId;
            return new Promise((resolve) => {
              resolveRefresh = resolve;
            });
          }
          if (url.endsWith("/login"))
            return new Promise((resolve) => {
              resolveLogin = resolve;
            });
          return Promise.resolve({ status: 200, response: { success: true } });
        },
      },
    };
    const service = new AuthService("https://paperchat.test");
    service.restoreSessionFromCookieJar();
    const refresh = service.refreshDashboardSession();
    await service.logout();
    const login = service.login({ username: "new-user", password: "pass" });
    cookieJar.emitSetCookie(
      "https://paperchat.test/api/user/auth/refresh",
      "new_api_refresh=old-session.rotated-secret; Path=/api/user/auth",
      oldRefreshChannel,
    );
    resolveRefresh({
      status: 200,
      response: {
        success: true,
        data: {
          access_token: "old-token",
          user: { id: 123 },
        },
      },
    });
    assert.isFalse((await refresh).success);
    resolveLogin({
      status: 200,
      response: {
        success: true,
        data: {
          access_token: "new-token",
          user: { id: 456 },
        },
      },
    });
    assert.isTrue((await login).success);
    assert.equal(service.getUserId(), 456);
    assert.isFalse(service.hasDashboardRefreshCookie());
    assert.isUndefined(cookieJar.find("new_api_refresh", "/api/user/auth"));
    service.destroy();
  });

  it("finishes local logout without waiting for the server and ignores an old user refresh", async function () {
    const prefs = new Map<string, unknown>();
    (globalThis as any).Zotero = {
      Prefs: {
        set: (key: string, value: unknown) => prefs.set(key, value),
      },
    };
    const manager = Object.create(AuthManager.prototype) as any;
    manager.environmentGeneration = 0;
    manager.state = { isLoggedIn: true, user: { id: 123 }, apiKey: "old-key" };
    const loginUpdates: boolean[] = [];
    manager.listeners = {
      onLoginStatusChange: [(value: boolean) => loginUpdates.push(value)],
      onUserInfoUpdate: [],
      onBalanceUpdate: [],
      onError: [],
    };
    let rejectLogout!: (error: Error) => void;
    let resolveUser!: (value: unknown) => void;
    manager.authService = {
      logout: () =>
        new Promise((_resolve, reject) => {
          rejectLogout = reject;
        }),
      setUserId: () => undefined,
      clearSessionCookie: () => undefined,
      getUserInfo: () =>
        new Promise((resolve) => {
          resolveUser = resolve;
        }),
    };
    const refresh = manager.refreshUserInfo();
    await manager.logout();
    assert.isFalse(manager.state.isLoggedIn);
    assert.deepEqual(loginUpdates, [false]);
    assert.equal(prefs.get("extensions.zotero.paperchat.loginPassword"), "");
    resolveUser({
      success: true,
      data: { id: 123, username: "old-user", quota: 50 },
    });
    assert.deepEqual(await refresh, {
      userInfo: false,
      subscriptionInfo: false,
    });
    assert.isFalse(manager.state.isLoggedIn);
    assert.isNull(manager.state.user);
    rejectLogout(new Error("offline"));
    await Promise.resolve();
    assert.isFalse(manager.state.isLoggedIn);
  });

  it("revokes the current session before an interactive login", async function () {
    const calls: string[] = [];
    (globalThis as any).Zotero = {
      DataDirectory: { dir: "/tmp/zotero-profile" },
      Prefs: {
        set: () => undefined,
      },
    };
    const manager = Object.create(AuthManager.prototype) as any;
    manager.environmentGeneration = 0;
    manager.state = {
      isLoggedIn: true,
      user: { id: 123 },
      subscription: null,
      token: null,
      apiKey: "sk-plugin",
      sessionToken: null,
      userId: 123,
    };
    manager.authService = {
      hasAuthenticationState: () => true,
      logout: async () => {
        calls.push("logout");
        return { success: true, message: "" };
      },
      setUserId: () => undefined,
      clearSessionCookie: () => undefined,
      login: async () => {
        calls.push("login");
        return {
          success: false,
          message: "Conflict",
          status: 409,
          code: "AUTH_SESSION_LIMIT",
        };
      },
    };

    const result = await manager.login("user", "wrong-password");

    assert.isFalse(result.success);
    assert.deepEqual(calls, ["logout", "login"]);
    assert.isAbove(manager.passwordLoginBlockedUntil, Date.now());
  });

  it("keeps restoring the legacy session cookie for older NewAPI versions", async function () {
    installCookieServices([
      { name: "session", path: "/", value: "legacy-session" },
    ]);
    const calls: HttpCall[] = [];
    installHttpMock(calls, [{ success: true, message: "", data: [] }]);
    const service = new AuthService("https://paperchat.test");

    service.restoreSessionFromCookieJar();
    const pricing = await service.getPricing();
    service.destroy();

    assert.isTrue(pricing.success);
    assert.equal(calls[0].headers.Cookie, "session=legacy-session");
  });

  it("ignores a login response from the previous PaperChat environment", async function () {
    let resolveLogin!: (response: {
      status: number;
      response: unknown;
    }) => void;
    (globalThis as any).Zotero = {
      HTTP: {
        request: () =>
          new Promise((resolve) => {
            resolveLogin = resolve;
          }),
      },
    };
    const service = new AuthService("https://old.paperchat.test");

    const loginPromise = service.login({ username: "user", password: "pass" });
    service.setBaseUrl("https://new.paperchat.test");
    resolveLogin({
      status: 200,
      response: {
        success: true,
        data: {
          access_token: "old-dashboard-token",
          user: { id: 123 },
        },
      },
    });

    const login = await loginPromise;
    assert.isFalse(login.success);
    assert.equal(service.getUserId(), null);
  });

  it("restores and rotates the dashboard refresh cookie without logging in again", async function () {
    const sessionId = "90d7cf27-e1eb-48bd-ae85-0f39ab0fd966";
    const cookieJar = installCookieServices();
    const loginCalls: HttpCall[] = [];
    installHttpMock(
      loginCalls,
      [
        {
          success: true,
          message: "",
          data: {
            access_token: "first-access-token",
            session: { sid: sessionId },
            user: { id: 123 },
          },
        },
      ],
      [],
      () =>
        cookieJar.emitSetCookie(
          "https://paperchat.test/api/user/login",
          `new_api_refresh=${sessionId}.first-secret; Path=/api/user/auth; HttpOnly; SameSite=Strict`,
        ),
    );
    const firstService = new AuthService("https://paperchat.test");

    const login = await firstService.login({
      username: "user",
      password: "pass",
    });
    firstService.destroy();

    assert.isTrue(login.success);
    assert.equal(
      cookieJar.find("new_api_refresh", "/api/user/auth")?.value,
      `${sessionId}.first-secret`,
    );

    const restoredCalls: HttpCall[] = [];
    installHttpMock(
      restoredCalls,
      [
        {
          success: true,
          message: "",
          data: {
            access_token: "restored-access-token",
            session: { sid: sessionId },
            user: { id: 123 },
          },
        },
        { success: true, message: "", data: [] },
      ],
      [],
      (index) => {
        if (index === 0) {
          cookieJar.emitSetCookie(
            "https://paperchat.test/api/user/auth/refresh",
            `new_api_refresh=${sessionId}.rotated-secret; Path=/api/user/auth; HttpOnly; SameSite=Strict`,
          );
        }
      },
    );
    const restoredService = new AuthService("https://paperchat.test");
    restoredService.restoreSessionFromCookieJar();

    const [firstRefresh, secondRefresh] = await Promise.all([
      restoredService.refreshDashboardSession(),
      restoredService.refreshDashboardSession(),
    ]);
    const pricing = await restoredService.getPricing();
    restoredService.destroy();

    assert.isTrue(firstRefresh.success);
    assert.isTrue(secondRefresh.success);
    assert.isTrue(pricing.success);
    assert.equal(restoredCalls.length, 2);
    assert.equal(
      restoredCalls[0].url,
      "https://paperchat.test/api/user/auth/refresh",
    );
    assert.equal(
      restoredCalls[0].headers.Cookie,
      `new_api_refresh=${sessionId}.first-secret`,
    );
    assert.equal(restoredCalls[0].headers.Origin, "https://paperchat.test");
    assert.equal(
      restoredCalls[1].headers.Authorization,
      "Bearer restored-access-token",
    );
    assert.isUndefined(restoredCalls[1].headers.Cookie);
    assert.equal(
      cookieJar.find("new_api_refresh", "/api/user/auth")?.value,
      `${sessionId}.rotated-secret`,
    );
    assert.notInclude(
      restoredCalls.map((call) => call.url),
      "https://paperchat.test/api/user/login",
    );
  });

  it("coalesces concurrent password login requests", async function () {
    const calls: HttpCall[] = [];
    let resolveLogin!: (value: { status: number; response: unknown }) => void;
    (globalThis as any).Zotero = {
      HTTP: {
        request: (
          method: string,
          url: string,
          options: { headers?: Record<string, string> },
        ) => {
          calls.push({ method, url, headers: options.headers || {} });
          return new Promise((resolve) => {
            resolveLogin = resolve;
          });
        },
      },
    };
    const service = new AuthService("https://paperchat.test");

    const firstLogin = service.login({ username: "user", password: "pass" });
    const secondLogin = service.login({ username: "user", password: "pass" });
    resolveLogin({
      status: 200,
      response: { success: true, message: "", data: { id: 123 } },
    });

    const results = await Promise.all([firstLogin, secondLogin]);

    assert.isTrue(results[0].success);
    assert.isTrue(results[1].success);
    assert.equal(calls.length, 1);
  });

  it("preserves structured login conflicts for recovery decisions", async function () {
    const calls: HttpCall[] = [];
    installHttpMock(
      calls,
      [
        {
          success: false,
          code: "AUTH_SESSION_LIMIT",
          message: "Conflict",
        },
      ],
      [409],
    );
    const service = new AuthService("https://paperchat.test");

    const result = await service.login({ username: "user", password: "pass" });

    assert.isFalse(result.success);
    assert.equal(result.status, 409);
    assert.equal(result.code, "AUTH_SESSION_LIMIT");
  });

  it("coalesces session recovery and refreshes before password fallback", async function () {
    const manager = Object.create(AuthManager.prototype) as any;
    let refreshCalls = 0;
    let loginCalls = 0;
    let resolveRefresh!: (value: {
      success: boolean;
      message: string;
      status: number;
    }) => void;
    manager.environmentGeneration = 0;
    manager.autoReloginAttempt = null;
    manager.state = { userId: null, sessionToken: null };
    manager.authService = {
      hasDashboardRefreshCookie: () => true,
      refreshDashboardSession: () => {
        refreshCalls += 1;
        return new Promise((resolve) => {
          resolveRefresh = resolve;
        });
      },
      getUserId: () => 123,
      setUserId: () => undefined,
      getSessionToken: () => null,
      clearSessionCookie: () => undefined,
      login: async () => {
        loginCalls += 1;
        return { success: true, message: "" };
      },
    };

    const firstRecovery = manager.autoRelogin();
    const secondRecovery = manager.autoRelogin();
    resolveRefresh({ success: true, message: "", status: 200 });

    const results = await Promise.all([firstRecovery, secondRecovery]);

    assert.deepEqual(results, [true, true]);
    assert.equal(refreshCalls, 1);
    assert.equal(loginCalls, 0);
    assert.equal(manager.state.userId, 123);
  });

  it("replays an authenticated operation after an Unauthorized response", async function () {
    const manager = Object.create(AuthManager.prototype) as any;
    let operationCalls = 0;
    let recoveryCalls = 0;
    manager.environmentGeneration = 0;
    manager.autoRelogin = async () => {
      recoveryCalls += 1;
      return true;
    };

    const result = await manager.withSessionRetry(async () => {
      operationCalls += 1;
      return operationCalls === 1
        ? { success: false, message: "Unauthorized" }
        : { success: true, message: "" };
    }, "getUserInfo");

    assert.isTrue(result.success);
    assert.equal(recoveryCalls, 1);
    assert.equal(operationCalls, 2);
  });

  it("does not create a new session when refresh fails transiently", async function () {
    const manager = Object.create(AuthManager.prototype) as any;
    let loginCalls = 0;
    manager.environmentGeneration = 0;
    manager.autoReloginAttempt = null;
    manager.state = { userId: 123, sessionToken: null };
    manager.authService = {
      hasDashboardRefreshCookie: () => true,
      refreshDashboardSession: async () => ({
        success: false,
        message: "Too Many Requests",
        status: 429,
      }),
      login: async () => {
        loginCalls += 1;
        return { success: true, message: "" };
      },
    };

    const recovered = await manager.autoRelogin();

    assert.isFalse(recovered);
    assert.equal(loginCalls, 0);
  });

  it("falls back to one password login after refresh is explicitly unauthorized", async function () {
    const manager = Object.create(AuthManager.prototype) as any;
    let clearCalls = 0;
    let loginCalls = 0;
    (globalThis as any).Zotero = {
      DataDirectory: { dir: "/tmp/zotero-profile" },
      Prefs: {
        get(key: string) {
          if (key.endsWith(".username")) return "user";
          if (key.endsWith(".loginPassword")) return btoa("pass");
          return undefined;
        },
      },
    };
    manager.environmentGeneration = 0;
    manager.autoReloginAttempt = null;
    manager.state = { userId: 123, sessionToken: null };
    manager.authService = {
      hasDashboardRefreshCookie: () => true,
      refreshDashboardSession: async () => ({
        success: false,
        message: "Unauthorized",
        status: 401,
      }),
      clearSessionCookie: () => {
        clearCalls += 1;
      },
      login: async (request: { username: string; password: string }) => {
        loginCalls += 1;
        assert.deepEqual(request, { username: "user", password: "pass" });
        return { success: true, message: "" };
      },
      getUserId: () => 123,
      setUserId: () => undefined,
      getSessionToken: () => null,
    };

    const recovered = await manager.autoRelogin();

    assert.isTrue(recovered);
    assert.equal(clearCalls, 1);
    assert.equal(loginCalls, 1);
  });

  it("does not repeat automatic password login after a session-limit conflict", async function () {
    const manager = Object.create(AuthManager.prototype) as any;
    let loginCalls = 0;
    (globalThis as any).Zotero = {
      DataDirectory: { dir: "/tmp/zotero-profile" },
      Prefs: {
        get(key: string) {
          if (key.endsWith(".username")) return "user";
          if (key.endsWith(".loginPassword")) return btoa("pass");
          return undefined;
        },
      },
    };
    manager.environmentGeneration = 0;
    manager.autoReloginAttempt = null;
    manager.passwordLoginBlockedUntil = 0;
    manager.state = { userId: 123, sessionToken: null };
    manager.authService = {
      hasDashboardRefreshCookie: () => false,
      clearSessionCookie: () => undefined,
      login: async () => {
        loginCalls += 1;
        return {
          success: false,
          message: "Conflict",
          status: 409,
          code: "AUTH_SESSION_LIMIT",
        };
      },
    };

    const firstRecovery = await manager.autoRelogin();
    const secondRecovery = await manager.autoRelogin();
    manager.passwordLoginBlockedUntil = 0;
    const thirdRecovery = await manager.autoRelogin();

    assert.isFalse(firstRecovery);
    assert.isFalse(secondRecovery);
    assert.isFalse(thirdRecovery);
    assert.equal(loginCalls, 2);
  });

  it("restores the dashboard session once during concurrent initialization", async function () {
    const manager = Object.create(AuthManager.prototype) as any;
    let recoveryCalls = 0;
    let userRefreshCalls = 0;
    let tokenCalls = 0;
    let resolveRecovery!: (value: boolean) => void;
    manager.environmentGeneration = 0;
    manager.initializeAttempt = null;
    manager.state = {
      apiKey: "sk-plugin",
      userId: 123,
      user: null,
      isLoggedIn: false,
    };
    manager.authService = {
      hasDashboardRefreshCookie: () => true,
      hasDashboardAccessToken: () => false,
      getSessionToken: () => null,
    };
    manager.autoRelogin = () => {
      recoveryCalls += 1;
      return new Promise((resolve) => {
        resolveRecovery = resolve;
      });
    };
    manager.refreshUserInfo = async () => {
      userRefreshCalls += 1;
      manager.state.isLoggedIn = true;
    };
    manager.ensurePluginToken = async () => {
      tokenCalls += 1;
      return true;
    };
    manager.fetchAndSetDefaultModel = async () => undefined;
    manager.syncLocalLanguagePreference = async () => undefined;
    manager.startModelRefreshTimer = () => undefined;

    const firstInitialize = manager.initialize();
    const secondInitialize = manager.initialize();
    resolveRecovery(true);
    await Promise.all([firstInitialize, secondInitialize]);

    assert.equal(recoveryCalls, 1);
    assert.equal(userRefreshCalls, 1);
    assert.equal(tokenCalls, 1);
  });
});

function installHttpMock(
  calls: HttpCall[],
  responses: unknown[],
  statuses: number[] = [],
  onResponse?: (index: number) => void,
): void {
  let index = 0;
  (globalThis as any).Zotero = {
    HTTP: {
      request: async (
        method: string,
        url: string,
        options: {
          headers?: Record<string, string>;
          body?: string;
          requestObserver?: (xhr: unknown) => void;
        },
      ) => {
        registerHttpChannel(url, options);
        calls.push({
          method,
          url,
          headers: options.headers || {},
          body: options.body ? JSON.parse(options.body) : undefined,
        });
        onResponse?.(index);
        const response = responses[index];
        const status = statuses[index] ?? 200;
        index += 1;
        return { status, response };
      },
    },
  };
}

function installCookieServices(initial: StoredCookie[] = []): {
  emitSetCookie: (url: string, value: string, channelId?: number) => void;
  find: (name: string, path: string) => StoredCookie | undefined;
} {
  const cookies = [...initial];
  let observer: {
    observe: (subject: unknown, topic: string, data: string) => void;
  } | null = null;

  (globalThis as any).Ci = {
    nsIHttpChannel: {},
    nsICookie: {
      SAMESITE_LAX: 1,
      SAMESITE_STRICT: 2,
      SCHEME_HTTPS: 2,
    },
  };
  (globalThis as any).Services = {
    obs: {
      addObserver(value: typeof observer) {
        observer = value;
      },
      removeObserver(value: typeof observer) {
        if (observer === value) observer = null;
      },
    },
    cookies: {
      getCookiesFromHost() {
        return cookies.map((cookie) => ({ ...cookie }));
      },
      add(_host: string, path: string, name: string, value: string) {
        const existing = cookies.findIndex(
          (cookie) => cookie.name === name && cookie.path === path,
        );
        if (existing >= 0) cookies.splice(existing, 1);
        cookies.push({ name, path, value });
      },
      remove(_host: string, name: string, path: string) {
        const existing = cookies.findIndex(
          (cookie) => cookie.name === name && cookie.path === path,
        );
        if (existing >= 0) cookies.splice(existing, 1);
      },
    },
  };

  return {
    emitSetCookie(url, value, channelId = mockChannelIds.get(url)) {
      observer?.observe(
        {
          QueryInterface: () => ({
            URI: { spec: url },
            channelId,
            getResponseHeader: (name: string) => {
              if (name === "Set-Cookie") return value;
              throw new Error(`Unexpected response header: ${name}`);
            },
          }),
        },
        "http-on-examine-response",
        "",
      );
    },
    find(name, path) {
      return cookies.find(
        (cookie) => cookie.name === name && cookie.path === path,
      );
    },
  };
}
