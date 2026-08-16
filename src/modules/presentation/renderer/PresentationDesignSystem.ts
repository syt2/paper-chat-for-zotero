import type {
  PresentationRequest,
  RenderablePresentationSlide,
} from "../PresentationSchema";
import type { PresentationDesignSystem } from "../PresentationLaunchSettings";

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

const DESIGN_SYSTEM_THEMES: Record<PresentationDesignSystem, ThemePalette> = {
  "teal-green-academic-defense": THEMES.academic,
  "blue-line-courseware": {
    background: "FFFFFF",
    paper: "F7F9FC",
    surface: "FFFFFF",
    text: "202124",
    muted: "6F7780",
    faint: "9AA0A6",
    accent: "4285F4",
    accentDark: "0059BA",
    accentSoft: "ADCCFA",
    framework: "24C2E0",
    frameworkSoft: "E8F6FA",
    focus: "34A853",
    danger: "5F6368",
    border: "D8DBE0",
    chart: ["4285F4", "24C2E0", "0059BA", "9AA0A6", "34A853"],
    coverText: "FFFFFF",
  },
  "deep-blue-atlas": {
    background: "FFFFFF",
    paper: "F7F9FC",
    surface: "FFFFFF",
    text: "203D74",
    muted: "7F899E",
    faint: "B5C0D0",
    accent: "49B7D0",
    accentDark: "203D74",
    accentSoft: "E7ECF1",
    framework: "2C477A",
    frameworkSoft: "F3F6FA",
    focus: "FD9F66",
    danger: "E94B3B",
    border: "D9DEE7",
    chart: ["203D74", "49B7D0", "7F899E", "FD9F66", "E94B3B"],
    coverText: "FFFFFF",
  },
  "paper-white-courseware": {
    background: "FDFAF5",
    paper: "FFFDFC",
    surface: "FDFAF5",
    text: "56687A",
    muted: "7B8996",
    faint: "A9B2BA",
    accent: "F5987E",
    accentDark: "44712E",
    accentSoft: "F9DED8",
    framework: "44712E",
    frameworkSoft: "D7EBCE",
    focus: "F5987E",
    danger: "C96F5A",
    border: "D9D8D0",
    chart: ["44712E", "F5987E", "88A97A", "E8B2A5", "56687A"],
    coverText: "FFFFFF",
  },
  "pastel-derivation": {
    background: "FFFFFF",
    paper: "F8FAFC",
    surface: "FFFFFF",
    text: "172C34",
    muted: "65747A",
    faint: "A8B1B5",
    accent: "0064E0",
    accentDark: "0051B8",
    accentSoft: "DBEDFE",
    framework: "0085FD",
    frameworkSoft: "F1F4F7",
    focus: "C32E8F",
    danger: "C32E8F",
    border: "D7DEE4",
    chart: ["1F77B4", "FF7F0E", "2CA02C", "D62728", "C32E8F"],
    coverText: "FFFFFF",
  },
  "wine-red-data": {
    background: "FFFFFF",
    paper: "F8F6F8",
    surface: "FFFFFF",
    text: "000000",
    muted: "5E5962",
    faint: "AAA4AD",
    accent: "E69138",
    accentDark: "820000",
    accentSoft: "FFEFD9",
    framework: "4F0E86",
    frameworkSoft: "F3F3F3",
    focus: "F7D05B",
    danger: "FF0000",
    border: "D8D3DA",
    chart: ["820000", "E69138", "0076BA", "56C1FF", "A9AAAC"],
    coverText: "FFFFFF",
  },
  "paperchat-editorial": THEMES.paperchat,
  "dark-editorial": THEMES.dark,
};

export function resolveTheme(spec: PresentationRequest): ThemePalette {
  if (spec.designSystem) return DESIGN_SYSTEM_THEMES[spec.designSystem];
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
