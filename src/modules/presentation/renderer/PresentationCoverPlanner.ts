import type {
  RenderablePresentationRequest,
  ResolvedPresentationFigure,
} from "../PresentationSchema";

function figureSignature(
  spec: RenderablePresentationRequest,
  figure: ResolvedPresentationFigure,
): string {
  return `${figure.itemKey || spec.sourceItemKey || ""}:${figure.page}:${figure.pixelWidth}x${figure.pixelHeight}:${figure.caption || figure.captionHint || ""}`;
}

function figureCaptionAnchor(figure: ResolvedPresentationFigure): string {
  const caption = (figure.captionHint || figure.caption || "")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  const anchoredLabel = caption.match(
    /(?:^|\b)(fig(?:ure)?|table)\s*\.?\s*([a-z]?\d+[a-z]?)/i,
  );
  if (anchoredLabel) {
    return `${anchoredLabel[1].startsWith("tab") ? "table" : "figure"}:${anchoredLabel[2]}`;
  }
  const cjkLabel = caption.match(
    /(?:^|\s)(图|表)\s*([0-9一二三四五六七八九十]+)/u,
  );
  if (cjkLabel) {
    return `${cjkLabel[1] === "表" ? "table" : "figure"}:${cjkLabel[2]}`;
  }
  return "";
}

function figureSemanticSignature(
  spec: RenderablePresentationRequest,
  figure: ResolvedPresentationFigure,
): string {
  const anchor = figureCaptionAnchor(figure);
  if (!anchor) return figureSignature(spec, figure);
  return `${figure.itemKey || spec.sourceItemKey || ""}:${figure.page}:${anchor}`;
}

function normalizedFigureDescription(
  figure: ResolvedPresentationFigure,
): string {
  return `${figure.captionHint || ""} ${figure.caption || ""}`
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function coverSemanticPenalty(figure: ResolvedPresentationFigure): number {
  const description = normalizedFigureDescription(figure);
  if (!description) return 0;

  // Covers need an immediately legible visual anchor. Dense quantitative
  // plots, tables, and architecture schematics remain valuable inside the
  // deck, but their tiny axes and labels make weak hero images. Qualitative
  // examples and learned visual representations carry the paper's subject at
  // first glance and therefore receive a strong preference.
  const denseEvidence =
    /(?:training|validation|test) (?:error|loss)|curve|plot|chart|table|architecture|pipeline|network diagram|训练(?:误差|损失|曲线)|验证(?:误差|损失)|测试误差|曲线|图表|表格|架构|流程/u.test(
      description,
    );
  const sceneLevelEvidence =
    /prediction|sample|nearest|retrieval|qualitative|test image|error case|示例|样本|预测|检索|定性|测试图像|错误案例/u.test(
      description,
    );
  const representationEvidence =
    /visualization|learned (?:filter|feature|representation)|卷积核|特征可视化|学习到的(?:特征|表示)/u.test(
      description,
    );
  // Real-world samples, predictions, retrievals, and error cases read at a
  // glance and make the strongest academic cover. Learned filters remain a
  // good fallback and often become the supporting visual on a result slide,
  // but should not beat a richer qualitative panel merely because the planner
  // happened to nominate them as coverFigure first.
  return (
    (denseEvidence ? 4.8 : 0) -
    (sceneLevelEvidence ? 9.2 : 0) -
    (representationEvidence ? 4.6 : 0)
  );
}

export function selectPresentationCoverHero(
  spec: RenderablePresentationRequest,
): ResolvedPresentationFigure | undefined {
  const allCandidates = [
    ...(spec.coverFigure ? [spec.coverFigure] : []),
    ...(spec.coverFigures || []),
  ];
  const seen = new Set<string>();
  const candidates = allCandidates.filter((figure) => {
    const signature = figureSemanticSignature(spec, figure);
    if (seen.has(signature)) return false;
    seen.add(signature);
    return true;
  });
  const contentFigureSignatures = new Set(
    spec.slides.flatMap((slide) => [
      ...(slide.figure ? [figureSemanticSignature(spec, slide.figure)] : []),
      ...(slide.figures || []).map((figure) =>
        figureSemanticSignature(spec, figure),
      ),
    ]),
  );
  return candidates.sort((left, right) => {
    const score = (figure: ResolvedPresentationFigure) => {
      const aspect = figure.pixelWidth / Math.max(1, figure.pixelHeight);
      const targetAspect = 1.28;
      const aspectPenalty =
        Math.abs(Math.log(Math.max(0.12, aspect) / targetAspect)) * 1.45 +
        (aspect < 0.62 || aspect > 2.4 ? 1.35 : 0);
      const repeatedContentPenalty = contentFigureSignatures.has(
        figureSemanticSignature(spec, figure),
      )
        ? 8
        : 0;
      const resolutionBonus =
        Math.log10(Math.max(1, figure.pixelWidth * figure.pixelHeight)) / 10;
      const preferredPrimaryBonus = figure === spec.coverFigure ? 3.4 : 0;
      return (
        aspectPenalty +
        repeatedContentPenalty +
        coverSemanticPenalty(figure) -
        resolutionBonus -
        preferredPrimaryBonus
      );
    };
    return score(left) - score(right);
  })[0];
}

export function planPresentationCoverFigures(
  spec: RenderablePresentationRequest,
  singleHero: boolean,
): ResolvedPresentationFigure[] {
  const heroFigure = selectPresentationCoverHero(spec);
  if (!heroFigure) return [];
  if (singleHero) return [heroFigure];

  const figures = [
    heroFigure,
    ...(spec.coverFigures || []),
    ...(spec.coverFigure ? [spec.coverFigure] : []),
  ];
  const seen = new Set<string>();
  const unique = figures.filter((figure) => {
    // PDF.js can return slightly different crops for the same printed figure.
    // Dimensions and audience captions therefore cannot be the sole identity:
    // the same item, page, and anchored Figure/Table label is one visual.
    const signature = figureSemanticSignature(spec, figure);
    if (seen.has(signature)) return false;
    seen.add(signature);
    return true;
  });
  const support = unique
    .filter((figure) => figure !== heroFigure)
    .sort((left, right) => {
      const score = (figure: ResolvedPresentationFigure) => {
        const aspect = figure.pixelWidth / Math.max(1, figure.pixelHeight);
        const aspectPenalty = aspect > 4.5 || aspect < 0.55 ? 2.2 : 0;
        return (
          Math.log10(Math.max(1, figure.pixelWidth * figure.pixelHeight)) -
          aspectPenalty
        );
      };
      return score(right) - score(left);
    })[0];
  return support ? [heroFigure, support] : [heroFigure];
}
