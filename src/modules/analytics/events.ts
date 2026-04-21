export const ANALYTICS_EVENTS = {
  pluginStarted: "plugin_started",
  chatPanelOpened: "chat_panel_opened",
  chatSent: "chat_sent",
  chatCompleted: "chat_completed",
  paperChatQuotaError: "paperchat_quota_error",
  paperChatModelRerouted: "paperchat_model_rerouted",
  paperChatTopupOpened: "paperchat_topup_opened",
  aiSummaryBatchStarted: "ai_summary_batch_started",
} as const;

export type AnalyticsEventName =
  (typeof ANALYTICS_EVENTS)[keyof typeof ANALYTICS_EVENTS];
