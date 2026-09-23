import { assert } from "chai";

describe("AnalyticsService helpers", function () {
  it("normalizeEventProps drops non-primitive values and returns undefined for empty objects", async function () {
    const { normalizeEventProps } =
      await import("../src/modules/analytics/AnalyticsService.ts");

    assert.isUndefined(normalizeEventProps());
    assert.isUndefined(normalizeEventProps({}));
    assert.isUndefined(
      normalizeEventProps({
        a: null,
        b: undefined,
        c: { nested: 1 } as unknown as string,
      }),
    );
    assert.deepEqual(normalizeEventProps({ a: "x", b: 1, c: false }), {
      a: "x",
      b: 1,
      c: false,
    });
    assert.deepEqual(
      normalizeEventProps({ a: "x", b: null, c: undefined, d: 2 }),
      { a: "x", d: 2 },
    );
  });

  it("createSessionId composes seconds and injected random suffix", async function () {
    const { createSessionId } =
      await import("../src/modules/analytics/AnalyticsService.ts");

    const id = createSessionId(
      () => 1_700_000_000_000,
      () => "12345678",
    );
    assert.equal(id, "170000000012345678");
  });
});
