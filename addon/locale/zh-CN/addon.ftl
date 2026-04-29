paperchat-prefs-title = Paper Chat

# Auth Dialog
paperchat-auth-dialog-title = 用户登录
paperchat-auth-login-tab = 登录
paperchat-auth-register-tab = 注册
paperchat-auth-login-identity = 邮箱 / 用户名
paperchat-auth-login-identity-placeholder = 请输入邮箱或用户名
paperchat-auth-username = 用户名
paperchat-auth-username-placeholder = 请输入用户名
paperchat-auth-email = 邮箱
paperchat-auth-email-placeholder = 请输入邮箱地址
paperchat-auth-verification-code = 验证码
paperchat-auth-verification-placeholder = 请输入验证码
paperchat-auth-send-code = 发送验证码
paperchat-auth-sending = 发送中...
paperchat-auth-code-sent = 验证码已发送，请查收邮箱；如果暂时没看到，也请检查一下垃圾邮件箱
paperchat-auth-password = 密码
paperchat-auth-password-placeholder = 请输入密码
paperchat-auth-confirm-password = 确认密码
paperchat-auth-confirm-password-placeholder = 请再次输入密码
paperchat-auth-submit = 确定
paperchat-auth-cancel = 取消
paperchat-auth-success = 操作成功
paperchat-auth-error-username-required = 请输入用户名
paperchat-auth-error-password-required = 请输入密码
paperchat-auth-error-email-required = 请输入邮箱
paperchat-auth-error-code-required = 请输入验证码
paperchat-auth-error-redeem-code-required = 请输入兑换码
paperchat-auth-error-password-mismatch = 两次密码输入不一致
paperchat-auth-error-password-too-short = 密码长度至少8位
paperchat-auth-error-unknown = 未知错误
paperchat-auth-forgot-password = 忘记密码？
paperchat-auth-error-email-required-reset = 请先输入用户名/邮箱
paperchat-auth-reset-email-sent = 重置密码邮件已发送，请查收邮箱

# API Errors
paperchat-api-error-network = 网络错误
paperchat-api-error-request-failed = 请求失败: { $status }
paperchat-api-error-register-failed = 注册失败: { $status }
paperchat-api-error-login-failed = 登录失败: { $status }
paperchat-api-error-2fa-not-supported = 此账号启用了两步验证，插件暂不支持两步验证登录，请在网页端关闭两步验证后重试
paperchat-api-error-logout-failed = 登出失败: { $status }
paperchat-api-error-get-user-failed = 获取用户信息失败: { $status }
paperchat-api-error-get-token-failed = 获取Token失败: { $status }
paperchat-api-error-get-tokens-failed = 获取Token列表失败: { $status }
paperchat-api-error-create-token-failed = 创建Token失败: { $status }
paperchat-api-error-delete-token-failed = 删除Token失败: { $status }
paperchat-api-error-redeem-failed = 兑换失败: { $status }
paperchat-api-error-parse-user-failed = 登录失败：无法解析用户信息，请重试
paperchat-api-success-login = 登录成功
paperchat-api-success-redeem = 兑换成功! 增加余额: { $amount }

# User Panel
paperchat-user-panel-title = 用户信息
paperchat-user-panel-logged-in = 已登录: { $username }
paperchat-user-panel-not-logged-in = 未登录
paperchat-user-panel-balance = Token余额
paperchat-user-panel-used = 已用
paperchat-user-panel-login-btn = 登录/注册
paperchat-user-panel-logout-btn = 退出登录
paperchat-user-panel-redeem-title = 兑换充值码
paperchat-user-panel-redeem-placeholder = 请输入兑换码
paperchat-user-panel-redeem-btn = 兑换
paperchat-user-panel-redeem-success = 兑换成功
paperchat-user-panel-redeem-error = 兑换失败
paperchat-user-checkin-btn = 签到
paperchat-user-checked-in = ✓ 已签到

# Balance display in sidebar
paperchat-sidebar-balance = Token余额: { $balance }
paperchat-sidebar-login-required = 请先登录

