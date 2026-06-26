// API Configuration
pref("apiKey", "");
pref("baseUrl", "https://paperchat.zotero.store/v1");
pref("model", "auto-smart");
pref("maxTokens", 0);
pref("temperature", "0.7");
pref(
  "systemPrompt",
  "You are a helpful research assistant. Help the user understand and analyze academic papers and documents.",
);

pref("username", "");
pref("loginPassword", ""); // 存储密码用于自动重新登录
pref("userId", 0);
pref("userQuotaJson", "");
pref("userSubscriptionJson", "");

// Cache
pref("paperchatModelsCache", "");
pref("paperchatRatiosCache", "");
pref("paperchatRoutingConfigCache", "");
pref("paperchatTierState", "");
pref("paperchatSuppressHighTierWarning", false);

// PDF Settings
pref("uploadRawPdfOnFailure", false);

// UI Settings
pref("panelMode", "sidebar");
pref("debugContextExportEnabled", false);
pref("readingLoopEnabled", true);
pref("readingLoopHistory", "");
pref("nextQuestionHintEnabled", true);

// Guide Settings
pref("firstInstalledVersion", "");
pref("guideStatus", 0);

// Context Management Settings
pref("contextMaxRecentPairs", 10);
pref("contextEnableSummary", true);
pref("contextAutoCompactBufferTokens", 13000);
pref("contextAutoCompactWindowTokens", 100000);

// AI Tools Settings
pref("toolPermissionDefaultModes", ""); // 各工具默认权限模式映射（JSON）
pref("webSearchProvider", "auto"); // Web 搜索后端
pref("agentMaxPlanningIterations", 15); // 单个 agent turn 的最大 planning 轮次
