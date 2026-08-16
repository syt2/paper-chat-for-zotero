import type { PresentationRequest } from "../PresentationSchema";
import type { PresentationDesignSystem } from "../PresentationLaunchSettings";

export interface PresentationThemeBlueprint {
  id: PresentationDesignSystem;
  fonts: {
    title: string;
    body: string;
    mono: string;
    officeTitleFallback: string;
    officeBodyFallback: string;
  };
  cover: {
    title: { x: number; y: number; w: number; h: number };
    hero: { x: number; y: number; w: number; h: number };
    subtitle: { x: number; y: number; w: number; h: number };
  };
  content: {
    left: number;
    right: number;
    bodyTop: number;
    bodyBottom: number;
    footerRuleY: number;
  };
  evidence: {
    narrativeWidth: number;
    dominantRatio: number;
    gap: number;
  };
}

const ACADEMIC_DEFENSE_BLUEPRINT: PresentationThemeBlueprint = {
  id: "teal-green-academic-defense",
  fonts: {
    title: "Helvetica Neue",
    body: "Helvetica Neue",
    mono: "Menlo",
    officeTitleFallback: "Aptos Display",
    officeBodyFallback: "Aptos",
  },
  cover: {
    title: { x: 0.74, y: 1.34, w: 6.3, h: 2.18 },
    hero: { x: 7.08, y: 0.28, w: 5.9, h: 6.18 },
    subtitle: { x: 0.76, y: 3.98, w: 6.12, h: 0.84 },
  },
  content: {
    left: 0.62,
    right: 12.72,
    bodyTop: 1.58,
    bodyBottom: 6.72,
    footerRuleY: 7.03,
  },
  evidence: {
    narrativeWidth: 3.02,
    dominantRatio: 0.66,
    gap: 0.22,
  },
};

const BLUE_LINE_COURSEWARE_BLUEPRINT: PresentationThemeBlueprint = {
  ...ACADEMIC_DEFENSE_BLUEPRINT,
  id: "blue-line-courseware",
  fonts: {
    ...ACADEMIC_DEFENSE_BLUEPRINT.fonts,
    title: "Aptos Display",
    body: "Aptos",
  },
  cover: {
    title: { x: 0.74, y: 1.08, w: 6.08, h: 2.12 },
    hero: { x: 7.16, y: 0.68, w: 5.48, h: 5.72 },
    subtitle: { x: 0.76, y: 3.58, w: 5.94, h: 0.84 },
  },
  evidence: {
    narrativeWidth: 3.22,
    dominantRatio: 0.64,
    gap: 0.24,
  },
};

const DEEP_BLUE_ATLAS_BLUEPRINT: PresentationThemeBlueprint = {
  ...ACADEMIC_DEFENSE_BLUEPRINT,
  id: "deep-blue-atlas",
  fonts: {
    ...ACADEMIC_DEFENSE_BLUEPRINT.fonts,
    title: "Aptos Display",
    body: "Aptos",
  },
  cover: {
    title: { x: 0.76, y: 1.02, w: 6.62, h: 2.3 },
    hero: { x: 8.02, y: 1.06, w: 4.66, h: 4.98 },
    subtitle: { x: 0.78, y: 3.72, w: 6.24, h: 0.82 },
  },
  content: {
    ...ACADEMIC_DEFENSE_BLUEPRINT.content,
    left: 0.68,
    right: 12.65,
    bodyTop: 1.68,
  },
  evidence: {
    narrativeWidth: 3.58,
    dominantRatio: 0.68,
    gap: 0.26,
  },
};

const PAPER_WHITE_COURSEWARE_BLUEPRINT: PresentationThemeBlueprint = {
  ...ACADEMIC_DEFENSE_BLUEPRINT,
  id: "paper-white-courseware",
  fonts: {
    ...ACADEMIC_DEFENSE_BLUEPRINT.fonts,
    title: "Aptos Display",
    body: "Aptos",
  },
  cover: {
    title: { x: 0.76, y: 1.3, w: 6.18, h: 2.14 },
    hero: { x: 7.18, y: 0.48, w: 5.46, h: 5.86 },
    subtitle: { x: 0.78, y: 3.84, w: 5.98, h: 0.86 },
  },
  evidence: {
    narrativeWidth: 3.42,
    dominantRatio: 0.63,
    gap: 0.28,
  },
};

