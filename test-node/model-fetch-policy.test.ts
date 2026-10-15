import { assert } from "chai";
import {
  shouldAutoFetchModels,
  type ModelFetchAttempt,
  type ModelFetchPolicyInput,
} from "../src/modules/preferences/model-fetch-policy";

const CREDENTIALS = "sk-test\nhttps://api.example.com/v1";

function policy(overrides: Partial<ModelFetchPolicyInput> = {}): boolean {
  return shouldAutoFetchModels({
    trigger: "blur",
    credentials: CREDENTIALS,
    hasApiKey: true,
    hasBaseUrl: true,
    modelCount: 0,
    attempt: undefined,
    ...overrides,
  });
}

describe("model fetch policy", function () {
  it("waits for a key and a Base URL before asking a provider", function () {
    assert.isFalse(policy({ hasApiKey: false }));
    assert.isFalse(policy({ hasBaseUrl: false }));
    assert.isFalse(policy({ hasApiKey: false, hasBaseUrl: false }));
  });

  it("fetches credentials it has never tried", function () {
    assert.isTrue(policy({ trigger: "paste" }));
    assert.isTrue(policy({ trigger: "blur" }));
    assert.isTrue(policy({ trigger: "open", modelCount: 0 }));
  });

  it("only fills an empty list when a panel is opened", function () {
    assert.isFalse(policy({ trigger: "open", modelCount: 12 }));
  });

  it("does not repeat a request for the same credentials", function () {
    for (const status of [
      "running",
      "loaded",
      "empty",
      "unsupported",
    ] as const) {
      const attempt: ModelFetchAttempt = { credentials: CREDENTIALS, status };
      for (const trigger of ["paste", "blur", "open"] as const) {
        assert.isFalse(
          policy({ attempt, trigger }),
          `${trigger} with status ${status}`,
        );
      }
    }
  });

  it("treats an edit as new credentials worth a request", function () {
    const attempt: ModelFetchAttempt = {
      credentials: "sk-old\nhttps://api.example.com/v1",
      status: "loaded",
    };
    assert.isTrue(policy({ attempt, trigger: "blur" }));
    assert.isTrue(policy({ attempt, trigger: "paste" }));
    assert.isTrue(policy({ attempt, trigger: "open", modelCount: 3 }));
  });

  it("retries a failure on the next edit, but not on a panel open", function () {
    const attempt: ModelFetchAttempt = {
      credentials: CREDENTIALS,
      status: "failed",
    };
    assert.isTrue(policy({ attempt, trigger: "blur" }));
    assert.isTrue(policy({ attempt, trigger: "paste" }));
    assert.isFalse(policy({ attempt, trigger: "open" }));
  });

  it("leaves a listed provider alone after a failed refresh", function () {
    const attempt: ModelFetchAttempt = {
      credentials: CREDENTIALS,
      status: "failed",
    };
    assert.isFalse(policy({ attempt, trigger: "blur", modelCount: 4 }));
  });
});
