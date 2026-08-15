import type { AnalyticsEventProps } from "./AnalyticsService";
import { ANALYTICS_EVENTS } from "./events";

export interface AnalyticsTracker {
  track(eventName: string, props?: AnalyticsEventProps): void;
}

function trackBusinessEvent(
  analytics: AnalyticsTracker,
  eventName: string,
  props: AnalyticsEventProps,
): void {
  try {
    analytics.track(eventName, props);
  } catch {
    // Analytics is best-effort and must never block the user's primary action.
  }
}

export type PaperChatPurchaseEntrySource =
  | "preferences"
  | "chat_user_bar_balance"
  | "chat_user_bar_subscription"
  | "quota_error_card"
  | "presentation_insufficient_balance";

export interface PaperChatPurchaseEntryContext {
  logged_in?: boolean;
  low_balance?: boolean;
}

export type PaperChatProductCategory = "quota" | "subscription";

/**
 * Aptabase accepts only flat primitive properties. `item` is therefore the
 * stable product SKU rather than the raw product object.
 */
export interface PaperChatPurchaseItemAnalytics extends AnalyticsEventProps {
  item: string;
  sku: string;
  product_name: string;
  product_category: PaperChatProductCategory;
  money: string;
  quota_label?: string;
}

export type PaperChatPresentationEntrySource = "chat_button" | "library_menu";

export interface PaperChatPresentationEntryContext {
  repeat_click?: boolean;
}

export function trackPaperChatPurchaseEntryClicked(
  analytics: AnalyticsTracker,
  source: PaperChatPurchaseEntrySource,
  context: PaperChatPurchaseEntryContext = {},
): void {
  trackBusinessEvent(
    analytics,
    ANALYTICS_EVENTS.paperChatPurchaseEntryClicked,
    {
      source,
      ...context,
    },
  );
}

export function trackPaperChatPurchaseButtonClicked(
  analytics: AnalyticsTracker,
  product: PaperChatPurchaseItemAnalytics,
): void {
  trackBusinessEvent(
    analytics,
    ANALYTICS_EVENTS.paperChatPurchaseButtonClicked,
    {
      source: "purchase_dialog",
      ...product,
    },
  );
}

export function trackPaperChatPresentationEntryClicked(
  analytics: AnalyticsTracker,
  source: PaperChatPresentationEntrySource,
  context: PaperChatPresentationEntryContext = {},
): void {
  trackBusinessEvent(
    analytics,
    ANALYTICS_EVENTS.paperChatPresentationEntryClicked,
    {
      source,
      ...context,
    },
  );
}
