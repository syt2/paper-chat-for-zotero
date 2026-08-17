import type { ToolCall, ToolExecutionResult } from "../../types/tool";
import {
  isPresentationDesignSystem,
  normalizePresentationUserInstructions,
  parsePresentationSlideCount,
} from "./PresentationLaunchSettings";

const PRESENTATION_TOOL_NAME = "presentation";
const PRESENTATION_LAUNCH_TOOL_NAME = "request_presentation";

const EXPLICIT_LANGUAGE_PATTERN =
  /(?:\b(?:zh(?:[-_](?:cn|tw|hk|mo))?|en(?:[-_][a-z]{2})?|ja(?:[-_]jp)?|ko(?:[-_]kr)?|english|chinese|japanese|korean)\b|中文|简体|繁体|英文|英语|日文|日语|韩文|韩语)/i;

const EXPLICIT_INSTRUCTION_PATTERN =
  /(?:面向|受众|重点|突出|着重|聚焦|强调|风格|样式|模板|组会|答辩|课程|课件|课堂|教学|汇报|极简|简洁|暗色|深色|青绿|青绿色|蓝线|深蓝|纸白|粉彩|酒红|编辑风|杂志风|audience|focus|emphasi[sz]e|style|theme|minimal|editorial|academic defense|courseware|atlas|pastel|wine red|dark|teal)/i;

const EXPLICIT_TITLE_PATTERN = /(?:标题|题目|命名|title|named)/i;
const EXPLICIT_FILENAME_PATTERN = /(?:文件名|档名|filename|file name)/i;

