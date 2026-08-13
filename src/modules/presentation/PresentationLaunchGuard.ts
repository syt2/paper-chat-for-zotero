import { AuthService } from "../auth";
import type { AuthManager, UserInfoRefreshResult } from "../auth/AuthManager";
import { showAuthDialog } from "../ui/AuthDialog";

export const PRESENTATION_MINIMUM_REMAINING_TOKENS = 1_000_000;
export const PRESENTATION_LAUNCH_PROMPT =
  "请直接使用 presentation 工具，基于当前论文生成一份 PPT。";

export interface PresentationBalanceSnapshot {
  quota: number;
  subscriptionRemaining: number;
  available: number;
}

export interface PresentationLaunchGuardDialogs {
  confirmSwitchToPaperChat(): Promise<boolean>;
  showBalanceRefreshFailed(): Promise<void>;
  showInsufficientBalance(balance: PresentationBalanceSnapshot): Promise<void>;
  confirmHighTokenConsumption(): Promise<boolean>;
}

export interface PresentationLaunchGuardOptions {
  providerManager: {
    getActiveProviderId(): string;
    getProvider(providerId: string): {
      config: { id: string; type: string };
      isReady(): boolean;
    } | null;
    setActiveProvider(providerId: string): void;
  };
  authManager: Pick<
    AuthManager,
    | "isLoggedIn"
    | "refreshUserInfo"
    | "getBalance"
    | "getSubscriptionUsageSummary"
  >;
  dialogs: PresentationLaunchGuardDialogs;
  ensureLoggedIn?: () => Promise<boolean>;
  isCostWarningSuppressed: () => boolean;
}

export type PresentationLaunchGuardResult =
  | {
      allowed: true;
      balance: PresentationBalanceSnapshot;
    }
  | {
      allowed: false;
      reason:
        | "provider"
        | "login"
        | "balance_refresh"
        | "balance"
        | "cancelled";
    };

function toUsableTokenAmount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

export function getPresentationBalanceSnapshot(
  authManager: Pick<AuthManager, "getBalance" | "getSubscriptionUsageSummary">,
  options: { includeSubscription?: boolean } = {},
): PresentationBalanceSnapshot {
  const quota = toUsableTokenAmount(authManager.getBalance().quota);
  const subscriptionRemaining =
    options.includeSubscription === false
      ? 0
      : toUsableTokenAmount(
          authManager.getSubscriptionUsageSummary()?.amountRemaining,
        );
  return {
    quota,
    subscriptionRemaining,
    // The account may consume from either the normal quota pool or an active
    // subscription pool. Requiring one complete PPT budget in a single pool
    // avoids assuming that the backend combines them for one request.
    available: Math.max(quota, subscriptionRemaining),
  };
}

export function hasEnoughPresentationBalance(
  balance: PresentationBalanceSnapshot,
): boolean {
  return balance.available > PRESENTATION_MINIMUM_REMAINING_TOKENS;
}

function isUserInfoRefreshResult(
  result: UserInfoRefreshResult | unknown,
): result is UserInfoRefreshResult {
  return (
    typeof result === "object" &&
    result !== null &&
    typeof (result as UserInfoRefreshResult).userInfo === "boolean" &&
    typeof (result as UserInfoRefreshResult).subscriptionInfo === "boolean"
  );
}

type FreshPresentationBalanceResult =
  | { ok: true; balance: PresentationBalanceSnapshot }
  | { ok: false; reason: "balance_refresh" | "balance" };

async function getFreshPresentationBalance(
  options: PresentationLaunchGuardOptions,
): Promise<FreshPresentationBalanceResult> {
  let refreshResult: UserInfoRefreshResult | unknown;
  try {
    refreshResult = await options.authManager.refreshUserInfo();
  } catch (error) {
    ztoolkit.log(
      "[PresentationLaunchGuard] Failed to refresh PaperChat balance:",
      error,
    );
    await options.dialogs.showBalanceRefreshFailed();
    return { ok: false, reason: "balance_refresh" };
  }

  if (!isUserInfoRefreshResult(refreshResult) || !refreshResult.userInfo) {
    await options.dialogs.showBalanceRefreshFailed();
    return { ok: false, reason: "balance_refresh" };
  }

  const freshQuota = toUsableTokenAmount(
    options.authManager.getBalance().quota,
  );
  if (
    !refreshResult.subscriptionInfo &&
    freshQuota <= PRESENTATION_MINIMUM_REMAINING_TOKENS
  ) {
    // A failed subscription refresh leaves that pool stale. A freshly fetched
    // ordinary quota can still safely authorize the launch by itself.
    await options.dialogs.showBalanceRefreshFailed();
    return { ok: false, reason: "balance_refresh" };
  }

  const balance = getPresentationBalanceSnapshot(options.authManager, {
    includeSubscription: refreshResult.subscriptionInfo,
  });
  if (!hasEnoughPresentationBalance(balance)) {
    await options.dialogs.showInsufficientBalance(balance);
    return { ok: false, reason: "balance" };
  }

  return { ok: true, balance };
}

