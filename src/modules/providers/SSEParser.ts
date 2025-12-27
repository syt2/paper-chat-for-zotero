/**
 * SSEParser - Unified Server-Sent Events stream parser
 *
 * Handles SSE parsing for different AI provider formats:
 * - OpenAI: choices[0].delta.content
 * - Anthropic: content_block_delta with delta.text
 * - Gemini: candidates[0].content.parts[0].text
 */

export type SSEFormat = "openai" | "anthropic" | "gemini";

export interface SSEParserCallbacks {
  onText: (text: string) => void;
  onDone: () => void;
  onError?: (error: Error) => void;
}

/**
 * Content extractors for different API formats
 */
const contentExtractors: Record<SSEFormat, (parsed: unknown) => string | null> = {
  openai: (parsed) => {
    const data = parsed as { choices?: Array<{ delta?: { content?: string } }> };
    return data.choices?.[0]?.delta?.content || null;
  },

  anthropic: (parsed) => {
    const data = parsed as {
      type?: string;
      delta?: { text?: string };
      error?: { message?: string };
    };
    // Handle errors
    if (data.type === "error") {
      throw new Error(data.error?.message || "Unknown Anthropic error");
    }
    // Only extract text from content_block_delta events
    if (data.type === "content_block_delta") {
      return data.delta?.text || null;
    }
    return null;
  },

  gemini: (parsed) => {
    const data = parsed as {
      candidates?: Array<{
        content?: {
          parts?: Array<{ text?: string }>;
        };
      }>;
      error?: { message?: string };
    };
    // Handle errors
    if (data.error) {
      throw new Error(data.error.message || "Unknown Gemini error");
    }
    return data.candidates?.[0]?.content?.parts?.[0]?.text || null;
  },
};

/**
 * Parse SSE stream with unified handling for different API formats
 *
 * @param reader - ReadableStream reader from fetch response
 * @param format - The API format to use for content extraction
 * @param callbacks - Callbacks for text, completion, and errors
 */
export async function parseSSEStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  format: SSEFormat,
  callbacks: SSEParserCallbacks,
): Promise<void> {
  const { onText, onDone, onError } = callbacks;
  const extractContent = contentExtractors[format];
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      const value = result.value as Uint8Array;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data: ")) continue;

        const data = trimmed.slice(6);
        if (data === "[DONE]") continue;

        try {
          const parsed = JSON.parse(data);
          const text = extractContent(parsed);
          if (text) {
            onText(text);
          }
        } catch (extractError) {
          // If extractor threw an error (not JSON parse error), propagate it
          if (extractError instanceof Error && extractError.message !== "Unexpected end of JSON input") {
            if (onError) {
              onError(extractError);
            }
            return;
          }
          // Ignore JSON parse errors for incomplete chunks
        }
      }
    }
    onDone();
  } catch (error) {
    if (onError) {
      onError(error instanceof Error ? error : new Error(String(error)));
    }
  }
}
