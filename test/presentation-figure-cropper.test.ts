import { assert } from "chai";
import {
  extractPaintedImageBounds,
  refineFigureCropFromPixels,
  selectRasterFigureCrop,
} from "../src/modules/presentation/PresentationFigureCropper.ts";

describe("presentation figure cropper", function () {
  it("locates raster image XObjects by replaying the PDF graphics transform", function () {
    const bounds = extractPaintedImageBounds(
      {
        fnArray: [10, 12, 85, 11],
        argsArray: [[], [50, 0, 0, 30, 100, 500], ["img-1"], []],
      },
      {
        width: 1_200,
        height: 1_600,
        transform: [2, 0, 0, -2, 0, 1_600],
      },
    );

    assert.lengthOf(bounds, 1);
    assert.closeTo(bounds[0].x, 200, 0.01);
    assert.closeTo(bounds[0].y, 540, 0.01);
    assert.closeTo(bounds[0].width, 100, 0.01);
    assert.closeTo(bounds[0].height, 60, 0.01);
  });

  it("selects the image group immediately above the matching caption", function () {
    const crop = selectRasterFigureCrop(
      [
        { x: 170, y: 170, width: 220, height: 100 },
        { x: 200, y: 540, width: 100, height: 60 },
      ],
      { x: 54, y: 88, width: 546, height: 540 },
      { x: 80, y: 650, width: 420, height: 22 },
      1_200,
      1_600,
    );

    assert.isNotNull(crop);
    assert.isAbove(crop?.y || 0, 500);
    assert.isBelow((crop?.y || 0) + (crop?.height || 0), 650);
    assert.isAtLeast(crop?.width || 0, 150);
    assert.isAtLeast(crop?.height || 0, 110);
    assert.isBelow(crop?.height || 0, 140);
  });

  it("keeps a safety gutter around raster plots so axis labels are not clipped", function () {
    const crop = selectRasterFigureCrop(
      [{ x: 220, y: 410, width: 430, height: 220 }],
      { x: 150, y: 330, width: 600, height: 360 },
      { x: 160, y: 700, width: 560, height: 24 },
      1_200,
      1_600,
    );

    assert.isNotNull(crop);
    assert.isAtMost(crop?.x || Number.MAX_SAFE_INTEGER, 194);
    assert.isAtMost(crop?.y || Number.MAX_SAFE_INTEGER, 382);
    assert.isAtLeast((crop?.x || 0) + (crop?.width || 0), 676);
    assert.isAtLeast((crop?.y || 0) + (crop?.height || 0), 658);
  });

  it("trims a neighboring body-text fragment from a raster figure gutter", function () {
    const crop = selectRasterFigureCrop(
      [{ x: 520, y: 440, width: 360, height: 170 }],
      { x: 470, y: 360, width: 460, height: 300 },
      { x: 500, y: 680, width: 420, height: 22 },
      1_200,
      1_600,
      {
        preferNonText: true,
        textRegions: [
          // The final few pixels of a long left-column body line enter the
          // default 26px image safety gutter, but never touch the image.
          { x: 80, y: 518, width: 428, height: 10 },
          // A short image-side label should not be treated as body copy.
          { x: 510, y: 565, width: 42, height: 9 },
        ],
      },
    );

    assert.isNotNull(crop);
    assert.isAtLeast(crop?.x || 0, 510);
    assert.isAtMost(crop?.x || Number.MAX_SAFE_INTEGER, 517);
    assert.isAtLeast((crop?.x || 0) + (crop?.width || 0), 904);
  });

  it("finds a substantial vector-figure band without keeping the page text above it", function () {
    const width = 480;
    const height = 500;
    const pixels = new Uint8ClampedArray(width * height * 4);
    pixels.fill(255);
    const paint = (
      left: number,
      top: number,
      right: number,
      bottom: number,
    ) => {
      for (let y = top; y < bottom; y++) {
        for (let x = left; x < right; x++) {
          const offset = (y * width + x) * 4;
          pixels[offset] = 20;
          pixels[offset + 1] = 20;
          pixels[offset + 2] = 20;
          pixels[offset + 3] = 255;
        }
      }
    };
    paint(40, 35, 410, 43); // unrelated body line above the figure
    paint(82, 245, 402, 405); // representative vector/raster evidence band

    const crop = refineFigureCropFromPixels(
      {
        width: 600,
        height: 800,
        getContext: () => ({
          getImageData: () => ({ data: pixels }),
        }),
      },
      { x: 60, y: 100, width, height },
    );

    assert.isNotNull(crop);
    assert.isAbove(crop?.y || 0, 320);
    assert.isBelow(crop?.y || 0, 350);
    assert.isAbove(crop?.width || 0, 320);
    assert.isBelow(crop?.height || 0, 200);
  });

  it("rejects a dense body-text band in favor of a compact research figure", function () {
    const width = 520;
    const height = 560;
    const pixels = new Uint8ClampedArray(width * height * 4);
    pixels.fill(255);
    const paint = (
      left: number,
      top: number,
      right: number,
      bottom: number,
    ) => {
      for (let y = top; y < bottom; y++) {
        for (let x = left; x < right; x++) {
          const offset = (y * width + x) * 4;
          pixels[offset] = 25;
          pixels[offset + 1] = 25;
          pixels[offset + 2] = 25;
          pixels[offset + 3] = 255;
        }
      }
    };

    const textRegions = Array.from({ length: 11 }, (_, index) => {
      const top = 34 + index * 18;
      paint(28, top, 480, top + 6);
      return { x: 88, y: 134 + top, width: 452, height: 6 };
    });
    paint(210, 330, 474, 444);

    const crop = refineFigureCropFromPixels(
      {
        width: 700,
        height: 900,
        getContext: () => ({
          getImageData: () => ({ data: pixels }),
        }),
      },
      { x: 60, y: 100, width, height },
      { textRegions, preferNonText: true },
    );

    assert.isNotNull(crop);
    assert.isAbove(crop?.y || 0, 410);
    assert.isBelow(crop?.height || Number.MAX_SAFE_INTEGER, 180);
  });

  it("masks PDF body-text geometry before grouping a nearby figure band", function () {
    const width = 500;
    const height = 460;
    const pixels = new Uint8ClampedArray(width * height * 4);
    pixels.fill(255);
    const paint = (
      left: number,
      top: number,
      right: number,
      bottom: number,
    ) => {
      for (let y = top; y < bottom; y++) {
        for (let x = left; x < right; x++) {
          const offset = (y * width + x) * 4;
          pixels[offset] = 24;
          pixels[offset + 1] = 24;
          pixels[offset + 2] = 24;
          pixels[offset + 3] = 255;
        }
      }
    };

    const textRegions = Array.from({ length: 15 }, (_, index) => {
      const top = 25 + index * 10;
      paint(18, top, 472, top + 6);
      return { x: 78, y: 125 + top, width: 454, height: 6 };
    });
    paint(170, 184, 455, 332);

    const crop = refineFigureCropFromPixels(
      {
        width: 660,
        height: 760,
        getContext: () => ({
          getImageData: () => ({ data: pixels }),
        }),
      },
      { x: 60, y: 100, width, height },
      { textRegions, preferNonText: true },
    );

    assert.isNotNull(crop);
    assert.isAbove(crop?.y || 0, 270);
    assert.isBelow(crop?.height || Number.MAX_SAFE_INTEGER, 190);
  });
});
