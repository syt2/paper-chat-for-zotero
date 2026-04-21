# Analytics Events

本文档整理当前插件内所有业务埋点事件。

说明：

- 不包含 Aptabase 自动附带的公参，如 `timestamp`、`sessionId`、`systemProps.locale`、`systemProps.appVersion`、`systemProps.isDebug`、`systemProps.sdkVersion`
- 仅记录当前代码里真实会发送的业务参数
- `可能取值` 表示当前实现里已经出现的值，不代表未来不能扩展

## 事件总表

| Event | 含义 | 触发时机 | 业务参数 |
| --- | --- | --- | --- |
| `auth_page_viewed` | 登录/注册弹窗中的某个页面被真正展示 | 登录/注册弹窗首次显示，或用户在弹窗内切换 login/register tab 时 | `mode`: 当前页模式，可能为 `login` / `register` |
| `auth_completed` | 一次登录或注册进入终态 | 用户提交登录/注册表单后，接口成功或失败时 | `mode`: 当前操作模式，可能为 `login` / `register`；`success`: 是否成功；失败时额外带 `reason`，当前可能为 `wrong_credentials` / `account_not_found` / `email_taken` / `invalid_verification_code` / `rate_limited` / `network_error` / `server_error` / `unknown`；当 `reason=unknown` 时额外带 `error_detail` |
| `auth_verification_code_sent` | 验证码发送或重置密码邮件发送进入终态 | 注册页发送验证码，或登录页点击“忘记密码”后请求结束时 | `scene`: 当前场景，当前可能为 `register` / `reset_password`；`success`: 是否成功；失败时额外带 `reason`，当前可能为 `rate_limited` / `invalid_email` / `quota_exceeded` / `network_error` / `server_error` / `unknown`；当 `reason=unknown` 时额外带 `error_detail` |
| `plugin_started` | 插件启动完成 | 插件启动流程完成后 | `startup_mode`: 启动模式。当前固定为 `normal` |
| `chat_panel_opened` | 聊天面板被打开 | 用户打开聊天面板时 | `panel_mode`: 面板模式，可能为 `sidebar` / `floating`；`open_source`: 打开来源，可能为 `menu` / `toolbar` / `unknown` |
| `chat_panel_closed` | 聊天面板被关闭或消失 | 面板关闭时 | `panel_mode`: 关闭时的面板模式，可能为 `sidebar` / `floating`；`open_source`: 本次面板最初的打开来源，可能为 `menu` / `toolbar` / `unknown`；`visible_duration_ms`: 本次面板持续显示时长，单位毫秒 |
| `chat_sent` | 用户发出一次聊天请求 | 每次调用发送消息时 | `provider`: 当前使用的 provider id；`has_item`: 是否绑定当前条目；`attach_pdf`: 是否尝试附带当前 PDF；`image_count`: 图片附件数量；`file_count`: 文件附件数量；`has_selected_text`: 是否带选中文本 |
| `chat_completed` | 一次聊天请求进入终态 | 聊天正常完成或异常失败时 | `provider`: 当前 provider id；`success`: 是否成功完成；`duration_ms`: 从 `chat_sent` 到终态的耗时，单位毫秒 |
| `chat_model_switched` | 用户在聊天面板切换模型或 PaperChat tier | 用户点击聊天面板模型下拉项时 | 公共字段：`source`、`provider`、`previous_provider`。`source` 当前可能为 `model_dropdown` / `tier_dropdown`。当 `source=model_dropdown` 时，还会带 `model`、`previous_model`。当 `source=tier_dropdown` 时，还会带 `tier`、`previous_tier` |
| `settings_opened` | 当前插件设置页被打开 | 插件设置页首次初始化完成时 | `selected_provider`: 设置页首次展示时选中的 provider id |
| `settings_provider_viewed` | 设置页中某个 provider 配置面板被展示 | 设置页首次打开时展示默认 provider，或用户在左侧点击切换 provider 时 | `provider`: 当前展示的 provider id；`source`: 展现来源，当前可能为 `settings_opened` / `sidebar_click` / `topup_cta` / `preferences_open`；`low_balance`: 是否低于 `LOW_BALANCE_WARNING_THRESHOLD`。仅对 `paperchat` 有业务意义，其他 provider 当前为 `false` |
| `paperchat_quota_error` | PaperChat 发生用户额度不足错误 | 聊天请求返回 `insufficient_user_quota` 时 | `provider`: 当前失败的 provider id，当前语义上应为 `paperchat` |
| `paperchat_quota_topup_clicked` | 用户点击额度不足错误卡片里的“去充值”按钮 | 聊天面板额度不足错误 UI 的 CTA 被点击时 | `source`: 当前固定为 `quota_error_card` |
| `paperchat_model_rerouted` | PaperChat 因模型硬失败或路由修复切换到了同 tier 的其他模型 | PaperChat 自动 reroute 成功时 | `tier`: 当前 tier；`previous_model`: 旧模型 id；`next_model`: 新模型 id；`reason`: reroute 原因，当前可能为 `streaming` / `tool_calling` / `failure_repair` |
| `paperchat_redeem_code_clicked` | 用户点击设置页里的“获取兑换码”按钮 | PaperChat 设置页内点击获取兑换码时 | `low_balance`: 点击时是否低于 `LOW_BALANCE_WARNING_THRESHOLD` |
| `sign_in_completed` | 一次签到操作进入终态 | 用户点击聊天面板签到按钮后，请求成功或失败时 | `success`: 是否成功；成功且服务端返回奖励时额外带 `reward_count`；失败时额外带 `reason`，当前可能为 `already_signed_in` / `not_authenticated` / `rate_limited` / `network_error` / `server_error` / `unknown`；当 `reason=unknown` 时额外带 `error_detail` |
| `ai_summary_batch_started` | AI Summary 批处理开始执行 | 启动摘要批处理时 | `item_count`: 本次批处理条目数；`trigger`: 启动来源，当前可能为 `manual_selection` / `configured_batch` |

