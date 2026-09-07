import { assert } from "chai";
import {
  AgentRuntime,
  retainCompletedApiOnlyModelContextMessagesForTurn,
} from "../src/modules/chat/agent-runtime/AgentRuntime.ts";
import { getAssistantResumeCheckpoint } from "../src/modules/chat/assistant-resume.ts";
import type { ChatMessage, ChatSession } from "../src/types/chat";

describe("agent runtime phase resume", function () {
  let previousToolkit: unknown;

  beforeEach(function () {
    previousToolkit = (globalThis as any).ztoolkit;
    (globalThis as any).ztoolkit = { log: () => undefined };
  });

  afterEach(function () {
    (globalThis as any).ztoolkit = previousToolkit;
  });

  it("keeps a finished tool when the next tool in the same model phase is interrupted", async function () {
    const assistant: ChatMessage = {
      id: "answer",
      role: "assistant",
      content: "",
      timestamp: 2,
    };
    const session: ChatSession = {
      id: "batch",
      createdAt: 1,
      updatedAt: 1,
      lastActiveItemKey: null,
      messages: [
        { id: "user", role: "user", content: "Create two notes", timestamp: 1 },
        assistant,
      ],
    };
    const calls = ["one", "two"].map((id) => ({
      id,
      type: "function",
      function: {
        name: "create_note",
        arguments: JSON.stringify({ content: id }),
      },
    }));
    let sequence = 0;
    const runtime = new AgentRuntime(
      {
        updateMessageContent: async () => undefined,
        updateSessionMeta: async () => undefined,
        saveSession: async () => undefined,
      } as any,
      {
        isSessionActive: () => false,
        isSessionTracked: () => true,
        generateId: () => `batch-${++sequence}`,
        formatToolCallCard: (_name: string, args: string, status: string) =>
          `<tool-call status="${status}">${args}</tool-call>`,
      } as any,
      {
        createExecutionBatches: (requests: any[]) =>
          requests.map((request) => [request]),
        executeBatch: async (requests: any[]) => {
          if (requests[0].toolCall.id === "two")
            throw new Error("stopped second tool");
          return [
            {
              toolCall: requests[0].toolCall,
              status: "completed",
              content: "Note key: NOTEONE",
            },
          ];
        },
      } as any,
    ) as any;
    runtime.getMaxIterations = () => 3;
    try {
      await runtime.executeNonStreamingToolLoop({
        provider: {
          config: { id: "test", type: "openai", defaultModel: "test" },
          chatCompletionWithTools: async () => ({
            content: "Creating the notes.",
            toolCalls: calls,
          }),
        },
        currentMessages: session.messages.filter(
          (message) => message !== assistant,
        ),
        assistantMessage: assistant,
        sendingSession: session,
        pdfWasAttached: false,
        summaryTriggered: false,
        tools: [
          {
            type: "function",
            function: {
              name: "create_note",
              description: "test",
              parameters: { type: "object", properties: {} },
            },
          },
        ],
      });
      assert.fail("second tool should stop");
    } catch (error) {
      assert.include(String(error), "stopped second tool");
    }
    const recovered = getAssistantResumeCheckpoint(assistant);
    assert.include(recovered.content, "Creating the notes.");
    assert.include(recovered.content, '"one"');
    assert.notInclude(recovered.content, '"two"');
    assert.notInclude(recovered.content, 'status="calling"');
    assert.equal(
      session.toolExecutionState?.results[0].content,
      "Note key: NOTEONE",
    );
    retainCompletedApiOnlyModelContextMessagesForTurn(session, assistant.id);
    assert.isTrue(
      session.messages.some((message) => message.tool_call_id === "one"),
    );
    assert.isFalse(
      session.messages.some((message) =>
        message.tool_calls?.some((call) => call.id === "two"),
      ),
    );
  });

  for (const streaming of [true, false]) {
    const mode = streaming ? "streaming" : "non-streaming";

    it(`replaces C after persisted A/B and reuses the created note (${mode})`, async function () {
      let session: ChatSession = {
        id: "session",
        createdAt: 1,
        updatedAt: 1,
        lastActiveItemKey: null,
        messages: [
          {
            id: "user",
            role: "user",
            content: "Read and create a note",
            timestamp: 1,
          },
        ],
      };
      let assistant: ChatMessage = {
        id: "answer",
        role: "assistant",
        content: "",
        timestamp: 2,
      };
      session.messages.push(assistant);
      const calls = [
        {
          id: "read",
          type: "function",
          function: {
            name: "get_item_notes",
            arguments: '{"itemKey":"PAPER"}',
          },
        },
        {
          id: "note",
          type: "function",
          function: {
            name: "create_note",
            arguments: '{"content":"saved note"}',
          },
        },
      ];
      const executed: string[] = [];
      const persisted: any[] = [];
      let id = 0;
      const runtime = new AgentRuntime(
        {
          updateMessageContent: async (
            _session: string,
            _message: string,
            content: string,
            _reasoning: string,
            options: any,
          ) => {
            persisted.push(JSON.parse(JSON.stringify({ content, ...options })));
          },
          updateSessionMeta: async () => undefined,
          saveSession: async () => undefined,
        } as any,
        {
          isSessionActive: () => false,
          isSessionTracked: () => true,
          generateId: () => `generated-${++id}`,
          formatToolCallCard: (
            name: string,
            _args: string,
            status: string,
            result: string,
          ) =>
            `<tool-call status="${status}"><tool-name>${name}</tool-name><tool-result>${result || ""}</tool-result></tool-call>`,
        } as any,
        {
          createExecutionBatches: (requests: any[]) =>
            requests.map((request) => [request]),
          executeBatch: async (requests: any[]) =>
            requests.map((request) => {
              executed.push(request.toolCall.function.name);
              return {
                toolCall: request.toolCall,
                status: "completed",
                content: `result-${request.toolCall.function.name}`,
              };
            }),
        } as any,
      ) as any;
      runtime.getMaxIterations = () => 5;
      let round = 0;
      let resumed = false;
      const response = () => {
        round++;
        if (resumed)
          return round === 1
            ? {
                content: "",
                toolCalls: [{ ...calls[1], id: "new-note-call-id" }],
              }
            : { content: "C complete" };
        return round <= 2
          ? {
              content: `${round === 1 ? "A" : "B"} complete.`,
              toolCalls: [calls[round - 1]],
            }
          : null;
      };
      const provider = {
        config: { id: "test", type: "openai", defaultModel: "test" },
        chatCompletionWithTools: async () => {
          const result = response();
          if (!result) throw new Error("interrupted C");
          return result;
        },
        streamChatCompletionWithTools: async (
          _messages: any,
          _tools: any,
          callbacks: any,
        ) => {
          const result = response();
          if (result) {
            callbacks.onTextDelta(result.content);
            callbacks.onComplete(result);
          } else {
            callbacks.onTextDelta("C interrupted");
            callbacks.onReasoningDelta("C unfinished thinking");
            callbacks.onError(new Error("interrupted C"));
          }
        },
      };
      const run = () =>
        runtime[
          streaming ? "executeStreamingToolLoop" : "executeNonStreamingToolLoop"
        ]({
          provider,
          assistantMessage: assistant,
          sendingSession: session,
          currentMessages: session.messages.filter(
            (message) => message.id !== assistant.id,
          ),
          pdfWasAttached: false,
          summaryTriggered: false,
          preserveToolExecutionState: resumed,
          tools: calls.map((call) => ({
            type: "function",
            function: {
              name: call.function.name,
              description: "test",
              parameters: { type: "object", properties: {} },
            },
          })),
        });
      try {
        await run();
        assert.fail("C should fail");
      } catch (error) {
        assert.include(String(error), "interrupted C");
      }
      assert.include(assistant.resumeCheckpoint!.content, "A complete.");
      assert.include(assistant.resumeCheckpoint!.content, "B complete.");
      assert.notInclude(assistant.resumeCheckpoint!.content, "C interrupted");
      assert.notInclude(
        assistant.resumeCheckpoint!.reasoning || "",
        "C unfinished",
      );
      assert.isTrue(
        persisted.some((entry) =>
          entry.resumeCheckpoint?.content.includes("result-create_note"),
        ),
      );

      // Reconstruct after restart: no in-memory tool/phase object survives.
      session = JSON.parse(JSON.stringify(session));
      assistant = session.messages.find((message) => message.id === "answer")!;
      retainCompletedApiOnlyModelContextMessagesForTurn(session, assistant.id);
      const checkpoint = getAssistantResumeCheckpoint(assistant);
      assistant.content = checkpoint.content;
      assistant.reasoning = checkpoint.reasoning;
      resumed = true;
      round = 0;
      await run();
      assert.deepEqual(executed, ["get_item_notes", "create_note"]);
      assert.notInclude(assistant.content, "C interrupted");
      assert.equal(assistant.content.split("A complete.").length - 1, 1);
      assert.equal(assistant.content.split("B complete.").length - 1, 1);
      assert.isTrue(assistant.content.endsWith("C complete"));
      assert.isUndefined(assistant.resumeCheckpoint);
      assert.equal(
        session.messages.filter((message) => message.role === "user").length,
        1,
      );
    });
  }
});
