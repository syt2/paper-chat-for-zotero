/** Return the end offset of a direct `p:*` child of a slide root. */
export function slideRootChildEnd(
  slideXml: string,
  childName: string,
  searchFrom = 0,
): number | undefined {
  const opening = `<p:${childName}`;
  const start = slideXml.indexOf(opening, searchFrom);
  if (start < 0) return undefined;
  const openingEnd = slideXml.indexOf(">", start + opening.length);
  if (openingEnd < 0) return undefined;
  if (slideXml[openingEnd - 1] === "/") return openingEnd + 1;
  const closing = `</p:${childName}>`;
  const closingStart = slideXml.indexOf(closing, openingEnd + 1);
  return closingStart < 0 ? undefined : closingStart + closing.length;
}

/**
 * Find the legal insertion point for a root-level timing child.
 *
 * CT_Slide orders its common slide data and optional color map first, then a
 * transition, then timing and extension children. Existing transitions are
 * preserved and the caller can insert timing immediately after them.
 */
export function slideRootTimingInsertionPoint(slideXml: string): number {
  const commonSlideEnd = slideRootChildEnd(slideXml, "cSld");
  if (commonSlideEnd === undefined) {
    throw new Error("Slide XML has no complete p:cSld root child.");
  }
  const colorMapEnd = slideRootChildEnd(slideXml, "clrMapOvr", commonSlideEnd);
  const afterCommonChildren = colorMapEnd ?? commonSlideEnd;
  const transitionEnd = slideRootChildEnd(
    slideXml,
    "transition",
    afterCommonChildren,
  );
  return transitionEnd ?? afterCommonChildren;
}

export function insertSlideRootTiming(
  slideXml: string,
  timingXml: string,
): string {
  const insertionPoint = slideRootTimingInsertionPoint(slideXml);
  return `${slideXml.slice(0, insertionPoint)}${timingXml}${slideXml.slice(insertionPoint)}`;
}
