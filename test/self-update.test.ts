import { assert } from "chai";
import { config } from "../package.json";
import {
  SELF_UPDATE_CHECK_INTERVAL_MS,
  SELF_UPDATE_CLOSE_DELAY_MS,
  compareVersion,
  findNewerUpdate,
  resetSelfUpdateSchedulerForTests,
  runScheduledUpdateCheckForTests,
  setSelfUpdateCloseDelayForTests,
  startSelfUpdateScheduler,
} from "../src/utils/selfUpdate.ts";
import {
  notifyChatPanelClosed,
  resetChatActivityForTests,
  setChatInUseCheck,
} from "../src/utils/chatActivity.ts";
import {
  GITHUB_PROXY_BASES,
  getGithubUrlCandidates,
  getUpdateURLTemplate,
  toGhProxyUrl,
  toProxyUrl,
} from "../src/utils/updateUrls.ts";

describe("self update helpers", function () {
  it("builds release update json paths from version channel", function () {
    assert.equal(
      getUpdateURLTemplate("2.2.1"),
      "https://github.com/{{owner}}/{{repo}}/releases/download/release/update.json",
    );
    assert.equal(
      getUpdateURLTemplate("2.2.1-beta.1"),
      "https://github.com/{{owner}}/{{repo}}/releases/download/release/update-beta.json",
    );
  });

  it("builds GitHub fallback candidates in direct-then-mirror order", function () {
    const githubUrl =
      "https://github.com/syt2/paper-chat-for-zotero/releases/download/release/update.json";

    assert.equal(toGhProxyUrl(githubUrl), `https://gh-proxy.org/${githubUrl}`);
    // kkgithub.com expired, so it must not be offered as a mirror any more.
    assert.notInclude(GITHUB_PROXY_BASES.join(" "), "kkgithub");
    assert.deepEqual(getGithubUrlCandidates(githubUrl), [
      githubUrl,
      `https://gh-proxy.org/${githubUrl}`,
      `https://gh-proxy.com/${githubUrl}`,
      `https://ghfast.top/${githubUrl}`,
      `https://ghproxy.net/${githubUrl}`,
    ]);
    assert.equal(
      toProxyUrl("https://ghfast.top/", githubUrl),
      `https://ghfast.top/${githubUrl}`,
    );
  });

  it("selects the newest update only when it is newer than the installed version", function () {
    const updateInfo = {
      addons: {
        [config.addonID]: {
          updates: [
            {
              version: "2.2.2",
              update_link: "https://github.com/example/release/2.2.2.xpi",
            },
            {
              version: "2.3.0",
              update_link: "https://github.com/example/release/2.3.0.xpi",
            },
          ],
        },
      },
    };

    assert.equal(
      findNewerUpdate("2.2.1", updateInfo)?.update_link,
      "https://github.com/example/release/2.3.0.xpi",
    );
    assert.isNull(findNewerUpdate("2.3.0", updateInfo));
  });

  it("compares dotted versions without Zotero Services", function () {
    assert.equal(compareVersion("2.2.1", "2.2.2"), -1);
    assert.equal(compareVersion("2.2.2", "2.2.1"), 1);
    assert.equal(compareVersion("2.2.1", "2.2.1"), 0);
  });

  describe("self update scheduler", function () {
    let originalZotero: unknown;
    let originalZtoolkit: unknown;
    let originalChromeUtils: unknown;
    let hadEnv: boolean;
    let originalEnv: unknown;
    const runtime = globalThis as Record<string, unknown>;

    beforeEach(function () {
      originalZotero = runtime.Zotero;
      originalZtoolkit = runtime.ztoolkit;
      originalChromeUtils = runtime.ChromeUtils;
      hadEnv = Object.prototype.hasOwnProperty.call(runtime, "__env__");
      originalEnv = runtime.__env__;
      runtime.ztoolkit = { log: () => undefined };
    });

    afterEach(function () {
      resetSelfUpdateSchedulerForTests();
      resetChatActivityForTests();
      runtime.Zotero = originalZotero;
      runtime.ztoolkit = originalZtoolkit;
      runtime.ChromeUtils = originalChromeUtils;
      if (hadEnv) {
        runtime.__env__ = originalEnv;
      } else {
        delete runtime.__env__;
      }
    });

    /** Mock a published release and an installed build that predates it. */
    function mockPublishedRelease(
      publishedVersion: () => string,
      state: { installs: number },
    ): void {
      runtime.Zotero = {
        HTTP: {
          request: async () => ({
            responseText: JSON.stringify({
              addons: {
                [config.addonID]: {
                  updates: [
                    {
                      version: publishedVersion(),
                      update_link: `https://example.test/${publishedVersion()}.xpi`,
                    },
                  ],
                },
              },
            }),
          }),
        },
      };
      runtime.ChromeUtils = {
        importESModule: () => ({
          AddonManager: {
            STATE_AVAILABLE: 0,
            getAddonByID: async () => ({ version: "1.0.0" }),
            getInstallForURL: async () => ({
              state: 0,
              install: async () => {
                state.installs += 1;
              },
            }),
          },
        }),
      };
    }

    it("uses a three hour interval and a ten second close delay", function () {
      assert.equal(SELF_UPDATE_CHECK_INTERVAL_MS, 3 * 60 * 60 * 1000);
      assert.equal(SELF_UPDATE_CLOSE_DELAY_MS, 10 * 1000);
    });

    it("does not schedule checks outside production builds", function () {
      delete runtime.__env__;
      let requests = 0;
      runtime.Zotero = {
        HTTP: {
          request: async () => {
            requests += 1;
            return { responseText: "{}" };
          },
        },
      };

      assert.isUndefined(startSelfUpdateScheduler());
      assert.equal(requests, 0);
    });

    it("checks on startup even while the chat panel is open", async function () {
      runtime.__env__ = "production";
      const state = { installs: 0 };
      mockPublishedRelease(() => "99.0.0", state);
      setChatInUseCheck(() => true);

      await startSelfUpdateScheduler();

      assert.equal(state.installs, 1);
    });

    it("defers an interval check while in use and installs after the panel closes", async function () {
      runtime.__env__ = "production";
      let inUse = true;
      let published = "1.0.0";
      const state = { installs: 0 };
      setChatInUseCheck(() => inUse);
      setSelfUpdateCloseDelayForTests(0);
      mockPublishedRelease(() => published, state);

      // Startup finds nothing newer, so nothing installs.
      await startSelfUpdateScheduler();
      assert.equal(state.installs, 0);

      // A release lands later; the interval check defers while in use.
      published = "99.0.0";
      await runScheduledUpdateCheckForTests();
      assert.equal(state.installs, 0);

      // Closing the panel schedules the deferred install.
      inUse = false;
      notifyChatPanelClosed();
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(state.installs, 1);
    });

    it("keeps waiting when the panel is reopened during the grace period", async function () {
      runtime.__env__ = "production";
      let inUse = true;
      let published = "1.0.0";
      const state = { installs: 0 };
      setChatInUseCheck(() => inUse);
      setSelfUpdateCloseDelayForTests(0);
      mockPublishedRelease(() => published, state);

      await startSelfUpdateScheduler();
      published = "99.0.0";
      await runScheduledUpdateCheckForTests();
      assert.equal(state.installs, 0);

      // The user closes and immediately reopens the panel.
      inUse = false;
      notifyChatPanelClosed();
      inUse = true;
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(state.installs, 0);

      // Closing it again lets the deferred install run.
      inUse = false;
      notifyChatPanelClosed();
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(state.installs, 1);
    });

    it("does nothing on close when no update was pending", async function () {
      runtime.__env__ = "production";
      const inUse = false;
      const state = { installs: 0 };
      setChatInUseCheck(() => inUse);
      setSelfUpdateCloseDelayForTests(0);
      mockPublishedRelease(() => "1.0.0", state);

      await startSelfUpdateScheduler();
      notifyChatPanelClosed();
      await new Promise((resolve) => setTimeout(resolve, 20));

      assert.equal(state.installs, 0);
    });
  });
});
