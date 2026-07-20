import { AGENT_MAX_PLANNING_ITERATIONS_SETTINGS_HREF } from "../../../utils/internalLinks";
import { getString } from "../../../utils/locale";

const MAX_ITERATIONS_MESSAGE_LOCALE_KEY =
  "chat-max-planning-iterations-reached";
const MAX_ITERATIONS_MESSAGE_FALLBACK =
  "I apologize, but I was unable to complete the request within the allowed number of iterations.";
const MAX_ITERATIONS_LINK_SUFFIX = `](${AGENT_MAX_PLANNING_ITERATIONS_SETTINGS_HREF})`;

function formatMaxIterationsMessage(label: string): string {
  const escapedLabel = label.replace(/([\\[\]])/g, "\\$1");
  return `\n\n[${escapedLabel}](${AGENT_MAX_PLANNING_ITERATIONS_SETTINGS_HREF})`;
}

export const MAX_ITERATIONS_MESSAGE = formatMaxIterationsMessage(
  MAX_ITERATIONS_MESSAGE_FALLBACK,
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

export function isMaxIterationsNoticeContent(content: string): boolean {
  return content.trimEnd().endsWith(MAX_ITERATIONS_LINK_SUFFIX);
}
