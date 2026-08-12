import type { PresentationSlide } from "./PresentationSchema";

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] | undefined {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return undefined;
  if (Object.prototype.toString.call(value) !== "[object Array]") {
    return undefined;
  }
  const length = Number((value as { length?: unknown }).length);
  if (!Number.isSafeInteger(length) || length < 0 || length > 10_000) {
    return undefined;
  }
  return Array.from(
    { length },
    (_, index) => (value as Record<number, unknown>)[index],
  );
}

function unwrapString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Object.prototype.toString.call(value) === "[object String]") {
    return String(value);
  }
  return undefined;
}

function isPlaceholderText(value: unknown): boolean {
  const text = unwrapString(value)?.trim() || "";
  return /^(?:placeholder|占位|占位图)$/i.test(text);
}

function containsPlaceholderText(value: unknown): boolean {
  if (isPlaceholderText(value)) return true;
  const array = asArray(value);
  if (array) return array.some(containsPlaceholderText);
  if (!isRecord(value)) return false;
  return Object.values(value).some(containsPlaceholderText);
}

function containsMeaningfulText(value: unknown): boolean {
  const text = unwrapString(value);
  if (text !== undefined) {
    return Boolean(text.trim()) && !isPlaceholderText(text);
  }
  const array = asArray(value);
  if (array) return array.some(containsMeaningfulText);
  if (!isRecord(value)) return false;
  return Object.values(value).some(containsMeaningfulText);
}

function meaningfulStrings(value: unknown): string[] {
  const text = unwrapString(value);
  if (text !== undefined) {
    const trimmed = text.trim();
    return trimmed && !isPlaceholderText(trimmed) ? [trimmed] : [];
  }
  const array = asArray(value);
  if (array) return array.flatMap(meaningfulStrings);
  if (!isRecord(value)) return [];
  return Object.values(value).flatMap(meaningfulStrings);
}

function containsOnlySchemaFiller(value: unknown): boolean {
  const strings = meaningfulStrings(value);
  return (
    strings.length > 0 &&
    strings.every((text) => /^(?:[a-c]|[1-3])$/i.test(text))
  );
}

function omitPlaceholderModules(slide: UnknownRecord): void {
  for (const key of [
    "section",
    "eyebrow",
    "subtitle",
    "keyMessage",
    "notes",
    "source",
  ]) {
    const text = unwrapString(slide[key]);
    if (text !== undefined && (!text.trim() || isPlaceholderText(text))) {
      delete slide[key];
    }
  }

  const bullets = asArray(slide.bullets)?.filter(
    (bullet) =>
      Boolean(unwrapString(bullet)?.trim()) && !isPlaceholderText(bullet),
  );
  if (bullets) {
    if (bullets.length > 0) slide.bullets = bullets;
    else delete slide.bullets;
  }

  for (const key of ["groups", "metrics", "callouts", "process", "timeline"]) {
    const modules = asArray(slide[key]);
    if (!modules) continue;
    const meaningful = modules.filter(
      (module) =>
        containsMeaningfulText(module) &&
        !containsPlaceholderText(module) &&
        !containsOnlySchemaFiller(module),
    );
    if (meaningful.length > 0) slide[key] = meaningful;
    else delete slide[key];
  }

  for (const key of ["chart", "table", "equation", "matrix", "comparison"]) {
    if (
      slide[key] !== undefined &&
      (!containsMeaningfulText(slide[key]) ||
        containsPlaceholderText(slide[key]) ||
        containsOnlySchemaFiller(slide[key]))
    ) {
      delete slide[key];
    }
  }
}

function omit(slide: UnknownRecord, keys: readonly string[]): void {
  for (const key of keys) {
    delete slide[key];
  }
}

function normalizeChart(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const chart = { ...value };
  const hasValues = Array.isArray(chart.values);
  const series = asArray(chart.series);
  const hasSeries = Boolean(series);
  if (hasValues && hasSeries) {
    if (series && series.length > 0) {
      delete chart.values;
    } else {
      delete chart.series;
    }
  }
  return chart;
}

