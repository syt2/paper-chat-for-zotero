/**
 * Provider Types - Multi-provider AI API type definitions
 */

import type { ChatMessage, StreamCallbacks } from "./chat";

/**
 * Model capabilities
 */
export type ModelCapability = "vision" | "reasoning" | "tool_use" | "web_search";

/**
 * Model information with metadata
 */
export interface ModelInfo {
  modelId: string;
  nickname?: string;           // Display name (optional)
  contextWindow?: number;      // Context window size
  maxOutput?: number;          // Max output tokens
  capabilities?: ModelCapability[]; // Model capabilities
  isCustom?: boolean;          // User-added custom model
}

/**
 * Supported provider types
 */
export type ProviderType =
  | "paperchat"         // PaperChat login-based system
  | "openai"            // Native OpenAI API
  | "anthropic"         // Anthropic Claude API (different format)
  | "gemini"            // Google Gemini API (different format)
  | "openai-compatible" // DeepSeek, Mistral, Groq, OpenRouter
  | "custom";           // User-defined OpenAI-compatible

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
  availableModels: string[];   // Model ID list
  models?: ModelInfo[];        // Detailed model info (optional)
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
  defaultModels: string[];        // Model ID list
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
}

/**
 * Message format for Anthropic API
 */
export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

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
  data: string;  // base64 encoded
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
