import { getAuthManager } from "../../auth";
import { getPaperChatApiBaseUrl } from "../../providers/PaperChatUrls";
import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResponse,
} from "./WebSearchProvider";
import { requestHttp } from "./WebSearchHttp";
import {
  buildDeepSeekSearchQuery,
  getDeepSeekSearchCount,
  parseDeepSeekSearchResults,
  type DeepSeekSearchResponse,
} from "./DeepSeekSearchResult";

interface PaperChatSearchAuth {
  getApiKey(): string | null;
}

interface PaperChatErrorEnvelope {
  error?: { message?: unknown };
  message?: unknown;
}

/**
 * Service-provided web search through NewAPI's native DeepSeek Search route.
 * NewAPI selects the DeepSeek channel by the `deepseek-search` model name and
 * deducts the signed-in user's quota before passing the request upstream.
 */
export class PaperChatSearchProvider implements WebSearchProvider {
  readonly id = "paperchat";
  readonly displayName = "PaperChat Search";

  constructor(
    private readonly auth: PaperChatSearchAuth = getAuthManager(),
    private readonly getApiBaseUrl: () => string = getPaperChatApiBaseUrl,
  ) {}

  async search(request: WebSearchRequest): Promise<WebSearchResponse> {
    const apiKey = this.auth.getApiKey()?.trim();
    if (!apiKey) {
      throw new Error(
        "PaperChat Search requires a signed-in PaperChat account. Sign in under Settings → PaperChat.",
      );
    }

    const response = await requestHttp(
      `${this.getApiBaseUrl().replace(/\/+$/, "")}/tools/search`,
      {
        method: "POST",
        timeoutMs: 20000,
        accept: "application/json",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query: buildDeepSeekSearchQuery(request),
          count: getDeepSeekSearchCount(request),
          need_content: request.includeContent,
        }),
      },
    );

    if (response.status === 401 || response.status === 403) {
      throw new Error(
        "PaperChat Search rejected the account credentials. Sign in again or check the API key.",
      );
    }
    if (response.status === 402) {
      throw new Error(
        "PaperChat Search cannot be charged because the account quota is insufficient.",
      );
    }
    if (response.status === 404) {
      throw new Error(
        "This NewAPI build does not provide /v1/tools/search. Upgrade NewAPI to a build containing commit 6cf0d90 (2026-10-17) or later.",
      );
    }
    if (response.status === 429) {
      throw new Error(
        "PaperChat Search is rate limited. Wait before retrying.",
      );
    }
    if (response.status >= 400) {
      throw new Error(readErrorMessage(response.status, response.body));
    }

    let payload: DeepSeekSearchResponse;
    try {
      payload = JSON.parse(response.body) as DeepSeekSearchResponse;
    } catch {
      throw new Error("PaperChat Search returned invalid JSON.");
    }

    return {
      providerId: this.id,
      provider: this.displayName,
      results: parseDeepSeekSearchResults(payload, request),
    };
  }
}

function readErrorMessage(status: number, body: string): string {
  try {
    const parsed = JSON.parse(body) as PaperChatErrorEnvelope;
    if (typeof parsed.error?.message === "string") {
      return parsed.error.message;
    }
    if (typeof parsed.message === "string") {
      return parsed.message;
    }
  } catch {
    // Fall through to the sanitized text body.
  }
  const text = body.replace(/\s+/g, " ").trim().slice(0, 300);
  return text || `PaperChat Search request failed (${status}).`;
}