function normalizeMatrix(value: unknown): unknown {
  if (!isRecord(value)) return value;

  const columns = (asArray(value.columns) || [])
    .map(unwrapString)
    .filter((entry): entry is string => Boolean(entry?.trim()))
    .map((entry) => entry.trim())
    .slice(0, 5);
  const rows = (asArray(value.rows) || [])
    .filter(isRecord)
    .map((row) => ({
      label: unwrapString(row.label)?.trim() || "",
      cells: (asArray(row.cells) || [])
        .map(unwrapString)
        .filter((entry): entry is string => Boolean(entry?.trim()))
        .map((entry) => entry.trim())
        .slice(0, 5),
    }))
    .filter((row) => row.label && row.cells.length >= 2)
    .slice(0, 6);

  if (columns.length < 2 || rows.length < 2) {
    return { ...value, columns, rows };
  }

  // Terra occasionally returns one short row or appends one extra cell to a
  // comparison matrix. Preserve only the complete shared rectangle instead
  // of discarding the entire presentation before rendering.
  const columnCount = Math.min(
    columns.length,
    ...rows.map((row) => row.cells.length),
  );
  const matrix: UnknownRecord = {
    ...value,
    columns: columns.slice(0, columnCount),
    rows: rows.map((row) => ({
      label: row.label,
      cells: row.cells.slice(0, columnCount),
    })),
  };
  const highlightColumn = Number(value.highlightColumn);
  if (
    !Number.isInteger(highlightColumn) ||
    highlightColumn < 0 ||
    highlightColumn >= columnCount
  ) {
    delete matrix.highlightColumn;
  } else {
    matrix.highlightColumn = highlightColumn;
  }
  return matrix;
}

function figureCandidates(slide: UnknownRecord): unknown[] {
  return dedupeFigures([
    ...(isRecord(slide.figure) ? [slide.figure] : []),
    ...(asArray(slide.figures) || []),
  ]);
}

function isPlaceholderFigure(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const caption = unwrapString(value.caption)?.trim() || "";
  const hint = unwrapString(value.captionHint)?.trim() || "";
  const placeholderText = isPlaceholderText(caption);
  const placeholderHint = isPlaceholderText(hint);
  const crop = isRecord(value.crop) ? value.crop : undefined;
  const cropArea = crop
    ? Number(crop.width) * Number(crop.height)
    : Number.POSITIVE_INFINITY;
  const blankTinyCrop = !caption && cropArea > 0 && cropArea <= 0.0025;
  return placeholderText || placeholderHint || blankTinyCrop;
}

function dedupeFigures(candidates: unknown[]): unknown[] {
  const seen = new Set<string>();
  return candidates.filter((figure) => {
    if (isPlaceholderFigure(figure)) return false;
    if (!isRecord(figure)) return true;
    const signature = JSON.stringify(figure);
    if (seen.has(signature)) return false;
    seen.add(signature);
    return true;
  });
}

function splitNumberedClaims(value: string): string[] {
  const normalized = value.normalize("NFKC").replace(/\s+/g, " ").trim();
  const pattern =
    /(?:^|[\n·•；;]\s*)(?:0?[1-9]|[①②③④⑤⑥⑦⑧⑨])(?:[.)、:：-]|\s)+([\s\S]*?)(?=(?:[\n·•；;]\s*)(?:0?[1-9]|[①②③④⑤⑥⑦⑧⑨])(?:[.)、:：-]|\s)+|$)/gu;
  return Array.from(normalized.matchAll(pattern), (match) => match[1].trim())
    .filter(Boolean)
    .slice(0, 3);
}

function splitClaimTitleAndBody(
  claim: string,
  index: number,
): { title: string; bullets: string[] } {
  const text = claim.replace(/[。.;；]+$/u, "").trim();
  const explicitSeparator = text.search(/[：:；;—–]/u);
  if (explicitSeparator >= 4 && explicitSeparator <= 36) {
    return {
      title: text.slice(0, explicitSeparator).trim(),
      bullets: [text.slice(explicitSeparator + 1).trim()].filter(Boolean),
    };
  }
  const clauseSeparator = text.search(/[，,]/u);
  if (clauseSeparator >= 6 && clauseSeparator <= 28) {
    return {
      title: text.slice(0, clauseSeparator).trim(),
      bullets: [text.slice(clauseSeparator + 1).trim()].filter(Boolean),
    };
  }

  const characters = Array.from(text);
  if (characters.length > 24) {
    let titleLength = 22;
    while (
      titleLength < Math.min(characters.length, 30) &&
      /[A-Za-z0-9]/u.test(characters[titleLength - 1] || "") &&
      /[A-Za-z0-9]/u.test(characters[titleLength] || "")
    ) {
      titleLength += 1;
    }
    return {
      title: characters.slice(0, titleLength).join("").trim(),
      bullets: [characters.slice(titleLength).join("").trim()].filter(Boolean),
    };
  }
  const words = text.split(/\s+/u).filter(Boolean);
  if (words.length > 8) {
    return {
      title: words.slice(0, 7).join(" "),
      bullets: [words.slice(7).join(" ")],
    };
  }
  return {
    title: text || `Finding ${String(index + 1).padStart(2, "0")}`,
    bullets: [text || "Supported by the paper."],
  };
}

