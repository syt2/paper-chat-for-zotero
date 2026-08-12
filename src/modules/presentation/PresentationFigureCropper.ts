export interface PixelCrop {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CaptionGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FigureCropRefinementOptions {
  /**
   * PDF text-line geometry in rendered-canvas coordinates. Long, thin lines
   * are treated as body-copy evidence and penalized when selecting a figure.
   * Plot labels and diagram annotations remain allowed because they occupy a
   * small fraction of the candidate region.
   */
  textRegions?: CaptionGeometry[];
  preferNonText?: boolean;
}

function trimBodyTextFromRasterGutter(
  expanded: PixelCrop,
  imageGroup: PixelCrop,
  textRegions: readonly CaptionGeometry[],
  canvasWidth: number,
  canvasHeight: number,
): PixelCrop {
  const regions = textRegions
    .map((region) => clampCrop(region, canvasWidth, canvasHeight))
    .filter((region): region is PixelCrop => Boolean(region))
    .filter((region) => {
      const isBodyLine =
        region.height <= Math.max(28, canvasHeight * 0.024) &&
        region.width >= Math.max(80, imageGroup.width * 0.28);
      const touchesGutter = intersectionArea(region, expanded) > 0;
      const touchesImage = intersectionArea(region, imageGroup) > 0;
      return isBodyLine && touchesGutter && !touchesImage;
    });
  if (!regions.length) return expanded;

  // Keep a small optical gutter around the actual image XObject even when a
  // neighboring body line runs into the larger safety band. This removes the
  // narrow column-text fragments seen beside real paper figures without
  // sacrificing labels that are part of the image itself.
  const minimumXGutter = Math.max(3, Math.min(8, canvasWidth * 0.004));
  const minimumYGutter = Math.max(3, Math.min(8, canvasHeight * 0.004));
  let left = expanded.x;
  let top = expanded.y;
  let right = expanded.x + expanded.width;
  let bottom = expanded.y + expanded.height;

  for (const region of regions) {
    const regionRight = region.x + region.width;
    const regionBottom = region.y + region.height;
    if (regionRight <= imageGroup.x && regionRight > left) {
      left = Math.min(imageGroup.x - minimumXGutter, regionRight + 2);
    } else if (
      region.x >= imageGroup.x + imageGroup.width &&
      region.x < right
    ) {
      right = Math.max(
        imageGroup.x + imageGroup.width + minimumXGutter,
        region.x - 2,
      );
    }
    if (regionBottom <= imageGroup.y && regionBottom > top) {
      top = Math.min(imageGroup.y - minimumYGutter, regionBottom + 2);
    } else if (
      region.y >= imageGroup.y + imageGroup.height &&
      region.y < bottom
    ) {
      bottom = Math.max(
        imageGroup.y + imageGroup.height + minimumYGutter,
        region.y - 2,
      );
    }
  }

  return (
    clampCrop(
      { x: left, y: top, width: right - left, height: bottom - top },
      canvasWidth,
      canvasHeight,
    ) || expanded
  );
}

export interface PdfOperatorListLike {
  fnArray?: unknown[];
  argsArray?: unknown[];
}

export interface PdfViewportGeometry {
  width: number;
  height: number;
  transform?: unknown;
}

interface PixelCanvasLike {
  width: number;
  height: number;
  getContext(contextId: "2d"): {
    getImageData?: (
      x: number,
      y: number,
      width: number,
      height: number,
    ) => { data: Uint8ClampedArray };
  } | null;
}

type Transform = [number, number, number, number, number, number];

const PDF_OP_SAVE = 10;
const PDF_OP_RESTORE = 11;
const PDF_OP_TRANSFORM = 12;
const PDF_OP_FORM_BEGIN = 74;
const PDF_OP_FORM_END = 75;
const PDF_IMAGE_OPERATORS = new Set([83, 85, 86, 90]);
const PDF_OP_INLINE_IMAGE_GROUP = 87;
const PDF_OP_IMAGE_REPEAT = 88;

function numericTransform(value: unknown): Transform | null {
  if (!Array.isArray(value) || value.length < 6) return null;
  const values = value.slice(0, 6).map(Number);
  if (values.some((item) => !Number.isFinite(item))) return null;
  return values as Transform;
}

function multiplyTransforms(left: Transform, right: Transform): Transform {
  const [a1, b1, c1, d1, e1, f1] = left;
  const [a2, b2, c2, d2, e2, f2] = right;
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1,
  ];
}

