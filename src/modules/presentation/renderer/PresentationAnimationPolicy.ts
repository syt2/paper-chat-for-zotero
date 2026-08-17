import {
  parsePresentationAnimationObjectName,
  type PresentationAnimationRole,
} from "./PresentationAnimationNames";

export type PresentationAnimationEffect = "fade" | "fly" | "zoom";
export type PresentationAnimationFlyDirection =
  | "fromLeft"
  | "fromRight"
  | "fromTop"
  | "fromBottom";

export interface PresentationAnimationTarget {
  name: string;
  role: PresentationAnimationRole;
  ordinal: number;
  effect: PresentationAnimationEffect;
  durationMs: number;
  direction?: PresentationAnimationFlyDirection;
}

const MAX_ANIMATIONS_PER_SLIDE = 3;

const ROLE_PRIORITY: Record<PresentationAnimationRole, number> = {
  "cover-title": 10,
  "content-title": 10,
  "key-message": 20,
  "cover-visual": 30,
  "evidence-visual": 30,
  chart: 30,
};

function effectForTarget(
  role: PresentationAnimationRole,
  ordinal: number,
  slideNumber: number,
): {
  effect: PresentationAnimationEffect;
  durationMs: number;
  direction?: PresentationAnimationFlyDirection;
} {
  switch (role) {
    case "cover-title":
    case "content-title":
    case "key-message":
      return { effect: "fade", durationMs: 450 };
    case "chart":
      return { effect: "zoom", durationMs: 600 };
    case "cover-visual":
      return { effect: "zoom", durationMs: 700 };
    case "evidence-visual": {
      // Rotate the visual treatment by slide so a normal deck naturally uses
      // all three restrained effects without requiring a model-facing schema.
      const effect = ["zoom", "fly", "fade"][
        (slideNumber + ordinal) % 3
      ] as PresentationAnimationEffect;
      if (effect === "fly") {
        const directions: PresentationAnimationFlyDirection[] = [
          "fromLeft",
          "fromBottom",
          "fromRight",
        ];
        return {
          effect,
          durationMs: 550,
          direction: directions[(slideNumber + ordinal) % directions.length],
        };
      }
      return { effect, durationMs: effect === "zoom" ? 650 : 450 };
    }
  }
}

/**
 * Resolve a small, deterministic set of animations for one slide.
 *
 * The renderer owns this policy. It deliberately does not accept arbitrary
 * model output, which keeps the PPTX writer bounded and makes failures
 * recoverable to a static deck.
 */
export function planPresentationSlideAnimations(
  objectNames: readonly string[],
  slideNumber: number,
): PresentationAnimationTarget[] {
  const candidates = objectNames
    .map((name) => {
      const parsed = parsePresentationAnimationObjectName(name);
      if (!parsed) return undefined;
      const effect = effectForTarget(parsed.role, parsed.ordinal, slideNumber);
      return {
        name,
        role: parsed.role,
        ordinal: parsed.ordinal,
        ...effect,
      } satisfies PresentationAnimationTarget;
    })
    .filter((target): target is PresentationAnimationTarget => Boolean(target));

  return candidates
    .sort(
      (left, right) =>
        ROLE_PRIORITY[left.role] - ROLE_PRIORITY[right.role] ||
        left.ordinal - right.ordinal,
    )
    .slice(0, MAX_ANIMATIONS_PER_SLIDE);
}

export { MAX_ANIMATIONS_PER_SLIDE };