function normalizeEvidenceNarrative(slide: UnknownRecord): void {
  const groups = asArray(slide.groups);
  if (!groups) return;
  slide.groups = groups.slice(0, 2).map((group) => {
    if (!isRecord(group)) return group;
    const bullets = (asArray(group.bullets) || [])
      .filter((bullet) => Boolean(unwrapString(bullet)?.trim()))
      .slice(0, 2);
    return { ...group, bullets };
  });
}

function normalizeConclusionNarrative(slide: UnknownRecord): void {
  const groups = asArray(slide.groups);
  if (groups?.length !== 1 || !isRecord(groups[0])) return;
  const group = groups[0];
  const bullets = (asArray(group.bullets) || [])
    .map(unwrapString)
    .filter((bullet): bullet is string => Boolean(bullet?.trim()));
  if (bullets.length !== 1) return;
  const claims = splitNumberedClaims(bullets[0]);
  if (claims.length < 2) return;
  slide.groups = claims.map(splitClaimTitleAndBody);
}

function keepSingleFigure(slide: UnknownRecord): void {
  const figures = figureCandidates(slide);
  if (figures.length > 0) {
    slide.figure = figures[0];
  } else {
    delete slide.figure;
  }
  delete slide.figures;
}

function keepSingleEvidenceObject(slide: UnknownRecord): void {
  keepSingleFigure(slide);
  if (slide.figure) {
    omit(slide, ["chart", "table", "equation"]);
  } else if (slide.chart) {
    omit(slide, ["table", "equation"]);
  } else if (slide.table) {
    delete slide.equation;
  }
}

function stringLength(value: unknown): number {
  return Array.from(unwrapString(value)?.trim() || "").length;
}

function trimStringArray(
  slide: UnknownRecord,
  key: "bullets",
  limit: number,
): void {
  const values = (asArray(slide[key]) || [])
    .map(unwrapString)
    .filter((value): value is string => Boolean(value?.trim()))
    .slice(0, limit);
  if (values.length > 0) slide[key] = values;
  else delete slide[key];
}

function trimGroups(
  slide: UnknownRecord,
  groupLimit: number,
  bulletLimit: number,
): void {
  const groups = (asArray(slide.groups) || [])
    .filter(isRecord)
    .slice(0, groupLimit)
    .map((group) => ({
      ...group,
      bullets: (asArray(group.bullets) || [])
        .map(unwrapString)
        .filter((value): value is string => Boolean(value?.trim()))
        .slice(0, bulletLimit),
    }));
  if (groups.length > 0) slide.groups = groups;
  else delete slide.groups;
}

function isTableFigureCandidate(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const caption = [value.captionHint, value.caption]
    .map(unwrapString)
    .filter((entry): entry is string => Boolean(entry?.trim()))
    .join(" ")
    .normalize("NFKC")
    .trim();
  return /^(?:table|tab\.?|表)\s*[A-Za-z0-9一二三四五六七八九十]/iu.test(
    caption,
  );
}

function isDensePlotFigureCandidate(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const caption = [value.captionHint, value.caption]
    .map(unwrapString)
    .filter((entry): entry is string => Boolean(entry?.trim()))
    .join(" ")
    .normalize("NFKC")
    .toLocaleLowerCase();
  return /(?:training|validation|test|error|accuracy|loss|curve|plot|graph|trajectory|convergence|训练|验证|测试|误差|错误率|准确率|损失|曲线|收敛)/u.test(
    caption,
  );
}

function isTrustedFigureCandidate(value: unknown): value is UnknownRecord {
  if (!isRecord(value) || isPlaceholderFigure(value)) return false;
  const page = Number(value.page);
  const captionHint = unwrapString(value.captionHint)?.trim() || "";
  return (
    Number.isInteger(page) &&
    page >= 1 &&
    page <= 10_000 &&
    value.mode !== "page" &&
    /^(?:fig(?:ure)?|table|tab\.?|图|表)\s*[A-Za-z0-9一二三四五六七八九十]+(?:[.:：\s-]|$)/iu.test(
      captionHint,
    )
  );
}

