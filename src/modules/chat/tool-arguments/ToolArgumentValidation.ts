import type { ToolDefinition, ToolParameterProperty } from "../../../types/tool";
import { WEB_SEARCH_SOURCES } from "../../../types/tool";
import { getPdfToolManager } from "../pdf-tools";

export interface ToolArgumentValidationResult {
  ok: boolean;
  args: Record<string, unknown>;
  repairedKeys: string[];
  droppedKeys: string[];
  issues: string[];
}

let cachedToolDefinitions: Map<string, ToolDefinition["function"]["parameters"]> | null =
  null;

const CSV_STRING_KEYS = new Set(["tags", "addTags", "removeTags"]);

export function resetToolArgumentValidationCache(): void {
  cachedToolDefinitions = null;
}

export function validateAndRepairToolArguments(
  toolName: string,
  args: Record<string, unknown>,
): ToolArgumentValidationResult {
  const parameters = getToolParameters(toolName);
  if (!parameters) {
    return {
      ok: true,
      args,
      repairedKeys: [],
      droppedKeys: [],
      issues: [],
    };
  }

  const normalized: Record<string, unknown> = { ...args };
  const repairedKeys: string[] = [];
  const droppedKeys: string[] = [];

  rewriteCanonicalKeys(normalized, parameters.properties, repairedKeys);
  dropUnknownKeys(normalized, parameters.properties, droppedKeys);

  for (const [key, property] of Object.entries(parameters.properties)) {
    if (!(key in normalized)) {
      continue;
    }
    const repaired = repairPropertyValue(toolName, key, property, normalized[key]);
    if (!repaired.changed) {
      continue;
    }
    normalized[key] = repaired.value;
    repairedKeys.push(key);
  }

  const issues = validateAgainstSchema(toolName, normalized, parameters);
  return {
    ok: issues.length === 0,
    args: normalized,
    repairedKeys,
    droppedKeys,
    issues,
  };
}

function getToolParameters(
  toolName: string,
): ToolDefinition["function"]["parameters"] | null {
  if (!cachedToolDefinitions) {
    cachedToolDefinitions = new Map();
    for (const definition of getPdfToolManager().getToolDefinitions(true)) {
      cachedToolDefinitions.set(
        definition.function.name,
        definition.function.parameters,
      );
    }
  }

  return cachedToolDefinitions.get(toolName) || null;
}

function rewriteCanonicalKeys(
  args: Record<string, unknown>,
  properties: Record<string, ToolParameterProperty>,
  repairedKeys: string[],
): void {
  const canonicalByNormalized = new Map<string, string>();
  for (const key of Object.keys(properties)) {
    canonicalByNormalized.set(normalizeKey(key), key);
  }

  for (const key of Object.keys(args)) {
    if (key in properties) {
      continue;
    }
    const canonical = canonicalByNormalized.get(normalizeKey(key));
    if (!canonical || canonical in args) {
      continue;
    }
    args[canonical] = args[key];
    delete args[key];
    repairedKeys.push(`${key}->${canonical}`);
  }
}

function dropUnknownKeys(
  args: Record<string, unknown>,
  properties: Record<string, ToolParameterProperty>,
  droppedKeys: string[],
): void {
  for (const key of Object.keys(args)) {
    if (key in properties) {
      continue;
    }
    droppedKeys.push(key);
    delete args[key];
  }
}

function repairPropertyValue(
  toolName: string,
  key: string,
  property: ToolParameterProperty,
  value: unknown,
): { changed: boolean; value: unknown } {
  switch (property.type) {
    case "string":
      return repairStringValue(toolName, key, property, value);
    case "number":
      return repairNumberValue(value);
    case "boolean":
      return repairBooleanValue(value);
    case "array":
      return repairArrayValue(property, value);
    default:
      return { changed: false, value };
  }
}

function repairStringValue(
  toolName: string,
  key: string,
  property: ToolParameterProperty,
  value: unknown,
): { changed: boolean; value: unknown } {
  let nextValue = value;
  let changed = false;

  if (CSV_STRING_KEYS.has(key) && Array.isArray(nextValue)) {
    const scalarEntries = nextValue
      .map((entry) =>
        typeof entry === "string" || typeof entry === "number"
          ? String(entry).trim()
          : "",
      )
      .filter(Boolean);
    if (scalarEntries.length > 0) {
      nextValue = scalarEntries.join(", ");
      changed = true;
    }
  }

  const allowedEnum = getAllowedEnum(toolName, key, property);
  if (allowedEnum && typeof nextValue === "string") {
    const normalizedEnum = normalizeEnumValue(allowedEnum, nextValue);
    if (normalizedEnum && normalizedEnum !== nextValue) {
      nextValue = normalizedEnum;
      changed = true;
    }
  }

  return { changed, value: nextValue };
}

