/**
 * Provider Types - Multi-provider AI API type definitions
 */

import type {
  ChatMessage,
  StreamCallbacks,
  StreamToolCallingCallbacks,
} from "./chat";
import type { ToolDefinition, ToolCall } from "./tool";

/**
 * Model capabilities
 */
export type ModelCapability =
  | "vision"
  | "reasoning"
  | "tool_use"
  | "web_search";

/**
 * Model information with metadata
 */
export interface ModelInfo {
  modelId: string;
  nickname?: string; // Display name (optional)
  contextWindow?: number; // Context window size
  maxOutput?: number; // Max output tokens
  capabilities?: ModelCapability[]; // Model capabilities
  isCustom?: boolean; // User-added custom model
}

/**
 * Supported provider types
 */
export type ProviderType =
  | "paperchat" // PaperChat login-based system
  | "openai" // Native OpenAI API
  | "anthropic" // Anthropic Claude API (different format)
  | "gemini" // Google Gemini API (different format)
  | "openai-compatible" // DeepSeek, Mistral, Groq, OpenRouter
  | "custom"; // User-defined OpenAI-compatible

/**
 * Provider identifier for built-in providers
 */
export type BuiltinProviderId =
  | "paperchat"
  | "openai"
  | "claude"
  | "gemini"
  | "deepseek"
  | "mistral"
  | "groq"
  | "openrouter";

/**
 * Base provider configuration
 */
export interface BaseProviderConfig {
  id: string;
  name: string;
  type: ProviderType;
  enabled: boolean;
  isBuiltin: boolean;
  order: number;
}

/**
 * Configuration for PaperChat (login-based) provider
 */
export interface PaperChatProviderConfig extends BaseProviderConfig {
  type: "paperchat";
  defaultModel?: string;
  availableModels?: string[];
  maxTokens?: number;
  temperature?: number;
  systemPrompt?: string;
}

/**
 * Configuration for API key-based providers
 */
export interface ApiKeyProviderConfig extends BaseProviderConfig {
  type: "openai" | "anthropic" | "gemini" | "openai-compatible" | "custom";
  apiKey: string;
  baseUrl: string;
  defaultModel: string;
  availableModels: string[]; // Model ID list
  models?: ModelInfo[]; // Detailed model info (optional)
  maxTokens?: number;
  temperature?: number;
  systemPrompt?: string;
}

/**
 * Union type for all provider configs
 */
export type ProviderConfig = PaperChatProviderConfig | ApiKeyProviderConfig;

/**
 * Provider metadata for display and defaults
 */
export interface ProviderMetadata {
  id: BuiltinProviderId;
  name: string;
  description: string;
  defaultBaseUrl: string;
  defaultModels: string[]; // Model ID list
  defaultModelInfos: ModelInfo[]; // Detailed model info
  website: string;
  type: ProviderType;
}

/**
 * Provider storage format (for Zotero prefs)
 */
export interface ProviderStorageData {
  activeProviderId: string;
  providers: ProviderConfig[];
  fallbackConfig?: FallbackConfig;
}

/**
 * Fallback configuration for provider failover
 *
 * Auto-fallback is enabled by default when multiple providers are ready.
 * User can optionally specify fallbackProviderIds to control the order.
 */
export interface FallbackConfig {
  /** Provider IDs to try in order after primary fails (optional, auto-detected if empty) */
  fallbackProviderIds: string[];
  /** Maximum number of retries across all providers (default: 3) */
  maxRetries: number;
}

/**
 * Error types that trigger fallback to next provider
 */
export type RetryableErrorType =
  | "rate_limit"
  | "timeout"
  | "service_unavailable"
  | "network_error"
  | "quota_exceeded";

/**
 * Result of a fallback execution attempt
 */
export interface FallbackExecutionResult<T> {
  success: boolean;
  result?: T;
  error?: Error;
  providerId: string;
  attemptNumber: number;
}

/**
 * Message format for Anthropic API
 * Supports text, images, documents, tool_use, and tool_result blocks
 */
export interface AnthropicMessage {
  role: "user" | "assistant";
  content:
    | string
    | (
        | AnthropicTextBlock
        | AnthropicImageBlock
        | AnthropicDocumentBlock
        | AnthropicToolUseBlock
        | AnthropicToolResultBlock
      )[];
}

/** Anthropic text content block */
export interface AnthropicTextBlock {
  type: "text";
  text: string;
}

/** Anthropic image content block */
export interface AnthropicImageBlock {
  type: "image";
  source: {
    type: "base64";
    media_type: string;
    data: string;
  };
}

/** Anthropic document content block */
export interface AnthropicDocumentBlock {
  type: "document";
  source: {
    type: "base64";
    media_type: string;
    data: string;
  };
}

/**
 * @deprecated Use AnthropicTextBlock | AnthropicImageBlock | AnthropicDocumentBlock instead
 * Kept for backward compatibility
 */
export interface AnthropicContentBlock {
  type: "text" | "image" | "document";
  text?: string;
  source?: {
    type: "base64";
    media_type: string;
    data: string;
  };
}

/**
 * Message format for Gemini API
 */
export interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

export interface GeminiPart {
  text?: string;
  inline_data?: {
    mime_type: string;
    data: string;
  };
}

/**
 * PDF attachment for providers that support PDF upload
 */
export interface PdfAttachment {
  data: string; // base64 encoded
  mimeType: string;
  name: string;
}

/**
 * AI Provider interface that all providers must implement
 */
export interface AIProvider {
  /** Provider configuration */
  readonly config: ProviderConfig;

  /** Get display name */
  getName(): string;

  /** Check if provider is configured and ready */
  isReady(): boolean;

  /** Check if provider supports PDF file upload */
  supportsPdfUpload(): boolean;

  /** Update configuration */
  updateConfig(config: Partial<ProviderConfig>): void;

  /** Stream chat completion */
  streamChatCompletion(
    messages: ChatMessage[],
    callbacks: StreamCallbacks,
    pdfAttachment?: PdfAttachment,
  ): Promise<void>;

  /** Non-streaming chat completion */
  chatCompletion(messages: ChatMessage[]): Promise<string>;

  /** Test connection to the API */
  testConnection(): Promise<boolean>;

  /** Get available models */
  getAvailableModels(): Promise<string[]>;
}

/**
 * Provider factory type
 */
export type ProviderFactory = (config: ProviderConfig) => AIProvider;

/**
 * Tool Calling Provider interface
 * Extends AIProvider with tool calling capabilities
 */
export interface ToolCallingProvider extends AIProvider {
  /** 非流式 tool calling */
  chatCompletionWithTools(
    messages: ChatMessage[],
    tools?: ToolDefinition[],
  ): Promise<{ content: string; toolCalls?: ToolCall[] }>;

  /** 流式 tool calling（可选，部分 provider 可能不支持） */
  streamChatCompletionWithTools?(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    callbacks: StreamToolCallingCallbacks,
  ): Promise<void>;
}

/**
 * Anthropic Tool 定义格式
 */
export interface AnthropicTool {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/**
 * Anthropic Tool Use 内容块
 */
export interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/**
 * Anthropic Tool Result 内容块
 */
export interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
}
