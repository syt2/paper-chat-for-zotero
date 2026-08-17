import JSZip from "jszip";
import { insertSlideRootTiming } from "./PresentationPptxXml";
import {
  planPresentationSlideAnimations,
  type PresentationAnimationFlyDirection,
  type PresentationAnimationTarget,
} from "./PresentationAnimationPolicy";
import {
  parsePresentationAnimationObjectName,
  type PresentationAnimationRole,
} from "./PresentationAnimationNames";

const SLIDE_XML_PATH = /^ppt\/slides\/slide\d+\.xml$/u;
const EXISTING_TIMING = /<p:timing\b[^>]*(?:\/>|>[\s\S]*?<\/p:timing>)/u;
const CNVPR_OPENING_TAG = /<p:cNvPr\b[^>]*>/gu;
const XML_ATTRIBUTE = (name: string): RegExp =>
  new RegExp(`\\b${name}="([^"]*)"`, "u");

export interface PresentationPptxAnimationInjectionResult {
  bytes: Uint8Array;
  warnings: string[];
  injectedSlides: number;
  injectedAnimations: number;
}

interface NamedShapeTarget {
  name: string;
  role: PresentationAnimationRole;
  ordinal: number;
  spid: number;
}

interface SlideAnimationXmlResult {
  xml: string;
  warnings: string[];
  injectedAnimations: number;
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&amp;/gu, "&")
    .replace(/&#x([0-9a-f]+);/giu, (_match, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    )
    .replace(/&#(\d+);/gu, (_match, code: string) =>
      String.fromCodePoint(Number(code)),
    );
}

function readXmlAttribute(tag: string, name: string): string | undefined {
  const value = tag.match(XML_ATTRIBUTE(name))?.[1];
  return value === undefined ? undefined : decodeXmlEntities(value);
}

function collectNamedShapeTargets(slideXml: string): {
  targets: NamedShapeTarget[];
  warnings: string[];
} {
  const warnings: string[] = [];
  const byName = new Map<string, NamedShapeTarget[]>();
  const bySpid = new Map<number, NamedShapeTarget[]>();

  for (const match of slideXml.matchAll(CNVPR_OPENING_TAG)) {
    const tag = match[0];
    const name = readXmlAttribute(tag, "name");
    const spidText = readXmlAttribute(tag, "id");
    if (!name || !spidText) continue;
    const parsed = parsePresentationAnimationObjectName(name);
    const spid = Number(spidText);
    if (!parsed || !Number.isSafeInteger(spid) || spid < 1) continue;
    const target: NamedShapeTarget = { name, ...parsed, spid };
    const named = byName.get(name) || [];
    named.push(target);
    byName.set(name, named);
    const shaped = bySpid.get(spid) || [];
    shaped.push(target);
    bySpid.set(spid, shaped);
  }

  const targets: NamedShapeTarget[] = [];
  for (const [name, candidates] of byName) {
    if (candidates.length !== 1) {
      warnings.push(
        `Skipped animation target ${name}: its semantic name occurs ${candidates.length} times on one slide.`,
      );
      continue;
    }
    const candidate = candidates[0];
    const sameId = bySpid.get(candidate.spid) || [];
    if (sameId.length !== 1) {
      warnings.push(
        `Skipped animation target ${name}: shape id ${candidate.spid} is not unique on one slide.`,
      );
      continue;
    }
    targets.push(candidate);
  }
  return { targets, warnings };
}

function targetXml(spid: number): string {
  return `<p:tgtEl><p:spTgt spid="${spid}"/></p:tgtEl>`;
}

function visibilitySetXml(spid: number, id: number): string {
  return `<p:set><p:cBhvr><p:cTn id="${id}" dur="1" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst></p:cTn>${targetXml(spid)}<p:attrNameLst><p:attrName>style.visibility</p:attrName></p:attrNameLst></p:cBhvr><p:to><p:strVal val="visible"/></p:to></p:set>`;
}

function fadeEffectXml(
  target: PresentationAnimationTarget & { spid: number },
  id: number,
): string {
  return `<p:animEffect transition="in" filter="fade"><p:cBhvr><p:cTn id="${id}" dur="${target.durationMs}"/>${targetXml(target.spid)}</p:cBhvr></p:animEffect>`;
}

