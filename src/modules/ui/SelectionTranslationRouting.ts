export type TranslationModelSelection = { providerId: string; model: string };

/** A maximum of two candidates; explicit choices never silently switch model. */
export function getTranslationCandidates(
  stored: string,
  active: { id: string; type: string },
  apiDefault?: string,
): Array<TranslationModelSelection | undefined> {
  if (stored !== "auto" && stored !== "") {
    const parsed = JSON.parse(stored);
    if (
      !parsed ||
      typeof parsed.providerId !== "string" ||
      !parsed.providerId ||
      typeof parsed.model !== "string" ||
      !parsed.model
    )
      throw new Error("Invalid translation model");
    return [parsed];
  }
  if (active.type !== "paperchat" || !apiDefault) return [undefined];
  return [{ providerId: active.id, model: apiDefault }, undefined];
}

export class SelectionTranslationError extends Error {
  constructor(
    message: string,
    readonly paperchat: boolean,
  ) {
    super(message);
    this.name = "SelectionTranslationError";
  }
}
