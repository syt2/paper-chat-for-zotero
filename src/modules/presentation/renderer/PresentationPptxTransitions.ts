import JSZip from "jszip";
import { slideRootChildEnd } from "./PresentationPptxXml";

const SLIDE_XML_PATH = /^ppt\/slides\/slide\d+\.xml$/u;
const EXISTING_TRANSITION =
  /<p:transition\b[^>]*(?:\/>|>[\s\S]*?<\/p:transition>)/gu;
const FADE_TRANSITION_XML =
  '<p:transition spd="fast" advClick="1"><p:fade/></p:transition>';

/**
 * OOXML requires `transition` to be a direct CT_Slide child after `cSld` and
 * optional `clrMapOvr`, but before optional `timing` and `extLst` children.
 */
export function applyDefaultFadeTransitionToSlideXml(slideXml: string): string {
  const withoutTransition = slideXml.replace(EXISTING_TRANSITION, "");
  const commonSlideEnd = slideRootChildEnd(withoutTransition, "cSld");
  if (commonSlideEnd === undefined) {
    throw new Error("Slide XML has no complete p:cSld root child.");
  }
  const colorMapEnd = slideRootChildEnd(
    withoutTransition,
    "clrMapOvr",
    commonSlideEnd,
  );
  const insertionPoint = colorMapEnd ?? commonSlideEnd;
  return `${withoutTransition.slice(0, insertionPoint)}${FADE_TRANSITION_XML}${withoutTransition.slice(insertionPoint)}`;
}

/** Add a default fade transition to every slide without external tooling. */
export async function applyDefaultFadeTransitions(
  bytes: Uint8Array,
): Promise<Uint8Array> {
  const archive = await JSZip.loadAsync(bytes);
  const slidePaths = Object.keys(archive.files).filter((path) =>
    SLIDE_XML_PATH.test(path),
  );
  if (slidePaths.length === 0) {
    throw new Error("PPTX contains no slide XML entries.");
  }

  await Promise.all(
    slidePaths.map(async (path) => {
      const entry = archive.file(path);
      if (!entry) throw new Error(`PPTX slide entry is missing: ${path}`);
      const xml = await entry.async("string");
      archive.file(path, applyDefaultFadeTransitionToSlideXml(xml));
    }),
  );

  return archive.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
}