/**
 * Shared launch gate for every PPT entry point. The cost-warning preference
 * deliberately does not bypass provider, login, or fresh-balance checks.
 */
export async function guardPresentationLaunch(
  options: PresentationLaunchGuardOptions,
): Promise<PresentationLaunchGuardResult> {
  if (options.providerManager.getActiveProviderId() !== "paperchat") {
    if (!(await options.dialogs.confirmSwitchToPaperChat())) {
      return { allowed: false, reason: "provider" };
    }
    options.providerManager.setActiveProvider("paperchat");
    const paperChatProvider = options.providerManager.getProvider("paperchat");
    if (
      options.providerManager.getActiveProviderId() !== "paperchat" ||
      paperChatProvider?.config.id !== "paperchat" ||
      paperChatProvider.config.type !== "paperchat"
    ) {
      return { allowed: false, reason: "provider" };
    }
  }

  if (!options.authManager.isLoggedIn()) {
    const loggedIn = await (
      options.ensureLoggedIn ?? (() => showAuthDialog("login"))
    )();
    if (!loggedIn || !options.authManager.isLoggedIn()) {
      return { allowed: false, reason: "login" };
    }
  }

  const initialBalanceResult = await getFreshPresentationBalance(options);
  if (!initialBalanceResult.ok) {
    return { allowed: false, reason: initialBalanceResult.reason };
  }
  let balance = initialBalanceResult.balance;

  const shouldConfirmCost = !options.isCostWarningSuppressed();
  if (shouldConfirmCost) {
    if (!(await options.dialogs.confirmHighTokenConsumption())) {
      return { allowed: false, reason: "cancelled" };
    }
  }

  // Dialogs yield back to the event loop. The user can still switch providers
  // while the login, balance refresh, or cost warning is open, so re-check the
  // execution boundary immediately before authorizing the expensive turn.
  if (options.providerManager.getActiveProviderId() !== "paperchat") {
    return { allowed: false, reason: "provider" };
  }
  if (!options.authManager.isLoggedIn()) {
    return { allowed: false, reason: "login" };
  }
  const paperChatProvider = options.providerManager.getProvider("paperchat");
  if (
    paperChatProvider?.config.id !== "paperchat" ||
    paperChatProvider.config.type !== "paperchat" ||
    !paperChatProvider.isReady()
  ) {
    return { allowed: false, reason: "provider" };
  }

  // The warning can stay open while the same account consumes tokens in
  // another window or device. Refresh again after confirmation so a stale
  // pre-dialog snapshot cannot authorize an expensive turn.
  if (shouldConfirmCost) {
    const finalBalanceResult = await getFreshPresentationBalance(options);
    if (!finalBalanceResult.ok) {
      return { allowed: false, reason: finalBalanceResult.reason };
    }
    balance = finalBalanceResult.balance;

    // The network refresh also yields, so provider/login state must still be
    // valid at the exact boundary where the launch authorization is returned.
    if (options.providerManager.getActiveProviderId() !== "paperchat") {
      return { allowed: false, reason: "provider" };
    }
    if (!options.authManager.isLoggedIn()) {
      return { allowed: false, reason: "login" };
    }
    const finalPaperChatProvider =
      options.providerManager.getProvider("paperchat");
    if (
      finalPaperChatProvider?.config.id !== "paperchat" ||
      finalPaperChatProvider.config.type !== "paperchat" ||
      !finalPaperChatProvider.isReady()
    ) {
      return { allowed: false, reason: "provider" };
    }
  }

  return { allowed: true, balance };
}

export function formatPresentationBalance(balance: number): string {
  return AuthService.formatQuota(balance);
}
