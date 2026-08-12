import type { PresentationRequest } from "../PresentationSchema";

export interface PresentationThemeBlueprint {
  id: "teal-green-academic-defense" | "paperchat-editorial" | "dark-editorial";
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

export function resolvePresentationThemeBlueprint(
  spec: Pick<PresentationRequest, "designSystem" | "theme" | "sourceItemKey">,
): PresentationThemeBlueprint {
  if (spec.designSystem === "paperchat-editorial") {
    return PAPERCHAT_EDITORIAL_BLUEPRINT;
  }
  if (spec.designSystem === "dark-editorial" || spec.theme === "dark") {
    return DARK_EDITORIAL_BLUEPRINT;
  }
  if (
    spec.designSystem === "teal-green-academic-defense" ||
    spec.theme === "academic"
  ) {
    return ACADEMIC_DEFENSE_BLUEPRINT;
  }
  if (spec.sourceItemKey) return ACADEMIC_DEFENSE_BLUEPRINT;
  return PAPERCHAT_EDITORIAL_BLUEPRINT;
}
