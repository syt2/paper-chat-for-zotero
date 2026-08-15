import { assert } from "chai";
import {
  ANALYTICS_EVENTS,
  trackPaperChatPresentationEntryClicked,
  trackPaperChatPurchaseButtonClicked,
  trackPaperChatPurchaseEntryClicked,
  type AnalyticsEventProps,
  type AnalyticsTracker,
} from "../src/modules/analytics/index.ts";

function createAnalyticsRecorder(): {
  analytics: AnalyticsTracker;
  events: Array<{ eventName: string; props?: AnalyticsEventProps }>;
} {
  const events: Array<{ eventName: string; props?: AnalyticsEventProps }> = [];
  return {
    analytics: {
      track: (eventName, props) => events.push({ eventName, props }),
    },
    events,
  };
}

describe("business analytics events", function () {
  it("reports purchase-credit entry clicks with their UI source", function () {
    const { analytics, events } = createAnalyticsRecorder();

    trackPaperChatPurchaseEntryClicked(
      analytics,
      "presentation_insufficient_balance",
      { low_balance: true, logged_in: true },
    );

    assert.deepEqual(events, [
      {
        eventName: ANALYTICS_EVENTS.paperChatPurchaseEntryClicked,
        props: {
          source: "presentation_insufficient_balance",
          low_balance: true,
          logged_in: true,
        },
      },
    ]);
  });

  it("reports the buy-button click with a flattened purchase item", function () {
    const { analytics, events } = createAnalyticsRecorder();

    trackPaperChatPurchaseButtonClicked(analytics, {
      item: "quota_500k",
      sku: "quota_500k",
      product_name: "500K Credits",
      product_category: "quota",
      money: "29.90",
      quota_label: "500K",
    });

    assert.deepEqual(events, [
      {
        eventName: ANALYTICS_EVENTS.paperChatPurchaseButtonClicked,
        props: {
          source: "purchase_dialog",
          item: "quota_500k",
          sku: "quota_500k",
          product_name: "500K Credits",
          product_category: "quota",
          money: "29.90",
          quota_label: "500K",
        },
      },
    ]);
  });

  it("distinguishes PPT toolbar clicks from library-menu clicks", function () {
    const { analytics, events } = createAnalyticsRecorder();

    trackPaperChatPresentationEntryClicked(analytics, "chat_button", {
      repeat_click: false,
    });
    trackPaperChatPresentationEntryClicked(analytics, "library_menu");

    assert.deepEqual(events, [
      {
        eventName: ANALYTICS_EVENTS.paperChatPresentationEntryClicked,
        props: { source: "chat_button", repeat_click: false },
      },
      {
        eventName: ANALYTICS_EVENTS.paperChatPresentationEntryClicked,
        props: { source: "library_menu" },
      },
    ]);
  });

  it("never lets analytics failures block a business action", function () {
    const analytics: AnalyticsTracker = {
      track: () => {
        throw new Error("analytics unavailable");
      },
    };

    assert.doesNotThrow(() =>
      trackPaperChatPurchaseEntryClicked(analytics, "preferences"),
    );
    assert.doesNotThrow(() =>
      trackPaperChatPurchaseButtonClicked(analytics, {
        item: "quota_500k",
        sku: "quota_500k",
        product_name: "500K Credits",
        product_category: "quota",
        money: "29.90",
      }),
    );
    assert.doesNotThrow(() =>
      trackPaperChatPresentationEntryClicked(analytics, "chat_button"),
    );
  });
});
