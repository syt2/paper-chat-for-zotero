import type {
  ToolExecutionResult,
  ToolSourceReference,
} from "../../types/tool";

const ZOTERO_KEY_PATTERN = /^[A-Z0-9]{8}$/;
const TRUSTED_NOTE_TOOLS = new Set(["create_note", "append_to_note"]);
const NOTE_RESULT_PATTERN =
  /^Note (?:created|appended) successfully!\s*\nNote key:\s*([A-Z0-9]{8})(?:\s|$)/;
const NAVIGATION_ATTRIBUTE_NAMES = new Set(["key", "url", "page"]);

export interface TrustedSourceTargets {
  itemKeys: ReadonlySet<string>;
  noteKeys: ReadonlySet<string>;
  annotationKeys: ReadonlySet<string>;
  collectionKeys: ReadonlySet<string>;
  webUrls: ReadonlySet<string>;
  itemPages: ReadonlySet<string>;
}

interface ParsedTagAttribute {
  name: string;
  value?: string;
  start: number;
  end: number;
}

interface ParsedTagAttributes {
  attributes: ParsedTagAttribute[];
  valid: boolean;
}

function normalizeZoteroKey(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const key = value.trim().toUpperCase();
  return ZOTERO_KEY_PATTERN.test(key) ? key : null;
}

function unescapeSourceAttribute(value: string): string {
  return value
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");
}

function escapeSourceAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function normalizeSourceUrl(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  try {
    const url = new URL(unescapeSourceAttribute(value.trim()));
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
    return url.href;
  } catch {
    return null;
  }
}

function itemPageIdentity(itemKey: string, page: number): string {
  return `${itemKey}:${page}`;
}

function parseTagAttributes(attrs: string): ParsedTagAttributes {
  const parsed: ParsedTagAttribute[] = [];
  let valid = true;
  let index = 0;

  while (index < attrs.length) {
    const whitespaceStart = index;
    while (index < attrs.length && /\s/.test(attrs[index])) {
      index += 1;
    }
    if (index >= attrs.length) {
      break;
    }

    const nameStart = index;
    if (!/[A-Za-z_:]/.test(attrs[index])) {
      valid = false;
      index += 1;
      continue;
    }
    index += 1;
    while (index < attrs.length && /[A-Za-z0-9_.:-]/.test(attrs[index])) {
      index += 1;
    }
    const nameEnd = index;
    const name = attrs.slice(nameStart, index).toLowerCase();
    const attributeStart =
      whitespaceStart < nameStart ? whitespaceStart : nameStart;

    while (index < attrs.length && /\s/.test(attrs[index])) {
      index += 1;
    }
    if (attrs[index] !== "=") {
      valid = false;
      parsed.push({ name, start: attributeStart, end: nameEnd });
      continue;
    }

    index += 1;
    while (index < attrs.length && /\s/.test(attrs[index])) {
      index += 1;
    }

    let value = "";
    if (attrs[index] === '"' || attrs[index] === "'") {
      const quote = attrs[index];
      index += 1;
      const valueStart = index;
      while (index < attrs.length && attrs[index] !== quote) {
        index += 1;
      }
      value = attrs.slice(valueStart, index);
      if (index < attrs.length) {
        index += 1;
      } else {
        valid = false;
      }
    } else {
      valid = false;
      const valueStart = index;
      while (index < attrs.length && !/\s/.test(attrs[index])) {
        index += 1;
      }
      value = attrs.slice(valueStart, index);
    }

    parsed.push({ name, value, start: attributeStart, end: index });
  }

  return { attributes: parsed, valid };
}

function getAttribute(
  parsed: ParsedTagAttribute[],
  name: string,
): string | undefined {
  return parsed.find((attribute) => attribute.name === name)?.value;
}

function stripNavigationAttributes(
  attrs: string,
  parsed: ParsedTagAttribute[],
): string {
  let output = "";
  let cursor = 0;
  for (const attribute of parsed) {
    if (!NAVIGATION_ATTRIBUTE_NAMES.has(attribute.name)) {
      continue;
    }
    output += attrs.slice(cursor, attribute.start);
    cursor = Math.max(cursor, attribute.end);
  }
  return output + attrs.slice(cursor);
}

function appendCanonicalAttributes(attrs: string, canonical: string[]): string {
  if (canonical.length === 0) {
    return attrs;
  }
  const selfClosing = attrs.match(/\s*\/\s*$/)?.[0];
  if (!selfClosing) {
    return `${attrs} ${canonical.join(" ")}`;
  }
  return `${attrs.slice(0, -selfClosing.length)} ${canonical.join(" ")}${selfClosing}`;
}

function addReferenceToTargets(
  reference: ToolSourceReference,
  targets: {
    itemKeys: Set<string>;
    noteKeys: Set<string>;
    annotationKeys: Set<string>;
    collectionKeys: Set<string>;
    webUrls: Set<string>;
  },
): void {
  switch (reference.type) {
    case "item": {
      const key = normalizeZoteroKey(reference.key);
      if (key) targets.itemKeys.add(key);
      break;
    }
    case "note": {
      const key = normalizeZoteroKey(reference.key);
      if (key) targets.noteKeys.add(key);
      break;
    }
    case "annotation": {
      const key = normalizeZoteroKey(reference.key);
      if (key) targets.annotationKeys.add(key);
      break;
    }
    case "collection": {
      const key = normalizeZoteroKey(reference.key);
      if (key) targets.collectionKeys.add(key);
      break;
    }
    case "web": {
      const url = normalizeSourceUrl(reference.url);
      if (url) targets.webUrls.add(url);
      break;
    }
    case "page":
      break;
  }
}

