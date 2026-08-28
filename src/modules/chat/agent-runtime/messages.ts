import { AGENT_MAX_PLANNING_ITERATIONS_SETTINGS_HREF } from "../../../utils/internalLinks";
import { getString } from "../../../utils/locale";

const MAX_ITERATIONS_MESSAGE_LOCALE_KEY =
  "chat-max-planning-iterations-reached";
const MAX_ITERATIONS_MESSAGE_FALLBACK =
  "I apologize, but I was unable to complete the request within the allowed number of iterations.";
const MAX_ITERATIONS_LINK_SUFFIX = `](${AGENT_MAX_PLANNING_ITERATIONS_SETTINGS_HREF})`;
const OUTPUT_TRUNCATION_NOTICE_LOCALE_KEY = "chat-output-truncated";
const OUTPUT_TRUNCATION_NOTICE_FALLBACK =
  "The provider stopped before completing this response. The reply may be incomplete.";

function formatMaxIterationsMessage(label: string): string {
  const escapedLabel = label.replace(/([\\[\]])/g, "\\$1");
  return `\n\n[${escapedLabel}](${AGENT_MAX_PLANNING_ITERATIONS_SETTINGS_HREF})`;
}

export const MAX_ITERATIONS_MESSAGE = formatMaxIterationsMessage(
  MAX_ITERATIONS_MESSAGE_FALLBACK,
);

function formatOutputTruncationNotice(label: string): string {
  return `\n\n> ${label.replace(/\s+/g, " ").trim()}`;
}

export const OUTPUT_TRUNCATION_NOTICE = formatOutputTruncationNotice(
  OUTPUT_TRUNCATION_NOTICE_FALLBACK,
);

export function getMaxIterationsMessage(): string {
  try {
    const localized = getString(MAX_ITERATIONS_MESSAGE_LOCALE_KEY);
    if (
      localized &&
      localized !== `paperchat-${MAX_ITERATIONS_MESSAGE_LOCALE_KEY}`
    ) {
      return formatMaxIterationsMessage(localized);
    }
  } catch {
    // Locale can be unavailable in startup and isolated test environments.
  }
  return MAX_ITERATIONS_MESSAGE;
}

export function getOutputTruncationNotice(): string {
  try {
    const localized = getString(OUTPUT_TRUNCATION_NOTICE_LOCALE_KEY);
    if (
      localized &&
      localized !== `paperchat-${OUTPUT_TRUNCATION_NOTICE_LOCALE_KEY}`
    ) {
      return formatOutputTruncationNotice(localized);
    }
  } catch {
    // Locale can be unavailable in startup and isolated test environments.
  }
  return OUTPUT_TRUNCATION_NOTICE;
}

/** Remove the app-authored incomplete-output notice from persisted text. */
export function stripOutputTruncationNotice(content: string): string {
  if (!content) return content;

  const candidates = Array.from(
    new Set([getOutputTruncationNotice(), OUTPUT_TRUNCATION_NOTICE]),
  ).sort((left, right) => right.length - left.length);
  for (const candidate of candidates) {
    if (content.endsWith(candidate)) {
      return content.slice(0, -candidate.length);
    }
  }

  // A persisted renderer may have normalized trailing whitespace while keeping
  // the same notice text. Retry against a right-trimmed copy, preserving any
  // whitespace that preceded the notice.
  const trimmed = content.trimEnd();
  if (trimmed !== content) {
    for (const candidate of candidates) {
      const candidateTrimmed = candidate.trimEnd();
      if (trimmed.endsWith(candidateTrimmed)) {
        return trimmed.slice(0, -candidateTrimmed.length);
      }
    }
  }
  return content;
}

export function isMaxIterationsNoticeContent(content: string): boolean {
  return content.trimEnd().endsWith(MAX_ITERATIONS_LINK_SUFFIX);
}
