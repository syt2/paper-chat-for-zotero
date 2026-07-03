import type {
  RequestUserInputAnswer,
  RequestUserInputArgs,
  RequestUserInputOption,
  RequestUserInputQuestion,
  RequestUserInputQuestionType,
  RequestUserInputResponse,
} from "../../../types/tool";

const MAX_QUESTIONS = 3;
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 4;
const MAX_TEXT_LENGTH = 500;
const MIN_AUTO_RESOLUTION_MS = 60_000;
const MAX_AUTO_RESOLUTION_MS = 240_000;

export type RequestUserInputValidationResult =
  | {
      ok: true;
      args: RequestUserInputArgs;
      warnings: string[];
    }
  | {
      ok: false;
      issues: string[];
    };

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizeId(value: unknown, fallback: string): string {
  const raw = asString(value) || fallback;
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
}

function normalizeQuestionType(
  question: Record<string, unknown>,
): RequestUserInputQuestionType {
  const raw = asString(question.type);
  if (
    raw === "single_choice" ||
    raw === "multi_choice" ||
    raw === "text" ||
    raw === "secret" ||
    raw === "confirm"
  ) {
    return raw;
  }
  return Array.isArray(question.options) ? "single_choice" : "text";
}

function normalizeOption(
  option: unknown,
  index: number,
): RequestUserInputOption | null {
  if (!option || typeof option !== "object" || Array.isArray(option)) {
    return null;
  }
  const raw = option as Record<string, unknown>;
  const label = asString(raw.label);
  if (!label) {
    return null;
  }
  return {
    label: label.slice(0, 80),
    description: (asString(raw.description) || "").slice(0, 180),
    value: (
      asString(raw.value) || normalizeId(label, `option_${index + 1}`)
    ).slice(0, 80),
    recommended: raw.recommended === true,
  };
}

function normalizeQuestion(
  rawQuestion: unknown,
  index: number,
  usedIds: Set<string>,
  issues: string[],
  warnings: string[],
): RequestUserInputQuestion | null {
  if (
    !rawQuestion ||
    typeof rawQuestion !== "object" ||
    Array.isArray(rawQuestion)
  ) {
    issues.push(`Question ${index + 1} must be an object.`);
    return null;
  }

  const raw = rawQuestion as Record<string, unknown>;
  let id = normalizeId(raw.id, `question_${index + 1}`);
  if (usedIds.has(id)) {
    id = `${id}_${index + 1}`.slice(0, 64);
    warnings.push(`Question id duplicated; normalized to ${id}.`);
  }
  usedIds.add(id);

  const header = asString(raw.header);
  const question = asString(raw.question);
  if (!header) {
    issues.push(`Question ${id} is missing a header.`);
  }
  if (!question) {
    issues.push(`Question ${id} is missing question text.`);
  }

  const type = normalizeQuestionType(raw);
  const options = Array.isArray(raw.options)
    ? raw.options
        .map((option, optionIndex) => normalizeOption(option, optionIndex))
        .filter((option): option is RequestUserInputOption => !!option)
    : undefined;

  if (
    type === "single_choice" ||
    type === "multi_choice" ||
    type === "confirm"
  ) {
    if (!options || options.length < MIN_OPTIONS) {
      issues.push(
        `Question ${id} must include at least ${MIN_OPTIONS} options.`,
      );
    }
    if (options && options.length > MAX_OPTIONS) {
      issues.push(
        `Question ${id} must include at most ${MAX_OPTIONS} options.`,
      );
    }
  }
  if ((type === "text" || type === "secret") && options?.length) {
    warnings.push(`Question ${id} ignores options because it is ${type}.`);
  }

  const normalized: RequestUserInputQuestion = {
    id,
    header: (header || "Choose").slice(0, 40),
    question: (question || "").slice(0, 320),
    type,
    options,
    allowOther: raw.allowOther === true,
    required: raw.required !== false,
    placeholder: asString(raw.placeholder)?.slice(0, 120),
    isSecret: raw.isSecret === true || type === "secret",
  };

  if (typeof raw.defaultValue === "string") {
    normalized.defaultValue = raw.defaultValue.slice(0, MAX_TEXT_LENGTH);
  } else if (typeof raw.defaultValue === "boolean") {
    normalized.defaultValue = raw.defaultValue;
  } else if (Array.isArray(raw.defaultValue)) {
    normalized.defaultValue = raw.defaultValue
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.slice(0, 80));
  }

  if (typeof raw.minSelections === "number") {
    normalized.minSelections = Math.max(0, Math.floor(raw.minSelections));
  }
  if (typeof raw.maxSelections === "number") {
    normalized.maxSelections = Math.max(1, Math.floor(raw.maxSelections));
  }
  if (
    type === "multi_choice" &&
    normalized.minSelections !== undefined &&
    normalized.maxSelections !== undefined &&
    normalized.minSelections > normalized.maxSelections
  ) {
    issues.push(`Question ${id} has minSelections greater than maxSelections.`);
  }
  if (type === "secret" && normalized.defaultValue !== undefined) {
    warnings.push(
      `Question ${id} defaultValue was dropped because it is a secret.`,
    );
    delete normalized.defaultValue;
  }

  return normalized;
}