function figureAnchor(value: UnknownRecord): string {
  const caption = [value.captionHint, value.caption]
    .map(unwrapString)
    .filter((entry): entry is string => Boolean(entry?.trim()))
    .join(" ")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  const latin = caption.match(
    /(?:^|\b)(fig(?:ure)?|table|tab\.?)\s*\.?\s*([a-z]?\d+[a-z]?)/iu,
  );
  if (latin) {
    return `${latin[1].startsWith("tab") ? "table" : "figure"}:${latin[2]}`;
  }
  const cjk = caption.match(/(?:^|\s)(图|表)\s*([0-9一二三四五六七八九十]+)/u);
  if (cjk) return `${cjk[1] === "表" ? "table" : "figure"}:${cjk[2]}`;
  return caption.replace(/[\s\p{P}\p{S}]+/gu, "").slice(0, 80);
}

function figureEvidenceIdentity(value: UnknownRecord): string {
  return [
    unwrapString(value.itemKey)?.trim() || "request-item",
    Number(value.page),
    figureAnchor(value) || "unanchored",
  ].join("|");
}

function figurePlacementIdentity(value: UnknownRecord): string {
  const crop = isRecord(value.crop)
    ? [value.crop.x, value.crop.y, value.crop.width, value.crop.height].join(
        ":",
      )
    : "auto";
  return `${figureEvidenceIdentity(value)}|${crop}`;
}

function setSlideFigures(slide: UnknownRecord, figures: unknown[]): void {
  const unique = dedupeFigures(figures);
  delete slide.figure;
  delete slide.figures;
  if (unique.length === 0) return;
  if (slide.layout === "gallery") {
    slide.figures = unique.slice(0, 2);
    return;
  }
  slide.figure = unique[0];
  if (slide.layout === "evidence" && unique.length > 1) {
    slide.figures = unique.slice(1);
  }
}

function removeSlideFiguresMatching(
  slide: UnknownRecord,
  predicate: (figure: unknown) => boolean,
): unknown[] {
  const figures = figureCandidates(slide);
  const removed = figures.filter(predicate);
  setSlideFigures(
    slide,
    figures.filter((figure) => !predicate(figure)),
  );
  return removed;
}

function hasProtectedStructuredEvidence(slide: UnknownRecord): boolean {
  return Boolean(
    slide.chart ||
    slide.table ||
    slide.matrix ||
    slide.comparison ||
    asArray(slide.process)?.length,
  );
}

function promoteSlideToFigure(slide: UnknownRecord, figure: unknown): void {
  slide.layout = "figure";
  slide.figure = figure;
  delete slide.figures;
  keepOneNarrative(slide, {
    preferKeyMessageBelow: 96,
    maximumBullets: 2,
  });
  omit(slide, [
    "chart",
    "table",
    "equation",
    "matrix",
    "timeline",
    "process",
    "comparison",
    "groups",
    "metrics",
    "callouts",
  ]);
}

function figureCount(slide: UnknownRecord): number {
  return figureCandidates(slide).length;
}

function isUltraWideResolvedFigure(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const width = Number(value.pixelWidth);
  const height = Number(value.pixelHeight);
  return (
    Number.isFinite(width) &&
    Number.isFinite(height) &&
    width > 0 &&
    height > 0 &&
    width / height >= 2.55
  );
}

function evidenceModuleCountWithoutFigures(slide: UnknownRecord): number {
  return (
    (slide.chart ? 1 : 0) +
    (slide.table ? 1 : 0) +
    (slide.matrix ? 1 : 0) +
    (slide.equation ? 1 : 0) +
    (asArray(slide.metrics)?.length ? 1 : 0)
  );
}

function isMethodFigureCandidate(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const caption = [value.captionHint, value.caption]
    .map(unwrapString)
    .filter((entry): entry is string => Boolean(entry?.trim()))
    .join(" ")
    .normalize("NFKC")
    .toLocaleLowerCase();
  return /(?:architecture|network|pipeline|method|model|implementation|framework|structure|架构|网络|流程|方法|模型|实现|结构)/u.test(
    caption,
  );
}

