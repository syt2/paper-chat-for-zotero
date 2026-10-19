import { getAuthManager } from "../../auth";
import { getPaperChatApiBaseUrl } from "../../providers/PaperChatUrls";
import type {
  WebFetchResult,
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResponse,
} from "./WebSearchProvider";
import { requestHttp } from "./WebSearchHttp";
import {
  buildDeepSeekSearchQuery,
  getDeepSeekSearchCount,
  normalizeDeepSeekOriginalQuestion,
  parseDeepSeekSearchResults,
  type DeepSeekSearchResponse,
} from "./DeepSeekSearchResult";
import {
  getOfficialDeepSeekSearchApiKey,
  getOfficialDeepSeekSearchBaseUrl,
} from "./deepseek-official";

interface DeepSeekToolsSearchMessages {
  missingKey: string;
  rejectedKey: string;
  insufficientQuota: string;
  missingEndpoint: string;
  missingFetchEndpoint: string;
  emptyContent: string;
  rateLimited: string;
  invalidJson: string;
}

export interface DeepSeekToolsSearchProviderOptions {
  id: string;
  displayName: string;
  getApiKey: () => string | null;
  getApiBaseUrl: () => string;
  messages: DeepSeekToolsSearchMessages;
}

interface DeepSeekSearchErrorEnvelope {
  error?: { message?: unknown };
  message?: unknown;
}

/**
 * DeepSeek's `/v1/tools/search` API, used by NewAPI for PaperChat and by the
 * official DeepSeek API. The wire format is identical; only the key and base
 * URL differ.
 */
export class DeepSeekToolsSearchProvider implements WebSearchProvider {
  readonly id: string;
  readonly displayName: string;

  constructor(private readonly options: DeepSeekToolsSearchProviderOptions) {
    this.id = options.id;
    this.displayName = options.displayName;
  }

  async search(request: WebSearchRequest): Promise<WebSearchResponse> {
    const apiKey = this.options.getApiKey()?.trim();
    if (!apiKey) {
      throw new Error(this.options.messages.missingKey);
    }

    const originalQuestion = normalizeDeepSeekOriginalQuestion(
      request.originalQuestion,
    );
    const response = await requestHttp(
      `${this.options.getApiBaseUrl().replace(/\/+$/, "")}/tools/search`,
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
          ...(originalQuestion ? { ori_question: originalQuestion } : {}),
        }),
      },
    );

    if (response.status === 401 || response.status === 403) {
      throw new Error(this.options.messages.rejectedKey);
    }
    if (response.status === 402) {
      throw new Error(this.options.messages.insufficientQuota);
    }
    if (response.status === 404) {
      throw new Error(this.options.messages.missingEndpoint);
    }
    if (response.status === 429) {
      throw new Error(this.options.messages.rateLimited);
    }
    if (response.status >= 400) {
      throw new Error(readErrorMessage(response.status, response.body));
    }

    let payload: DeepSeekSearchResponse;
    try {
      payload = JSON.parse(response.body) as DeepSeekSearchResponse;
    } catch {
      throw new Error(this.options.messages.invalidJson);
    }

    return {
      providerId: this.id,
      provider: this.displayName,
      results: parseDeepSeekSearchResults(payload, request),
    };
  }

  async fetchPage(url: string): Promise<WebFetchResult> {
    const apiKey = this.options.getApiKey()?.trim();
    if (!apiKey) {
      throw new Error(this.options.messages.missingKey);
    }

    const response = await requestHttp(
      `${this.options.getApiBaseUrl().replace(/\/+$/, "")}/tools/fetch`,
      {
        method: "POST",
        timeoutMs: 30000,
        accept: "application/json",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ url }),
      },
    );

    if (response.status === 401 || response.status === 403) {
      throw new Error(this.options.messages.rejectedKey);
    }
    if (response.status === 402) {
      throw new Error(this.options.messages.insufficientQuota);
    }
    if (response.status === 404) {
      throw new Error(this.options.messages.missingFetchEndpoint);
    }
    if (response.status === 429) {
      throw new Error(this.options.messages.rateLimited);
    }
    if (response.status >= 400) {
      throw new Error(readErrorMessage(response.status, response.body));
    }

    let payload: { title?: unknown; url?: unknown; content?: unknown };
    try {
      payload = JSON.parse(response.body) as typeof payload;
    } catch {
      throw new Error(this.options.messages.invalidJson);
    }
    const content =
      typeof payload.content === "string" ? payload.content.trim() : "";
    if (!content) {
      throw new Error(this.options.messages.emptyContent);
    }
    return {
      title:
        typeof payload.title === "string" && payload.title.trim()
          ? payload.title.trim()
          : url,
      url:
        typeof payload.url === "string" && payload.url.trim()
          ? payload.url.trim()
          : url,
      content,
      contentType: "markdown",
    };
  }
}

