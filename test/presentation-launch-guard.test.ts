import { assert } from "chai";
import {
  getPresentationBalanceSnapshot,
  guardPresentationLaunch,
  hasEnoughPresentationBalance,
  PRESENTATION_LAUNCH_PROMPT,
  PRESENTATION_MINIMUM_REMAINING_TOKENS,
  type PresentationLaunchGuardDialogs,
} from "../src/modules/presentation/PresentationLaunchGuard.ts";
import type { PresentationLaunchSettings } from "../src/modules/presentation/PresentationLaunchSettings.ts";

const DEFAULT_SETTINGS: PresentationLaunchSettings = {
  slideCount: 6,
  designSystem: "teal-green-academic-defense",
  userInstructions: "",
};

interface GuardHarnessOptions {
  providerId?: string;
  loggedIn?: boolean;
  quota?: number;
  subscriptionRemaining?: number;
  failIfBalanceRefreshed?: boolean;
  switchAccepted?: boolean;
  loginAccepted?: boolean;
  settingsAccepted?: boolean;
  providerAfterSettings?: string;
  loggedInAfterSettings?: boolean;
  quotaAfterSettings?: number;
  paperChatReady?: boolean;
  settings?: PresentationLaunchSettings;
}

function createGuardHarness(options: GuardHarnessOptions = {}) {
  let providerId = options.providerId ?? "paperchat";
  let loggedIn = options.loggedIn ?? true;
  let quota = options.quota ?? 1_000_001;
  const calls: string[] = [];

  const dialogs: PresentationLaunchGuardDialogs = {
    confirmSwitchToPaperChat: async () => {
      calls.push("provider-dialog");
      return options.switchAccepted ?? true;
    },
    showInsufficientBalance: async () => {
      calls.push("balance-dialog");
    },
    configurePresentation: async () => {
      calls.push("settings-dialog");
      if (options.providerAfterSettings) {
        providerId = options.providerAfterSettings;
      }
      if (options.loggedInAfterSettings !== undefined) {
        loggedIn = options.loggedInAfterSettings;
      }
      if (options.quotaAfterSettings !== undefined) {
        quota = options.quotaAfterSettings;
      }
      return options.settingsAccepted === false
        ? null
        : options.settings || DEFAULT_SETTINGS;
    },
  };

  const authManager = {
    isLoggedIn: () => loggedIn,
    refreshUserInfo: async () => {
      calls.push("refresh-balance");
      if (options.failIfBalanceRefreshed) {
        throw new Error("presentation launch must use cached balance");
      }
      return { userInfo: true, subscriptionInfo: true };
    },
    getBalance: () => ({ quota, usedQuota: 0 }),
    getSubscriptionUsageSummary: () =>
      options.subscriptionRemaining === undefined
        ? null
        : {
            amountTotal: options.subscriptionRemaining,
            amountUsed: 0,
            amountRemaining: options.subscriptionRemaining,
            amountTotalLabel: "",
            amountUsedLabel: "",
            percentUsed: 0,
          },
  };

  return {
    calls,
    run: () =>
      guardPresentationLaunch({
        providerManager: {
          getActiveProviderId: () => providerId,
          getProvider: (requestedProviderId: string) =>
            requestedProviderId === "paperchat"
              ? {
                  config: { id: "paperchat", type: "paperchat" },
                  isReady: () => options.paperChatReady ?? loggedIn,
                }
              : null,
          setActiveProvider: (nextProviderId: string) => {
            calls.push(`switch:${nextProviderId}`);
            providerId = nextProviderId;
          },
        },
        authManager: authManager as never,
        dialogs,
        ensureLoggedIn: async () => {
          calls.push("login-dialog");
          loggedIn = options.loginAccepted ?? true;
          return loggedIn;
        },
      }),
  };
}