function transformPoint(
  transform: Transform,
  x: number,
  y: number,
): [number, number] {
  return [
    transform[0] * x + transform[2] * y + transform[4],
    transform[1] * x + transform[3] * y + transform[5],
  ];
}

function boundsFromTransform(transform: Transform): PixelCrop {
  const points = [
    transformPoint(transform, 0, 0),
    transformPoint(transform, 1, 0),
    transformPoint(transform, 0, 1),
    transformPoint(transform, 1, 1),
  ];
  const xs = points.map((point) => point[0]);
  const ys = points.map((point) => point[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return {
    x,
    y,
    width: Math.max(...xs) - x,
    height: Math.max(...ys) - y,
  };
}

function clampCrop(
  crop: PixelCrop,
  canvasWidth: number,
  canvasHeight: number,
): PixelCrop | null {
  const left = Math.max(0, Math.min(canvasWidth, crop.x));
  const top = Math.max(0, Math.min(canvasHeight, crop.y));
  const right = Math.max(left, Math.min(canvasWidth, crop.x + crop.width));
  const bottom = Math.max(top, Math.min(canvasHeight, crop.y + crop.height));
  if (right - left < 2 || bottom - top < 2) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function argsAt(operatorList: PdfOperatorListLike, index: number): unknown[] {
  const value = operatorList.argsArray?.[index];
  return Array.isArray(value) ? value : [];
}

/**
 * Replays the small subset of PDF.js graphics-state operators required to
 * locate raster images on the already rendered page canvas. Vector figures
 * intentionally fall through to pixel-region analysis below.
 */
export function extractPaintedImageBounds(
  operatorList: PdfOperatorListLike,
  viewport: PdfViewportGeometry,
): PixelCrop[] {
  const viewportTransform = numericTransform(viewport.transform);
  if (!viewportTransform || !Array.isArray(operatorList.fnArray)) return [];

  let current = viewportTransform;
  const stack: Transform[] = [];
  const bounds: PixelCrop[] = [];

  const addBounds = (transform: Transform) => {
    const crop = clampCrop(
      boundsFromTransform(transform),
      viewport.width,
      viewport.height,
    );
    if (crop) bounds.push(crop);
  };

  operatorList.fnArray.forEach((rawOperator, index) => {
    const operator = Number(rawOperator);
    const args = argsAt(operatorList, index);
    if (operator === PDF_OP_SAVE) {
      stack.push([...current] as Transform);
      return;
    }
    if (operator === PDF_OP_RESTORE) {
      current = stack.pop() || current;
      return;
    }
    if (operator === PDF_OP_TRANSFORM) {
      const transform = numericTransform(args);
      if (transform) current = multiplyTransforms(current, transform);
      return;
    }
    if (operator === PDF_OP_FORM_BEGIN) {
      stack.push([...current] as Transform);
      const transform = numericTransform(args[0]);
      if (transform) current = multiplyTransforms(current, transform);
      return;
    }
    if (operator === PDF_OP_FORM_END) {
      current = stack.pop() || current;
      return;
    }
    if (PDF_IMAGE_OPERATORS.has(operator)) {
      addBounds(current);
      return;
    }
    if (operator === PDF_OP_IMAGE_REPEAT) {
      const scaleX = Number(args[1]);
      const scaleY = Number(args[2]);
      const positions = Array.isArray(args[3]) ? args[3].map(Number) : [];
      if (!Number.isFinite(scaleX) || !Number.isFinite(scaleY)) return;
      for (
        let positionIndex = 0;
        positionIndex < positions.length;
        positionIndex += 2
      ) {
        const x = positions[positionIndex];
        const y = positions[positionIndex + 1];
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        addBounds(multiplyTransforms(current, [scaleX, 0, 0, scaleY, x, y]));
      }
      return;
    }
    if (operator === PDF_OP_INLINE_IMAGE_GROUP) {
      const map = Array.isArray(args[1]) ? args[1] : [];
      for (const entry of map) {
        const transform = numericTransform(
          entry && typeof entry === "object"
            ? (entry as { transform?: unknown }).transform
            : undefined,
        );
        if (transform) addBounds(multiplyTransforms(current, transform));
      }
    }
  });

  return bounds;
}

function intersectionArea(left: PixelCrop, right: PixelCrop): number {
  const width = Math.max(
    0,
    Math.min(left.x + left.width, right.x + right.width) -
      Math.max(left.x, right.x),
  );
  const height = Math.max(
    0,
    Math.min(left.y + left.height, right.y + right.height) -
      Math.max(left.y, right.y),
  );
  return width * height;
}

function unionCrops(crops: PixelCrop[]): PixelCrop {
  const left = Math.min(...crops.map((crop) => crop.x));
  const top = Math.min(...crops.map((crop) => crop.y));
  const right = Math.max(...crops.map((crop) => crop.x + crop.width));
  const bottom = Math.max(...crops.map((crop) => crop.y + crop.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function cropGap(left: PixelCrop, right: PixelCrop): [number, number] {
  const horizontal = Math.max(
    0,
    Math.max(left.x, right.x) -
      Math.min(left.x + left.width, right.x + right.width),
  );
  const vertical = Math.max(
    0,
    Math.max(left.y, right.y) -
      Math.min(left.y + left.height, right.y + right.height),
  );
  return [horizontal, vertical];
}

function groupNearbyCrops(
  crops: PixelCrop[],
  gapX: number,
  gapY: number,
): PixelCrop[] {
  const remaining = [...crops];
  const groups: PixelCrop[] = [];
  while (remaining.length) {
    const members = [remaining.shift() as PixelCrop];
    let changed = true;
    while (changed) {
      changed = false;
      const aggregate = unionCrops(members);
      for (let index = remaining.length - 1; index >= 0; index--) {
        const [horizontal, vertical] = cropGap(aggregate, remaining[index]);
        if (horizontal <= gapX && vertical <= gapY) {
          members.push(remaining.splice(index, 1)[0]);
          changed = true;
        }
      }
    }
    groups.push(unionCrops(members));
  }
  return groups;
}

function expandCrop(
  crop: PixelCrop,
  canvasWidth: number,
  canvasHeight: number,
  paddingX: number,
  paddingY: number,
  maximumBottom = canvasHeight,
): PixelCrop | null {
  return clampCrop(
    {
      x: crop.x - paddingX,
      y: crop.y - paddingY,
      width: crop.width + paddingX * 2,
      height:
        Math.min(maximumBottom, crop.y + crop.height + paddingY) -
        (crop.y - paddingY),
    },
    canvasWidth,
    canvasHeight,
  );
}

/** Selects the image-object group most plausibly associated with a caption. */
export function selectRasterFigureCrop(
  imageBounds: PixelCrop[],
  candidate: PixelCrop,
  caption: CaptionGeometry,
  canvasWidth: number,
  canvasHeight: number,
  options: FigureCropRefinementOptions = {},
): PixelCrop | null {
  const pageArea = Math.max(1, canvasWidth * canvasHeight);
  const plausible = imageBounds.filter((bound) => {
    const area = bound.width * bound.height;
    const overlap = intersectionArea(bound, candidate) / Math.max(1, area);
    const bottom = bound.y + bound.height;
    return (
      area / pageArea >= 0.0012 &&
      overlap >= 0.24 &&
      bound.y < caption.y &&
      bottom <= caption.y + caption.height * 0.8
    );
  });
  if (!plausible.length) return null;

  const groups = groupNearbyCrops(
    plausible,
    Math.max(12, canvasWidth * 0.018),
    Math.max(12, canvasHeight * 0.018),
  );
  const maximumDistance = Math.max(80, candidate.height * 0.72);
  const ranked = groups
    .map((group) => {
      const area = group.width * group.height;
      const overlap = intersectionArea(group, candidate) / Math.max(1, area);
      const distance = Math.max(0, caption.y - (group.y + group.height));
      const closeness = 1 - Math.min(1, distance / maximumDistance);
      const size = Math.min(1, area / pageArea / 0.12);
      const width = Math.min(1, group.width / Math.max(1, candidate.width));
      return {
        group,
        distance,
        score: closeness * 2.4 + size + width + overlap,
      };
    })
    .filter((item) => item.distance <= maximumDistance)
    .sort((left, right) => right.score - left.score);
  if (!ranked.length) return null;

  const expanded = expandCrop(
    ranked[0].group,
    canvasWidth,
    canvasHeight,
    // PDF image XObjects often contain only the plot bitmap while tick labels,
    // axis titles, and small diagram annotations are separate text/vector
    // objects. A one-percent gutter clipped those labels on real papers. Keep
    // a conservative page-relative safety band while still stopping above the
    // anchored caption below.
    Math.max(10, canvasWidth * 0.022),
    Math.max(10, canvasHeight * 0.018),
    caption.y - Math.max(2, caption.height * 0.3),
  );
  if (!expanded || !options.preferNonText || !options.textRegions?.length) {
    return expanded;
  }
  return trimBodyTextFromRasterGutter(
    expanded,
    ranked[0].group,
    options.textRegions,
    canvasWidth,
    canvasHeight,
  );
}

interface RowSegment {
  start: number;
  end: number;
  minX: number;
  maxX: number;
  ink: number;
  sampledRows: number;
}

/**
 * Finds the closest substantial non-white band above a caption. This handles
 * vector diagrams, plots, and tables that do not appear as PDF image XObjects.
 */
export function refineFigureCropFromPixels(
  canvas: PixelCanvasLike,
  candidate: PixelCrop,
  options: FigureCropRefinementOptions = {},
): PixelCrop | null {
  const safeCandidate = clampCrop(candidate, canvas.width, canvas.height);
  if (!safeCandidate) return null;
  const context = canvas.getContext("2d");
  if (!context?.getImageData) return null;

  const x = Math.floor(safeCandidate.x);
  const y = Math.floor(safeCandidate.y);
  const width = Math.max(1, Math.floor(safeCandidate.width));
  const height = Math.max(1, Math.floor(safeCandidate.height));
  let data: Uint8ClampedArray;
  try {
    data = context.getImageData(x, y, width, height).data;
  } catch {
    return null;
  }

  const step = Math.max(1, Math.round(Math.max(width, height) / 650));
  const sampledColumns = Math.ceil(width / step);
  const activeThreshold = Math.max(2, Math.floor(sampledColumns * 0.004));
  const maximumGap = Math.max(1, Math.round(10 / step));
  const textRegions = (options.textRegions || [])
    .map((region) => clampCrop(region, canvas.width, canvas.height))
    .filter((region): region is PixelCrop => Boolean(region));
  const bodyTextMasks = options.preferNonText
    ? textRegions.filter((region) => {
        const thinLine = region.height <= Math.max(28, canvas.height * 0.024);
        const substantialWidth =
          region.width >= Math.max(80, safeCandidate.width * 0.24);
        return (
          thinLine &&
          substantialWidth &&
          intersectionArea(region, safeCandidate) > 0
        );
      })
    : [];
  const segments: RowSegment[] = [];
  let current: RowSegment | null = null;
  let inactiveRows = 0;

  for (let row = 0; row < height; row += step) {
    let ink = 0;
    let minX = width;
    let maxX = 0;
    for (let column = 0; column < width; column += step) {
      const absoluteX = x + column;
      const absoluteY = y + row;
      if (
        bodyTextMasks.some(
          (region) =>
            absoluteX >= region.x &&
            absoluteX <= region.x + region.width &&
            absoluteY >= region.y &&
            absoluteY <= region.y + region.height,
        )
      ) {
        continue;
      }
      const offset = (row * width + column) * 4;
      const alpha = data[offset + 3];
      const red = data[offset];
      const green = data[offset + 1];
      const blue = data[offset + 2];
      if (
        alpha > 12 &&
        (red < 242 || green < 242 || blue < 242) &&
        red + green + blue < 724
      ) {
        ink += 1;
        minX = Math.min(minX, column);
        maxX = Math.max(maxX, column + step);
      }
    }

    if (ink >= activeThreshold) {
      if (!current) {
        current = {
          start: row,
          end: row + step,
          minX,
          maxX,
          ink,
          sampledRows: 1,
        };
      } else {
        current.end = row + step;
        current.minX = Math.min(current.minX, minX);
        current.maxX = Math.max(current.maxX, maxX);
        current.ink += ink;
        current.sampledRows += 1;
      }
      inactiveRows = 0;
    } else if (current) {
      inactiveRows += 1;
      if (inactiveRows > maximumGap) {
        current.end = Math.max(
          current.start + step,
          current.end - maximumGap * step,
        );
        segments.push(current);
        current = null;
        inactiveRows = 0;
      }
    }
  }
  if (current) segments.push(current);

  const minimumHeight = Math.max(24, height * 0.035);
  const minimumWidth = Math.max(42, width * 0.18);
  const ranked = segments
    .map((segment) => {
      const segmentHeight = segment.end - segment.start;
      const segmentWidth = segment.maxX - segment.minX;
      const absoluteCrop: PixelCrop = {
        x: x + segment.minX,
        y: y + segment.start,
        width: segmentWidth,
        height: segmentHeight,
      };
      const heightFraction = segmentHeight / height;
      const widthFraction = segmentWidth / width;
      const distance = Math.max(0, height - segment.end);
      const closeness = 1 - Math.min(1, distance / Math.max(1, height * 0.62));
      const density =
        segment.ink / Math.max(1, segment.sampledRows * sampledColumns);
      const bodyTextRegions = textRegions.filter((region) => {
        const thinLine = region.height <= Math.max(28, canvas.height * 0.024);
        const substantialWidth =
          region.width >= Math.max(80, absoluteCrop.width * 0.2);
        return (
          thinLine &&
          substantialWidth &&
          intersectionArea(region, absoluteCrop) > 0
        );
      });
      const textOverlap = bodyTextRegions.reduce(
        (total, region) => total + intersectionArea(region, absoluteCrop),
        0,
      );
      const textCoverage =
        textOverlap / Math.max(1, absoluteCrop.width * absoluteCrop.height);
      const textPenalty = options.preferNonText
        ? Math.min(
            4.8,
            bodyTextRegions.length * 0.38 + Math.min(3.2, textCoverage * 18),
          )
        : 0;
      const score =
        heightFraction * 2.8 +
        widthFraction * 2.2 +
        closeness * 2.2 +
        Math.min(1, density / 0.08) * 0.55 -
        textPenalty;
      return {
        segment,
        segmentHeight,
        segmentWidth,
        bodyTextLines: bodyTextRegions.length,
        score,
      };
    })
    .filter(
      (item) =>
        item.segmentHeight >= minimumHeight &&
        item.segmentWidth >= minimumWidth &&
        (!options.preferNonText || item.bodyTextLines <= 10),
    )
    .sort((left, right) => right.score - left.score);
  if (!ranked.length) return null;

  const selected = ranked[0].segment;
  return expandCrop(
    {
      x: x + selected.minX,
      y: y + selected.start,
      width: selected.maxX - selected.minX,
      height: selected.end - selected.start,
    },
    canvas.width,
    canvas.height,
    // Pixel segmentation finds the visible ink, not the optical boundary of a
    // chart. Preserve labels that sit just outside the detected band instead
    // of making a technically tight but presentation-unsafe crop.
    Math.max(10, width * 0.026),
    Math.max(10, height * 0.022),
    safeCandidate.y + safeCandidate.height,
  );
}
