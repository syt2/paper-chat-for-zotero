import { cleanText } from "./WebSearchUtils";

interface HiddenBrowserPageData {
  title: string;
  bodyText: string;
}

interface HiddenBrowserInstance {
  load(url: string): Promise<void>;
  getPageData(fields: string[]): Promise<Record<string, unknown>>;
  destroy?(): Promise<void> | void;
}

type HiddenBrowserConstructor = new (options?: Record<string, unknown>) => HiddenBrowserInstance;

let hiddenBrowserConstructorForTests: HiddenBrowserConstructor | null = null;

const HIDDEN_BROWSER_MODULE_PATHS = [
  "chrome://zotero/content/HiddenBrowser.mjs",
  "chrome://zotero/content/HiddenBrowser.sys.mjs",
  "chrome://zotero/content/HiddenBrowser.jsm",
  "resource://zotero/HiddenBrowser.mjs",
  "resource://zotero/HiddenBrowser.sys.mjs",
  "resource://zotero/HiddenBrowser.jsm",
];

function getHiddenBrowserConstructor(): HiddenBrowserConstructor {
  if (hiddenBrowserConstructorForTests) {
    return hiddenBrowserConstructorForTests;
  }

  const chromeUtils = (globalThis as any).ChromeUtils;
  if (!chromeUtils) {
    throw new Error("ChromeUtils is unavailable; HiddenBrowser cannot be loaded");
  }

  for (const path of HIDDEN_BROWSER_MODULE_PATHS) {
    try {
      const module =
        typeof chromeUtils.importESModule === "function"
          ? chromeUtils.importESModule(path)
          : typeof chromeUtils.import === "function"
            ? chromeUtils.import(path)
            : null;
      const HiddenBrowser =
        module?.HiddenBrowser || module?.default || module;
      if (typeof HiddenBrowser === "function") {
        return HiddenBrowser as HiddenBrowserConstructor;
      }
    } catch {
      continue;
    }
  }

  throw new Error("Unable to locate Zotero HiddenBrowser module");
}

function createHiddenBrowserInstance(): HiddenBrowserInstance {
  const HiddenBrowser = getHiddenBrowserConstructor();
  return new HiddenBrowser({
    allowJavaScript: true,
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export async function loadPageWithHiddenBrowser(
  url: string,
  options: {
    timeoutMs?: number;
    settleDelayMs?: number;
  } = {},
): Promise<HiddenBrowserPageData> {
  const timeoutMs = options.timeoutMs ?? 15000;
  const settleDelayMs = options.settleDelayMs ?? 1000;
  const browser = createHiddenBrowserInstance();

  try {
    await withTimeout(browser.load(url), timeoutMs, `Hidden browser load for ${url}`);
    if (settleDelayMs > 0) {
      await delay(settleDelayMs);
    }

    const pageData = await withTimeout(
      browser.getPageData(["title", "bodyText"]),
      timeoutMs,
      `Hidden browser page data for ${url}`,
    );

    return {
      title: cleanText(String(pageData.title || "")),
      bodyText: cleanText(String(pageData.bodyText || "")),
    };
  } finally {
    try {
      await browser.destroy?.();
    } catch {
      // Ignore cleanup failures from experimental hidden-browser-backed searches.
    }
  }
}

export function __setHiddenBrowserConstructorForTests(
  constructor: HiddenBrowserConstructor | null,
): void {
  hiddenBrowserConstructorForTests = constructor;
}
