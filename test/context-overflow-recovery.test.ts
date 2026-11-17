import { assert } from "chai";
import {
  ContextInputTooLongError,
  createContextOverflowRecovery,
  isContextOverflowError,
} from "../src/modules/providers/context-overflow.ts";
import { HttpResponseError } from "../src/modules/providers/HttpResponseError.ts";
import { isRetryableProviderError } from "../src/modules/providers/provider-retry-policy.ts";
import { ChatManager } from "../src/modules/chat/ChatManager.ts";
import { getContextManager } from "../src/modules/chat/ContextManager.ts";
import { getResumableTurn } from "../src/modules/chat/resumable-turn.ts";
import type { ChatMessage } from "../src/types/chat.ts";

const overflow = () =>
  new HttpResponseError({
    status: 400,
    responseBody:
      "status_code=400, number of input tokens (1087050) has exceeded max_prompt_tokens (1048576) limit.",
  });
const message = (
  id: string,
  role: ChatMessage["role"],
  content: string,
): ChatMessage => ({ id, role, content, timestamp: 1 });

async function rejected(operation: () => Promise<unknown>): Promise<Error> {
  try {
    await operation();
  } catch (error) {
    return error as Error;
  }
  assert.fail("Expected request to fail");
}

describe("context overflow recovery", function () {
  it("recognizes the production GLM error without retrying raw input", function () {
    assert.isTrue(isContextOverflowError(overflow()));
    assert.isTrue(isContextOverflowError(overflow().message));
    assert.isFalse(isRetryableProviderError(overflow()));
    assert.isFalse(
      isRetryableProviderError(new ContextInputTooLongError(overflow())),
    );
    for (const text of [
      "rate limit exceeded",
      "insufficient quota",
      "invalid api key",
      "network error",
      "max_tokens must be greater than 0",
    ]) {
      assert.isFalse(isContextOverflowError(new Error(text)), text);
    }
  });

  it("compacts and retries only once, including across later tool rounds", async function () {
    let compactions = 0;
    let calls = 0;
    const recover = createContextOverflowRecovery({
      compact: async () => {
        compactions++;
        return true;
      },
    });
    assert.equal(
      await recover(async () => {
        if (++calls === 1) throw overflow();
        return "recovered";
      }),
      "recovered",
    );
    const error = await rejected(() =>
      recover(async () => {
        calls++;
        throw overflow();
      }),
    );
    assert.instanceOf(error, ContextInputTooLongError);
    assert.equal(compactions, 1);
    assert.equal(calls, 3);
  });

  it("reports a terminal error when compaction fails or the compacted request still overflows", async function () {
    for (const compact of [
      async () => false,
      async () => {
        throw new Error("summary unavailable");
      },
      async () => true,
    ]) {
      let calls = 0;
      const recover = createContextOverflowRecovery({ compact });
      const error = await rejected(() =>
        recover(async () => {
          calls++;
          throw overflow();
        }),
      );
      assert.instanceOf(error, ContextInputTooLongError);
      assert.isAtMost(calls, 2);
    }
  });

  it("does not mislabel a network failure after successful compression", async function () {
    let calls = 0;
    const network = new Error("network error");
    const recover = createContextOverflowRecovery({
      compact: async () => true,
    });
    const error = await rejected(() =>
      recover(async () => {
        if (++calls === 1) throw overflow();
        throw network;
      }),
    );
    assert.strictEqual(error, network);
    assert.isTrue(isRetryableProviderError(error));
  });

  it("honors cancellation and the guard against replaying hosted side effects", async function () {
    const controller = new AbortController();
    let calls = 0;
    const recover = createContextOverflowRecovery({
      signal: controller.signal,
      compact: async () => {
        controller.abort();
        return true;
      },
    });
    assert.equal(
      (
        await rejected(() =>
          recover(async () => {
            calls++;
            throw overflow();
          }),
        )
      ).name,
      "AbortError",
    );
    assert.equal(calls, 1);
    let compactions = 0;
    const guarded = createContextOverflowRecovery({
      shouldRecover: () => false,
      compact: async () => {
        compactions++;
        return true;
      },
    });
    const original = overflow();
    assert.strictEqual(
      await rejected(() =>
        guarded(async () => {
          throw original;
        }),
      ),
      original,
    );
    assert.equal(compactions, 0);
  });

  it("replaces live request history while preserving stored messages, the current question and attachments", async function () {
    const context = getContextManager();
    const summarize = context.summarizeRequestForRecovery;
    const old = message("old", "user", "x".repeat(100000));
    const current = {
      ...message("current", "user", "Keep my exact question"),
      files: [
        {
          name: "notes.txt",
          type: "text" as const,
          content: "exact attachment",
        },
      ],
    };
    const tool = {
      ...message("tool", "tool", "tool result"),
      tool_call_id: "call1",
    };
    const system = message("rules", "system", "stable rules");
    const messages = [system, old, current, tool];
    const session = {
      id: "recovery-test",
      messages: [old, current, tool],
    } as any;
    const manager = Object.create(ChatManager.prototype) as any;
    let saves = 0;
    manager.ensureTrackedRun = () => {};
    manager.sessionStorage = {
      updateSessionMeta: async () => {
        saves++;
      },
    };
    manager.insertSystemNotice = async () => "notice";
    const previousAddon = (globalThis as any).addon;
    (globalThis as any).addon = {
      data: {
        locale: {
          current: { formatMessagesSync: () => [{ value: "compressed" }] },
        },
      },
    };
    context.summarizeRequestForRecovery = async (input) => {
      assert.include(input, tool);
      return "The earlier paper and completed tool results were summarized.";
    };
    try {
      assert.isTrue(await manager.compactOverflowRequest(messages, session, 1));
      assert.deepEqual(
        messages.map((m) => m.role),
        ["system", "system", "user"],
      );
      assert.strictEqual(messages[0], system);
      assert.strictEqual(messages[2], current);
      assert.equal(current.files[0].content, "exact attachment");
      assert.lengthOf(session.messages, 3);
      assert.equal(old.content.length, 100000);
      assert.deepEqual(session.contextSummary.coveredMessageIds, ["old"]);
      assert.equal(saves, 1);
    } finally {
      context.summarizeRequestForRecovery = summarize;
      (globalThis as any).addon = previousAddon;
    }
  });

  it("does not offer resume for persisted overflow errors", function () {
    const user = message("u", "user", "question");
    for (const content of [
      overflow().message,
      new ContextInputTooLongError(overflow()).message,
    ]) {
      assert.isNull(getResumableTurn([user, message("e", "error", content)]));
    }
  });
});
