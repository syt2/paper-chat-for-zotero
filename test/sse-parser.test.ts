import { assert } from "chai";
import {
  parseSSEStream,
  parseSSEStreamWithToolCalling,
  type SSEToolCallingEvent,
} from "../src/modules/providers/SSEParser.ts";

function readerFromSSE(
  chunks: string[],
): ReadableStreamDefaultReader<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  }).getReader();
}

describe("SSEParser", function () {
  it("reports OpenAI length truncation as max_tokens", async function () {
    const events: SSEToolCallingEvent[] = [];
    const sse = [
      `data: ${JSON.stringify({
        choices: [
          {
            index: 0,
            delta: { content: "partial" },
            finish_reason: "length",
          },
        ],
      })}\n\n`,
      "data: [DONE]\n\n",
    ];

    await parseSSEStreamWithToolCalling(readerFromSSE(sse), "openai", {
      onEvent: (event) => events.push(event),
    });

    assert.deepEqual(events, [
      { type: "text_delta", text: "partial" },
      { type: "done", stopReason: "max_tokens" },
    ]);
  });

  it("keeps Anthropic max_tokens through message_stop", async function () {
    const events: SSEToolCallingEvent[] = [];
    const sse = [
      `data: ${JSON.stringify({
        type: "message_delta",
        delta: { stop_reason: "max_tokens" },
      })}\n\n`,
      `data: ${JSON.stringify({ type: "message_stop" })}\n\n`,
    ];

    await parseSSEStreamWithToolCalling(readerFromSSE(sse), "anthropic", {
      onEvent: (event) => events.push(event),
    });

    assert.deepEqual(events, [{ type: "done", stopReason: "max_tokens" }]);
  });

  it("parses OpenAI-compatible tool calls packaged with finish_reason", async function () {
    const events: SSEToolCallingEvent[] = [];
    const sse = [
      `data: ${JSON.stringify({
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              content: "",
              reasoning: "I should call the tool.",
              tool_calls: [
                {
                  index: 0,
                  id: "chatcmpl-tool-test",
                  type: "function",
                  function: {
                    name: "get_current_weather",
                    arguments: '{"location":"Shanghai, China"}',
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      })}\n\n`,
      "data: [DONE]\n\n",
    ];

    await parseSSEStreamWithToolCalling(readerFromSSE(sse), "openai", {
      onEvent: (event) => events.push(event),
    });

    assert.deepEqual(events, [
      { type: "reasoning_delta", text: "I should call the tool." },
      {
        type: "tool_call_start",
        index: 0,
        id: "chatcmpl-tool-test",
        name: "get_current_weather",
      },
      {
        type: "tool_call_delta",
        index: 0,
        argumentsDelta: '{"location":"Shanghai, China"}',
      },
      { type: "done", stopReason: "tool_calls" },
    ]);
  });

  it("keeps OpenAI-style split tool call chunks working", async function () {
    const events: SSEToolCallingEvent[] = [];
    const sse = [
      `data: ${JSON.stringify({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_1",
                  type: "function",
                  function: { name: "search" },
                },
              ],
            },
          },
        ],
      })}\n\n`,
      `data: ${JSON.stringify({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  function: { arguments: '{"query"' },
                },
              ],
            },
          },
        ],
      })}\n\n`,
      `data: ${JSON.stringify({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  function: { arguments: ':"resnet"}' },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      })}\n\n`,
      "data: [DONE]\n\n",
    ];

    await parseSSEStreamWithToolCalling(readerFromSSE(sse), "openai", {
      onEvent: (event) => events.push(event),
    });

    assert.deepEqual(events, [
      { type: "tool_call_start", index: 0, id: "call_1", name: "search" },
      { type: "tool_call_delta", index: 0, argumentsDelta: '{"query"' },
      { type: "tool_call_delta", index: 0, argumentsDelta: ':"resnet"}' },
      { type: "done", stopReason: "tool_calls" },
    ]);
  });

  it("ignores repeated OpenAI-compatible tool call starts for the same index", async function () {
    const events: SSEToolCallingEvent[] = [];
    const sse = [
      `data: ${JSON.stringify({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_1",
                  type: "function",
                  function: { name: "search", arguments: '{"query"' },
                },
              ],
            },
          },
        ],
      })}\n\n`,
      `data: ${JSON.stringify({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_1",
                  type: "function",
                  function: { name: "search", arguments: ':"resnet"}' },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      })}\n\n`,
    ];

    await parseSSEStreamWithToolCalling(readerFromSSE(sse), "openai", {
      onEvent: (event) => events.push(event),
    });

    assert.deepEqual(events, [
      { type: "tool_call_start", index: 0, id: "call_1", name: "search" },
      { type: "tool_call_delta", index: 0, argumentsDelta: '{"query"' },
      { type: "tool_call_delta", index: 0, argumentsDelta: ':"resnet"}' },
      { type: "done", stopReason: "tool_calls" },
    ]);
  });

  it("reads OpenAI-compatible reasoning from delta.reasoning", async function () {
    const reasoning: string[] = [];
    const text: string[] = [];

    await parseSSEStream(
      readerFromSSE([
        `data: ${JSON.stringify({
          choices: [
            {
              index: 0,
              delta: { reasoning: "thinking", content: "answer" },
            },
          ],
        })}\n\n`,
        "data: [DONE]\n\n",
      ]),
      "openai",
      {
        onText: (chunk) => text.push(chunk),
        onReasoning: (text) => reasoning.push(text),
        onDone: () => undefined,
      },
    );

    assert.deepEqual(reasoning, ["thinking"]);
    assert.deepEqual(text, ["answer"]);
  });

  it("skips bare data: keep-alive lines without erroring the stream", async function () {
    const text: string[] = [];
    const errors: Error[] = [];
    let done = false;

    await parseSSEStream(
      readerFromSSE([
        "data:\n\n",
        `data: ${JSON.stringify({
          choices: [{ index: 0, delta: { content: "after keep-alive" } }],
        })}\n\n`,
        "data:\n\n",
        "data: [DONE]\n\n",
      ]),
      "openai",
      {
        onText: (chunk) => text.push(chunk),
        onDone: () => {
          done = true;
        },
        onError: (error) => errors.push(error),
      },
    );

    assert.deepEqual(text, ["after keep-alive"]);
    assert.deepEqual(errors, []);
    assert.isTrue(done);
  });

  it("does not let Anthropic message_stop overwrite tool_use completion", async function () {
    const events: SSEToolCallingEvent[] = [];
    const sse = [
      `event: content_block_start\n`,
      `data: ${JSON.stringify({
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "toolu_1",
          name: "search",
        },
      })}\n\n`,
      `event: content_block_delta\n`,
      `data: ${JSON.stringify({
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "input_json_delta",
          partial_json: '{"query":"resnet"}',
        },
      })}\n\n`,
      `event: message_delta\n`,
      `data: ${JSON.stringify({
        type: "message_delta",
        delta: { stop_reason: "tool_use" },
      })}\n\n`,
      `event: message_stop\n`,
      `data: ${JSON.stringify({ type: "message_stop" })}\n\n`,
    ];

    await parseSSEStreamWithToolCalling(readerFromSSE(sse), "anthropic", {
      onEvent: (event) => events.push(event),
    });

    assert.deepEqual(events, [
      { type: "tool_call_start", index: 0, id: "toolu_1", name: "search" },
      {
        type: "tool_call_delta",
        index: 0,
        argumentsDelta: '{"query":"resnet"}',
      },
      { type: "done", stopReason: "tool_calls" },
    ]);
  });
});