function addRecoveredFigure(
  slide: UnknownRecord,
  figure: UnknownRecord,
): boolean {
  const layout = unwrapString(slide.layout) || "";
  if (layout === "gallery") {
    const figures = figureCandidates(slide);
    if (figures.length !== 1) return false;
    setSlideFigures(slide, [...figures, figure]);
    return true;
  }
  if (figureCount(slide) > 0) return false;
  if (layout === "evidence") {
    const moduleCount = evidenceModuleCountWithoutFigures(slide);
    if (moduleCount < 1 || moduleCount > 2) return false;
    slide.figure = figure;
    return true;
  }
  if (layout === "process") {
    if (!isMethodFigureCandidate(figure)) return false;
    slide.figure = figure;
    return true;
  }
  if (layout === "ablation") {
    if (!slide.chart && !slide.table && !slide.matrix) return false;
    slide.figure = figure;
    return true;
  }
  if (
    ["figure", "split", "data", "matrix", "timeline", "summary"].includes(
      layout,
    )
  ) {
    slide.figure = figure;
    return true;
  }
  if (!layout && !hasProtectedStructuredEvidence(slide)) {
    promoteSlideToFigure(slide, figure);
    return true;
  }
  return false;
}

function canonicalizePaperFigureEvidence(
  originalSlides: readonly unknown[],
  normalizedSlides: UnknownRecord[],
  coverCandidates: readonly unknown[],
): void {
  const recoveredCandidates: Array<{
    figure: UnknownRecord;
    sourceIndex: number;
    mustRecover?: boolean;
  }> = [];

  normalizedSlides.forEach((slide, index) => {
    if (slide.layout === "figure") return;
    const denseFigures = removeSlideFiguresMatching(
      slide,
      isDensePlotFigureCandidate,
    );
    recoveredCandidates.push(
      ...denseFigures.filter(isTrustedFigureCandidate).map((figure) => ({
        figure,
        sourceIndex: index,
      })),
    );
    if (
      index > 0 &&
      slide.layout !== "conclusion" &&
      denseFigures.length > 0 &&
      !hasProtectedStructuredEvidence(slide)
    ) {
      promoteSlideToFigure(slide, denseFigures[0]);
    } else if (slide.layout === "gallery" && figureCount(slide) === 1) {
      promoteSlideToFigure(slide, figureCandidates(slide)[0]);
    }
  });

  originalSlides.forEach((originalSlide, sourceIndex) => {
    if (!isRecord(originalSlide)) return;
    const originalFigures = figureCandidates(originalSlide);
    const ultraWideGallery =
      originalSlide.layout === "gallery" &&
      originalFigures.length === 2 &&
      originalFigures.every(isUltraWideResolvedFigure);
    recoveredCandidates.push(
      ...originalFigures
        .filter(isTrustedFigureCandidate)
        .map((figure, figureIndex) => ({
          figure,
          sourceIndex,
          mustRecover: ultraWideGallery && figureIndex === 1,
        })),
    );
  });

  const coverIdentities = new Set(
    coverCandidates
      .filter(isTrustedFigureCandidate)
      .map(figureEvidenceIdentity),
  );
  const candidatePlacements = new Set<string>();
  const candidates = recoveredCandidates.filter(({ figure }) => {
    if (isTableFigureCandidate(figure)) return false;
    if (coverIdentities.has(figureEvidenceIdentity(figure))) return false;
    const placement = figurePlacementIdentity(figure);
    if (candidatePlacements.has(placement)) return false;
    candidatePlacements.add(placement);
    return true;
  });

  const currentFigures = (): UnknownRecord[] =>
    normalizedSlides.flatMap(figureCandidates).filter(isTrustedFigureCandidate);
  const currentEvidenceIdentities = (): Set<string> =>
    new Set(currentFigures().map(figureEvidenceIdentity));
  const figureSlideCount = (): number =>
    normalizedSlides.filter((slide) => figureCount(slide) > 0).length;

  for (const { figure, sourceIndex, mustRecover } of candidates) {
    if (
      !mustRecover &&
      currentFigures().length >= 3 &&
      figureSlideCount() >= 2
    ) {
      break;
    }
    if (currentEvidenceIdentities().has(figureEvidenceIdentity(figure))) {
      continue;
    }
    if (isDensePlotFigureCandidate(figure)) {
      const targetIndex = normalizedSlides.findIndex(
        (slide, index) =>
          index > 0 &&
          index !== sourceIndex &&
          slide.layout !== "conclusion" &&
          figureCount(slide) === 0 &&
          !hasProtectedStructuredEvidence(slide),
      );
      if (targetIndex >= 0) {
        promoteSlideToFigure(normalizedSlides[targetIndex], figure);
      }
      continue;
    }

    const rankedTargets = normalizedSlides
      .map((slide, index) => {
        const layout = unwrapString(slide.layout) || "";
        let rank = Number.POSITIVE_INFINITY;
        if (index === 0 || layout === "conclusion" || layout === "comparison") {
          return { index, rank };
        }
        if (layout === "evidence" && figureCount(slide) === 0) rank = 1;
        else if (
          layout === "process" &&
          figureCount(slide) === 0 &&
          isMethodFigureCandidate(figure)
        ) {
          rank = 2;
        } else if (layout === "ablation" && figureCount(slide) === 0) {
          rank = 3;
        } else if (
          ["figure", "split", "data", "matrix", "timeline", "summary"].includes(
            layout,
          ) &&
          figureCount(slide) === 0
        ) {
          rank = 4;
        } else if (layout === "gallery" && figureCount(slide) === 1) {
          rank = 5;
        } else if (!layout && !hasProtectedStructuredEvidence(slide)) {
          rank = 6;
        }
        if (index === sourceIndex) rank -= 0.25;
        return { index, rank };
      })
      .filter(({ rank }) => Number.isFinite(rank))
      .sort(
        (left, right) => left.rank - right.rank || left.index - right.index,
      );
    for (const { index } of rankedTargets) {
      if (addRecoveredFigure(normalizedSlides[index], figure)) break;
    }
  }
}

