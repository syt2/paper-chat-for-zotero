import { assert } from "chai";
import { AuthService } from "../src/modules/auth/AuthService";

interface HttpCall {
  method: string;
  url: string;
  headers: Record<string, string>;
}

describe("AuthService NewAPI authentication", function () {
  let originalZotero: unknown;
  let originalZtoolkit: unknown;

  beforeEach(function () {
    originalZotero = (globalThis as any).Zotero;
    originalZtoolkit = (globalThis as any).ztoolkit;
    (globalThis as any).ztoolkit = { log: () => undefined };
  });

  afterEach(function () {
    (globalThis as any).Zotero = originalZotero;
    (globalThis as any).ztoolkit = originalZtoolkit;
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
});

function installHttpMock(
  calls: HttpCall[],
  responses: unknown[],
  statuses: number[] = [],
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
        const response = responses[index];
        const status = statuses[index] ?? 200;
        index += 1;
        return { status, response };
      },
    },
  };
}
