import type { AIProvider, ToolCallingProvider } from "../../types/provider";

export function providerSupportsToolCalling(
  provider: AIProvider | null | undefined,
): provider is AIProvider & ToolCallingProvider {
  return (
    !!provider &&
    "chatCompletionWithTools" in provider &&
    typeof (provider as ToolCallingProvider).chatCompletionWithTools ===
      "function"
  );
}
