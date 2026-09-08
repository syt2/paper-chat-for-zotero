import { assert } from "chai";
import { GeminiEmbedding } from "../src/modules/embedding/providers/GeminiEmbedding";

describe("Gemini Embedding 2 batching", function () {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("uses separate requests per text, explicit dimensions, and splits large batches", async function () {
    const calls: any[] = [];
    globalThis.fetch = (async (url: string, options: any) => {
      assert.include(url, "models/gemini-embedding-2:batchEmbedContents");
      const body = JSON.parse(options.body);
      calls.push(body);
      return {
        ok: true,
        json: async () => ({
          embeddings: body.requests.map((request: any) => {
            assert.equal(request.model, "models/gemini-embedding-2");
            assert.equal(request.outputDimensionality, 768);
            assert.notProperty(request, "taskType");
            assert.lengthOf(request.content.parts, 1);
            return { values: Array(768).fill(0) };
          }),
        }),
      };
    }) as any;
    const provider = new GeminiEmbedding("test-key");
    assert.lengthOf(
      await provider.embedBatch(
        Array.from({ length: 101 }, (_, i) => `text ${i}`),
      ),
      101,
    );
    assert.deepEqual(
      calls.map((call) => call.requests.length),
      [100, 1],
    );
    assert.equal(calls[1].requests[0].content.parts[0].text, "text 100");
  });

  it("rejects missing results, invalid dimensions and nonfinite values", async function () {
    for (const embeddings of [
      [],
      [{ values: [1] }],
      [{ values: Array(768).fill(NaN) }],
    ]) {
      globalThis.fetch = (async () => ({
        ok: true,
        json: async () => ({ embeddings }),
      })) as any;
      try {
        await new GeminiEmbedding("test").embed("hello");
        assert.fail("must reject invalid vectors");
      } catch (error) {
        assert.include(String(error), "Invalid");
      }
    }
  });
});