function hasAutoResolutionDefault(question: RequestUserInputQuestion): boolean {
  if (question.required === false) {
    return true;
  }
  if (
    question.type === "single_choice" ||
    question.type === "multi_choice" ||
    question.type === "confirm"
  ) {
    return Boolean(
      question.options?.some((option) => option.recommended) ||
      question.defaultValue !== undefined,
    );
  }
  if (question.type === "secret") {
    return false;
  }
  return question.defaultValue !== undefined;
}

export function normalizeRequestUserInputArgs(
  rawArgs: unknown,
): RequestUserInputValidationResult {
  if (!rawArgs || typeof rawArgs !== "object" || Array.isArray(rawArgs)) {
    return {
      ok: false,
      issues: ["request_user_input arguments must be an object."],
    };
  }

  const raw = rawArgs as Record<string, unknown>;
  const rawQuestions = Array.isArray(raw.questions) ? raw.questions : [];
  const issues: string[] = [];
  const warnings: string[] = [];

  if (rawQuestions.length === 0) {
    issues.push("At least one question is required.");
  }
  if (rawQuestions.length > MAX_QUESTIONS) {
    issues.push(
      `This version supports at most ${MAX_QUESTIONS} blocking questions per request.`,
    );
  }

  const usedIds = new Set<string>();
  const questions = rawQuestions
    .slice(0, MAX_QUESTIONS)
    .map((question, index) =>
      normalizeQuestion(question, index, usedIds, issues, warnings),
    )
    .filter((question): question is RequestUserInputQuestion => !!question);

  let autoResolutionMs: number | undefined;
  if (typeof raw.autoResolutionMs === "number") {
    const rounded = Math.floor(raw.autoResolutionMs);
    if (rounded < MIN_AUTO_RESOLUTION_MS || rounded > MAX_AUTO_RESOLUTION_MS) {
      issues.push(
        `autoResolutionMs must be between ${MIN_AUTO_RESOLUTION_MS} and ${MAX_AUTO_RESOLUTION_MS}.`,
      );
    } else {
      autoResolutionMs = rounded;
    }
  }

  if (autoResolutionMs !== undefined) {
    const missingDefault = questions.find(
      (question) => !hasAutoResolutionDefault(question),
    );
    if (missingDefault) {
      warnings.push(
        `autoResolutionMs was dropped because required question ${missingDefault.id} has no safe auto-resolution default.`,
      );
      autoResolutionMs = undefined;
    }
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  return {
    ok: true,
    args: {
      reason: asString(raw.reason)?.slice(0, 240),
      questions,
      autoResolutionMs,
    },
    warnings,
  };
}

export function createCancelledUserInputResponse(
  args: RequestUserInputArgs,
): RequestUserInputResponse {
  const answers: Record<string, RequestUserInputAnswer> = {};
  for (const question of args.questions) {
    answers[question.id] = {
      cancelled: true,
    };
  }
  return {
    answers,
    cancelled: true,
  };
}

export function createAutoResolvedUserInputResponse(
  args: RequestUserInputArgs,
): RequestUserInputResponse {
  const answers: Record<string, RequestUserInputAnswer> = {};
  for (const question of args.questions) {
    const recommendedOptions =
      question.options?.filter((option) => option.recommended) || [];
    if (recommendedOptions.length > 0) {
      answers[question.id] = {
        answers:
          question.type === "multi_choice"
            ? recommendedOptions.map((option) => option.value || option.label)
            : [recommendedOptions[0].value || recommendedOptions[0].label],
        autoResolved: true,
      };
    } else if (typeof question.defaultValue === "string") {
      if (
        question.type === "single_choice" ||
        question.type === "multi_choice" ||
        question.type === "confirm"
      ) {
        answers[question.id] = {
          answers: [question.defaultValue],
          autoResolved: true,
        };
      } else {
        answers[question.id] = {
          text: question.defaultValue,
          autoResolved: true,
        };
      }
    } else if (Array.isArray(question.defaultValue)) {
      answers[question.id] = {
        answers: question.defaultValue,
        autoResolved: true,
      };
    } else {
      answers[question.id] = {
        cancelled: true,
        autoResolved: true,
      };
    }
  }
  return {
    answers,
    autoResolved: true,
  };
}

export function formatUserInputToolResult(
  response: RequestUserInputResponse,
): string {
  return JSON.stringify({
    ok: !response.cancelled,
    response,
  });
}