function flyParameters(direction: PresentationAnimationFlyDirection): {
  presetSubtype: number;
  attribute: "ppt_x" | "ppt_y";
  from: string;
} {
  switch (direction) {
    case "fromBottom":
      return { presetSubtype: 4, attribute: "ppt_y", from: "1+#ppt_h/2" };
    case "fromRight":
      return { presetSubtype: 2, attribute: "ppt_x", from: "1+#ppt_w/2" };
    case "fromTop":
      return { presetSubtype: 1, attribute: "ppt_y", from: "0-#ppt_h/2" };
    case "fromLeft":
      return { presetSubtype: 8, attribute: "ppt_x", from: "0-#ppt_w/2" };
  }
}

function numericAnimationXml(
  spid: number,
  id: number,
  durationMs: number,
  attribute: string,
  from: string,
): string {
  return `<p:anim calcmode="lin" valueType="num"><p:cBhvr additive="base"><p:cTn id="${id}" dur="${durationMs}" fill="hold"/>${targetXml(spid)}<p:attrNameLst><p:attrName>${attribute}</p:attrName></p:attrNameLst></p:cBhvr><p:tavLst><p:tav tm="0"><p:val><p:strVal val="${from}"/></p:val></p:tav><p:tav tm="100000"><p:val><p:strVal val="#${attribute}"/></p:val></p:tav></p:tavLst></p:anim>`;
}

function effectDetails(
  target: PresentationAnimationTarget & { spid: number },
  ids: { next: () => number },
): { presetId: number; presetSubtype: number; body: string } {
  switch (target.effect) {
    case "fade":
      return {
        presetId: 10,
        presetSubtype: 0,
        body: `${visibilitySetXml(target.spid, ids.next())}${fadeEffectXml(target, ids.next())}`,
      };
    case "fly": {
      const parameters = flyParameters(target.direction || "fromLeft");
      return {
        presetId: 2,
        presetSubtype: parameters.presetSubtype,
        body: `${visibilitySetXml(target.spid, ids.next())}${numericAnimationXml(target.spid, ids.next(), target.durationMs, parameters.attribute, parameters.from)}`,
      };
    }
    case "zoom":
      return {
        presetId: 23,
        presetSubtype: 16,
        body: [
          visibilitySetXml(target.spid, ids.next()),
          numericAnimationXml(
            target.spid,
            ids.next(),
            target.durationMs,
            "ppt_w",
            "0",
          ),
          numericAnimationXml(
            target.spid,
            ids.next(),
            target.durationMs,
            "ppt_h",
            "0",
          ),
          numericAnimationXml(
            target.spid,
            ids.next(),
            target.durationMs,
            "ppt_x",
            "0.5",
          ),
          numericAnimationXml(
            target.spid,
            ids.next(),
            target.durationMs,
            "ppt_y",
            "0.5",
          ),
        ].join(""),
      };
  }
}

function animationNodeXml(
  target: PresentationAnimationTarget & { spid: number },
  delayMs: number,
  groupId: number,
  ids: { next: () => number },
): string {
  const details = effectDetails(target, ids);
  const presetId = ids.next();
  const outerId = ids.next();
  return `<p:par><p:cTn id="${outerId}" fill="hold"><p:stCondLst><p:cond delay="${delayMs}"/></p:stCondLst><p:childTnLst><p:par><p:cTn id="${presetId}" presetID="${details.presetId}" presetClass="entr" presetSubtype="${details.presetSubtype}" fill="hold" grpId="${groupId}" nodeType="afterEffect"><p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst>${details.body}</p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn></p:par>`;
}

