import { assert } from "chai";
import {
  DeepSeekToolsSearchProvider,
  type DeepSeekToolsSearchProviderOptions,
} from "../src/modules/chat/web-search/DeepSeekToolsSearchProvider.ts";
import { parseDeepSeekSearchResults } from "../src/modules/chat/web-search/DeepSeekSearchResult.ts";
import { normalizeWebFetchUrl } from "../src/modules/chat/web-search/WebFetchService.ts";
import type { WebSearchRequest } from "../src/modules/chat/web-search/WebSearchProvider.ts";

interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

class FakeXMLHttpRequest {
  static responses: Array<{
    status: number;
    statusText: string;
    body: string;
  }> = [];
  static requests: RecordedRequest[] = [];

  timeout = 0;
  status = 0;
  statusText = "";
  responseText = "";
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  onabort: (() => void) | null = null;

  private method = "";
  private url = "";
  private headers: Record<string, string> = {};

  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(name: string, value: string): void {
    this.headers[name] = value;
  }

  getResponseHeader(): string | null {
    return null;
  }

  send(body?: string): void {
    FakeXMLHttpRequest.requests.push({
      method: this.method,
      url: this.url,
      headers: { ...this.headers },
      body: body || "",
    });
    const queued = FakeXMLHttpRequest.responses.shift();
    if (!queued) {
      throw new Error(`No queued response for ${this.url}`);
    }
    setTimeout(() => {
      this.status = queued.status;
      this.statusText = queued.statusText;
      this.responseText = queued.body;
      this.onload?.();
    }, 0);
  }

  abort(): void {
    this.onabort?.();
  }
}

function request(overrides: Partial<WebSearchRequest> = {}): WebSearchRequest {
  return {
    query: "DeepSeek V4 release",
    source: "paperchat",
    intent: "web",
    maxResults: 5,
    includeContent: false,
    openAccessOnly: false,
    ...overrides,
  };
}