const PAPERCHAT_MESSAGES: DeepSeekToolsSearchMessages = {
  missingKey:
    "PaperChat Search requires a signed-in PaperChat account. Sign in under Settings → PaperChat.",
  rejectedKey:
    "PaperChat Search rejected the account credentials. Sign in again or check the API key.",
  insufficientQuota:
    "PaperChat Search cannot be charged because the account quota is insufficient.",
  missingEndpoint:
    "This NewAPI build does not provide /v1/tools/search. Upgrade NewAPI to a build containing commit 6cf0d90 (2026-10-17) or later.",
  missingFetchEndpoint:
    "This NewAPI build does not provide /v1/tools/fetch. Upgrade NewAPI to a build containing commit 6cf0d90 (2026-10-17) or later.",
  emptyContent:
    "PaperChat Fetch returned no page content. The page may be empty, blocked, or unavailable.",
  rateLimited: "PaperChat Search is rate limited. Wait before retrying.",
  invalidJson: "PaperChat Search returned invalid JSON.",
};

const OFFICIAL_DEEPSEEK_MESSAGES: DeepSeekToolsSearchMessages = {
  missingKey:
    "DeepSeek Search requires an API key for the official DeepSeek provider. Configure it under Settings → Service Providers → DeepSeek.",
  rejectedKey:
    "DeepSeek Search rejected the API key. Check the official DeepSeek provider configuration.",
  insufficientQuota:
    "DeepSeek Search cannot be billed because the DeepSeek account balance is insufficient.",
  missingEndpoint:
    "The configured DeepSeek API does not provide /v1/tools/search.",
  missingFetchEndpoint:
    "The configured DeepSeek API does not provide /v1/tools/fetch.",
  emptyContent:
    "DeepSeek Fetch returned no page content. The page may be empty, blocked, or unavailable.",
  rateLimited: "DeepSeek Search is rate limited. Wait before retrying.",
  invalidJson: "DeepSeek Search returned invalid JSON.",
};

export function createPaperChatSearchProvider(): DeepSeekToolsSearchProvider {
  return new DeepSeekToolsSearchProvider({
    id: "paperchat",
    displayName: "PaperChat Search",
    getApiKey: () => getAuthManager().getApiKey(),
    getApiBaseUrl: getPaperChatApiBaseUrl,
    messages: PAPERCHAT_MESSAGES,
  });
}

export function createOfficialDeepSeekSearchProvider(): DeepSeekToolsSearchProvider {
  return new DeepSeekToolsSearchProvider({
    id: "deepseek",
    displayName: "DeepSeek Search",
    getApiKey: getOfficialDeepSeekSearchApiKey,
    getApiBaseUrl: getOfficialDeepSeekSearchBaseUrl,
    messages: OFFICIAL_DEEPSEEK_MESSAGES,
  });
}

export function createPaperChatFetchProvider(): DeepSeekToolsSearchProvider {
  return new DeepSeekToolsSearchProvider({
    id: "paperchat",
    displayName: "PaperChat Fetch",
    getApiKey: () => getAuthManager().getApiKey(),
    getApiBaseUrl: getPaperChatApiBaseUrl,
    messages: PAPERCHAT_MESSAGES,
  });
}

export function createOfficialDeepSeekFetchProvider(): DeepSeekToolsSearchProvider {
  return new DeepSeekToolsSearchProvider({
    id: "deepseek",
    displayName: "DeepSeek Fetch",
    getApiKey: getOfficialDeepSeekSearchApiKey,
    getApiBaseUrl: getOfficialDeepSeekSearchBaseUrl,
    messages: OFFICIAL_DEEPSEEK_MESSAGES,
  });
}

function readErrorMessage(status: number, body: string): string {
  try {
    const parsed = JSON.parse(body) as DeepSeekSearchErrorEnvelope;
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
  return text || `Search request failed (${status}).`;
}
