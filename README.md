<h1><img src="addon/content/icons/favicon.svg" width="32" height="32" style="vertical-align: middle;"> Paper Chat</h1>

[![Zotero](https://img.shields.io/badge/Zotero-7+-green?style=flat-square&logo=zotero&logoColor=CC2936)](https://www.zotero.org)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL%20v3-blue.svg?style=flat-square)](https://www.gnu.org/licenses/agpl-3.0)

> **This project was entirely developed by AI.**

Chat with AI about your PDF documents directly in Zotero. Supports OpenAI, Claude, Gemini, DeepSeek, and more.

[English](README.md) | [简体中文](doc/README-zhCN.md)

## Screenshots

|             Chat Panel & Settings             |                 Float Chat Window                 |
| :-------------------------------------------: | :-----------------------------------------------: |
| ![Chat](doc/screenshots/screenshot_total.png) | ![Settings](doc/screenshots/screenshot_split.png) |

## Features

- **Multi-Provider**: OpenAI, Claude, Gemini, DeepSeek, Mistral, Groq, OpenRouter, or custom API
- **PDF Context**: Attach PDF content for context-aware responses
- **AI Summary**: Auto-generate summaries for papers with customizable templates
- **@ Mentions**: Reference items, attachments, and notes in conversations
- **Streaming**: Real-time response streaming
- **History**: Multi-session conversation history per document
- **Markdown**: Full markdown with syntax highlighting
- **Themes**: Auto dark/light mode
- **i18n**: English and Chinese localization

## Installation

1. Download `.xpi` from [Releases](https://github.com/syt2/paper-chat-for-zotero/releases)
2. Zotero → `Tools` → `Add-ons` → ⚙️ → `Install Add-on From File...`

## Quick Start

### Chat with PDF
1. Open a PDF in Zotero
2. Click the chat icon in toolbar
3. Check "Attach PDF" to include document context
4. Start chatting!

### AI Summary
1. Right-click on an item or PDF attachment
2. Select "Generate AI Summary"
3. A note with the AI-generated summary will be created

## Configuration

Go to `Settings` → `Paper Chat` to:

- Select AI provider and model
- Enter API key (or use built-in PaperChat service)
- Adjust temperature, max tokens, system prompt
- Configure AI Summary templates and options

## License

[AGPL-3.0](LICENSE)

## Acknowledgments

- [Zotero Plugin Template](https://github.com/windingwind/zotero-plugin-template)
- [Claude](https://claude.ai/) - AI that developed this project
