import { assert } from "chai";
import { BaseProvider } from "../src/modules/providers/BaseProvider.ts";
import {
  HttpResponseError,
  getHttpResponseStatus,
} from "../src/modules/providers/HttpResponseError.ts";
import {
  getProviderRetryBackoffDelayMs,
  isRetryableProviderError,
  PROVIDER_REQUEST_MAX_ATTEMPTS,
} from "../src/modules/providers/provider-retry-policy.ts";
import type { ChatMessage, StreamCallbacks } from "../src/types/chat";

class ResponseValidatingProvider extends BaseProvider {
  constructor() {
    super({
      id: "response-validator",
      name: "Response Validator",
      type: "openai-compatible",
      enabled: true,
      isBuiltin: false,
      order: 0,
      apiKey: "test-key",
      baseUrl: "https://example.com/v1",
      defaultModel: "test-model",
      availableModels: ["test-model"],
    });
  }

  validate(response: Response): Promise<void> {
    return this.validateResponse(response);
  }

  async streamChatCompletion(
    _messages: ChatMessage[],
    _callbacks: StreamCallbacks,
  ): Promise<void> {}

  async chatCompletion(_messages: ChatMessage[]): Promise<string> {
    return "";
  }

  async testConnection(): Promise<boolean> {
    return true;
  }

  async getAvailableModels(): Promise<string[]> {
    return [];
  }
}

describe("provider HTTP errors", function () {
  it("preserves response metadata in a structured error", async function () {
    const provider = new ResponseValidatingProvider();
    let caught: unknown;

    try {
      await provider.validate(
        new Response("", { status: 504, statusText: "Gateway Timeout" }),
      );
    } catch (error) {
      caught = error;
    }

    assert.instanceOf(caught, HttpResponseError);
    assert.equal(getHttpResponseStatus(caught), 504);
    assert.equal((caught as HttpResponseError).statusText, "Gateway Timeout");
    assert.equal((caught as HttpResponseError).responseBody, "");
    assert.equal((caught as Error).message, "API Error: 504 - ");
  });

  it("classifies retryable HTTP failures by status", function () {
    for (const status of [408, 429, 500, 502, 503, 504, 524]) {
      assert.isTrue(
        isRetryableProviderError(new HttpResponseError({ status })),
        `expected HTTP ${status} to be retryable`,
      );
    }

    assert.isTrue(
      isRetryableProviderError(
        new HttpResponseError({
          status: 400,
          responseBody: "upstream mentioned 504 Gateway Timeout",
        }),
      ),
    );
    assert.isFalse(
      isRetryableProviderError(
        new HttpResponseError({
          status: 400,
          responseBody: "invalid request",
        }),
      ),
    );
  });

  it("does not retry exhausted quotas", function () {
    assert.isFalse(
      isRetryableProviderError(
        new HttpResponseError({
          status: 429,
          responseBody: '{"error":{"code":"insufficient_quota"}}',
        }),
      ),
    );
    assert.isFalse(
      isRetryableProviderError(
        new Error(
          '{"error":{"code":"insufficient_user_quota","message":"额度不足"}}',
        ),
      ),
    );
  });

  it("keeps rate-limit and legacy transport fallbacks", function () {
    assert.isTrue(
      isRetryableProviderError(
        new HttpResponseError({ status: 403, responseBody: "rate limit" }),
      ),
    );
    assert.isTrue(
      isRetryableProviderError(new Error("API Error: 504 - Gateway Timeout")),
    );
  });

  it("uses four attempts with 2s, 4s, and 8s backoff", function () {
    assert.equal(PROVIDER_REQUEST_MAX_ATTEMPTS, 4);
    assert.deepEqual(
      [1, 2, 3].map((attempt) => getProviderRetryBackoffDelayMs(attempt)),
      [2000, 4000, 8000],
    );
    assert.equal(getProviderRetryBackoffDelayMs(4), 8000);
  });
});
