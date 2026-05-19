import pkg from "../../package.json";
import { config } from "../../package.json";
import {
  getGithubUrlCandidates,
  getUpdateURLTemplate,
} from "./updateUrls";

type AddonManagerLike = {
  STATE_AVAILABLE?: number;
  getAddonByID(id: string): Promise<{ version: string } | null>;
  getInstallForURL(url: string): Promise<{
    state?: number;
    install(): Promise<void> | void;
  } | null>;
};

type AddonUpdateEntry = {
  version?: string;
  update_link?: string;
};

type AddonUpdateManifest = {
  addons?: Record<string, { updates?: AddonUpdateEntry[] }>;
};

export function compareVersion(current: string, next: string): number {
  const versionComparator = (globalThis as any).Services?.vc;
  if (versionComparator?.compare) {
    return versionComparator.compare(current, next);
  }
  return compareVersionFallback(current, next);
}

export async function installAddonFrom(
  url: string,
  addonName: string,
  notify = false,
): Promise<void> {
  const addonManager = getAddonManager();
  const install = await addonManager.getInstallForURL(url);
  if (!install) {
    throw new Error(`No install available for ${addonName} from ${url}`);
  }
  if (
    addonManager.STATE_AVAILABLE !== undefined &&
    install.state !== undefined &&
    install.state !== addonManager.STATE_AVAILABLE
  ) {
    throw new Error(`Install is not available for ${addonName} from ${url}`);
  }
  await Promise.resolve(install.install());
  if (notify) {
    ztoolkit.log(`[SelfUpdate] Installed ${addonName} from ${url}`);
  }
}

export async function updateSelfIfNeed(): Promise<void> {
  if (__env__ !== "production") {
    return;
  }
  try {
    const addonManager = getAddonManager();
    const addon = await addonManager.getAddonByID(config.addonID);
    if (!addon?.version) {
      return;
    }

    const updateInfo = await loadUpdateManifestWithFallback();
    const update = findNewerUpdate(addon.version, updateInfo);
    if (!update) {
      return;
    }

    if (!update.update_link) {
      ztoolkit.log(
        `[SelfUpdate] Skip update ${update.version}: missing update_link`,
      );
      return;
    }

    await installWithFallback(update.update_link);
  } catch (error) {
    ztoolkit.log(`autoupdate self failed: ${error}`);
  }
}

async function loadUpdateManifestWithFallback(): Promise<AddonUpdateManifest> {
  const updateUrl = resolveTemplate(getUpdateURLTemplate(pkg.version));
  const responseText = await requestTextWithFallback(updateUrl);
  return JSON.parse(responseText) as AddonUpdateManifest;
}

async function requestTextWithFallback(url: string): Promise<string> {
  let lastError: unknown;
  for (const candidate of getGithubUrlCandidates(url)) {
    try {
      const response = await Zotero.HTTP.request("GET", candidate, {
        timeout: 15000,
        noCache: true,
      });
      return response.responseText || response.response;
    } catch (error) {
      lastError = error;
      ztoolkit.log(`[SelfUpdate] Fetch failed from ${candidate}:`, error);
    }
  }
  throw lastError;
}

async function installWithFallback(url: string): Promise<void> {
  let lastError: unknown;
  for (const candidate of getGithubUrlCandidates(url)) {
    try {
      await installAddonFrom(candidate, config.addonName, false);
      return;
    } catch (error) {
      lastError = error;
      ztoolkit.log(`[SelfUpdate] Install failed from ${candidate}:`, error);
    }
  }
  throw lastError;
}

export function findNewerUpdate(
  currentVersion: string,
  updateInfo: AddonUpdateManifest,
): AddonUpdateEntry | null {
  const updates = updateInfo.addons?.[config.addonID]?.updates || [];
  const latest =
    updates
      .filter((update) => update.version)
      .sort((a, b) => compareVersion(b.version || "", a.version || ""))[0] ||
    null;
  if (!latest?.version || compareVersion(currentVersion, latest.version) >= 0) {
    return null;
  }
  return latest;
}

function resolveTemplate(template: string, version = pkg.version): string {
  const repo = parseGithubRepository(pkg.repository?.url || "");
  return template
    .replaceAll("{{owner}}", repo.owner)
    .replaceAll("{{repo}}", repo.repo)
    .replaceAll("{{version}}", version)
    .replaceAll("{{xpiName}}", toKebabCase(config.addonName));
}

function parseGithubRepository(repositoryUrl: string): {
  owner: string;
  repo: string;
} {
  const match = repositoryUrl.match(
    /github\.com[/:]([^/]+)\/([^/.]+)(?:\.git)?/,
  );
  if (!match) {
    throw new Error(`Cannot parse GitHub repository URL: ${repositoryUrl}`);
  }
  return {
    owner: match[1],
    repo: match[2],
  };
}

function getAddonManager(): AddonManagerLike {
  const chromeUtils = (globalThis as any).ChromeUtils;
  if (!chromeUtils) {
    throw new Error("ChromeUtils is unavailable");
  }
  let imported: { AddonManager?: unknown } | undefined;
  try {
    imported = chromeUtils.importESModule?.(
      "resource://gre/modules/AddonManager.sys.mjs",
    );
  } catch {
    imported = undefined;
  }
  imported ||= chromeUtils.import?.("resource://gre/modules/AddonManager.jsm");
  if (!imported?.AddonManager) {
    throw new Error("AddonManager is unavailable");
  }
  return imported.AddonManager as AddonManagerLike;
}

function compareVersionFallback(current: string, next: string): number {
  const currentParts = splitVersion(current);
  const nextParts = splitVersion(next);
  const length = Math.max(currentParts.length, nextParts.length);
  for (let i = 0; i < length; i++) {
    const left = currentParts[i] || 0;
    const right = nextParts[i] || 0;
    if (left !== right) {
      return left > right ? 1 : -1;
    }
  }
  return 0;
}

function splitVersion(version: string): number[] {
  return version
    .split(/[-+.]/)
    .map((part) => Number.parseInt(part, 10))
    .map((part) => (Number.isFinite(part) ? part : 0));
}

function toKebabCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}
