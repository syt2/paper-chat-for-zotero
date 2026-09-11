<h1><img src="../addon/content/icons/favicon.svg" width="32" height="32" alt=""> AI Paper Chat</h1>

**AI 论文助手：论文问答、划词翻译、文献检索、笔记与 PPT 生成。**

直接在 Zotero 中阅读、讨论和整理文献，支持侧栏与悬浮聊天窗口。可以使用内置 PaperChat 服务，也可以接入自己的 AI 服务商。

[English](../README.md) | [简体中文](README-zhCN.md)

[![Zotero](https://img.shields.io/badge/Zotero-7–10-green?style=flat-square&logo=zotero&logoColor=CC2936)](https://www.zotero.org)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL%20v3-blue.svg?style=flat-square)](../LICENSE)

[下载安装](https://github.com/syt2/paper-chat-for-zotero/releases/latest) · [快速开始](#快速开始) · [反馈问题](https://github.com/syt2/paper-chat-for-zotero/issues)

## 可以做什么

| 功能           | 使用场景                                                                      |
| -------------- | ----------------------------------------------------------------------------- |
| **论文问答**   | 讨论研究方法、实验结果、公式和图表；通过 `@` 引用文献库条目、笔记或多篇论文。 |
| **划词翻译**   | 在 PDF 中选中文本，就地查看流式翻译；在翻译窗口中选择模型与目标语言。         |
| **文献检索**   | 在对话中检索 Zotero 文献库及外部学术来源，查找相关研究。                      |
| **笔记与摘要** | 将回复或整段对话整理为 Zotero 笔记，或按自定义模板生成论文摘要。              |
| **PPT 生成**   | 根据论文生成 PPTX，自选页数与风格，中断后从保存的进度继续。需使用 PaperChat。 |
| **附件讨论**   | 附加选中文本、PDF 截图、图片及支持的文本文件，也可从文件管理器拖入附件。      |

对话支持流式回复、Markdown、公式、代码高亮、历史记录搜索和长对话导航。界面支持中英文，以及浅色、深色主题。

## 截图

|                   聊天侧栏与设置                    |                   悬浮聊天窗口                    |
| :-------------------------------------------------: | :-----------------------------------------------: |
| ![聊天侧栏与设置](screenshots/screenshot_total.png) | ![悬浮聊天窗口](screenshots/screenshot_split.png) |

## 安装

支持 **Zotero 7–10**。

1. 从[最新版本](https://github.com/syt2/paper-chat-for-zotero/releases/latest)下载 `ai-paper-chat.xpi`。
2. 在 Zotero 中打开 **工具 → 插件**（部分版本称为“附加组件”）。
3. 点击齿轮图标，选择**从文件安装插件…**，打开下载的 `.xpi` 文件。

## 快速开始

### 1. 选择 AI 服务

在 Zotero 设置中打开 Paper Chat，或点击聊天面板中的设置按钮。

- **PaperChat：** 登录账号，即可使用内置服务及其可用模型。
- **自己的服务商：** 选择 OpenAI、Claude、Gemini、DeepSeek，或添加兼容 OpenAI 接口的自定义服务，填写 API Key 并选择模型。

图片输入和工具类功能取决于所选模型与服务商的能力。PPT 生成目前需要使用 PaperChat 服务。

### 2. 开始论文对话

在 Zotero 中打开 PDF，点击工具栏中的 Paper Chat 图标，然后直接提问。当前论文会作为可用上下文，AI 可以按需读取或检索其中的内容。

可以试试：

- “这篇论文解决了什么问题？主要贡献是什么？”
- “解释一下图 2，它如何支持论文的结论？”
- “帮我查找相关研究，并比较它们的方法。”

输入 `@` 可引用文献库条目或笔记；点击输入框内的 **+** 可上传支持的文件或截取论文图片。也可以在文献库首页开始普通对话。

### 3. 翻译选中文本

在 PDF 中选中文本，将鼠标移到小问号图标上，选择**翻译**，即可在选区旁查看流式翻译；选择发送图标则将原文附加到聊天中。

翻译窗口内可以选择模型与语言。语言设为**自动**时跟随 Zotero 的界面语言；按住窗口顶部可以拖动位置。

### 4. 整理笔记或制作 PPT

- **对话笔记：** 点击 **+ → 笔记**，将当前讨论整理为 Zotero 笔记。
- **论文摘要：** 右键点击条目或 PDF 附件，选择**生成 AI 快速摘要**或**生成 AI 深度摘要**。
- **论文 PPT：** 打开或选中一篇带 PDF 的论文，点击 **+ → PPT**，确认来源论文、页数和风格后开始制作。暂停后可从保存的进度继续，重启 Zotero 后也能恢复。

## 设置

在插件设置中管理服务商、模型、PaperChat 账号与额度，以及摘要模板。翻译模型与目标语言直接在翻译窗口中选择。

## 反馈

欢迎在 [GitHub Issues](https://github.com/syt2/paper-chat-for-zotero/issues) 反馈问题或提出建议。报告问题时，请附上 Zotero 版本、插件版本、操作系统和复现步骤。

## 许可证与致谢

采用 [AGPL-3.0-or-later](../LICENSE) 许可证。

本项目在 AI 辅助下开发，基于 [Zotero Plugin Template](https://github.com/windingwind/zotero-plugin-template) 和 [Zotero Plugin Toolkit](https://github.com/windingwind/zotero-plugin-toolkit) 构建。
