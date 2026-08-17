import { AuthService } from "../auth";
import type { AuthManager } from "../auth/AuthManager";
import type { PaperChatTier } from "../providers/paperchat-tier-routing";
import { showAuthDialog } from "../ui/AuthDialog";
import type { PresentationLaunchSettings } from "./PresentationLaunchSettings";

export const PRESENTATION_MINIMUM_REMAINING_TOKENS = 250_000;
export const PRESENTATION_LITE_MINIMUM_REMAINING_TOKENS = 150_000;
export const PRESENTATION_PRO_MINIMUM_REMAINING_TOKENS = 750_000;
export const PRESENTATION_LAUNCH_PROMPT =
  "请直接使用 presentation 工具，基于当前论文生成一份 PPT。";

/**
 * Return the cached-balance gate for the tier that will execute the PPT turn.
 * Lite and Pro use their product-specific gates. Unknown or omitted values
 * safely retain the established Standard threshold.
 */
export function getPresentationMinimumRemainingTokens(
  paperChatTier?: PaperChatTier,
): number {
  if (paperChatTier === "paperchat-lite") {
    return PRESENTATION_LITE_MINIMUM_REMAINING_TOKENS;
  }
  if (paperChatTier === "paperchat-pro") {
    return PRESENTATION_PRO_MINIMUM_REMAINING_TOKENS;
  }
  return PRESENTATION_MINIMUM_REMAINING_TOKENS;
}

export interface PresentationBalanceSnapshot {
  quota: number;
  subscriptionRemaining: number;
  available: number;
  /** Threshold used for this launch; omitted only for legacy callers. */
  required?: number;
}

export interface PresentationLaunchGuardDialogs {
  confirmSwitchToPaperChat(): Promise<boolean>;
  showInsufficientBalance(balance: PresentationBalanceSnapshot): Promise<void>;
  configurePresentation(
    suggestedSettings?: Partial<PresentationLaunchSettings>,
  ): Promise<PresentationLaunchSettings | null>;
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
  /**
   * Optional model-derived suggestions. These are only initial form values;
   * the settings returned by the native dialog remain the source of truth.
   */
  suggestedSettings?: Partial<PresentationLaunchSettings>;
  /** Tier bound to the chat turn that will execute the presentation. */
  paperChatTier?: PaperChatTier;
}

export type PresentationLaunchGuardResult =
  | {
      allowed: true;
      balance: PresentationBalanceSnapshot;
      settings: PresentationLaunchSettings;
    }
  | {
      allowed: false;
      reason: "provider" | "login" | "balance" | "cancelled";
    };

function toUsableTokenAmount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

export function getPresentationBalanceSnapshot(
  authManager: Pick<AuthManager, "getBalance" | "getSubscriptionUsageSummary">,
  required: number = PRESENTATION_MINIMUM_REMAINING_TOKENS,
): PresentationBalanceSnapshot {
  const quota = toUsableTokenAmount(authManager.getBalance().quota);
  const subscriptionRemaining = toUsableTokenAmount(
    authManager.getSubscriptionUsageSummary()?.amountRemaining,
  );
  return {
    quota,
    subscriptionRemaining,
    // Presentation eligibility uses the user's total cached spendable balance:
    // ordinary token quota plus the remaining active subscription allowance.
    available: quota + subscriptionRemaining,
    required,
  };
}

export function hasEnoughPresentationBalance(
  balance: PresentationBalanceSnapshot,
): boolean {
  return (
    balance.available >
    (balance.required ?? PRESENTATION_MINIMUM_REMAINING_TOKENS)
  );
}

async function getCachedPresentationBalance(
  options: PresentationLaunchGuardOptions,
): Promise<PresentationBalanceSnapshot | null> {
  // The chat panel already keeps the account and subscription balances in
  // memory. PPT launch intentionally uses that snapshot instead of refreshing
  // the account endpoint, which avoids rate-limiting a user who opens or
  // revisits the settings window several times.
  const balance = getPresentationBalanceSnapshot(
    options.authManager,
    getPresentationMinimumRemainingTokens(options.paperChatTier),
  );
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

  const settings = await options.dialogs.configurePresentation(
    options.suggestedSettings,
  );
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