const PASTEL_DERIVATION_BLUEPRINT: PresentationThemeBlueprint = {
  ...ACADEMIC_DEFENSE_BLUEPRINT,
  id: "pastel-derivation",
  fonts: {
    ...ACADEMIC_DEFENSE_BLUEPRINT.fonts,
    title: "Aptos Display",
    body: "Aptos",
  },
  cover: {
    title: { x: 0.72, y: 1.3, w: 6.42, h: 2.08 },
    hero: { x: 7.3, y: 0.54, w: 5.35, h: 5.76 },
    subtitle: { x: 0.74, y: 3.76, w: 6.12, h: 0.82 },
  },
  content: {
    ...ACADEMIC_DEFENSE_BLUEPRINT.content,
    bodyTop: 1.5,
  },
  evidence: {
    narrativeWidth: 3.34,
    dominantRatio: 0.66,
    gap: 0.24,
  },
};

const WINE_RED_DATA_BLUEPRINT: PresentationThemeBlueprint = {
  ...ACADEMIC_DEFENSE_BLUEPRINT,
  id: "wine-red-data",
  fonts: {
    ...ACADEMIC_DEFENSE_BLUEPRINT.fonts,
    title: "Arial",
    body: "Arial",
  },
  cover: {
    title: { x: 0.76, y: 1.24, w: 6.22, h: 2.16 },
    hero: { x: 7.16, y: 0.5, w: 5.5, h: 5.84 },
    subtitle: { x: 0.78, y: 3.82, w: 6.02, h: 0.84 },
  },
  evidence: {
    narrativeWidth: 3.18,
    dominantRatio: 0.65,
    gap: 0.24,
  },
};

const PAPERCHAT_EDITORIAL_BLUEPRINT: PresentationThemeBlueprint = {
  ...ACADEMIC_DEFENSE_BLUEPRINT,
  id: "paperchat-editorial",
};

const DARK_EDITORIAL_BLUEPRINT: PresentationThemeBlueprint = {
  id: "dark-editorial",
  fonts: {
    title: "Aptos Display",
    body: "Aptos",
    mono: "Aptos Mono",
    officeTitleFallback: "Aptos Display",
    officeBodyFallback: "Aptos",
  },
  cover: {
    // The dark renderer treats the cover as one full-bleed composition. These
    // boxes remain the semantic safe areas used when no hero is available.
    title: { x: 0.82, y: 4.46, w: 8.7, h: 1.46 },
    hero: { x: 0, y: 0, w: 13.333, h: 7.5 },
    subtitle: { x: 0.84, y: 6.03, w: 7.7, h: 0.58 },
  },
  content: {
    left: 0.72,
    right: 12.62,
    bodyTop: 1.64,
    bodyBottom: 6.72,
    footerRuleY: 7.05,
  },
  evidence: {
    narrativeWidth: 2.92,
    dominantRatio: 0.72,
    gap: 0.28,
  },
};

const DESIGN_SYSTEM_BLUEPRINTS: Record<
  PresentationDesignSystem,
  PresentationThemeBlueprint
> = {
  "teal-green-academic-defense": ACADEMIC_DEFENSE_BLUEPRINT,
  "blue-line-courseware": BLUE_LINE_COURSEWARE_BLUEPRINT,
  "deep-blue-atlas": DEEP_BLUE_ATLAS_BLUEPRINT,
  "paper-white-courseware": PAPER_WHITE_COURSEWARE_BLUEPRINT,
  "pastel-derivation": PASTEL_DERIVATION_BLUEPRINT,
  "wine-red-data": WINE_RED_DATA_BLUEPRINT,
  "paperchat-editorial": PAPERCHAT_EDITORIAL_BLUEPRINT,
  "dark-editorial": DARK_EDITORIAL_BLUEPRINT,
};

export function resolvePresentationThemeBlueprint(
  spec: Pick<PresentationRequest, "designSystem" | "theme" | "sourceItemKey">,
): PresentationThemeBlueprint {
  if (spec.designSystem) return DESIGN_SYSTEM_BLUEPRINTS[spec.designSystem];
  if (spec.theme === "dark") {
    return DARK_EDITORIAL_BLUEPRINT;
  }
  if (spec.theme === "academic") {
    return ACADEMIC_DEFENSE_BLUEPRINT;
  }
  if (spec.sourceItemKey) return ACADEMIC_DEFENSE_BLUEPRINT;
  return PAPERCHAT_EDITORIAL_BLUEPRINT;
}
