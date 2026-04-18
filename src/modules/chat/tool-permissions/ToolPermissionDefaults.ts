import type {
  ToolPermissionMode,
  ToolPermissionRiskLevel,
} from "../../../types/tool";
import { getPref, setPref } from "../../../utils/prefs";

export const DEFAULT_MODE_BY_RISK_LEVEL: Record<
  ToolPermissionRiskLevel,
  ToolPermissionMode
> = {
  read: "auto_allow",
  network: "auto_allow",
  write: "auto_allow",
  memory: "auto_allow",
  high_cost: "auto_allow",
};

export const CONFIGURABLE_TOOL_PERMISSION_RISK_LEVELS: ToolPermissionRiskLevel[] =
  ["network", "write", "memory", "high_cost"];

function isToolPermissionMode(value: unknown): value is ToolPermissionMode {
  return value === "auto_allow" || value === "ask" || value === "deny";
}

function isToolPermissionRiskLevel(
  value: string,
): value is ToolPermissionRiskLevel {
  return (
    value === "read" ||
    value === "network" ||
    value === "write" ||
    value === "memory" ||
    value === "high_cost"
  );
}

export function getToolPermissionDefaultModes(): Record<
  ToolPermissionRiskLevel,
  ToolPermissionMode
> {
  const mergedDefaults = { ...DEFAULT_MODE_BY_RISK_LEVEL };
  const raw = getPref("toolPermissionDefaultModes");
  if (!raw || typeof raw !== "string") {
    return mergedDefaults;
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    for (const [riskLevel, mode] of Object.entries(parsed)) {
      if (
        !isToolPermissionRiskLevel(riskLevel) ||
        !isToolPermissionMode(mode)
      ) {
        continue;
      }
      mergedDefaults[riskLevel] = mode;
    }
  } catch {
    return mergedDefaults;
  }

  return mergedDefaults;
}

export function getToolPermissionDefaultMode(
  riskLevel: ToolPermissionRiskLevel,
): ToolPermissionMode {
  return getToolPermissionDefaultModes()[riskLevel];
}

export function setToolPermissionDefaultMode(
  riskLevel: ToolPermissionRiskLevel,
  mode: ToolPermissionMode,
): void {
  const nextModes = getToolPermissionDefaultModes();
  nextModes[riskLevel] = mode;
  setPref("toolPermissionDefaultModes", JSON.stringify(nextModes));
}
