export const ANALYTICS_EVENTS = {
  pluginStarted: "plugin_started",
  chatPanelOpened: "chat_panel_opened",
  chatPanelClosed: "chat_panel_closed",
  chatSent: "chat_sent",
  chatCompleted: "chat_completed",
  chatModelSwitched: "chat_model_switched",
  settingsOpened: "settings_opened",
  settingsProviderViewed: "settings_provider_viewed",
  paperChatQuotaError: "paperchat_quota_error",
  paperChatQuotaTopupClicked: "paperchat_quota_topup_clicked",
  paperChatModelRerouted: "paperchat_model_rerouted",
  paperChatRedeemCodeClicked: "paperchat_redeem_code_clicked",
  aiSummaryBatchStarted: "ai_summary_batch_started",
} as const;

export type AnalyticsEventName =
  (typeof ANALYTICS_EVENTS)[keyof typeof ANALYTICS_EVENTS];
