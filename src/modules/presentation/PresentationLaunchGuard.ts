import { AuthService } from "../auth";
import type { AuthManager } from "../auth/AuthManager";
import { showAuthDialog } from "../ui/AuthDialog";
import type { PresentationLaunchSettings } from "./PresentationLaunchSettings";

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
  configurePresentation(): Promise<PresentationLaunchSettings | null>;
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
    "isLoggedIn" | "getBalance" | "getSubscriptionUsageSummary"
  >;
  dialogs: PresentationLaunchGuardDialogs;
  ensureLoggedIn?: () => Promise<boolean>;
}

export type PresentationLaunchGuardResult =
  | {
      allowed: true;
      balance: PresentationBalanceSnapshot;
      settings: PresentationLaunchSettings;
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

async function getCachedPresentationBalance(
  options: PresentationLaunchGuardOptions,
): Promise<PresentationBalanceSnapshot | null> {
  // The chat panel already keeps the account and subscription balances in
  // memory. PPT launch intentionally uses that snapshot instead of refreshing
  // the account endpoint, which avoids rate-limiting a user who opens or
  // revisits the settings window several times.
  const balance = getPresentationBalanceSnapshot(options.authManager);
  if (!hasEnoughPresentationBalance(balance)) {
    await options.dialogs.showInsufficientBalance(balance);
    return null;
  }
  return balance;
}

/** Shared launch gate for every PPT entry point. */
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

  let balance = await getCachedPresentationBalance(options);
  if (!balance) return { allowed: false, reason: "balance" };

  const settings = await options.dialogs.configurePresentation();
  if (!settings) {
    return { allowed: false, reason: "cancelled" };
  }

  // Dialogs yield back to the event loop. The user can still switch providers
  // or sign out while the settings window is open, so re-check the execution
  // boundary immediately before authorizing the expensive turn.
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

  // Re-read the in-memory snapshot in case another local task consumed quota
  // while this dialog was open. This remains synchronous and performs no
  // account or subscription network request.
  balance = await getCachedPresentationBalance(options);
  if (!balance) return { allowed: false, reason: "balance" };

  return { allowed: true, balance, settings };
}

export function formatPresentationBalance(balance: number): string {
  return AuthService.formatQuota(balance);
}
