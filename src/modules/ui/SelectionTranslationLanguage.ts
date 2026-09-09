export const translationLanguages = [
  { value: "zh-CN", label: "简体中文" },
  { value: "zh-TW", label: "繁體中文" },
  { value: "en", label: "English" },
  { value: "ja", label: "日本語" },
  { value: "ko", label: "한국어" },
  { value: "fr", label: "Français" },
  { value: "de", label: "Deutsch" },
  { value: "es", label: "Español" },
  { value: "pt", label: "Português" },
  { value: "ru", label: "Русский" },
  { value: "it", label: "Italiano" },
  { value: "ar", label: "العربية" },
] as const;

export function normalizeTranslationLanguage(
  value: string | undefined,
): string {
  return translationLanguages.some((language) => language.value === value)
    ? value!
    : "auto";
}

export function getTranslationTargetLocale(
  selection: string | undefined,
  uiLocale: string,
): string {
  const language = normalizeTranslationLanguage(selection);
  return language === "auto" ? uiLocale || "en-US" : language;
}
