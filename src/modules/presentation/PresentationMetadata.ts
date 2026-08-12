export function formatPresentationAuthors(
  authors: readonly string[] | undefined,
  language: string | undefined,
): string | undefined {
  const normalized = Array.from(
    new Set(
      (authors || [])
        .map((author) => author.normalize("NFKC").replace(/\s+/g, " ").trim())
        .filter(Boolean),
    ),
  );
  if (!normalized.length) return undefined;

  const chinese = /^zh(?:-|$)/i.test(language || "");
  const visible = normalized.slice(0, 3);
  const suffix =
    normalized.length > visible.length ? (chinese ? " 等" : " et al.") : "";
  const joined = `${visible.join(chinese ? "、" : ", ")}${suffix}`;
  return Array.from(joined).slice(0, 120).join("");
}