function keepOneNarrative(
  slide: UnknownRecord,
  options?: {
    preferKeyMessageBelow?: number;
    maximumBullets?: number;
  },
): void {
  const keyMessage = unwrapString(slide.keyMessage)?.trim();
  const bullets = asArray(slide.bullets) || [];
  const preferKeyMessage = Boolean(
    keyMessage &&
    stringLength(keyMessage) <= (options?.preferKeyMessageBelow || 96) &&
    bullets.length <= 1,
  );
  if (preferKeyMessage || (keyMessage && bullets.length === 0)) {
    delete slide.bullets;
  } else if (bullets.length > 0) {
    delete slide.keyMessage;
    trimStringArray(slide, "bullets", options?.maximumBullets || 2);
  }
}

function normalizeSlide(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const slide: UnknownRecord = { ...value };
  omitPlaceholderModules(slide);
  const layout = unwrapString(slide.layout);
  if (layout) slide.layout = layout;
  if (slide.chart !== undefined) {
    slide.chart = normalizeChart(slide.chart);
  }
  if (slide.matrix !== undefined) {
    slide.matrix = normalizeMatrix(slide.matrix);
  }

  switch (layout as PresentationSlide["layout"]) {
    case "statement":
      omit(slide, [
        "chart",
        "table",
        "equation",
        "matrix",
        "timeline",
        "process",
        "comparison",
        "figure",
        "figures",
        "groups",
        "callouts",
      ]);
      break;
    case "split":
      keepSingleEvidenceObject(slide);
      keepOneNarrative(slide, {
        preferKeyMessageBelow: 88,
        maximumBullets: 2,
      });
      omit(slide, [
        "matrix",
        "timeline",
        "process",
        "comparison",
        "equation",
        "groups",
        "metrics",
        "callouts",
      ]);
      break;
    case "data":
      keepSingleEvidenceObject(slide);
      omit(slide, [
        "matrix",
        "timeline",
        "process",
        "comparison",
        "groups",
        "metrics",
        "callouts",
      ]);
      break;
    case "comparison":
      omit(slide, [
        "chart",
        "table",
        "equation",
        "matrix",
        "timeline",
        "process",
        "figure",
        "figures",
        "groups",
        "bullets",
      ]);
      if (asArray(slide.callouts)) {
        slide.callouts = asArray(slide.callouts)!.slice(0, 1);
      }
      break;
    case "process":
      keepSingleFigure(slide);
      omit(slide, [
        "chart",
        "table",
        "equation",
        "matrix",
        "timeline",
        "comparison",
        "groups",
        "bullets",
        "keyMessage",
        "metrics",
      ]);
      if (asArray(slide.callouts)) {
        slide.callouts = asArray(slide.callouts)!.slice(0, 1);
      }
      if (asArray(slide.process)) {
        slide.process = asArray(slide.process)!.slice(0, 4);
      }
      break;
    case "figure":
      keepSingleFigure(slide);
      omit(slide, [
        "chart",
        "table",
        "equation",
        "matrix",
        "timeline",
        "process",
        "comparison",
        "groups",
        "metrics",
        "callouts",
      ]);
      break;
    case "gallery": {
      const suppliedFigures = dedupeFigures(asArray(slide.figures) || []);
      const figures =
        suppliedFigures.length >= 2 ? suppliedFigures : figureCandidates(slide);
      if (figures.length === 2 && figures.every(isUltraWideResolvedFigure)) {
        // Two very wide paper diagrams cannot both remain readable on one
        // 16:9 slide: even stacked edge-to-edge they occupy only about a
        // quarter of the canvas. Promote the primary evidence to a full-width
        // figure. canonicalizePaperFigureEvidence then gives the secondary
        // crop a chance to move to another compatible content slide.
        promoteSlideToFigure(slide, figures[0]);
        break;
      }
      if (figures.length > 0) slide.figures = figures.slice(0, 2);
      delete slide.figure;
      omit(slide, [
        "chart",
        "table",
        "equation",
        "matrix",
        "timeline",
        "process",
        "comparison",
        "metrics",
        "callouts",
      ]);
      if (
        unwrapString(slide.keyMessage)?.trim() &&
        stringLength(slide.keyMessage) <= 150
      ) {
        omit(slide, ["groups", "bullets"]);
      } else if (asArray(slide.groups)?.length) {
        delete slide.keyMessage;
        delete slide.bullets;
        trimGroups(slide, 2, 1);
      } else if (asArray(slide.bullets)?.length) {
        delete slide.keyMessage;
        delete slide.groups;
        trimStringArray(slide, "bullets", 2);
      }
      break;
    }
    case "evidence": {
      const figures = figureCandidates(slide);
      const hasEvidenceSpecificModule = Boolean(
        figures.length ||
        slide.chart ||
        slide.table ||
        slide.equation ||
        slide.matrix,
      );
      if (slide.comparison && !hasEvidenceSpecificModule) {
        // Terra sometimes selects the generic evidence silhouette for a
        // comparison-first problem slide. The evidence renderer cannot show a
        // comparison, so deleting it turns a valid research-gap page into an
        // empty or single-module slide. Preserve the model's actual evidence
        // by switching to the renderer that owns the comparison field.
        slide.layout = "comparison";
        omit(slide, [
          "chart",
          "table",
          "equation",
          "matrix",
          "timeline",
          "process",
          "figure",
          "figures",
          "groups",
          "bullets",
        ]);
        if (asArray(slide.callouts)) {
          slide.callouts = asArray(slide.callouts)!.slice(0, 1);
        }
        break;
      }
      if (figures.length > 0) {
        slide.figure = figures[0];
        if (figures.length > 1) slide.figures = figures.slice(1);
        else delete slide.figures;
      } else {
        delete slide.figure;
        delete slide.figures;
      }
      omit(slide, ["process", "comparison"]);
      normalizeEvidenceNarrative(slide);
      break;
    }
    case "matrix":
      keepSingleFigure(slide);
      omit(slide, [
        "chart",
        "table",
        "equation",
        "timeline",
        "process",
        "comparison",
        "groups",
        "bullets",
        "metrics",
        "callouts",
      ]);
      break;
    case "timeline":
      keepSingleFigure(slide);
      omit(slide, [
        "chart",
        "table",
        "equation",
        "matrix",
        "process",
        "comparison",
        "metrics",
      ]);
      break;
    case "ablation": {
      // Ablation is a single-result editorial composition, not a dashboard.
      // Prefer one editable result, but retain one genuinely visual paper crop
      // as supporting evidence. The renderer gives that crop a narrow sidebar
      // rather than shrinking the chart or table into a dashboard tile.
      if (slide.chart) {
        keepSingleFigure(slide);
        omit(slide, ["table", "matrix"]);
      } else if (slide.table) {
        keepSingleFigure(slide);
        omit(slide, ["matrix"]);
      } else if (slide.matrix) {
        keepSingleFigure(slide);
      } else {
        keepSingleFigure(slide);
      }
      omit(slide, ["equation", "timeline", "process", "comparison"]);

      if (asArray(slide.callouts)?.length) {
        slide.callouts = asArray(slide.callouts)!.slice(0, 2);
        // A chart-only result benefits from a compact numeric evidence tier
        // above its interpretation. Preserve up to two authored metrics in
        // that composition; when a paper figure already occupies the sidebar,
        // keep the rail simpler and let the source image own that tier.
        if (figureCount(slide) === 0 && asArray(slide.metrics)?.length) {
          slide.metrics = asArray(slide.metrics)!.slice(0, 2);
        } else {
          delete slide.metrics;
        }
        omit(slide, ["groups", "bullets", "keyMessage"]);
      } else if (asArray(slide.groups)?.length) {
        trimGroups(slide, 2, 1);
        omit(slide, ["bullets", "keyMessage", "metrics"]);
      } else if (unwrapString(slide.keyMessage)?.trim()) {
        omit(slide, ["groups", "bullets", "metrics"]);
      } else if (asArray(slide.bullets)?.length) {
        trimStringArray(slide, "bullets", 2);
        omit(slide, ["groups", "keyMessage", "metrics"]);
      } else if (asArray(slide.metrics)?.length) {
        slide.metrics = asArray(slide.metrics)!.slice(0, 2);
      }

      if (slide.figure && isTableFigureCandidate(slide.figure)) {
        // Keep the invalid candidate visible to the quality gate so the
        // planner gets a precise repair diagnostic instead of silently
        // accepting a rasterized paper table as the main result.
        delete slide.figures;
      }
      break;
    }
    case "conclusion": {
      normalizeConclusionNarrative(slide);
      omit(slide, [
        "chart",
        "table",
        "equation",
        "matrix",
        "process",
        "comparison",
        "metrics",
        "figure",
        "figures",
        "keyMessage",
      ]);
      if (asArray(slide.groups)) {
        trimGroups(slide, 3, 1);
      } else if (asArray(slide.bullets)) {
        trimStringArray(slide, "bullets", 3);
      }
      if (asArray(slide.callouts)) {
        slide.callouts = asArray(slide.callouts)!.slice(0, 2);
      }
      if (asArray(slide.timeline)) {
        slide.timeline = asArray(slide.timeline)!.slice(0, 4);
      }
      break;
    }
    case "summary":
      keepSingleFigure(slide);
      omit(slide, [
        "chart",
        "table",
        "equation",
        "matrix",
        "timeline",
        "process",
        "comparison",
        "groups",
        "callouts",
      ]);
      break;
  }
  if ((asArray(slide.groups)?.length || 0) > 0) {
    delete slide.bullets;
  }
  return slide;
}