describe("presentation launch guard", function () {
  it("uses the deliberately short dedicated launch prompt", function () {
    assert.equal(
      PRESENTATION_LAUNCH_PROMPT,
      "请直接使用 presentation 工具，基于当前论文生成一份 PPT。",
    );
  });

  it("requires more than two hundred fifty thousand cached tokens", function () {
    assert.isFalse(
      hasEnoughPresentationBalance({
        quota: 249_999,
        subscriptionRemaining: 0,
        available: 249_999,
      }),
    );
    assert.isFalse(
      hasEnoughPresentationBalance({
        quota: 250_000,
        subscriptionRemaining: 0,
        available: 250_000,
      }),
    );
    assert.isTrue(
      hasEnoughPresentationBalance({
        quota: 250_001,
        subscriptionRemaining: 0,
        available: 250_001,
      }),
    );
    assert.equal(PRESENTATION_MINIMUM_REMAINING_TOKENS, 250_000);
  });

  it("adds ordinary quota and subscription balance for launch eligibility", function () {
    const authManager = {
      getBalance: () => ({ quota: 400_000, usedQuota: 0 }),
      getSubscriptionUsageSummary: () => ({
        amountRemaining: 1_200_000,
      }),
    };
    assert.deepEqual(getPresentationBalanceSnapshot(authManager as never), {
      quota: 400_000,
      subscriptionRemaining: 1_200_000,
      available: 1_600_000,
    });

    const splitPools = getPresentationBalanceSnapshot({
      getBalance: () => ({ quota: 150_000, usedQuota: 0 }),
      getSubscriptionUsageSummary: () => ({ amountRemaining: 150_000 }),
    } as never);
    assert.equal(splitPools.available, 300_000);
    assert.isTrue(hasEnoughPresentationBalance(splitPools));
  });

  it("switches to PaperChat before using the cached balance", async function () {
    const harness = createGuardHarness({ providerId: "openai" });
    assert.deepEqual(await harness.run(), {
      allowed: true,
      balance: {
        quota: 1_000_001,
        subscriptionRemaining: 0,
        available: 1_000_001,
      },
      settings: DEFAULT_SETTINGS,
    });
    assert.deepEqual(harness.calls, [
      "provider-dialog",
      "switch:paperchat",
      "settings-dialog",
    ]);
  });

  it("switches to PaperChat before prompting a logged-out user to sign in", async function () {
    const harness = createGuardHarness({
      providerId: "openai",
      loggedIn: false,
      loginAccepted: true,
    });
    assert.isTrue((await harness.run()).allowed);
    assert.deepEqual(harness.calls, [
      "provider-dialog",
      "switch:paperchat",
      "login-dialog",
      "settings-dialog",
    ]);
  });

  it("stops when the user refuses the PaperChat switch", async function () {
    const harness = createGuardHarness({
      providerId: "openai",
      switchAccepted: false,
    });
    assert.deepEqual(await harness.run(), {
      allowed: false,
      reason: "provider",
    });
    assert.deepEqual(harness.calls, ["provider-dialog"]);
  });

  it("does not start when PaperChat is selected but unavailable", async function () {
    const harness = createGuardHarness({ paperChatReady: false });
    assert.deepEqual(await harness.run(), {
      allowed: false,
      reason: "provider",
    });
    assert.deepEqual(harness.calls, ["settings-dialog"]);
  });

  it("requires login before checking balance", async function () {
    const harness = createGuardHarness({
      loggedIn: false,
      loginAccepted: false,
    });
    assert.deepEqual(await harness.run(), {
      allowed: false,
      reason: "login",
    });
    assert.deepEqual(harness.calls, ["login-dialog"]);
  });

  it("blocks a cached balance of 249,999", async function () {
    const harness = createGuardHarness({ quota: 249_999 });
    assert.deepEqual(await harness.run(), {
      allowed: false,
      reason: "balance",
    });
    assert.deepEqual(harness.calls, ["balance-dialog"]);
  });

  it("blocks exactly 250,000 cached tokens without refreshing the account", async function () {
    const harness = createGuardHarness({
      quota: 250_000,
      failIfBalanceRefreshed: true,
    });
    assert.deepEqual(await harness.run(), {
      allowed: false,
      reason: "balance",
    });
    assert.deepEqual(harness.calls, ["balance-dialog"]);
  });

  it("allows 250,001 cached tokens without refreshing the account", async function () {
    const harness = createGuardHarness({
      quota: 250_001,
      failIfBalanceRefreshed: true,
    });
    assert.isTrue((await harness.run()).allowed);
    assert.deepEqual(harness.calls, ["settings-dialog"]);
  });

  it("shows the settings and high-token warning on every launch", async function () {
    const harness = createGuardHarness({ quota: 1_000_001 });

    assert.isTrue((await harness.run()).allowed);
    assert.isTrue((await harness.run()).allowed);
    assert.deepEqual(harness.calls, ["settings-dialog", "settings-dialog"]);
  });

  it("does not authorize the turn if the provider changes while settings are open", async function () {
    const harness = createGuardHarness({
      quota: 1_000_001,
      providerAfterSettings: "openai",
    });
    assert.deepEqual(await harness.run(), {
      allowed: false,
      reason: "provider",
    });
    assert.deepEqual(harness.calls, ["settings-dialog"]);
  });

  it("does not authorize the turn if login expires while settings are open", async function () {
    const harness = createGuardHarness({
      quota: 1_000_001,
      loggedInAfterSettings: false,
    });
    assert.deepEqual(await harness.run(), {
      allowed: false,
      reason: "login",
    });
    assert.deepEqual(harness.calls, ["settings-dialog"]);
  });

  it("rechecks balance after settings confirmation before authorizing the turn", async function () {
    const harness = createGuardHarness({
      quota: 1_000_001,
      quotaAfterSettings: 249_999,
    });
    assert.deepEqual(await harness.run(), {
      allowed: false,
      reason: "balance",
    });
    assert.deepEqual(harness.calls, ["settings-dialog", "balance-dialog"]);
  });

  it("uses the cached subscription balance without a network refresh", async function () {
    const harness = createGuardHarness({
      quota: 10,
      subscriptionRemaining: 10_000_000,
      failIfBalanceRefreshed: true,
    });
    const result = await harness.run();
    assert.deepEqual(result, {
      allowed: true,
      balance: {
        quota: 10,
        subscriptionRemaining: 10_000_000,
        available: 10_000_010,
      },
      settings: DEFAULT_SETTINGS,
    });
    assert.deepEqual(harness.calls, ["settings-dialog"]);
  });

  it("returns the selected slide count and design system", async function () {
    const settings: PresentationLaunchSettings = {
      slideCount: 15,
      designSystem: "dark-editorial",
      userInstructions: "Focus on the ablation study.",
    };
    const result = await createGuardHarness({ settings }).run();

    assert.isTrue(result.allowed);
    if (result.allowed) {
      assert.deepEqual(result.settings, settings);
    }
  });

  it("cancels immediately when settings are dismissed", async function () {
    const harness = createGuardHarness({ settingsAccepted: false });

    assert.deepEqual(await harness.run(), {
      allowed: false,
      reason: "cancelled",
    });
    assert.deepEqual(harness.calls, ["settings-dialog"]);
  });
});
