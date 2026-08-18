import { raceWithAbort, throwIfAborted } from "../../../utils/abort";

const SLIDE_WIDTH_INCHES = 13.333;
const SLIDE_HEIGHT_INCHES = 7.5;
const PREVIEW_WIDTH = 1600;
const PREVIEW_HEIGHT = 900;
const EMU_PER_INCH = 914400;

type UnknownRecord = Record<string, unknown>;

interface PreviewTextRun {
  text: string;
  options: UnknownRecord;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): UnknownRecord {
  return isRecord(value) ? value : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asNumber(value: unknown, fallback: number = 0): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function asString(value: unknown, fallback: string = ""): string {
  return typeof value === "string" ? value : fallback;
}

function toInches(value: unknown): number {
  const number = asNumber(value);
  return Math.abs(number) > 1000 ? number / EMU_PER_INCH : number;
}

function toPixels(value: unknown, axis: "x" | "y"): number {
  const inches = toInches(value);
  return (
    inches *
    (axis === "x"
      ? PREVIEW_WIDTH / SLIDE_WIDTH_INCHES
      : PREVIEW_HEIGHT / SLIDE_HEIGHT_INCHES)
  );
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function normalizeColor(value: unknown, fallback: string): string {
  const color = asString(value)
    .replace(/^#/, "")
    .replace(/[^0-9a-f]/gi, "");
  return color.length === 6 ? `#${color}` : fallback;
}

function colorWithTransparency(
  value: unknown,
  transparency: unknown,
  fallback: string,
): { color: string; opacity: number } {
  return {
    color: normalizeColor(value, fallback),
    opacity: Math.max(0, Math.min(1, 1 - asNumber(transparency) / 100)),
  };
}

function estimateCharacterWidth(character: string, fontSize: number): number {
  if (character === "\u2060") return 0;
  if (/\s/.test(character)) return fontSize * 0.3;
  if (/[\u2E80-\u9FFF\uF900-\uFAFF]/.test(character)) return fontSize;
  if (/[A-Z0-9]/.test(character)) return fontSize * 0.62;
  return fontSize * 0.52;
}

function wrapText(value: string, maxWidth: number, fontSize: number): string[] {
  const explicitLines = value.replace(/\r/g, "").split("\n");
  const lines: string[] = [];
  for (const explicitLine of explicitLines) {
    if (!explicitLine) {
      lines.push("");
      continue;
    }
    let line = "";
    let lineWidth = 0;
    for (const character of explicitLine) {
      const characterWidth = estimateCharacterWidth(character, fontSize);
      if (line && lineWidth + characterWidth > maxWidth) {
        lines.push(line.trimEnd());
        line = character.trimStart();
        lineWidth = estimateCharacterWidth(line, fontSize);
      } else {
        line += character;
        lineWidth += characterWidth;
      }
    }
    if (line || lines.length === 0) lines.push(line.trimEnd());
  }
  return lines;
}

function normalizeMargin(value: unknown): [number, number, number, number] {
  if (typeof value === "number") {
    return [value, value, value, value];
  }
  const margins = asArray(value).map((entry) => asNumber(entry));
  if (margins.length === 4) {
    return margins as [number, number, number, number];
  }
  return [0.05, 0.1, 0.05, 0.1];
}

function extractTextRuns(object: UnknownRecord): PreviewTextRun[] {
  const objectOptions = asRecord(object.options);
  if (typeof object.text === "string") {
    return [{ text: object.text, options: objectOptions }];
  }
  return asArray(object.text)
    .map((entry) => {
      const run = asRecord(entry);
      return {
        text: asString(run.text),
        options: { ...objectOptions, ...asRecord(run.options) },
      };
    })
    .filter((run) => run.text.length > 0);
}

function renderShape(object: UnknownRecord): string {
  const options = asRecord(object.options);
  const x = toPixels(options.x, "x");
  const y = toPixels(options.y, "y");
  const width = toPixels(options.w, "x");
  const height = toPixels(options.h, "y");
  const fill = asRecord(options.fill);
  const line = asRecord(options.line);
  const fillStyle = colorWithTransparency(
    fill.color,
    fill.transparency,
    "transparent",
  );
  const strokeStyle = colorWithTransparency(
    line.color,
    line.transparency,
    "transparent",
  );
  const strokeWidth = Math.max(0, asNumber(line.width, 0.75) * 1.6);
  const common = `fill="${fillStyle.color}" fill-opacity="${fillStyle.opacity}" stroke="${strokeStyle.color}" stroke-opacity="${strokeStyle.opacity}" stroke-width="${strokeWidth}"`;
  const shape = asString(object.shape || options.shape, "rect");
  if (shape === "line") {
    const dash = asString(line.dashType).includes("dash")
      ? ' stroke-dasharray="8 6"'
      : "";
    return `<line x1="${x}" y1="${y}" x2="${x + width}" y2="${y + height}" ${common}${dash}/>`;
  }
  if (shape === "ellipse") {
    return `<ellipse cx="${x + width / 2}" cy="${y + height / 2}" rx="${Math.abs(width / 2)}" ry="${Math.abs(height / 2)}" ${common}/>`;
  }
  if (shape === "diamond") {
    return `<polygon points="${x + width / 2},${y} ${x + width},${y + height / 2} ${x + width / 2},${y + height} ${x},${y + height / 2}" ${common}/>`;
  }
  const radius = shape === "roundRect" ? Math.min(width, height) * 0.12 : 0;
  return `<rect x="${x}" y="${y}" width="${Math.max(0, width)}" height="${Math.max(0, height)}" rx="${radius}" ry="${radius}" ${common}/>`;
}

function renderText(object: UnknownRecord): string {
  const runs = extractTextRuns(object);
  if (runs.length === 0) return "";
  const options = asRecord(object.options);
  const firstOptions = runs[0].options;
  const x = toPixels(options.x, "x");
  const y = toPixels(options.y, "y");
  const width = Math.max(1, toPixels(options.w, "x"));
  const height = Math.max(1, toPixels(options.h, "y"));
  const margins = normalizeMargin(options.margin);
  const left = x + toPixels(margins[3], "x");
  const right = x + width - toPixels(margins[1], "x");
  const top = y + toPixels(margins[0], "y");
  const bottom = y + height - toPixels(margins[2], "y");
  const fontSize = Math.max(
    8,
    asNumber(firstOptions.fontSize || options.fontSize, 18) *
      (PREVIEW_WIDTH / SLIDE_WIDTH_INCHES / 72),
  );
  const fontFamily = escapeXml(
    asString(firstOptions.fontFace || options.fontFace, "Arial"),
  );
  const color = normalizeColor(firstOptions.color || options.color, "#111827");
  const bold = Boolean(firstOptions.bold || options.bold);
  const italic = Boolean(firstOptions.italic || options.italic);
  const align = asString(firstOptions.align || options.align, "left");
  const anchor =
    align === "center" ? "middle" : align === "right" ? "end" : "start";
  const textX =
    align === "center" ? (left + right) / 2 : align === "right" ? right : left;
  const combined = runs
    .map((run) => {
      const bullet = asRecord(run.options.bullet);
      const prefix =
        run.options.bullet || Object.keys(bullet).length ? "• " : "";
      return `${prefix}${run.text}${run.options.breakLine ? "\n" : ""}`;
    })
    .join("");
  const lines = wrapText(combined, Math.max(1, right - left), fontSize);
  const lineHeight =
    fontSize * asNumber(options.breakLine === false ? 1.05 : 1.16);
  const totalHeight = Math.max(lineHeight, lines.length * lineHeight);
  const verticalAnchor = asString(
    firstOptions.valign || options.valign || asRecord(options._bodyProp).anchor,
    "top",
  );
  const firstBaseline =
    verticalAnchor === "mid" || verticalAnchor === "ctr"
      ? top + Math.max(0, (bottom - top - totalHeight) / 2) + fontSize
      : verticalAnchor === "bottom" || verticalAnchor === "b"
        ? bottom - totalHeight + fontSize
        : top + fontSize;
  const rotate = asNumber(options.rotate);
  const transform = rotate
    ? ` transform="rotate(${rotate} ${x + width / 2} ${y + height / 2})"`
    : "";
  return `<text x="${textX}" y="${firstBaseline}" text-anchor="${anchor}" font-family="${fontFamily}" font-size="${fontSize}" font-weight="${bold ? 700 : 400}" font-style="${italic ? "italic" : "normal"}" fill="${color}"${transform}>${lines
    .map(
      (line, index) =>
        `<tspan x="${textX}" dy="${index === 0 ? 0 : lineHeight}">${escapeXml(line)}</tspan>`,
    )
    .join("")}</text>`;
}

function renderImage(object: UnknownRecord, slide: UnknownRecord): string {
  const options = asRecord(object.options);
  const relation = asArray(slide._relsMedia)
    .map(asRecord)
    .find((candidate) => candidate.rId === object.imageRid);
  const href = relation ? asString(relation.data) : "";
  if (!href) return "";
  const x = toPixels(options.x, "x");
  const y = toPixels(options.y, "y");
  const sizing = asRecord(options.sizing);
  const sizingType = asString(sizing.type);
  // PptxGenJS seeds cover images with their natural dimensions, then replaces
  // the OOXML picture extent with sizing.w / sizing.h. Using options.w / h in
  // the preview therefore makes a cropped figure appear several times larger
  // than the actual PowerPoint object and can trigger false overflow failures.
  const width = toPixels(sizingType ? sizing.w || options.w : options.w, "x");
  const height = toPixels(sizingType ? sizing.h || options.h : options.h, "y");
  const opacity = Math.max(
    0,
    Math.min(1, 1 - asNumber(options.transparency) / 100),
  );
  const preserveAspectRatio =
    sizingType === "cover"
      ? "xMidYMid slice"
      : sizingType === "contain"
        ? "xMidYMid meet"
        : "none";
  return `<image href="${escapeXml(href)}" x="${x}" y="${y}" width="${width}" height="${height}" preserveAspectRatio="${preserveAspectRatio}" opacity="${opacity}"/>`;
}

function renderChart(object: UnknownRecord, slide: UnknownRecord): string {
  const relation = asArray(slide._relsChart)
    .map(asRecord)
    .find((candidate) => candidate.rId === object.chartRid);
  if (!relation) return "";
  const options = { ...asRecord(relation.opts), ...asRecord(object.options) };
  const x = toPixels(options.x, "x");
  const y = toPixels(options.y, "y");
  const width = Math.max(1, toPixels(options.w, "x"));
  const height = Math.max(1, toPixels(options.h, "y"));
  const series = asArray(relation.data).map(asRecord);
  const labels = asArray(series[0]?.labels).flat().map(String);
  const values = series.flatMap((entry) => asArray(entry.values).map(Number));
  const maximum = Math.max(1, ...values.map((value) => Math.abs(value)));
  const colors = asArray(options.chartColors).map(String);
  const horizontal = asString(options.barDir) === "bar";
  const elements = [
    `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="#ffffff"/>`,
  ];
  if (asString(relation.type) === "line") {
    const points = values.map((value, index) => {
      const px =
        x + 42 + (index / Math.max(1, values.length - 1)) * (width - 70);
      const py = y + height - 30 - (value / maximum) * (height - 60);
      return `${px},${py}`;
    });
    elements.push(
      `<polyline points="${points.join(" ")}" fill="none" stroke="${normalizeColor(colors[0], "#009b84")}" stroke-width="4"/>`,
    );
  } else {
    const count = Math.max(1, values.length);
    values.forEach((value, index) => {
      const color = normalizeColor(
        colors[index % Math.max(1, colors.length)],
        "#009b84",
      );
      if (horizontal) {
        const rowHeight = (height - 30) / count;
        const barHeight = rowHeight * 0.52;
        const barWidth = (Math.abs(value) / maximum) * (width - 150);
        const barY = y + 14 + index * rowHeight;
        elements.push(
          `<text x="${x + 4}" y="${barY + barHeight * 0.82}" font-family="Arial" font-size="15" fill="#374151">${escapeXml(labels[index] || "")}</text>`,
          `<rect x="${x + 118}" y="${barY}" width="${barWidth}" height="${barHeight}" fill="${color}"/>`,
          `<text x="${x + 126 + barWidth}" y="${barY + barHeight * 0.82}" font-family="Arial" font-size="15" font-weight="700" fill="#111827">${escapeXml(String(value))}</text>`,
        );
      } else {
        const columnWidth = (width - 40) / count;
        const barWidth = columnWidth * 0.56;
        const barHeight = (Math.abs(value) / maximum) * (height - 55);
        const barX = x + 24 + index * columnWidth;
        const barY = y + height - 28 - barHeight;
        elements.push(
          `<rect x="${barX}" y="${barY}" width="${barWidth}" height="${barHeight}" fill="${color}"/>`,
          `<text x="${barX + barWidth / 2}" y="${y + height - 8}" text-anchor="middle" font-family="Arial" font-size="14" fill="#374151">${escapeXml(labels[index] || "")}</text>`,
        );
      }
    });
  }
  return `<g>${elements.join("")}</g>`;
}

function renderTable(object: UnknownRecord): string {
  const options = asRecord(object.options);
  const rows = asArray(object.arrTabRows).map((row) =>
    asArray(row).map(asRecord),
  );
  if (rows.length === 0) return "";
  const x = toPixels(options.x, "x");
  const y = toPixels(options.y, "y");
  const width = Math.max(1, toPixels(options.w, "x"));
  const height = Math.max(1, toPixels(options.h, "y"));
  const columnCount = Math.max(1, ...rows.map((row) => row.length));
  const rowHeight = height / rows.length;
  const columnWidth = width / columnCount;
  const elements: string[] = [];
  rows.forEach((row, rowIndex) => {
    row.forEach((cell, columnIndex) => {
      const cellOptions = { ...options, ...asRecord(cell.options) };
      const fill = asRecord(cellOptions.fill);
      const cellX = x + columnIndex * columnWidth;
      const cellY = y + rowIndex * rowHeight;
      elements.push(
        `<rect x="${cellX}" y="${cellY}" width="${columnWidth}" height="${rowHeight}" fill="${normalizeColor(fill.color, rowIndex === 0 ? "#eef5f4" : "#ffffff")}" stroke="#d6dddc" stroke-width="1"/>`,
        `<text x="${cellX + 10}" y="${cellY + rowHeight / 2 + 6}" font-family="Arial" font-size="${Math.max(12, asNumber(cellOptions.fontSize, 12) * 1.45)}" font-weight="${rowIndex === 0 ? 700 : 400}" fill="${normalizeColor(cellOptions.color, "#111827")}">${escapeXml(asString(cell.text))}</text>`,
      );
    });
  });
  return `<g>${elements.join("")}</g>`;
}

function renderSlideObject(
  object: UnknownRecord,
  slide: UnknownRecord,
): string {
  const type = asString(object._type);
  if (type === "image") return renderImage(object, slide);
  if (type === "chart") return renderChart(object, slide);
  if (type === "table") return renderTable(object);
  if (type === "text") {
    return `${renderShape(object)}${renderText(object)}`;
  }
  return "";
}

function resolveSlideBackgroundColor(slide: UnknownRecord): string {
  const background = asRecord(
    slide.background || slide._background || slide.bkgd || slide._bkgd,
  );
  return normalizeColor(background.color || background.fill, "#ffffff");
}

export function renderPresentationSlideSvgs(
  presentation: unknown,
  abortSignal?: AbortSignal,
): string[] {
  const slides = asArray(asRecord(presentation)._slides).map(asRecord);
  return slides.map((slide) => {
    throwIfAborted(abortSignal);
    const backgroundColor = resolveSlideBackgroundColor(slide);
    const body = asArray(slide._slideObjects)
      .map(asRecord)
      .map((object) => renderSlideObject(object, slide))
      .join("");
    return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${PREVIEW_WIDTH}" height="${PREVIEW_HEIGHT}" viewBox="0 0 ${PREVIEW_WIDTH} ${PREVIEW_HEIGHT}"><rect width="100%" height="100%" fill="${backgroundColor}"/>${body}</svg>`;
  });
}

function runtimeWindow(): Window | null {
  if (typeof window !== "undefined") return window;
  return null;
}

async function renderSvgToPng(
  svg: string,
  abortSignal?: AbortSignal,
): Promise<string> {
  throwIfAborted(abortSignal);
  const targetWindow = runtimeWindow();
  const document = targetWindow?.document;
  const ImageConstructor = targetWindow?.Image;
  if (!document || !ImageConstructor) {
    throw new Error(
      "Presentation preview requires the Zotero browser runtime.",
    );
  }
  const canvas = document.createElement("canvas");
  canvas.width = PREVIEW_WIDTH;
  canvas.height = PREVIEW_HEIGHT;
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) {
    throw new Error("Presentation preview could not create a canvas context.");
  }
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, PREVIEW_WIDTH, PREVIEW_HEIGHT);
  const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  let image: InstanceType<typeof ImageConstructor> | undefined;
  try {
    image = new ImageConstructor();
    await raceWithAbort(
      () =>
        new Promise<void>((resolve, reject) => {
          image.onload = () => resolve();
          image.onerror = () =>
            reject(new Error("Presentation preview SVG could not be decoded."));
          image.src = url;
        }),
      abortSignal,
    );
    throwIfAborted(abortSignal);
    context.drawImage(image, 0, 0, PREVIEW_WIDTH, PREVIEW_HEIGHT);
    const data = canvas.toDataURL("image/png");
    if (!data.startsWith("data:image/png;base64,")) {
      throw new Error("Presentation preview did not produce a PNG image.");
    }
    return data;
  } finally {
    if (image) {
      image.onload = null;
      image.onerror = null;
      try {
        // Stop a still-pending decode when cancellation wins the race and
        // release the Blob-backed image resource before the next slide starts.
        image.src = "";
      } catch {
        // Some wrapped browser Image objects reject writes after teardown.
      }
    }
    URL.revokeObjectURL(url);
  }
}

export async function renderPresentationPreviewSlides(
  presentation: unknown,
  abortSignal?: AbortSignal,
): Promise<string[]> {
  const svgs = renderPresentationSlideSvgs(presentation, abortSignal);
  const previews: string[] = [];
  for (const svg of svgs) {
    throwIfAborted(abortSignal);
    previews.push(await renderSvgToPng(svg, abortSignal));
  }
  throwIfAborted(abortSignal);
  return previews;
}