function parseArguments(toolCall: ToolCall): Record<string, unknown> | null {
  try {
    const value = JSON.parse(toolCall.function.arguments);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function cloneArguments(
  value: Record<string, unknown>,
): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function rewriteArguments(
  toolCall: ToolCall,
  args: Record<string, unknown>,
): ToolCall {
  return {
    ...toolCall,
    function: {
      ...toolCall.function,
      arguments: JSON.stringify(args),
    },
  };
}

function firstFailedPresentationArguments(
  previousResults: readonly ToolExecutionResult[],
): Record<string, unknown> | null {
  for (const result of previousResults) {
    if (
      result.toolCall.function.name !== PRESENTATION_TOOL_NAME ||
      result.status !== "failed"
    ) {
      continue;
    }
    if (result.args) {
      return cloneArguments(result.args);
    }
    const parsed = parseArguments(result.toolCall);
    if (parsed) {
      return cloneArguments(parsed);
    }
  }
  return null;
}

function explicitlyRequestsDesignSystem(
  userRequest: string,
  designSystem: unknown,
): boolean {
  if (typeof designSystem !== "string") return false;
  const normalizedRequest = userRequest.toLowerCase();
  if (normalizedRequest.includes(designSystem.toLowerCase())) return true;
  if (designSystem === "teal-green-academic-defense") {
    return /(?:青绿|青绿色|teal|学术答辩|academic defense)/i.test(userRequest);
  }
  if (designSystem === "blue-line-courseware") {
    return /(?:蓝线课件|blue[- ]line courseware)/i.test(userRequest);
  }
  if (designSystem === "deep-blue-atlas") {
    return /(?:深蓝图谱|deep[- ]blue atlas)/i.test(userRequest);
  }
  if (designSystem === "paper-white-courseware") {
    return /(?:纸白课件|paper[- ]white courseware)/i.test(userRequest);
  }
  if (designSystem === "pastel-derivation") {
    return /(?:粉彩推导|pastel derivation)/i.test(userRequest);
  }
  if (designSystem === "wine-red-data") {
    return /(?:酒红数据|wine[- ]red data)/i.test(userRequest);
  }
  if (designSystem === "paperchat-editorial") {
    return /(?:编辑风|杂志风|editorial)/i.test(userRequest);
  }
  if (designSystem === "dark-editorial") {
    return /(?:暗色|深色|dark)/i.test(userRequest);
  }
  return false;
}

function parsePositiveInteger(value: unknown): number | undefined {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value.trim())
        : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function normalizeLaunchInstructions(
  userRequest: string,
  parsedInstructions: unknown,
): string | undefined {
  if (
    !EXPLICIT_INSTRUCTION_PATTERN.test(userRequest) ||
    typeof parsedInstructions !== "string" ||
    !parsedInstructions.trim()
  ) {
    return undefined;
  }

  // The outer model is the intent extractor in this flow, so keep its concise
  // custom-requirement summary instead of echoing the entire original prompt
  // into the native field. This value remains only a visible prefill; the
  // user's confirmation dialog is authoritative. Bound it before scheduler
  // validation so an overlong suggestion cannot block opening that dialog.
  return normalizePresentationUserInstructions(parsedInstructions).slice(
    0,
    1_000,
  );
}

/**
 * Keep the public presentation tool grounded in what the user actually asked
 * for. The hidden planner owns narrative and visual planning; the outer chat
 * model must not invent style variants to recover from a failed render. Once
 * an attempt has failed, retries reuse the first normalized arguments.
 */
export function normalizePresentationToolCall(
  toolCall: ToolCall,
  userRequest: string,
  previousResults: readonly ToolExecutionResult[] = [],
): ToolCall {
  const isLaunchCall = toolCall.function.name === PRESENTATION_LAUNCH_TOOL_NAME;
  if (!isLaunchCall && toolCall.function.name !== PRESENTATION_TOOL_NAME) {
    return toolCall;
  }

  if (!isLaunchCall) {
    const retryArguments = firstFailedPresentationArguments(previousResults);
    if (retryArguments) {
      return rewriteArguments(toolCall, retryArguments);
    }
  }

  const parsed = parseArguments(toolCall);
  if (!parsed) return toolCall;

  const normalized: Record<string, unknown> = {};
  if (typeof parsed.sourceItemKey === "string" && parsed.sourceItemKey.trim()) {
    normalized.sourceItemKey = parsed.sourceItemKey.trim();
  }

  if (isLaunchCall) {
    // The model still performs intent extraction. This boundary only removes
    // optional style/instruction guesses that are not grounded in the user's
    // request; it does not derive page counts or source identities itself.
    const normalizedSourceItemKey =
      typeof normalized.sourceItemKey === "string"
        ? normalized.sourceItemKey
        : undefined;
    if (normalizedSourceItemKey && normalizedSourceItemKey.length <= 32) {
      const sourceLibraryID = parsePositiveInteger(parsed.sourceLibraryID);
      if (sourceLibraryID !== undefined) {
        normalized.sourceLibraryID = sourceLibraryID;
      }
    } else if (normalizedSourceItemKey) {
      // Item keys are identity values, not free text. Dropping an invalid
      // overlong key is safer than truncating it into another paper.
      delete normalized.sourceItemKey;
    }
    const slideCount = parsePresentationSlideCount(parsed.slideCount);
    if (slideCount !== null) {
      normalized.slideCount = slideCount;
    }
    if (
      isPresentationDesignSystem(parsed.designSystem) &&
      explicitlyRequestsDesignSystem(userRequest, parsed.designSystem)
    ) {
      normalized.designSystem = parsed.designSystem;
    }
    const instructions = normalizeLaunchInstructions(
      userRequest,
      parsed.instructions,
    );
    if (instructions) {
      normalized.instructions = instructions;
    }
    return rewriteArguments(toolCall, normalized);
  }

  if (
    EXPLICIT_LANGUAGE_PATTERN.test(userRequest) &&
    typeof parsed.language === "string" &&
    parsed.language.trim()
  ) {
    normalized.language = parsed.language.trim();
  }

  if (explicitlyRequestsDesignSystem(userRequest, parsed.designSystem)) {
    normalized.designSystem = parsed.designSystem;
  }

  if (
    EXPLICIT_TITLE_PATTERN.test(userRequest) &&
    typeof parsed.title === "string" &&
    parsed.title.trim()
  ) {
    normalized.title = parsed.title.trim();
  }

  if (
    EXPLICIT_FILENAME_PATTERN.test(userRequest) &&
    typeof parsed.fileName === "string" &&
    parsed.fileName.trim()
  ) {
    normalized.fileName = parsed.fileName.trim();
  }

  if (EXPLICIT_INSTRUCTION_PATTERN.test(userRequest)) {
    normalized.instructions = userRequest.trim().slice(0, 1_000);
  }

  return rewriteArguments(toolCall, normalized);
}
