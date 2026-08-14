export const PRESENTATION_SLIDE_COUNTS = [6, 10, 15] as const;

export const PRESENTATION_MINIMUM_SLIDE_COUNT = 4;
export const PRESENTATION_MAXIMUM_SLIDE_COUNT = 30;

export type PresentationPresetSlideCount =
  (typeof PRESENTATION_SLIDE_COUNTS)[number];
export type PresentationSlideCount = number;

export const PRESENTATION_DESIGN_SYSTEMS = [
  "teal-green-academic-defense",
  "paperchat-editorial",
  "dark-editorial",
] as const;

export type PresentationDesignSystem =
  (typeof PRESENTATION_DESIGN_SYSTEMS)[number];

export interface PresentationLaunchSettings {
  slideCount: PresentationSlideCount;
  designSystem: PresentationDesignSystem;
}

export const DEFAULT_PRESENTATION_LAUNCH_SETTINGS = Object.freeze({
  slideCount: 6,
  designSystem: "teal-green-academic-defense",
}) satisfies Readonly<PresentationLaunchSettings>;

export function isPresentationSlideCount(
  value: unknown,
): value is PresentationSlideCount {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= PRESENTATION_MINIMUM_SLIDE_COUNT &&
    value <= PRESENTATION_MAXIMUM_SLIDE_COUNT
  );
}

export function isPresentationPresetSlideCount(
  value: unknown,
): value is PresentationPresetSlideCount {
  return PRESENTATION_SLIDE_COUNTS.includes(
    value as PresentationPresetSlideCount,
  );
}

export function parsePresentationSlideCount(
  value: unknown,
): PresentationSlideCount | null {
  const parsed =
    typeof value === "string" && value.trim()
      ? Number(value.trim())
      : typeof value === "number"
        ? value
        : Number.NaN;
  return isPresentationSlideCount(parsed) ? parsed : null;
}

export function resolvePresentationSlideCount(
  value: unknown,
): PresentationSlideCount {
  return (
    parsePresentationSlideCount(value) ??
    DEFAULT_PRESENTATION_LAUNCH_SETTINGS.slideCount
  );
}

export function isPresentationDesignSystem(
  value: unknown,
): value is PresentationDesignSystem {
  return PRESENTATION_DESIGN_SYSTEMS.includes(
    value as PresentationDesignSystem,
  );
}

export function normalizePresentationLaunchSettings(
  value: Partial<PresentationLaunchSettings> | null | undefined,
): PresentationLaunchSettings {
  return {
    slideCount: resolvePresentationSlideCount(value?.slideCount),
    designSystem: isPresentationDesignSystem(value?.designSystem)
      ? value.designSystem
      : DEFAULT_PRESENTATION_LAUNCH_SETTINGS.designSystem,
  };
}
