/**
 * Typography helpers for the chat panel.
 *
 * Zotero's View -> Font Size command updates registered UI roots and exposes
 * the resulting length through `--zotero-font-size`. Keeping that integration
 * here lets rendering modules express their existing size hierarchy without
 * knowing how Zotero stores or observes the preference.
 */

export const CHAT_BASE_FONT_SIZE_PX = 13;

interface ZoteroUIProperties {
  registerRoot(root: HTMLElement): void;
}

interface ZoteroTypographyRuntime {
  Zotero?: {
    UIProperties?: ZoteroUIProperties;
  };
}

function formatRatio(value: number): string {
  return value.toFixed(6).replace(/\.?0+$/, "");
}

/**
 * Return a font size that follows Zotero's native UI font-size preference.
 * The pixel fallback preserves the existing appearance outside Zotero and in
 * lightweight DOM tests where the native custom property is unavailable.
 */
export function chatFontSize(sizePx: number): string {
  if (!Number.isFinite(sizePx) || sizePx < 0) {
    throw new RangeError("Chat font size must be a finite non-negative number");
  }
  if (sizePx === 0) {
    return "0px";
  }
  if (sizePx === CHAT_BASE_FONT_SIZE_PX) {
    return `var(--zotero-font-size, ${CHAT_BASE_FONT_SIZE_PX}px)`;
  }
  return `calc(var(--zotero-font-size, ${CHAT_BASE_FONT_SIZE_PX}px) * ${formatRatio(sizePx / CHAT_BASE_FONT_SIZE_PX)})`;
}

/**
 * Register a panel root with Zotero's native typography lifecycle.
 * Zotero 7+ stores registered roots as WeakRefs and refreshes them whenever
 * the global font-size preference changes. If the API is unavailable, all
 * `chatFontSize()` values retain their current pixel fallback.
 */
export function registerChatTypographyRoot(container: HTMLElement): boolean {
  const runtime = globalThis as typeof globalThis & ZoteroTypographyRuntime;
  const uiProperties = runtime.Zotero?.UIProperties;
  if (!uiProperties?.registerRoot) {
    return false;
  }

  try {
    uiProperties.registerRoot(container);
    return true;
  } catch {
    return false;
  }
}
