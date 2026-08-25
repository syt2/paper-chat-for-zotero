const SERIALIZED_SELECTIONS_PREFIX = "paperchat-selections-v1:";

export function normalizeSelectedTexts(
  selectedTexts?: string[],
  selectedText?: string,
): string[] {
  const normalizedSelections = (selectedTexts || [])
    .filter((text): text is string => typeof text === "string")
    .map((text) => text.trim())
    .filter(Boolean);
  if (normalizedSelections.length > 0) return normalizedSelections;

  const normalizedFallback = selectedText?.trim();
  return normalizedFallback ? [normalizedFallback] : [];
}

export function serializeSelectedTexts(selectedTexts: string[]): string {
  return `${SERIALIZED_SELECTIONS_PREFIX}${JSON.stringify(
    normalizeSelectedTexts(selectedTexts),
  )}`;
}

export function splitSelectedTexts(selectedText: string): string[] {
  if (!selectedText.startsWith(SERIALIZED_SELECTIONS_PREFIX)) {
    // Existing messages stored one plain passage in selectedText. Treat the
    // entire legacy value as one selection, even if the paper contains a
    // Markdown divider that newer versions once used as a separator.
    return normalizeSelectedTexts(undefined, selectedText);
  }

  try {
    const parsed = JSON.parse(
      selectedText.slice(SERIALIZED_SELECTIONS_PREFIX.length),
    );
    if (Array.isArray(parsed)) {
      const normalized = normalizeSelectedTexts(parsed);
      if (normalized.length > 0) return normalized;
    }
  } catch {
    // Preserve malformed or externally produced values as one legacy passage
    // instead of dropping visible user context.
  }
  return normalizeSelectedTexts(undefined, selectedText);
}

export function getSelectedTextContext(selectedText: string): string {
  return splitSelectedTexts(selectedText).join("\n\n");
}

export function formatSelectedTextsForPrompt(selectedTexts: string[]): string {
  return selectedTexts
    .map((text, index) => `[Selection ${index + 1}]:\n"${text}"`)
    .join("\n\n");
}

export function formatSelectedTextsForDisplay(
  selectedText: string,
  question: string,
): string {
  const selectedTexts = splitSelectedTexts(selectedText);
  if (!selectedText.startsWith(SERIALIZED_SELECTIONS_PREFIX)) {
    return `[Selected]: ${selectedTexts[0] || selectedText}\n\n${question}`;
  }

  return [
    ...selectedTexts.map((text, index) => `[Selection ${index + 1}]:\n${text}`),
    question,
  ].join("\n\n");
}