function buildTimingXml(
  targets: readonly (PresentationAnimationTarget & { spid: number })[],
): string {
  let nextId = 1;
  const ids = { next: () => nextId++ };
  let delayMs = 0;
  const nodes = targets
    .map((target, index) => {
      const node = animationNodeXml(target, delayMs, index, ids);
      delayMs += target.durationMs;
      return node;
    })
    .join("");
  const buildList = targets
    .map(
      (target, index) =>
        `<p:bldP spid="${target.spid}" grpId="${index}" animBg="1"/>`,
    )
    .join("");

  return `<p:timing><p:tnLst><p:par><p:cTn id="${ids.next()}" dur="indefinite" restart="never" nodeType="tmRoot"><p:childTnLst><p:seq concurrent="1" nextAc="seek"><p:cTn id="${ids.next()}" dur="indefinite" nodeType="mainSeq"><p:childTnLst>${nodes}</p:childTnLst></p:cTn><p:prevCondLst><p:cond evt="onPrev" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:prevCondLst><p:nextCondLst><p:cond evt="onNext" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:nextCondLst></p:seq></p:childTnLst></p:cTn></p:par></p:tnLst><p:bldLst>${buildList}</p:bldLst></p:timing>`;
}

function applyAnimationsToSlideXml(
  slideXml: string,
  slideNumber: number,
): SlideAnimationXmlResult {
  if (EXISTING_TIMING.test(slideXml)) {
    return {
      xml: slideXml,
      warnings: [
        `Skipped element animations on slide ${slideNumber}: the slide already contains timing XML.`,
      ],
      injectedAnimations: 0,
    };
  }

  const { targets: namedTargets, warnings } =
    collectNamedShapeTargets(slideXml);
  const planned = planPresentationSlideAnimations(
    namedTargets.map((target) => target.name),
    slideNumber,
  );
  const targetByName = new Map(
    namedTargets.map((target) => [target.name, target]),
  );
  const targets = planned.flatMap((target) => {
    const namedTarget = targetByName.get(target.name);
    return namedTarget ? [{ ...target, spid: namedTarget.spid }] : [];
  });
  if (targets.length === 0) {
    return { xml: slideXml, warnings, injectedAnimations: 0 };
  }

  const timingXml = buildTimingXml(targets);
  return {
    xml: insertSlideRootTiming(slideXml, timingXml),
    warnings,
    injectedAnimations: targets.length,
  };
}

/** Exposed for focused XML tests and for callers that already have one slide. */
export function applyPresentationAnimationsToSlideXml(
  slideXml: string,
  slideNumber = 1,
): string {
  return applyAnimationsToSlideXml(slideXml, slideNumber).xml;
}

/**
 * Inject bounded element animations into a PPTX archive.
 *
 * This function only throws when the archive itself cannot be read or contains
 * no slides. Per-slide defects are converted to warnings so the exporter can
 * retain the original static bytes.
 */
export async function applyPresentationAnimations(
  bytes: Uint8Array,
): Promise<PresentationPptxAnimationInjectionResult> {
  const archive = await JSZip.loadAsync(bytes);
  const slidePaths = Object.keys(archive.files)
    .filter((path) => SLIDE_XML_PATH.test(path))
    .sort((left, right) => {
      const leftNumber = Number(left.match(/slide(\d+)\.xml$/u)?.[1] || 0);
      const rightNumber = Number(right.match(/slide(\d+)\.xml$/u)?.[1] || 0);
      return leftNumber - rightNumber;
    });
  if (slidePaths.length === 0) {
    throw new Error("PPTX contains no slide XML entries.");
  }

  const warnings: string[] = [];
  let injectedSlides = 0;
  let injectedAnimations = 0;
  for (const [index, path] of slidePaths.entries()) {
    const entry = archive.file(path);
    if (!entry) {
      warnings.push(
        `Skipped element animations: slide entry is missing: ${path}`,
      );
      continue;
    }
    const slideNumber = index + 1;
    try {
      const result = applyAnimationsToSlideXml(
        await entry.async("string"),
        slideNumber,
      );
      archive.file(path, result.xml);
      warnings.push(...result.warnings);
      if (result.injectedAnimations > 0) injectedSlides += 1;
      injectedAnimations += result.injectedAnimations;
    } catch (error) {
      warnings.push(
        `Skipped element animations on slide ${slideNumber}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  return {
    bytes: await archive.generateAsync({
      type: "uint8array",
      compression: "DEFLATE",
      compressionOptions: { level: 6 },
    }),
    warnings,
    injectedSlides,
    injectedAnimations,
  };
}

export { buildTimingXml, collectNamedShapeTargets, applyAnimationsToSlideXml };
