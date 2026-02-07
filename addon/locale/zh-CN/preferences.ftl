pref-title = Paper Chat 设置

# Account Settings
pref-account-settings = 账户设置
pref-copy-btn = 复制
pref-copied = 已复制!
pref-redeem-label = Token 兑换码
pref-redeem-placeholder =
    .placeholder = 输入Token兑换码
pref-redeem-btn = 兑换
pref-get-redeem-code = 获取兑换码
pref-get-redeem-code-title = 获取兑换码
pref-get-redeem-code-link = 购买链接
pref-get-redeem-code-scan = 手机淘宝扫码前往获取

# API Settings
pref-api-settings = API 设置
pref-model = 模型
pref-model-placeholder =
    .placeholder = gpt-4o
pref-advanced-options = 高级选项
pref-max-tokens = 最大Token数
pref-temperature = 温度
pref-system-prompt = 系统提示词
pref-system-prompt-placeholder =
    .placeholder = 您是一个有帮助的研究助手...

# Provider Settings
pref-providers = 服务提供商
pref-add-provider = + 添加自定义
pref-paperchat-title = PaperChat 服务
pref-paperchat-description = 基于登录的 AI 服务，支持多种模型。无需 API 密钥。
pref-official-website = 访问官网

# Provider Configuration
pref-provider-enabled = 启用
pref-api-key = API 密钥
pref-base-url = 接口地址
pref-show-key = 显示
pref-hide-key = 隐藏
pref-refresh-models = 刷新
pref-test-connection = 测试连接
pref-delete-provider = 删除提供商

# Active Provider
pref-active-provider = 当前使用的提供商
pref-current-provider = 当前:

# Test Results
pref-testing = 测试中...
pref-test-success = 连接成功！
pref-test-failed = 连接失败
pref-provider-not-ready = 提供商未配置
pref-refresh-failed = 刷新模型列表失败
pref-fetching-models = 正在获取模型列表...
pref-models-loaded = 已加载 { $count } 个模型
pref-fetch-models-failed = 获取模型列表失败

# Custom Provider
pref-enter-provider-name = 请输入提供商名称:

# Model Management
pref-model-list = 模型列表
pref-add-model = + 添加模型
pref-enter-model-id = 请输入模型ID:
pref-model-custom = 自定义
pref-model-exists = 该模型已存在

# PDF Settings
pref-pdf-settings = PDF 设置
pref-upload-raw-pdf = 文本提取失败时上传原始 PDF
pref-upload-raw-pdf-desc = 启用后，若文本提取失败将上传原始 PDF 给 AI，这可能会消耗大量 token。

# AI Tools Settings
pref-ai-tools-settings = AI 工具设置
pref-enable-ai-write = 允许 AI 创建笔记和修改标签
pref-enable-ai-write-desc = 启用后，AI 可以在您的文献库中创建笔记和批量更新标签。请谨慎使用。

# AISummary Settings
pref-aisummary-settings = AI摘要
pref-aisummary-template = 模板
pref-aisummary-include-annotations = 包含用户高亮和笔记
pref-aisummary-run-now = 生成摘要
pref-aisummary-desc = 为文献库中未处理的论文生成AI摘要笔记（每次最多10篇）。

# Semantic Search Settings
pref-semantic-search-settings = 语义搜索
pref-enable-semantic-search = 启用语义搜索
pref-semantic-search-available = 使用 { $provider } Embedding
pref-semantic-search-unavailable = 无可用 Embedding 服务。请配置 Gemini 或 OpenAI API Key。
pref-embedding-status-paperchat = 使用 PaperChat Embedding ({ $model })
pref-embedding-status-gemini = 使用 Gemini Embedding (免费)
pref-embedding-status-ollama = 使用 Ollama 本地 Embedding
pref-embedding-status-openai = 使用 OpenAI Embedding
pref-embedding-unavailable-ollama = Ollama 已运行但未安装 Embedding 模型，请运行: ollama pull nomic-embed-text
pref-embedding-unavailable-none = 无可用 Embedding 服务，请登录 PaperChat 或配置 API Key
