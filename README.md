# PDF AI Talk

[![zotero target version](https://img.shields.io/badge/Zotero-7+-green?style=flat-square&logo=zotero&logoColor=CC2936)](https://www.zotero.org)
[![Using Zotero Plugin Template](https://img.shields.io/badge/Using-Zotero%20Plugin%20Template-blue?style=flat-square&logo=github)](https://github.com/windingwind/zotero-plugin-template)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL%20v3-blue.svg?style=flat-square)](https://www.gnu.org/licenses/agpl-3.0)

> **This project was entirely developed by AI.**

A powerful Zotero plugin that enables you to chat with AI about your PDF documents directly within Zotero. Supports multiple AI providers including OpenAI, Claude, Gemini, DeepSeek, and more.

[English](README.md) | [简体中文](doc/README-zhCN.md)

## Features

### Multi-Provider Support

Support for 8+ AI providers out of the box:

| Provider | Type | Description |
|----------|------|-------------|
| **PDFAiTalk** | Built-in | Login-based service, no API key required |
| **OpenAI** | API Key | GPT-4o, o3, o1, etc. |
| **Claude** | API Key | Claude 4, Claude 3.5 Sonnet/Haiku |
| **Gemini** | API Key | Gemini 2.5 Pro, 2.0 Flash, etc. |
| **DeepSeek** | API Key | DeepSeek V3, DeepSeek R1 |
| **Mistral** | API Key | Mistral Large, Codestral |
| **Groq** | API Key | Fast inference with Llama, Mixtral |
| **OpenRouter** | API Key | Access to 100+ models |
| **Custom** | API Key | Any OpenAI-compatible API |

### Core Features

- **PDF Context Chat**: Attach PDF content to your conversations for context-aware AI responses
- **Streaming Responses**: Real-time streaming output with SSE (Server-Sent Events)
- **Conversation History**: Persistent chat history per document with easy session management
- **Markdown Rendering**: Full markdown support with syntax highlighting (powered by highlight.js)
- **Dark/Light Mode**: Automatic theme detection and switching
- **Image & File Attachments**: Upload images and files to include in your conversations
- **Global Chat Mode**: Chat without document context when needed

### User Experience

- **Sidebar Integration**: Seamless integration into Zotero's sidebar
- **Keyboard Shortcuts**: Send messages with Enter, new line with Shift+Enter
- **Copy Code Blocks**: One-click copy for code snippets
- **Auto-scroll**: Automatic scrolling during streaming responses
- **Provider Switching**: Quick switch between AI providers

## Screenshots

### Chat Panel
![Chat Panel](doc/screenshots/screenshot_talk.png)

### Settings
![Settings](doc/screenshots/screenshot_pref.png)

## Installation

### From Release (Recommended)

1. Download the latest `.xpi` file from [Releases](https://github.com/syt2/pdf-ai-talk/releases)
2. In Zotero, go to `Tools` → `Add-ons`
3. Click the gear icon and select `Install Add-on From File...`
4. Select the downloaded `.xpi` file

### From Source

```bash
# Clone the repository
git clone https://github.com/syt2/pdf-ai-talk.git
cd pdf-ai-talk

# Install dependencies
npm install

# Build the plugin
npm run build

# The built .xpi file will be in .scaffold/build/
```

## Usage

### Quick Start

1. **Open a PDF** in Zotero's PDF reader
2. **Click the chat icon** in the toolbar (or use the sidebar)
3. **Start chatting** with AI about your document
4. **Check "Attach PDF"** to include PDF content in your message

### Configure Provider

1. Go to `Edit` → `Settings` → `PDF AI Talk`
2. Select your preferred AI provider from the sidebar
3. Enter your API key (not required for PDFAiTalk service)
4. Choose your model and adjust settings

### PDFAiTalk Service

The built-in PDFAiTalk service offers:
- No API key required - just login
- Multiple models available (Claude, DeepSeek, Qwen, etc.)
- Pay-as-you-go pricing
- Invite friends for bonus credits

## Configuration Options

| Option | Description | Default |
|--------|-------------|---------|
| Model | AI model to use | Provider default |
| Max Tokens | Maximum response length | 4096 |
| Temperature | Response creativity (0-2) | 0.7 |
| System Prompt | Custom instructions for AI | Empty |
| Base URL | API endpoint (for custom providers) | Provider default |

## Development

### Prerequisites

- Node.js 18+
- Zotero 7 Beta

### Setup

```bash
# Install dependencies
npm install

# Start development server with hot reload
npm start

# Build for production
npm run build

# Lint code
npm run lint:fix
```

### Project Structure

```
src/
├── modules/
│   ├── auth/          # Authentication services
│   ├── chat/          # Chat management & API
│   ├── preferences/   # Settings UI
│   ├── providers/     # AI provider implementations
│   └── ui/            # UI components
│       └── chat-panel/
├── types/             # TypeScript definitions
└── utils/             # Utilities
```

## Tech Stack

- **Framework**: [Zotero Plugin Template](https://github.com/windingwind/zotero-plugin-template)
- **Language**: TypeScript
- **Build Tool**: [Zotero Plugin Scaffold](https://github.com/northword/zotero-plugin-scaffold)
- **Markdown**: markdown-it
- **Syntax Highlighting**: highlight.js
- **Toolkit**: [Zotero Plugin Toolkit](https://github.com/windingwind/zotero-plugin-toolkit)

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is licensed under the AGPL-3.0 License - see the [LICENSE](LICENSE) file for details.

## Acknowledgments

- [Zotero](https://www.zotero.org/) - The amazing reference manager
- [Zotero Plugin Template](https://github.com/windingwind/zotero-plugin-template) - Plugin development foundation
- [Claude](https://claude.ai/) - AI assistant that developed this entire project

