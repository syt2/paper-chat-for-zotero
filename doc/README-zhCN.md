# PDF AI Talk

[![zotero target version](https://img.shields.io/badge/Zotero-7+-green?style=flat-square&logo=zotero&logoColor=CC2936)](https://www.zotero.org)
[![Using Zotero Plugin Template](https://img.shields.io/badge/Using-Zotero%20Plugin%20Template-blue?style=flat-square&logo=github)](https://github.com/windingwind/zotero-plugin-template)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL%20v3-blue.svg?style=flat-square)](https://www.gnu.org/licenses/agpl-3.0)

> **本项目完全由 AI 开发完成。**

一款强大的 Zotero 插件，让你可以在 Zotero 中直接与 AI 讨论 PDF 文档内容。支持多种 AI 服务商，包括 OpenAI、Claude、Gemini、DeepSeek 等。

[English](../README.md) | [简体中文](README-zhCN.md)

## 功能特性

### 多服务商支持

开箱即用支持 8+ 种 AI 服务商：

| 服务商 | 类型 | 描述 |
|--------|------|------|
| **PDFAiTalk** | 内置服务 | 登录即用，无需 API Key |
| **OpenAI** | API Key | GPT-4o、o3、o1 等 |
| **Claude** | API Key | Claude 4、Claude 3.5 Sonnet/Haiku |
| **Gemini** | API Key | Gemini 2.5 Pro、2.0 Flash 等 |
| **DeepSeek** | API Key | DeepSeek V3、DeepSeek R1 |
| **Mistral** | API Key | Mistral Large、Codestral |
| **Groq** | API Key | Llama、Mixtral 快速推理 |
| **OpenRouter** | API Key | 访问 100+ 种模型 |
| **自定义** | API Key | 任何 OpenAI 兼容 API |

### 核心功能

- **PDF 上下文对话**：将 PDF 内容附加到对话中，获得上下文感知的 AI 回复
- **流式响应**：基于 SSE（Server-Sent Events）的实时流式输出
- **对话历史**：每个文档独立的持久化聊天记录，便捷的会话管理
- **Markdown 渲染**：完整的 Markdown 支持，配备语法高亮（基于 highlight.js）
- **深色/浅色模式**：自动检测系统主题并切换
- **图片和文件附件**：上传图片和文件加入对话
- **全局聊天模式**：无需文档上下文也可聊天

### 用户体验

- **侧边栏集成**：无缝集成到 Zotero 侧边栏
- **快捷键**：Enter 发送消息，Shift+Enter 换行
- **代码块复制**：一键复制代码片段
- **自动滚动**：流式响应时自动滚动到底部
- **服务商切换**：快速切换 AI 服务商

## 截图

### 聊天面板
![聊天面板](screenshots/screenshot_talk.png)

### 设置页面
![设置页面](screenshots/screenshot_pref.png)

## 安装

### 从 Release 安装（推荐）

1. 从 [Releases](https://github.com/syt2/pdf-ai-talk/releases) 下载最新的 `.xpi` 文件
2. 在 Zotero 中，进入 `工具` → `附加组件`
3. 点击齿轮图标，选择 `从文件安装附加组件...`
4. 选择下载的 `.xpi` 文件

### 从源码构建

```bash
# 克隆仓库
git clone https://github.com/syt2/pdf-ai-talk.git
cd pdf-ai-talk

# 安装依赖
npm install

# 构建插件
npm run build

# 构建的 .xpi 文件在 .scaffold/build/ 目录下
```

## 使用方法

### 快速开始

1. **打开 PDF** - 在 Zotero 的 PDF 阅读器中打开文档
2. **点击聊天图标** - 在工具栏中点击聊天图标（或使用侧边栏）
3. **开始对话** - 与 AI 讨论你的文档内容
4. **勾选"附加 PDF"** - 将 PDF 内容包含在消息中

### 配置服务商

1. 进入 `编辑` → `设置` → `PDF AI Talk`
2. 从侧边栏选择你想使用的 AI 服务商
3. 输入 API Key（PDFAiTalk 服务无需输入）
4. 选择模型并调整设置

### PDFAiTalk 服务

内置的 PDFAiTalk 服务提供：
- 无需 API Key - 登录即可使用
- 多种模型可选（Claude、DeepSeek、Qwen 等）
- 按量付费
- 邀请好友获得额外额度

## 配置选项

| 选项 | 描述 | 默认值 |
|------|------|--------|
| 模型 | 使用的 AI 模型 | 服务商默认 |
| 最大 Token 数 | 最大响应长度 | 4096 |
| 温度 | 回复创造性（0-2） | 0.7 |
| 系统提示词 | AI 的自定义指令 | 空 |
| Base URL | API 端点（自定义服务商用） | 服务商默认 |

## 开发

### 环境要求

- Node.js 18+
- Zotero 7 Beta

### 开发设置

```bash
# 安装依赖
npm install

# 启动开发服务器（支持热重载）
npm start

# 生产构建
npm run build

# 代码格式化
npm run lint:fix
```

### 项目结构

```
src/
├── modules/
│   ├── auth/          # 认证服务
│   ├── chat/          # 聊天管理和 API
│   ├── preferences/   # 设置界面
│   ├── providers/     # AI 服务商实现
│   └── ui/            # UI 组件
│       └── chat-panel/
├── types/             # TypeScript 类型定义
└── utils/             # 工具函数
```

## 技术栈

- **框架**: [Zotero Plugin Template](https://github.com/windingwind/zotero-plugin-template)
- **语言**: TypeScript
- **构建工具**: [Zotero Plugin Scaffold](https://github.com/northword/zotero-plugin-scaffold)
- **Markdown**: markdown-it
- **语法高亮**: highlight.js
- **工具包**: [Zotero Plugin Toolkit](https://github.com/windingwind/zotero-plugin-toolkit)

## 贡献

欢迎贡献！请随时提交 Pull Request。

1. Fork 本仓库
2. 创建功能分支 (`git checkout -b feature/amazing-feature`)
3. 提交更改 (`git commit -m 'Add some amazing feature'`)
4. 推送分支 (`git push origin feature/amazing-feature`)
5. 发起 Pull Request

## 许可证

本项目基于 AGPL-3.0 许可证开源 - 详见 [LICENSE](../LICENSE) 文件。

## 致谢

- [Zotero](https://www.zotero.org/) - 优秀的文献管理工具
- [Zotero Plugin Template](https://github.com/windingwind/zotero-plugin-template) - 插件开发基础
- [Claude](https://claude.ai/) - 完全开发本项目的 AI 助手
