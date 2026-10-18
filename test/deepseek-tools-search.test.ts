import { assert } from "chai";
import {
  DeepSeekToolsSearchProvider,
  type DeepSeekToolsSearchProviderOptions,
} from "../src/modules/chat/web-search/DeepSeekToolsSearchProvider.ts";
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
          query: "DeepSeek V4 release site:example.com after:2025 before:2027",
          count: 5,
          need_content: true,
        }),
      },
    ]);
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