const PAPERCHAT_MESSAGES = {
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

function createProvider(
  overrides: Partial<DeepSeekToolsSearchProviderOptions> = {},
): DeepSeekToolsSearchProvider {
  return new DeepSeekToolsSearchProvider({
    id: "paperchat",
    displayName: "PaperChat Search",
    getApiKey: () => "sk-paperchat-token",
    getApiBaseUrl: () => "https://paperchat.example/v1",
    messages: PAPERCHAT_MESSAGES,
    ...overrides,
  });
}

describe("DeepSeek tools search provider", function () {
  let originalXMLHttpRequest: unknown;

  beforeEach(function () {
    originalXMLHttpRequest = (globalThis as any).XMLHttpRequest;
    (globalThis as any).XMLHttpRequest = FakeXMLHttpRequest;
    FakeXMLHttpRequest.requests = [];
    FakeXMLHttpRequest.responses = [];
  });

  afterEach(function () {
    (globalThis as any).XMLHttpRequest = originalXMLHttpRequest;
    FakeXMLHttpRequest.requests = [];
    FakeXMLHttpRequest.responses = [];
  });

  it("calls NewAPI /v1/tools/search and maps DeepSeek results", async function () {
    FakeXMLHttpRequest.responses.push({
      status: 200,
      statusText: "OK",
      body: JSON.stringify({
        results: [
          {
            title: "DeepSeek V4",
            url: "https://example.com/deepseek-v4",
            summary: "A result summary.",
            content: "Full page content.",
            date: "2026-06-01T00:00:00+00:00",
            site_name: "Example News",
          },
        ],
      }),
    });
    const provider = createProvider({
      getApiBaseUrl: () => "https://paperchat.example/v1/",
    });

    const response = await provider.search(
      request({
        includeContent: true,
        domainFilter: ["example.com"],
        yearFrom: 2025,
        yearTo: 2026,
        language: "en",
        originalQuestion: "What changed in DeepSeek V4?",
      }),
    );

    assert.equal(response.providerId, "paperchat");
    assert.equal(response.provider, "PaperChat Search");
    assert.lengthOf(response.results, 1);
    assert.equal(response.results[0]?.title, "DeepSeek V4");
    assert.equal(response.results[0]?.venue, "Example News");
    assert.equal(response.results[0]?.year, 2026);
    assert.include(
      response.results[0]?.contentExcerpt || "",
      "Full page content.",
    );

    assert.deepEqual(FakeXMLHttpRequest.requests, [
      {
        method: "POST",
        url: "https://paperchat.example/v1/tools/search",
        headers: {
          Accept: "application/json",
          Authorization: "Bearer sk-paperchat-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query:
            "DeepSeek V4 release site:example.com lang:en after:2025 before:2027",
          count: 5,
          need_content: true,
          ori_question: "What changed in DeepSeek V4?",
        }),
      },
    ]);
  });

  it("keeps and ranks rerank_score and authority without dropping unknown authority", function () {
    const results = parseDeepSeekSearchResults(
      {
        results: [
          {
            title: "Unranked",
            url: "https://example.com/unranked",
            summary: "No scores",
          },
          {
            title: "High authority",
            url: "https://example.com/high",
            summary: "Official documentation",
            rerank_score: 2.8,
            authority: 4,
          },
          {
            title: "Unknown authority",
            url: "https://example.com/unknown",
            summary: "Useful result",
            rerank_score: 1.8,
            authority: -1,
          },
          {
            title: "Low quality",
            url: "https://example.com/low",
            summary: "Weak result",
            rerank_score: 0.8,
            authority: 1,
          },
        ],
      },
      request(),
    );

    assert.deepEqual(
      results.map((result) => result.title),
      ["High authority", "Unknown authority", "Low quality", "Unranked"],
    );
    assert.equal(results[0]?.rerankScore, 2.8);
    assert.equal(results[0]?.authority, 4);
    assert.equal(results[1]?.authority, -1);
    assert.equal(results[0]?.summary, "Official documentation");
  });

  it("caps ori_question at the DeepSeek 128-character limit", async function () {
    FakeXMLHttpRequest.responses.push({
      status: 200,
      statusText: "OK",
      body: JSON.stringify({
        results: [{ title: "Result", url: "https://example.com/" }],
      }),
    });

    await createProvider().search(
      request({ originalQuestion: "这是一个很长的用户问题".repeat(20) }),
    );

    const body = JSON.parse(FakeXMLHttpRequest.requests[0]?.body || "{}") as {
      ori_question?: string;
    };
    assert.equal(Array.from(body.ori_question || "").length, 128);
  });

  it("fetches one URL as Markdown through /v1/tools/fetch", async function () {
    FakeXMLHttpRequest.responses.push({
      status: 200,
      statusText: "OK",
      body: JSON.stringify({
        title: "Example Domain",
        content: "# Example Domain\n\nThis domain is for use in examples.",
      }),
    });
    const provider = createProvider();

    const result = await provider.fetchPage("https://example.com/");

    assert.equal(result.title, "Example Domain");
    assert.equal(result.url, "https://example.com/");
    assert.include(result.content, "# Example Domain");
    assert.deepEqual(FakeXMLHttpRequest.requests, [
      {
        method: "POST",
        url: "https://paperchat.example/v1/tools/fetch",
        headers: {
          Accept: "application/json",
          Authorization: "Bearer sk-paperchat-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ url: "https://example.com/" }),
      },
    ]);
  });

  it("rejects an empty Fetch response instead of returning blank evidence", async function () {
    FakeXMLHttpRequest.responses.push({
      status: 200,
      statusText: "OK",
      body: JSON.stringify({ title: "Blocked", content: "" }),
    });

    let message = "";
    try {
      await createProvider().fetchPage("https://example.com/");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assert.include(message, "returned no page content");
  });

  it("blocks local and private Fetch targets", function () {
    assert.throws(
      () => normalizeWebFetchUrl("http://127.0.0.1/private"),
      /private-network/,
    );
    assert.throws(
      () => normalizeWebFetchUrl("http://169.254.169.254/latest/meta-data"),
      /private-network/,
    );
    assert.throws(() => normalizeWebFetchUrl("file:///etc/passwd"), /http/);
    assert.equal(
      normalizeWebFetchUrl("https://example.com/article#section"),
      "https://example.com/article",
    );
  });

  it("calls the official DeepSeek search endpoint with the provider key", async function () {
    FakeXMLHttpRequest.responses.push({
      status: 200,
      statusText: "OK",
      body: JSON.stringify({
        results: [
          {
            title: "Official result",
            url: "https://example.com/official",
          },
        ],
      }),
    });
    const provider = createProvider({
      id: "deepseek",
      displayName: "DeepSeek Search",
      getApiKey: () => "sk-deepseek-token",
      getApiBaseUrl: () => "https://api.deepseek.com/v1",
    });

    const response = await provider.search(request({ source: "deepseek" }));

    assert.equal(response.providerId, "deepseek");
    assert.equal(response.provider, "DeepSeek Search");
    assert.deepEqual(
      FakeXMLHttpRequest.requests.map((recorded) => recorded.url),
      ["https://api.deepseek.com/v1/tools/search"],
    );
    assert.equal(
      FakeXMLHttpRequest.requests[0]?.headers.Authorization,
      "Bearer sk-deepseek-token",
    );
  });

  it("explains that an older NewAPI build needs an upgrade", async function () {
    FakeXMLHttpRequest.responses.push({
      status: 404,
      statusText: "Not Found",
      body: JSON.stringify({
        error: { message: "Invalid URL (POST /v1/tools/search)" },
      }),
    });
    const provider = createProvider();

    let message = "";
    try {
      await provider.search(request());
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assert.include(message, "Upgrade NewAPI");
  });

  it("reports insufficient quota and invalid credentials", async function () {
    const quotaProvider = createProvider();
    FakeXMLHttpRequest.responses.push({
      status: 402,
      statusText: "Payment Required",
      body: JSON.stringify({ error: { message: "quota exhausted" } }),
    });
    let quotaMessage = "";
    try {
      await quotaProvider.search(request());
    } catch (error) {
      quotaMessage = error instanceof Error ? error.message : String(error);
    }
    assert.include(quotaMessage, "quota is insufficient");

    FakeXMLHttpRequest.responses.push({
      status: 401,
      statusText: "Unauthorized",
      body: JSON.stringify({ error: { message: "invalid token" } }),
    });
    let authMessage = "";
    try {
      await quotaProvider.search(request());
    } catch (error) {
      authMessage = error instanceof Error ? error.message : String(error);
    }
    assert.include(authMessage, "rejected the account credentials");
  });

  it("fails before making a request when no PaperChat key is available", async function () {
    const provider = createProvider({ getApiKey: () => null });

    let message = "";
    try {
      await provider.search(request());
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assert.include(message, "signed-in PaperChat account");
    assert.lengthOf(FakeXMLHttpRequest.requests, 0);
  });
});
