import type PptxGenJS from "pptxgenjs";

/**
 * Names used as the stable bridge between the renderer and PPTX timing XML.
 *
 * PptxGenJS assigns numeric shape ids while serializing a slide. Those ids are
 * not stable enough to use in the renderer, so we tag only the semantic
 * objects that may receive an animation and resolve their ids after export.
 */
export const PRESENTATION_ANIMATION_NAME_PREFIX = "paperchat.anim.";

export type PresentationAnimationRole =
  | "cover-title"
  | "cover-visual"
  | "content-title"
  | "key-message"
  | "evidence-visual"
  | "chart";

interface RoleCounter {
  next: number;
}

const roleCounters = new WeakMap<
  object,
  Map<PresentationAnimationRole, RoleCounter>
>();

/** Allocate a deterministic, slide-local semantic object name. */
export function nextPresentationAnimationObjectName(
  slide: PptxGenJS.Slide,
  role: PresentationAnimationRole,
): string {
  let counters = roleCounters.get(slide);
  if (!counters) {
    counters = new Map();
    roleCounters.set(slide, counters);
  }
  const counter = counters.get(role) || { next: 1 };
  const ordinal = counter.next;
  counter.next += 1;
  counters.set(role, counter);
  return `${PRESENTATION_ANIMATION_NAME_PREFIX}${role}.${ordinal}`;
}

export interface ParsedPresentationAnimationName {
  role: PresentationAnimationRole;
  ordinal: number;
}

const PARSABLE_ROLES = new Set<PresentationAnimationRole>([
  "cover-title",
  "cover-visual",
  "content-title",
  "key-message",
  "evidence-visual",
  "chart",
]);

/** Parse a renderer-owned animation name, ignoring unrelated PPTX objects. */
export function parsePresentationAnimationObjectName(
  name: string,
): ParsedPresentationAnimationName | undefined {
  const match = name.match(/^paperchat\.anim\.([a-z-]+)\.(\d+)$/u);
  if (!match) return undefined;
  const role = match[1] as PresentationAnimationRole;
  const ordinal = Number(match[2]);
  if (
    !PARSABLE_ROLES.has(role) ||
    !Number.isSafeInteger(ordinal) ||
    ordinal < 1
  ) {
    return undefined;
  }
  return { role, ordinal };
}
