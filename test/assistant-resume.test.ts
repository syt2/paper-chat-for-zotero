import { assert } from "chai";
import {
  checkpointAssistantPhase,
  getAssistantResumeCheckpoint,
  parseAssistantResumeCheckpoint,
} from "../src/modules/chat/assistant-resume.ts";
import { mapMessageRowToChatMessage } from "../src/modules/chat/db/MessageRowStorage.ts";
import type { ChatMessage } from "../src/types/chat";

describe("assistant phase recovery", function () {
  it("keeps completed phases and drops only the new partial text and reasoning", function () {
    const message: ChatMessage = {
      id: "reply",
      role: "assistant",
      timestamp: 1,
      content: "A complete. B complete. ",
      reasoning: "A/B reasoning",
    };
    checkpointAssistantPhase(message);
    message.content += "C interrupted";
    message.reasoning += " C partial reasoning";
    const recovered = getAssistantResumeCheckpoint(message);
    assert.deepEqual(recovered, {
      content: "A complete. B complete. ",
      reasoning: "A/B reasoning",
    });
    assert.include(message.content, "C interrupted");
  });

  it("round-trips an empty first-phase boundary through storage", function () {
    const restored = mapMessageRowToChatMessage({
      id: "reply",
      role: "assistant",
      timestamp: 1,
      content: "First answer interrupted",
      streaming_state: "interrupted",
      resume_checkpoint: JSON.stringify({ content: "" }),
    });
    assert.equal(getAssistantResumeCheckpoint(restored).content, "");
  });

  it("restores a phase after restart independently of partial-content cleanup", function () {
    const checkpoint = { content: "A\n\nB\n", reasoning: "done" };
    const restored = mapMessageRowToChatMessage({
      id: "reply",
      role: "assistant",
      timestamp: 1,
      content: "A\nB\npartial",
      streaming_state: "interrupted",
      resume_checkpoint: JSON.stringify(checkpoint),
    });
    assert.deepEqual(getAssistantResumeCheckpoint(restored), checkpoint);
  });

  it("handles old replies and malformed checkpoints without replaying partial prose", function () {
    for (const value of ["{", "null", '{"content":3}', "[]"]) {
      assert.isUndefined(parseAssistantResumeCheckpoint(value));
    }
    const card =
      '<tool-call status="completed"><tool-name>create_note</tool-name></tool-call>';
    const message: ChatMessage = {
      id: "old",
      role: "assistant",
      timestamp: 1,
      content: `Created note.${card}Unfinished summary`,
    };
    assert.equal(
      getAssistantResumeCheckpoint(message).content,
      `Created note.${card}`,
    );
    message.content = "First answer interrupted";
    assert.equal(getAssistantResumeCheckpoint(message).content, "");
  });
});
