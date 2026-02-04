/**
 * Providers Module Exports
 */

// Manager
export {
  ProviderManager,
  getProviderManager,
  destroyProviderManager,
  BUILTIN_PROVIDERS,
} from "./ProviderManager";

// Provider implementations
export { BaseProvider } from "./BaseProvider";
export { OpenAICompatibleProvider } from "./OpenAICompatibleProvider";
export { AnthropicProvider } from "./AnthropicProvider";
export { GeminiProvider } from "./GeminiProvider";
export { PaperChatProvider } from "./PaperChatProvider";

// Re-export types
export type {
  AIProvider,
  ProviderConfig,
  ProviderMetadata,
  ProviderStorageData,
  ProviderType,
  BuiltinProviderId,
  BaseProviderConfig,
  ApiKeyProviderConfig,
  PaperChatProviderConfig,
  ModelInfo,
  ModelCapability,
  FallbackConfig,
  FallbackExecutionResult,
  RetryableErrorType,
} from "../../types/provider";
