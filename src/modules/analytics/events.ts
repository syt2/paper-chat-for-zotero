export const ANALYTICS_EVENTS = {
  aiSummaryBatchStarted: "ai_summary_batch_started",
  authCompleted: "auth_completed",
  authPageViewed: "auth_page_viewed",
  authVerificationCodeSent: "auth_verification_code_sent",
  chatCompleted: "chat_completed",
  chatModelSwitched: "chat_model_switched",
  chatPanelClosed: "chat_panel_closed",
  chatPanelOpened: "chat_panel_opened",
  chatSent: "chat_sent",
  paperChatModelRerouted: "paperchat_model_rerouted",
  paperChatQuotaError: "paperchat_quota_error",
  paperChatLowBalanceClicked: "paperchat_low_balance_clicked",
  paperChatQuotaTopupClicked: "paperchat_quota_topup_clicked",
  paperChatRedeemCodeClicked: "paperchat_redeem_code_clicked",
  pluginStarted: "plugin_started",
  settingsOpened: "settings_opened",
  settingsProviderViewed: "settings_provider_viewed",
  signInCompleted: "sign_in_completed",
} as const;

export type AnalyticsEventName =
  (typeof ANALYTICS_EVENTS)[keyof typeof ANALYTICS_EVENTS];
