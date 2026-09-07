import { assert } from "chai";
import { mapMessageRowToChatMessage } from "../src/modules/chat/db/MessageRowStorage.ts";
import { serializePresentationArtifacts } from "../src/modules/chat/presentation-artifacts.ts";

describe("presentation artifact upgrade compatibility", function () {
  const row = {
    id: "legacy-message",
    role: "assistant" as const,
    content: "Existing answer",
    timestamp: 1,
  };
  const legacyArtifact = {
    toolCallId: "legacy-tool",
    path: "C:\\Users\\Reader\\deck.pptx",
    attachmentItemID: 42,
    sourceItemKey: "PAPER001",
    sourceLibraryID: 1,
  };

  it("reads older rows with no artifact or streaming columns", function () {
    const strictRow = new Proxy(row, {
      get(target, property, receiver) {
        if (!(property in target)) throw new Error("Missing column");
        return Reflect.get(target, property, receiver);
      },
    });
    assert.deepEqual(mapMessageRowToChatMessage(strictRow), row);
  });

  it("preserves old attachment and source metadata without requiring checkpoint fields", function () {
    const restored = mapMessageRowToChatMessage({
      ...row,
      presentation_artifacts: serializePresentationArtifacts([legacyArtifact]),
    });
    assert.lengthOf(restored.presentationArtifacts!, 1);
    assert.include(restored.presentationArtifacts![0], legacyArtifact);
    assert.notProperty(restored.presentationArtifacts![0], "checkpointId");
    assert.notProperty(restored.presentationArtifacts![0], "interruptedAt");
  });

  it("round-trips paused checkpoint metadata and ignores malformed optional fields", function () {
    const paused = {
      toolCallId: "paused-tool",
      localId: "paused-card",
      isDraft: true,
      checkpointId: "ppt-123-abc",
      interruptedAt: 1788760000000,
    };
    const restored = mapMessageRowToChatMessage({
      ...row,
      streaming_state: "interrupted",
      presentation_artifacts: serializePresentationArtifacts([
        paused,
        { ...legacyArtifact, checkpointId: "../escape", interruptedAt: -1 },
      ]),
    });
    assert.equal(restored.streamingState, "interrupted");
    assert.lengthOf(restored.presentationArtifacts!, 2);
    assert.include(restored.presentationArtifacts![0], paused);
    assert.include(restored.presentationArtifacts![1], legacyArtifact);
    assert.notProperty(restored.presentationArtifacts![1], "checkpointId");
    assert.notProperty(restored.presentationArtifacts![1], "interruptedAt");
  });
});
