import { assert } from "chai";
import { AuthManager } from "../src/modules/auth/AuthManager";
import { AuthService } from "../src/modules/auth/AuthService";

interface HttpCall {
  method: string;
  url: string;
  headers: Record<string, string>;
}

interface StoredCookie {
  name: string;
  path: string;
  value: string;
}

describe("AuthService NewAPI authentication", function () {
  let originalZotero: unknown;
  let originalZtoolkit: unknown;
  let originalServices: unknown;
  let originalCi: unknown;

  beforeEach(function () {
    originalZotero = (globalThis as any).Zotero;
    originalZtoolkit = (globalThis as any).ztoolkit;
    originalServices = (globalThis as any).Services;
    originalCi = (globalThis as any).Ci;
    (globalThis as any).ztoolkit = { log: () => undefined };
  });

  afterEach(function () {
    (globalThis as any).Zotero = originalZotero;
    (globalThis as any).ztoolkit = originalZtoolkit;
    (globalThis as any).Services = originalServices;
    (globalThis as any).Ci = originalCi;
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
      calls.slice(1).map((call) => call.url),
      [
        "https://paperchat.test/api/user/auth/logout",
        "https://paperchat.test/api/user/logout",
      ],
    );
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
        options: { headers?: Record<string, string> },
      ) => {
        calls.push({ method, url, headers: options.headers || {} });
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
  emitSetCookie: (url: string, value: string) => void;
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
    emitSetCookie(url, value) {
      observer?.observe(
        {
          QueryInterface: () => ({
            URI: { spec: url },
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
