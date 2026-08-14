import { assert } from "chai";
import {
  createPresentationDialogSelectOption,
  parsePresentationDialogSlideCount,
  PRESENTATION_CUSTOM_SLIDE_COUNT_OPTION,
  shouldShowPresentationCustomSlideCount,
} from "../src/modules/presentation/PresentationLaunchDialogs.ts";
import {
  DEFAULT_PRESENTATION_LAUNCH_SETTINGS,
  isPresentationPresetSlideCount,
  normalizePresentationLaunchSettings,
  normalizePresentationUserInstructions,
  parsePresentationSlideCount,
  PRESENTATION_MAXIMUM_SLIDE_COUNT,
  PRESENTATION_MINIMUM_SLIDE_COUNT,
  PRESENTATION_USER_INSTRUCTIONS_MAX_LENGTH,
  truncatePresentationUserInstructions,
} from "../src/modules/presentation/PresentationLaunchSettings.ts";

describe("presentation launch settings", function () {
  it("accepts preset and custom integer slide counts from 4 through 30", function () {
    for (const value of [4, 6, 8, 10, 15, 30]) {
      assert.equal(parsePresentationSlideCount(value), value);
      assert.equal(parsePresentationSlideCount(String(value)), value);
    }
    assert.equal(PRESENTATION_MINIMUM_SLIDE_COUNT, 4);
    assert.equal(PRESENTATION_MAXIMUM_SLIDE_COUNT, 30);
  });

  it("rejects out-of-range, fractional, empty, and non-numeric values", function () {
    for (const value of [3, 31, 8.5, "8.5", "", "   ", "eight", null]) {
      assert.isNull(parsePresentationSlideCount(value));
    }
  });

  it("distinguishes presets while preserving a saved custom default", function () {
    assert.isTrue(isPresentationPresetSlideCount(6));
    assert.isTrue(isPresentationPresetSlideCount(10));
    assert.isTrue(isPresentationPresetSlideCount(15));
    assert.isFalse(isPresentationPresetSlideCount(8));

    assert.deepEqual(
      normalizePresentationLaunchSettings({
        slideCount: 8,
        designSystem: "dark-editorial",
      }),
      {
        slideCount: 8,
        designSystem: "dark-editorial",
        userInstructions: "",
      },
    );
    assert.deepEqual(
      normalizePresentationLaunchSettings({
        slideCount: 31,
        designSystem: "invalid" as never,
      }),
      DEFAULT_PRESENTATION_LAUNCH_SETTINGS,
    );
  });

  it("trims and bounds one-time user requirements without persisting a default", function () {
    assert.equal(
      normalizePresentationUserInstructions("  Focus on ablations.  "),
      "Focus on ablations.",
    );
    assert.equal(normalizePresentationUserInstructions(null), "");
    const oversized = "x".repeat(
      PRESENTATION_USER_INSTRUCTIONS_MAX_LENGTH + 25,
    );
    const normalized = normalizePresentationLaunchSettings({
      userInstructions: oversized,
    });
    assert.lengthOf(
      normalized.userInstructions,
      PRESENTATION_USER_INSTRUCTIONS_MAX_LENGTH,
    );
    assert.equal(DEFAULT_PRESENTATION_LAUNCH_SETTINGS.userInstructions, "");
  });

  it("never cuts a Unicode surrogate pair at the instruction boundary", function () {
    const exact = `${"x".repeat(
      PRESENTATION_USER_INSTRUCTIONS_MAX_LENGTH - 2,
    )}😀`;
    assert.equal(truncatePresentationUserInstructions(exact), exact);

    const splitAtBoundary = `${"x".repeat(
      PRESENTATION_USER_INSTRUCTIONS_MAX_LENGTH - 1,
    )}😀`;
    const truncated = truncatePresentationUserInstructions(splitAtBoundary);
    assert.equal(
      truncated,
      "x".repeat(PRESENTATION_USER_INSTRUCTIONS_MAX_LENGTH - 1),
    );
    assert.notMatch(truncated, /[\uD800-\uDFFF]$/u);
  });

  it("uses the custom field only while custom length is selected", function () {
    assert.equal(
      parsePresentationDialogSlideCount(
        PRESENTATION_CUSTOM_SLIDE_COUNT_OPTION,
        "8",
      ),
      8,
    );
    assert.equal(parsePresentationDialogSlideCount("6", "30"), 6);
    assert.isTrue(
      shouldShowPresentationCustomSlideCount(
        PRESENTATION_CUSTOM_SLIDE_COUNT_OPTION,
      ),
    );
    assert.isFalse(shouldShowPresentationCustomSlideCount("6"));
    assert.isNull(
      parsePresentationDialogSlideCount(
        PRESENTATION_CUSTOM_SLIDE_COUNT_OPTION,
        "",
      ),
    );
    assert.equal(parsePresentationDialogSlideCount("6", "31"), 6);
  });

  it("stores option values where ztoolkit's Zotero menu adapter reads them", function () {
    const option = createPresentationDialogSelectOption(
      "custom",
      "Custom…",
      true,
    );

    assert.equal(option.properties?.value, "custom");
    assert.equal(option.properties?.textContent, "Custom…");
    assert.isTrue(option.properties?.selected);
    assert.notProperty(option, "attributes");
  });
});
