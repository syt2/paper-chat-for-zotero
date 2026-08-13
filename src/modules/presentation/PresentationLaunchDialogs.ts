import { getString } from "../../utils/locale";
import { getPref, setPref } from "../../utils/prefs";
import { openPaperChatPurchaseDialog } from "../preferences/UserAuthUI";
import {
  formatPresentationBalance,
  PRESENTATION_MINIMUM_REMAINING_TOKENS,
  type PresentationBalanceSnapshot,
  type PresentationLaunchGuardDialogs,
} from "./PresentationLaunchGuard";

const STRING_BUTTON = 127;
const BUTTON_POSITION_0 = 1;
const BUTTON_POSITION_1 = 256;

function getPromptParent(): mozIDOMWindowProxy {
  return Zotero.getMainWindow() as unknown as mozIDOMWindowProxy;
}

function showTwoButtonDialog(options: {
  title: string;
  message: string;
  primary: string;
  secondary: string;
  checkboxLabel?: string;
}): { accepted: boolean; checked: boolean } {
  const checkState = { value: false };
  const result = Services.prompt.confirmEx(
    getPromptParent(),
    options.title,
    options.message,
    (STRING_BUTTON * BUTTON_POSITION_0) | (STRING_BUTTON * BUTTON_POSITION_1),
    options.primary,
    options.secondary,
    "",
    options.checkboxLabel || "",
    checkState,
  );
  return { accepted: result === 0, checked: checkState.value };
}

export function isPresentationCostWarningSuppressed(): boolean {
  return getPref("paperchatSuppressPresentationCostWarning") === true;
}

export function createPresentationLaunchDialogs(): PresentationLaunchGuardDialogs {
  return {
    async confirmSwitchToPaperChat(): Promise<boolean> {
      return showTwoButtonDialog({
        title: getString("presentation-paperchat-required-title"),
        message: getString("presentation-paperchat-required-message"),
        primary: getString("presentation-switch-paperchat"),
        secondary: getString("auth-cancel"),
      }).accepted;
    },

    async showBalanceRefreshFailed(): Promise<void> {
      Services.prompt.alert(
        getPromptParent(),
        getString("presentation-balance-refresh-failed-title"),
        getString("presentation-balance-refresh-failed-message"),
      );
    },

    async showInsufficientBalance(
      balance: PresentationBalanceSnapshot,
    ): Promise<void> {
      const decision = showTwoButtonDialog({
        title: getString("presentation-insufficient-balance-title"),
        message: getString("presentation-insufficient-balance-message", {
          args: {
            current: formatPresentationBalance(balance.available),
            required: formatPresentationBalance(
              PRESENTATION_MINIMUM_REMAINING_TOKENS,
            ),
          },
        }),
        primary: getString("pref-get-redeem-code"),
        secondary: getString("auth-cancel"),
      });
      if (decision.accepted) {
        await openPaperChatPurchaseDialog();
      }
    },

    async confirmHighTokenConsumption(): Promise<boolean> {
      const decision = showTwoButtonDialog({
        title: getString("presentation-cost-warning-title"),
        message: getString("presentation-cost-warning-message"),
        primary: getString("presentation-start"),
        secondary: getString("auth-cancel"),
        checkboxLabel: getString("presentation-dont-remind"),
      });
      if (decision.accepted && decision.checked) {
        setPref("paperchatSuppressPresentationCostWarning", true);
      }
      return decision.accepted;
    },
  };
}
