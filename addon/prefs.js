// API Configuration
pref("apiKey", "");
pref("baseUrl", "https://paperchat.zotero.store/v1");
pref("model", "claude-haiku-4-5-20251001");
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

// Cache
pref("paperchatModelsCache", "");
pref("paperchatRatiosCache", "");

// PDF Settings
pref("uploadRawPdfOnFailure", false);

// UI Settings
pref("panelMode", "sidebar");

// Guide Settings
pref("firstInstalledVersion", "");
pref("guideStatus", 0);

// Context Management Settings
pref("contextMaxRecentPairs", 10);
pref("contextEnableSummary", false);
pref("contextSummaryThreshold", 20);

// AI Tools Settings
pref("enableAIWriteOperations", true); // 是否允许 AI 执行写入操作（创建笔记、批量更新标签）
