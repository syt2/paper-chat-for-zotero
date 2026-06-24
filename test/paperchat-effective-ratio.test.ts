import { assert } from "chai";
import { getEffectivePricingModelRatio } from "../src/modules/preferences/paperchat-effective-ratio.ts";

describe("paperchat effective pricing ratio", function () {
  it("prefers enabled auto groups and picks the lowest group ratio", function () {
    const ratio = getEffectivePricingModelRatio(
      {
        model_name: "gpt-5.4",
        model_ratio: 2,
        enable_groups: ["default", "gpt-discount", "premium"],
      },
      {
        autoGroups: ["premium", "gpt-discount"],
        usableGroup: {
          default: "Default",
          "gpt-discount": "GPT discount",
          premium: "Premium",
        },
        groupRatio: {
          default: 1,
          "gpt-discount": 0.5,
          premium: 0.8,
        },
      },
    );

    assert.equal(ratio, 1);
  });

  it("falls back to enabled usable groups when no auto group matches", function () {
    const ratio = getEffectivePricingModelRatio(
      {
        model_name: "deepseek-v4-pro",
        model_ratio: 2,
        enable_groups: ["default", "vip"],
      },
      {
        autoGroups: ["other"],
        usableGroup: {
          default: "Default",
          vip: "VIP",
        },
        groupRatio: {
          default: 1,
          vip: 0.7,
        },
      },
    );

    assert.equal(ratio, 1.4);
  });

  it("expands all-enabled models to usable groups", function () {
    const ratio = getEffectivePricingModelRatio(
      {
        model_name: "gemini-3.5-flash",
        model_ratio: 1.25,
        enable_groups: ["all"],
      },
      {
        autoGroups: ["standard"],
        usableGroup: {
          default: "Default",
          standard: "Standard",
          expensive: "Expensive",
        },
        groupRatio: {
          default: 1,
          standard: 0.6,
          expensive: 1.5,
        },
      },
    );

    assert.equal(ratio, 0.75);
  });

  it("keeps the raw model ratio when there is no usable group match", function () {
    const ratio = getEffectivePricingModelRatio(
      {
        model_name: "gpt-5.5",
        model_ratio: 3,
        enable_groups: ["pro"],
      },
      {
        autoGroups: ["auto"],
        usableGroup: {
          default: "Default",
        },
        groupRatio: {
          default: 1,
        },
      },
    );

    assert.equal(ratio, 3);
  });

  it("accepts NewAPI-compatible string ratios", function () {
    const ratio = getEffectivePricingModelRatio(
      {
        ModelName: "GLM-5.1",
        ModelRatio: "1.2",
        EnableGroup: ["default", "cheap"],
      },
      {
        autoGroups: ["cheap"],
        usableGroup: {
          default: "Default",
          cheap: "Cheap",
        },
        groupRatio: {
          default: "1",
          cheap: "0.3333",
        },
      },
    );

    assert.equal(ratio, 0.4);
  });
});