function repairNumberValue(
  value: unknown,
): { changed: boolean; value: unknown } {
  if (typeof value !== "string") {
    return { changed: false, value };
  }

  const trimmed = value.trim();
  if (!trimmed || !/^-?\d+(\.\d+)?$/.test(trimmed)) {
    return { changed: false, value };
  }

  return {
    changed: true,
    value: Number(trimmed),
  };
}

function repairBooleanValue(
  value: unknown,
): { changed: boolean; value: unknown } {
  if (typeof value === "number") {
    if (value === 1) {
      return { changed: true, value: true };
    }
    if (value === 0) {
      return { changed: true, value: false };
    }
    return { changed: false, value };
  }

  if (typeof value !== "string") {
    return { changed: false, value };
  }

  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes"].includes(normalized)) {
    return { changed: true, value: true };
  }
  if (["false", "0", "no"].includes(normalized)) {
    return { changed: true, value: false };
  }

  return { changed: false, value };
}

function repairArrayValue(
  property: ToolParameterProperty,
  value: unknown,
): { changed: boolean; value: unknown } {
  if (property.items?.type !== "string") {
    return { changed: false, value };
  }

  const normalized = normalizeStringArray(value);
  if (!normalized) {
    return { changed: false, value };
  }

  if (Array.isArray(value) && JSON.stringify(value) === JSON.stringify(normalized)) {
    return { changed: false, value };
  }

  return { changed: true, value: normalized };
}

function validateAgainstSchema(
  toolName: string,
  args: Record<string, unknown>,
  parameters: ToolDefinition["function"]["parameters"],
): string[] {
  const issues: string[] = [];
  const required = parameters.required || [];

  for (const key of required) {
    if (!hasMeaningfulValue(args[key])) {
      issues.push(`Missing required field: ${key}`);
    }
  }

  for (const [key, value] of Object.entries(args)) {
    const property = parameters.properties[key];
    if (!property) {
      continue;
    }

    const typeIssue = validatePropertyType(property, value);
    if (typeIssue) {
      issues.push(`${key}: ${typeIssue}`);
      continue;
    }

    const allowedEnum = getAllowedEnum(toolName, key, property);
    if (
      allowedEnum &&
      typeof value === "string" &&
      !allowedEnum.includes(value)
    ) {
      issues.push(`${key}: expected one of ${allowedEnum.join(", ")}`);
    }
  }

  return issues;
}

function validatePropertyType(
  property: ToolParameterProperty,
  value: unknown,
): string | null {
  switch (property.type) {
    case "string":
      return typeof value === "string" ? null : `expected string, got ${describeType(value)}`;
    case "number":
      return typeof value === "number" && Number.isFinite(value)
        ? null
        : `expected number, got ${describeType(value)}`;
    case "boolean":
      return typeof value === "boolean"
        ? null
        : `expected boolean, got ${describeType(value)}`;
    case "array":
      if (!Array.isArray(value)) {
        return `expected array, got ${describeType(value)}`;
      }
      if (property.items?.type === "string") {
        const invalid = value.some((entry) => typeof entry !== "string");
        if (invalid) {
          return "expected array of strings";
        }
      }
      return null;
    default:
      return null;
  }
}

function hasMeaningfulValue(value: unknown): boolean {
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  return value !== undefined && value !== null;
}

function getAllowedEnum(
  toolName: string,
  key: string,
  property: ToolParameterProperty,
): readonly string[] | undefined {
  if (toolName === "web_search" && key === "source") {
    return WEB_SEARCH_SOURCES;
  }
  return property.enum;
}

function normalizeEnumValue(
  allowed: readonly string[],
  value: string,
): string | null {
  if (allowed.includes(value)) {
    return value;
  }

  const normalizedValue = normalizeKey(value);
  for (const candidate of allowed) {
    if (normalizeKey(candidate) === normalizedValue) {
      return candidate;
    }
  }
  return null;
}

function normalizeStringArray(value: unknown): string[] | null {
  if (Array.isArray(value)) {
    const normalized = value
      .map((entry) =>
        typeof entry === "string" || typeof entry === "number"
          ? String(entry).trim()
          : "",
      )
      .filter(Boolean);
    return normalized.length > 0 ? normalized : null;
  }

  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    try {
      const parsed = JSON.parse(trimmed);
      return normalizeStringArray(parsed);
    } catch {
      // Fall through to delimiter split.
    }
  }
  return trimmed
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function describeType(value: unknown): string {
  if (Array.isArray(value)) {
    return "array";
  }
  if (value === null) {
    return "null";
  }
  return typeof value;
}
