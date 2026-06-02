import { assert } from "chai";
import type { TokenInfo } from "../src/types/auth";
import {
  PLUGIN_TOKEN_GROUP,
  PLUGIN_TOKEN_NAME,
  buildLegacyPluginTokenCreateRequest,
  buildPluginTokenCreateRequest,
  findActiveAutoPluginToken,
  findLegacyPluginToken,
  normalizePluginApiKey,
} from "../src/modules/auth/PluginToken.ts";

function token(overrides: Partial<TokenInfo>): TokenInfo {
  return {
    id: 1,
    user_id: 1,
    key: "masked",
    name: PLUGIN_TOKEN_NAME,
    status: 1,
    created_time: 1,
    accessed_time: 0,
    expired_time: -1,
    remain_quota: 0,
    unlimited_quota: true,
    used_quota: 0,
    model_limits_enabled: false,
    model_limits: "",
    allow_ips: "",
    group: "",
    ...overrides,
  };
}

describe("plugin token helpers", function () {
  it("builds PaperChat plugin tokens in the auto group", function () {
    assert.deepEqual(buildPluginTokenCreateRequest(), {
      name: PLUGIN_TOKEN_NAME,
      remain_quota: 0,
      remain_amount: 0,
      expired_time: -1,
      unlimited_quota: true,
      model_limits_enabled: false,
      model_limits: "",
      cross_group_retry: true,
      group: PLUGIN_TOKEN_GROUP,
      allow_ips: "",
    });
  });

  it("builds legacy plugin tokens with the old default-group payload", function () {
    assert.deepEqual(buildLegacyPluginTokenCreateRequest(), {
      name: PLUGIN_TOKEN_NAME,
      unlimited_quota: true,
      expired_time: -1,
    });
  });

  it("prefers the newest active auto plugin token", function () {
    const selected = findActiveAutoPluginToken([
      token({ id: 1, created_time: 10, group: PLUGIN_TOKEN_GROUP }),
      token({ id: 2, created_time: 20, group: "" }),
      token({ id: 3, created_time: 30, group: PLUGIN_TOKEN_GROUP, status: 2 }),
      token({ id: 4, created_time: 30, group: PLUGIN_TOKEN_GROUP }),
    ]);

    assert.equal(selected?.id, 4);
  });

  it("finds legacy plugin tokens without treating unrelated tokens as fallback", function () {
    const selected = findLegacyPluginToken([
      token({ id: 1, group: PLUGIN_TOKEN_GROUP }),
      token({ id: 2, name: "Manual Token", group: "" }),
      token({ id: 3, group: "", status: 2 }),
      token({ id: 4, group: "" }),
    ]);

    assert.equal(selected?.id, 4);
  });

  it("normalizes NewAPI token keys without double-prefixing", function () {
    assert.equal(normalizePluginApiKey("abc"), "sk-abc");
    assert.equal(normalizePluginApiKey("sk-abc"), "sk-abc");
  });
});