# Chat Panel
paperchat-chat-toolbar-button-tooltip = 打开AI聊天面板
paperchat-chat-menu-open = AI 聊天
paperchat-chat-error-no-provider = ⚠️ 没有可用的 AI 服务商，请在设置中配置。
paperchat-chat-error-session-expired = ⚠️ 登录已过期，请重新登录。
paperchat-chat-start-conversation = 开始对话
paperchat-chat-attach-pdf = 附加PDF
paperchat-chat-new-chat = 新对话
paperchat-chat-upload-file = 上传文件
paperchat-chat-history = 聊天记录
paperchat-chat-input-placeholder = 询问关于PDF的问题...
paperchat-chat-send = 发送
paperchat-chat-stop-generating = 停止本轮
paperchat-chat-no-messages = (无消息)
paperchat-chat-message-count = { $count } 条消息
paperchat-chat-show-more = 显示更多 (剩余 { $count } 条)
paperchat-chat-no-history = 暂无聊天记录
paperchat-chat-close = 关闭
paperchat-chat-open-settings = 打开设置
paperchat-chat-error-paperchat-insufficient-quota = PaperChat 额度不足，当前余额低于本次请求所需的预扣费额度。请前往设置页充值或兑换 Token。
paperchat-chat-error-paperchat-topup-action = 去充值
paperchat-chat-switch-model-label = 切换模型
paperchat-chat-switch-model-help = 模型能力越强，消耗 Token 的速度通常也越快。请根据任务复杂度选择合适的模型。
paperchat-chat-select-model = 选择模型
paperchat-chat-tier-lite = Lite
paperchat-chat-tier-standard = Standard
paperchat-chat-tier-pro = Pro
paperchat-chat-tier-ultra = Ultra
paperchat-chat-tier-models = 显示 { $tier } 模型
paperchat-chat-tier-auto-reroute = 自动档位路由
paperchat-chat-model-rerouted = 已将 { $tier } 从 { $old } 切换为 { $new }
paperchat-chat-reroll-model = 使用其他模型重试
paperchat-chat-toggle-panel-mode = 切换侧边栏/悬浮窗模式
paperchat-chat-switch-to-floating = 切换为悬浮窗模式
paperchat-chat-switch-to-sidebar = 切换为侧边栏模式
paperchat-chat-no-models = 暂无可用模型
paperchat-chat-configure-provider = 请先在设置中配置服务商
paperchat-chat-delete = 删除
paperchat-chat-edit-title = 编辑标题
paperchat-chat-copy = 复制
paperchat-chat-interrupted = 已中断
paperchat-chat-turn-cancelled = 已取消本次请求。
paperchat-chat-thinking = 思考中
paperchat-chat-history-title = 对话 { $time }

# Guide
paperchat-guide-toolbar-title = 开始与 AI 对话
paperchat-guide-toolbar-description = 点击这里打开 AI 聊天面板，与 AI 讨论你的文献内容
paperchat-guide-got-it = 知道了

# Chat Panel - Panel Title
paperchat-chat-panel-title = Paper Chat

# Mention Selector
paperchat-mention-no-match = 没有匹配的资源
paperchat-mention-group-items = 条目
paperchat-mention-group-attachments = 附件
paperchat-mention-group-notes = 笔记
paperchat-mention-loading = 加载中...

# Default titles
paperchat-untitled = 无标题
paperchat-untitled-attachment = 无标题附件
paperchat-untitled-note = 无标题笔记

# AI Summary Task Window
paperchat-aisummary-window-title = AI 摘要任务
paperchat-aisummary-section-queue = 当前队列
paperchat-aisummary-section-history = 历史记录
paperchat-aisummary-no-tasks = 队列中暂无任务
paperchat-aisummary-no-history = 暂无历史记录
paperchat-aisummary-status-pending = 等待中
paperchat-aisummary-status-running = 处理中...
paperchat-aisummary-status-completed = 已完成
paperchat-aisummary-status-failed = 失败

# AI Summary Progress Status
paperchat-aisummary-progress-running = 处理中 { $processed }/{ $total }...
paperchat-aisummary-progress-paused = 已暂停 ({ $processed }/{ $total })
paperchat-aisummary-progress-completed = 完成: { $success } 成功, { $failed } 失败
paperchat-aisummary-progress-error = 错误: { $error }

# AI Summary Templates
paperchat-aisummary-template-summary-name = 简要摘要
paperchat-aisummary-template-summary-prefix = AI 摘要
paperchat-aisummary-template-findings-name = 核心发现
paperchat-aisummary-template-findings-prefix = 核心发现
paperchat-aisummary-template-methodology-name = 方法分析
paperchat-aisummary-template-methodology-prefix = 方法分析
paperchat-aisummary-template-literature-name = 文献笔记
paperchat-aisummary-template-literature-prefix = 文献笔记

# AI Summary Menu
paperchat-aisummary-menu-generate = 生成 AI 摘要
paperchat-aisummary-menu-tasks = AI 摘要任务

# Common
paperchat-unknown = 未知

# Tool call status
paperchat-tool-status-calling = 调用中...
paperchat-tool-status-done = 完成
paperchat-tool-status-error = 错误
paperchat-chat-tool-group-earlier = 展开更早的 { $count } 次调用
paperchat-tool-error-fix-hint-label = 修复建议：
paperchat-tool-error-alternative-label = 替代方案：

# Chat execution banner
paperchat-chat-banner-running = 运行中
paperchat-chat-banner-waiting-approval = 等待审批
paperchat-chat-banner-auto-recovering = 自动恢复中
paperchat-chat-banner-paused-at = 已暂停于 { $step }
paperchat-chat-banner-progress = { $completed }/{ $total } 步
paperchat-chat-banner-preparing = 准备中
paperchat-chat-banner-pending-one = 1 个待审批操作
paperchat-chat-banner-pending-many = { $count } 个待审批操作
paperchat-chat-banner-approval-applied = 审批已生效
paperchat-chat-banner-denial-applied = 拒绝已生效
paperchat-chat-banner-next-up = 下一个审批已就绪
paperchat-chat-banner-extra-many = +另外 { $count } 个
paperchat-chat-banner-risk-read = 读取权限
paperchat-chat-banner-risk-network = 联网访问
paperchat-chat-banner-risk-write = 写入权限
paperchat-chat-banner-risk-memory = 记忆写入
paperchat-chat-banner-risk-high-cost = 高成本操作
paperchat-chat-banner-allow-once = 仅本次允许
paperchat-chat-banner-session = 本会话允许
paperchat-chat-banner-always = 始终允许
paperchat-chat-banner-deny = 拒绝