export function collectTrustedSourceTargets(
  results: ToolExecutionResult[],
): TrustedSourceTargets {
  const targets = {
    itemKeys: new Set<string>(),
    noteKeys: new Set<string>(),
    annotationKeys: new Set<string>(),
    collectionKeys: new Set<string>(),
    webUrls: new Set<string>(),
  };

  for (const result of results) {
    if (result.status !== "completed") {
      continue;
    }
    for (const reference of result.references || []) {
      addReferenceToTargets(reference, targets);
    }
  }

  const itemPages = new Set<string>();
  for (const result of results) {
    if (result.status !== "completed") {
      continue;
    }
    for (const reference of result.references || []) {
      if (reference.type !== "page") {
        continue;
      }
      const itemKey = normalizeZoteroKey(reference.itemKey);
      const page = reference.page;
      if (
        itemKey &&
        targets.itemKeys.has(itemKey) &&
        Number.isSafeInteger(page) &&
        page > 0
      ) {
        itemPages.add(itemPageIdentity(itemKey, page));
      }
    }
  }

  return { ...targets, itemPages };
}

export function sanitizeSourceGroupTargets(
  content: string,
  trustedTargets: TrustedSourceTargets,
): string {
  const openingTagPattern = /<source-group\b/gi;
  let sanitized = "";
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = openingTagPattern.exec(content)) !== null) {
    sanitized += content.slice(cursor, match.index);
    const tagEnd = findOpeningTagEnd(content, openingTagPattern.lastIndex);
    if (tagEnd === null) {
      return (
        sanitized +
        "<invalid-source-group" +
        content.slice(openingTagPattern.lastIndex)
      );
    }
    const attrs = content.slice(openingTagPattern.lastIndex, tagEnd);
    const parsedResult = parseTagAttributes(attrs);
    if (!parsedResult.valid) {
      sanitized += `<invalid-source-group${attrs}>`;
      cursor = tagEnd + 1;
      openingTagPattern.lastIndex = cursor;
      continue;
    }
    const parsed = parsedResult.attributes;
    const type = (getAttribute(parsed, "type") || "paper").trim().toLowerCase();
    const rawKey = normalizeZoteroKey(getAttribute(parsed, "key"));
    const rawUrl = normalizeSourceUrl(getAttribute(parsed, "url"));
    const rawPage = getAttribute(parsed, "page")?.trim();
    const page = rawPage && /^\d+$/.test(rawPage) ? Number(rawPage) : null;
    const canonical: string[] = [];

    if (
      (type === "paper" || type === "item") &&
      rawKey &&
      trustedTargets.itemKeys.has(rawKey)
    ) {
      canonical.push(`key="${rawKey}"`);
      if (
        page !== null &&
        Number.isSafeInteger(page) &&
        page > 0 &&
        trustedTargets.itemPages.has(itemPageIdentity(rawKey, page))
      ) {
        canonical.push(`page="${page}"`);
      }
    } else if (
      type === "note" &&
      rawKey &&
      trustedTargets.noteKeys.has(rawKey)
    ) {
      canonical.push(`key="${rawKey}"`);
    } else if (
      type === "annotation" &&
      rawKey &&
      trustedTargets.annotationKeys.has(rawKey)
    ) {
      canonical.push(`key="${rawKey}"`);
    } else if (
      type === "collection" &&
      rawKey &&
      trustedTargets.collectionKeys.has(rawKey)
    ) {
      canonical.push(`key="${rawKey}"`);
    } else if (type === "web" && rawUrl && trustedTargets.webUrls.has(rawUrl)) {
      canonical.push(`url="${escapeSourceAttribute(rawUrl)}"`);
    }

    const attrsWithoutNavigation = stripNavigationAttributes(attrs, parsed);
    sanitized += `<source-group${appendCanonicalAttributes(
      attrsWithoutNavigation,
      canonical,
    )}>`;
    cursor = tagEnd + 1;
    openingTagPattern.lastIndex = cursor;
  }

  return sanitized + content.slice(cursor);
}

/**
 * Compatibility helper for callers/tests that only deal with generated Note
 * writes. New completion paths should use collectTrustedSourceTargets.
 */
export function collectTrustedGeneratedNoteKeys(
  results: ToolExecutionResult[],
): Set<string> {
  const keys = new Set(collectTrustedSourceTargets(results).noteKeys);
  for (const result of results) {
    if (
      result.status !== "completed" ||
      !TRUSTED_NOTE_TOOLS.has(result.toolCall.function.name)
    ) {
      continue;
    }
    const key = normalizeZoteroKey(
      result.content.match(NOTE_RESULT_PATTERN)?.[1],
    );
    if (key) {
      keys.add(key);
    }
  }
  return keys;
}

/** Compatibility wrapper for the original Note-only sanitizer API. */
export function sanitizeNoteSourceGroupKeys(
  content: string,
  trustedNoteKeys: ReadonlySet<string>,
): string {
  return sanitizeSourceGroupTargets(content, {
    itemKeys: new Set(),
    noteKeys: trustedNoteKeys,
    annotationKeys: new Set(),
    collectionKeys: new Set(),
    webUrls: new Set(),
    itemPages: new Set(),
  });
}

function findOpeningTagEnd(content: string, start: number): number | null {
  let quote: '"' | "'" | null = null;
  for (let index = start; index < content.length; index += 1) {
    const char = content[index];
    if (quote) {
      if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === ">") {
      return index;
    }
  }
  return null;
}