## 字段补充说明

| 字段 | 说明 |
| --- | --- |
| `provider` | provider 配置 id，例如 `paperchat` 或其他模型服务 provider id |
| `previous_provider` | 切换前的 provider 配置 id |
| `selected_provider` | 设置页初次打开时默认展示的 provider 配置 id |
| `mode` | 当前认证页面或认证提交的模式 |
| `scene` | 当前验证码或密码重置请求的业务场景 |
| `low_balance` | 是否低于 `LOW_BALANCE_WARNING_THRESHOLD`。当前阈值定义在 `src/modules/preferences/UserAuthUI.ts` |
| `panel_mode` | 当前聊天面板展示模式 |
| `open_source` | 聊天面板本次打开的入口来源 |
| `success` | 当前业务动作是否成功进入预期终态 |
| `reason` | 失败原因的业务枚举值；只在 `success=false` 时发送 |
| `error_detail` | 仅当 `reason=unknown` 时发送的脱敏错误细节，最长 200 字 |
| `reward_count` | 本次签到奖励数量；仅在签到成功且服务端返回奖励时发送 |
| `duration_ms` | 单次聊天请求耗时 |
| `visible_duration_ms` | 单次聊天面板展示时长 |

## 推荐漏斗事件

### 1. PaperChat 额度不足转化漏斗

| 步骤 | Event | 说明 |
| --- | --- | --- |
| 1 | `paperchat_quota_error` | 用户在聊天时真实撞到额度不足 |
| 2 | `paperchat_quota_topup_clicked` | 用户点击错误卡片里的“去充值” |
| 3 | `settings_provider_viewed` | 来源为 `topup_cta`，说明已经进入 PaperChat 设置页 |
| 4 | `paperchat_redeem_code_clicked` | 用户点击获取兑换码 |

### 2. 聊天入口使用漏斗

| 步骤 | Event | 说明 |
| --- | --- | --- |
| 1 | `chat_panel_opened` | 看入口使用量，可按 `open_source` 分菜单和右上角入口 |
| 2 | `chat_sent` | 看打开后是否真正发起聊天 |
| 3 | `chat_completed` | 看请求是否成功完成，可按 `success` 切分 |

### 3. 设置页使用漏斗

| 步骤 | Event | 说明 |
| --- | --- | --- |
| 1 | `settings_opened` | 用户是否进入插件设置页 |
| 2 | `settings_provider_viewed` | 用户实际查看了哪些 provider 配置面板 |
| 3 | `paperchat_redeem_code_clicked` | 在 PaperChat 设置页中是否进一步进入兑换码获取动作 |

### 4. 认证转化漏斗

| 步骤 | Event | 说明 |
| --- | --- | --- |
| 1 | `auth_page_viewed` | 用户是否真正看到登录或注册页，可按 `mode` 切分 |
| 2 | `auth_verification_code_sent` | 注册验证码或重置密码邮件是否发送成功 |
| 3 | `auth_completed` | 登录或注册是否完成，可按 `mode` 和 `success` 切分 |

### 5. 签到完成漏斗

| 步骤 | Event | 说明 |
| --- | --- | --- |
| 1 | `chat_panel_opened` | 用户先打开聊天面板 |
| 2 | `sign_in_completed` | 用户是否完成签到，可按 `success` 和 `reason` 看失败分布 |

## 备注

- `chat_completed` 当前只统计“成功完成”和“异常失败”两类终态，不把用户主动取消计入完成事件
- `settings_opened` 指当前插件自己的设置页，不是 Zotero 整个 Preferences 窗口
- `settings_provider_viewed` 已避免在设置页 focus refresh 时重复上报
