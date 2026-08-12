import type {
  PresentationRequest,
  RenderablePresentationSlide,
} from "../PresentationSchema";

export const SLIDE_WIDTH = 13.333;
export const SLIDE_HEIGHT = 7.5;
// The reference academic system is a restrained neo-grotesque, not the
// generic Office default. Helvetica Neue is bundled on the supported macOS
// Zotero runtime and cleanly falls back to the deck theme in other viewers.
export const TITLE_FONT = "Helvetica Neue";
export const BODY_FONT = "Helvetica Neue";
export const MONO_FONT = "Menlo";

export type ResolvedLayout =
  | "statement"
  | "split"
  | "figure"
  | "data"
  | "process"
  | "comparison"
  | "summary"
  | "evidence"
  | "matrix"
  | "timeline"
  | "gallery"
  | "ablation"
  | "conclusion";

export interface ThemePalette {
  background: string;
  paper: string;
  surface: string;
  text: string;
  muted: string;
  faint: string;
  accent: string;
  accentDark: string;
  accentSoft: string;
  framework: string;
  frameworkSoft: string;
  focus: string;
  danger: string;
  border: string;
  chart: string[];
  coverText: string;
}

const THEMES: Record<
  NonNullable<PresentationRequest["theme"]>,
  ThemePalette
> = {
  paperchat: {
    background: "F3F1EA",
    paper: "FBFAF6",
    surface: "FFFFFF",
    text: "121820",
    muted: "59636F",
    faint: "9AA2AA",
    accent: "245C73",
    accentDark: "173C4B",
    accentSoft: "DCE9ED",
    framework: "D6A13D",
    frameworkSoft: "F4E9D0",
    focus: "D97941",
    danger: "A53A2A",
    border: "CBD1D3",
    chart: ["245C73", "D6A13D", "6B8F71", "D97941", "7A6F9B"],
    coverText: "FFFFFF",
  },
  academic: {
    background: "FFFFFF",
    paper: "F7F7F4",
    surface: "FFFFFF",
    text: "0B1013",
    muted: "5D666B",
    faint: "A2AAAE",
    accent: "009682",
    accentDark: "006D60",
    accentSoft: "DFF3EF",
    framework: "68BCE0",
    frameworkSoft: "F4FAFD",
    focus: "F0A81D",
    danger: "B51E00",
    border: "D8DEDF",
    chart: ["1F77B4", "FF7F0E", "2CA02C", "D62728", "9467BD"],
    coverText: "FFFFFF",
  },
  dark: {
    background: "0B0C0D",
    paper: "F5F3EC",
    surface: "17191B",
    text: "F7F4EC",
    muted: "B8B5AD",
    faint: "6E7072",
    accent: "E3A62F",
    accentDark: "F0BC4B",
    accentSoft: "332713",
    framework: "67B9CF",
    frameworkSoft: "182B31",
    focus: "E3A62F",
    danger: "E17B62",
    border: "383A3C",
    chart: ["E3A62F", "67B9CF", "8FC57A", "E17B62", "A891D4"],
    coverText: "F7F4EC",
  },
};

export function resolveTheme(spec: PresentationRequest): ThemePalette {
  if (spec.designSystem === "teal-green-academic-defense") {
    return THEMES.academic;
  }
  if (spec.designSystem === "paperchat-editorial") {
    return THEMES.paperchat;
  }
  if (spec.designSystem === "dark-editorial") return THEMES.dark;
  if (spec.theme) return THEMES[spec.theme];
  return spec.sourceItemKey ? THEMES.academic : THEMES.paperchat;
}

export function chartColorsForSlide(
  chart: NonNullable<RenderablePresentationSlide["chart"]>,
  palette: ThemePalette,
): string[] {
  // Terra frequently wraps one series in `series: [{ ... }]`. PptxGenJS treats
  // a single series plus a multi-color palette as per-data-point coloring,
  // producing unrelated rainbow bars with no legend. Only real multi-series
  // charts receive one color per series; a wrapped single series follows the
  // same restrained highlight logic as `values`.
  if ((chart.series?.length || 0) > 1) {
    return palette.chart.slice(0, chart.series?.length);
  }
  if (chart.highlightIndex === undefined) {
    return chart.labels.map((_, index) =>
      index === 0 ? palette.accent : "AEB7BB",
    );
  }
  return chart.labels.map((_, index) =>
    index === chart.highlightIndex ? palette.focus : "AEB7BB",
  );
}

export function resolveLayout(
  slide: RenderablePresentationSlide,
  _index: number,
): ResolvedLayout {
  if (slide.layout && slide.layout !== "auto") return slide.layout;
  if (slide.matrix) return "matrix";
  if (
    slide.timeline?.length &&
    (slide.groups?.length || slide.bullets?.length || slide.callouts?.length)
  ) {
    return "conclusion";
  }
  if (slide.timeline?.length) return "timeline";
  if (slide.process?.length) return "process";
  if (slide.comparison) return "comparison";
  const figures = (slide.figure ? 1 : 0) + (slide.figures?.length || 0);
  const hasRiskCallout = Boolean(
    slide.callouts?.some((callout) => callout.tone === "risk"),
  );
  if (
    (slide.chart || slide.table) &&
    (hasRiskCallout || slide.groups?.length || slide.callouts?.length)
  ) {
    return "ablation";
  }
  if (figures >= 2 && !slide.chart && !slide.table && !slide.equation) {
    return "gallery";
  }
  const evidenceCount =
    figures +
    (slide.chart ? 1 : 0) +
    (slide.table ? 1 : 0) +
    (slide.equation ? 1 : 0) +
    (slide.metrics?.length ? 1 : 0);
  if (evidenceCount >= 2 || (slide.figures?.length || 0) >= 2) {
    return "evidence";
  }
  if (slide.chart || slide.table || slide.equation) return "data";
  if (slide.figure || slide.figures?.length) return "figure";
  if (slide.metrics?.length) return "statement";
  return "statement";
}

export function titleFontSize(title: string): number {
  const length = Array.from(title).length;
  if (length <= 28) return 28;
  if (length <= 44) return 26.5;
  if (length <= 65) return 24.5;
  return 22.5;
}

export function coverTitleFontSize(title: string): number {
  const length = Array.from(title).length;
  if (length <= 24) return 42;
  if (length <= 42) return 37;
  if (length <= 65) return 31.5;
  return 30;
}
