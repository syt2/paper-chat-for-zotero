import { assert } from "chai";
import { getTranslationCandidates } from "../src/modules/ui/SelectionTranslationRouting.ts";
import { parseModelRoutingDefaults } from "../src/modules/providers/paperchat-routing-metadata.ts";

const paperchat = { id: "paperchat", type: "paperchat" };

describe("translation routing", function () {
  it("tries default then chat in automatic mode and reverses in follow mode", function () {
    const model = { providerId: "paperchat", model: "translate" };
    assert.deepEqual(getTranslationCandidates("auto", paperchat, "translate"), [
      model,
      undefined,
    ]);
    assert.deepEqual(getTranslationCandidates("", paperchat, "translate"), [
      undefined,
      model,
    ]);
  });

  it("does not switch providers in automatic mode for external providers", function () {
    assert.deepEqual(
      getTranslationCandidates(
        "auto",
        { id: "deepseek", type: "openai-compatible" },
        "translate",
      ),
      [undefined],
    );
    assert.deepEqual(getTranslationCandidates("auto", paperchat), [undefined]);
  });

  it("keeps explicit selections and ignores invalid API defaults", function () {
    const selected = { providerId: "custom", model: "chosen" };
    assert.deepEqual(
      getTranslationCandidates(
        JSON.stringify(selected),
        paperchat,
        "translate",
      ),
      [selected],
    );
    assert.equal(
      parseModelRoutingDefaults({
        defaults: { translationModel: " translate " },
      }).translationModel,
      "translate",
    );
    assert.isUndefined(
      parseModelRoutingDefaults({ defaults: { translationModel: 1 } })
        .translationModel,
    );
  });
});