function inferPresentationSourceItemKey(
  value: UnknownRecord,
): string | undefined {
  const figures: unknown[] = [
    value.coverFigure,
    ...(asArray(value.coverFigures) || []),
  ];
  for (const slide of asArray(value.slides) || []) {
    if (!isRecord(slide)) continue;
    figures.push(slide.figure, ...(asArray(slide.figures) || []));
  }
  for (const figure of figures) {
    if (!isRecord(figure)) continue;
    const itemKey = unwrapString(figure.itemKey)?.trim();
    if (itemKey) return itemKey;
  }
  return undefined;
}

/**
 * Models sometimes populate every optional presentation field, even when the
 * selected layout cannot render it. Canonicalize only those known layout
 * conflicts, then let the schema and quality gate reject anything still bad.
 */
export function normalizePresentationRequestInput(
  value: UnknownRecord,
): UnknownRecord {
  const normalized = { ...value };
  if (isPlaceholderFigure(normalized.coverFigure)) {
    delete normalized.coverFigure;
  }
  const coverFigures = dedupeFigures(asArray(normalized.coverFigures) || []);
  if (coverFigures.length > 0) normalized.coverFigures = coverFigures;
  else delete normalized.coverFigures;
  const slides = asArray(value.slides);
  if (slides) {
    normalized.slides = slides.map(normalizeSlide);
  }
  if (!unwrapString(normalized.sourceItemKey)?.trim()) {
    const sourceItemKey = inferPresentationSourceItemKey(normalized);
    if (sourceItemKey) normalized.sourceItemKey = sourceItemKey;
  }
  if (
    slides &&
    slides.length >= 4 &&
    unwrapString(normalized.sourceItemKey)?.trim()
  ) {
    canonicalizePaperFigureEvidence(
      slides,
      (normalized.slides as UnknownRecord[]).filter(isRecord),
      [normalized.coverFigure, ...(asArray(normalized.coverFigures) || [])],
    );
  }
  return normalized;
}
