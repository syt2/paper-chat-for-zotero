import { assert } from "chai";
import {
  getPresentationBalanceSnapshot,
  guardPresentationLaunch,
  hasEnoughPresentationBalance,
  PRESENTATION_LAUNCH_PROMPT,
  PRESENTATION_MINIMUM_REMAINING_TOKENS,
  type PresentationLaunchGuardDialogs,
} from "../src/modules/presentation/PresentationLaunchGuard.ts";

interface GuardHarnessOptions {
  providerId?: string;
  loggedIn?: boolean;
  quota?: number;
  subscriptionRemaining?: number;
  refreshResult?: {
    userInfo: boolean;
    subscriptionInfo: boolean;
  };
  switchAccepted?: boolean;
  loginAccepted?: boolean;
  warningSuppressed?: boolean;
  warningAccepted?: boolean;
  providerAfterWarning?: string;
  loggedInAfterWarning?: boolean;
  quotaAfterWarning?: number;
  paperChatReady?: boolean;
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
    showBalanceRefreshFailed: async () => {
      calls.push("refresh-failed-dialog");
    },
    showInsufficientBalance: async () => {
      calls.push("balance-dialog");
    },
    confirmHighTokenConsumption: async () => {
      calls.push("cost-dialog");
      if (options.providerAfterWarning) {
        providerId = options.providerAfterWarning;
      }
      if (options.loggedInAfterWarning !== undefined) {
        loggedIn = options.loggedInAfterWarning;
      }
      if (options.quotaAfterWarning !== undefined) {
        quota = options.quotaAfterWarning;
      }
      return options.warningAccepted ?? true;
    },
  };

  const authManager = {
    isLoggedIn: () => loggedIn,
    refreshUserInfo: async () => {
      calls.push("refresh-balance");
      return (
        options.refreshResult ?? {
          userInfo: true,
          subscriptionInfo: true,
        }
      );
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
        isCostWarningSuppressed: () => options.warningSuppressed ?? false,
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

  it("requires a balance strictly greater than one million tokens", function () {
    for (const amount of [999_999, 1_000_000]) {
      assert.isFalse(
        hasEnoughPresentationBalance({
          quota: amount,
          subscriptionRemaining: 0,
          available: amount,
        }),
      );
    }
    assert.isTrue(
      hasEnoughPresentationBalance({
        quota: 1_000_001,
        subscriptionRemaining: 0,
        available: 1_000_001,
      }),
    );
    assert.equal(PRESENTATION_MINIMUM_REMAINING_TOKENS, 1_000_000);
  });

  it("accepts either complete usable balance pool without summing partial pools", function () {
    const authManager = {
      getBalance: () => ({ quota: 400_000, usedQuota: 0 }),
      getSubscriptionUsageSummary: () => ({
        amountRemaining: 1_200_000,
      }),
    };
    assert.deepEqual(getPresentationBalanceSnapshot(authManager as never), {
      quota: 400_000,
      subscriptionRemaining: 1_200_000,
      available: 1_200_000,
    });

    const splitPools = getPresentationBalanceSnapshot({
      getBalance: () => ({ quota: 600_000, usedQuota: 0 }),
      getSubscriptionUsageSummary: () => ({ amountRemaining: 600_000 }),
    } as never);
    assert.equal(splitPools.available, 600_000);
    assert.isFalse(hasEnoughPresentationBalance(splitPools));
  });

  it("switches to PaperChat before refreshing balance", async function () {
    const harness = createGuardHarness({ providerId: "openai" });
    assert.deepEqual(await harness.run(), {
      allowed: true,
      balance: {
        quota: 1_000_001,
        subscriptionRemaining: 0,
        available: 1_000_001,
      },
    });
    assert.deepEqual(harness.calls, [
      "provider-dialog",
      "switch:paperchat",
      "refresh-balance",
      "cost-dialog",
      "refresh-balance",
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
      "refresh-balance",
      "cost-dialog",
      "refresh-balance",
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
    assert.deepEqual(harness.calls, ["refresh-balance", "cost-dialog"]);
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

  it("blocks a freshly refreshed balance of 999,999", async function () {
    const harness = createGuardHarness({ quota: 999_999 });
    assert.deepEqual(await harness.run(), {
      allowed: false,
      reason: "balance",
    });
    assert.deepEqual(harness.calls, ["refresh-balance", "balance-dialog"]);
  });

  it("blocks a freshly refreshed balance of 1,000,000", async function () {
    const harness = createGuardHarness({ quota: 1_000_000 });
    assert.deepEqual(await harness.run(), {
      allowed: false,
      reason: "balance",
    });
    assert.deepEqual(harness.calls, ["refresh-balance", "balance-dialog"]);
  });

  it("allows 1,000,001 tokens after the cost confirmation", async function () {
    const harness = createGuardHarness({ quota: 1_000_001 });
    assert.isTrue((await harness.run()).allowed);
    assert.deepEqual(harness.calls, [
      "refresh-balance",
      "cost-dialog",
      "refresh-balance",
    ]);
  });

  it("does not let the cost-warning preference bypass balance checks", async function () {
    const harness = createGuardHarness({
      quota: 1_000_000,
      warningSuppressed: true,
    });
    assert.deepEqual(await harness.run(), {
      allowed: false,
      reason: "balance",
    });
    assert.deepEqual(harness.calls, ["refresh-balance", "balance-dialog"]);
  });

  it("skips only the high-consumption warning when suppressed", async function () {
    const harness = createGuardHarness({
      quota: 1_000_001,
      warningSuppressed: true,
    });
    assert.isTrue((await harness.run()).allowed);
    assert.deepEqual(harness.calls, ["refresh-balance"]);
  });

  it("does not authorize the turn if the provider changes while the warning is open", async function () {
    const harness = createGuardHarness({
      quota: 1_000_001,
      providerAfterWarning: "openai",
    });
    assert.deepEqual(await harness.run(), {
      allowed: false,
      reason: "provider",
    });
    assert.deepEqual(harness.calls, ["refresh-balance", "cost-dialog"]);
  });

  it("does not authorize the turn if login expires while the warning is open", async function () {
    const harness = createGuardHarness({
      quota: 1_000_001,
      loggedInAfterWarning: false,
    });
    assert.deepEqual(await harness.run(), {
      allowed: false,
      reason: "login",
    });
    assert.deepEqual(harness.calls, ["refresh-balance", "cost-dialog"]);
  });

  it("rechecks balance after the cost warning before authorizing the turn", async function () {
    const harness = createGuardHarness({
      quota: 1_000_001,
      quotaAfterWarning: 1_000_000,
    });
    assert.deepEqual(await harness.run(), {
      allowed: false,
      reason: "balance",
    });
    assert.deepEqual(harness.calls, [
      "refresh-balance",
      "cost-dialog",
      "refresh-balance",
      "balance-dialog",
    ]);
  });

  it("blocks stale subscription data when ordinary quota is insufficient", async function () {
    const harness = createGuardHarness({
      quota: 10,
      subscriptionRemaining: 10_000_000,
      refreshResult: { userInfo: true, subscriptionInfo: false },
    });
    assert.deepEqual(await harness.run(), {
      allowed: false,
      reason: "balance_refresh",
    });
    assert.deepEqual(harness.calls, [
      "refresh-balance",
      "refresh-failed-dialog",
    ]);
  });

  it("allows fresh ordinary quota even if the optional subscription refresh failed", async function () {
    const harness = createGuardHarness({
      quota: 1_000_001,
      subscriptionRemaining: 10,
      refreshResult: { userInfo: true, subscriptionInfo: false },
    });
    const result = await harness.run();
    assert.deepEqual(result, {
      allowed: true,
      balance: {
        quota: 1_000_001,
        subscriptionRemaining: 0,
        available: 1_000_001,
      },
    });
  });
});
