import pkg from "../../package.json";
import { config } from "../../package.json";
import { getGithubUrlCandidates, getUpdateURLTemplate } from "./updateUrls";
import { NO_RETRY_ON_THROTTLE } from "./http";
import { isChatInUse, onChatPanelClosed } from "./chatActivity";

/** Re-check for a new release every three hours. */
export const SELF_UPDATE_CHECK_INTERVAL_MS = 3 * 60 * 60 * 1000;
/** Grace period after the chat panel closes before a deferred install runs. */
export const SELF_UPDATE_CLOSE_DELAY_MS = 10 * 1000;

let selfUpdateTimer: ReturnType<typeof setInterval> | null = null;
let deferredInstallTimer: ReturnType<typeof setTimeout> | null = null;
/** Update seen while the panel was open, waiting for an idle moment. */
let pendingUpdateLink: string | null = null;
let closeListenerRegistered = false;
let closeDelayMs = SELF_UPDATE_CLOSE_DELAY_MS;

function isProductionBuild(): boolean {
  return typeof __env__ !== "undefined" && __env__ === "production";
}

/**
 * Checks for updates on startup (never skipped, matching the behaviour before
 * the scheduler existed) and then every three hours. An interval check that
 * finds an update while the chat panel is open only remembers it: the install
 * runs after the user closes the panel and it stays closed for
 * {@link SELF_UPDATE_CLOSE_DELAY_MS}. Returns the startup check so callers
 * (and tests) can await it.
 */
export function startSelfUpdateScheduler(): Promise<void> | undefined {
  if (!isProductionBuild()) {
    return undefined;
  }
  stopSelfUpdateScheduler();
  registerCloseListener();
  selfUpdateTimer = setInterval(() => {
    void runSelfUpdateCheck("interval", { ignoreInUse: false });
  }, SELF_UPDATE_CHECK_INTERVAL_MS);
  return runSelfUpdateCheck("startup", { ignoreInUse: true });
}

export function stopSelfUpdateScheduler(): void {
  if (selfUpdateTimer !== null) {
    clearInterval(selfUpdateTimer);
    selfUpdateTimer = null;
  }
  if (deferredInstallTimer !== null) {
    clearTimeout(deferredInstallTimer);
    deferredInstallTimer = null;
  }
  pendingUpdateLink = null;
}

export function setSelfUpdateCloseDelayForTests(delayMs: number): void {
  closeDelayMs = delayMs;
}

export function resetSelfUpdateSchedulerForTests(): void {
  stopSelfUpdateScheduler();
  closeListenerRegistered = false;
  closeDelayMs = SELF_UPDATE_CLOSE_DELAY_MS;
}

function registerCloseListener(): void {
  if (closeListenerRegistered) {
    return;
  }
  closeListenerRegistered = true;
  onChatPanelClosed(() => {
    scheduleDeferredInstallCheck();
  });
}

function scheduleDeferredInstallCheck(): void {
  if (!pendingUpdateLink) {
    return;
  }
  if (deferredInstallTimer !== null) {
    clearTimeout(deferredInstallTimer);
  }
  ztoolkit.log(
    `[SelfUpdate] Chat panel closed; re-checking for updates in ${closeDelayMs}ms`,
  );
  deferredInstallTimer = setTimeout(() => {
    deferredInstallTimer = null;
    void runDeferredInstallCheck();
  }, closeDelayMs);
}

/**
 * Runs once the grace period after closing the panel elapses. Skipped when the
 * user reopened the panel in the meantime.
 */
export async function runDeferredInstallCheck(): Promise<void> {
  if (isChatInUse()) {
    ztoolkit.log(
      "[SelfUpdate] Chat panel is open again; keeping the update pending",
    );
    return;
  }
  await runSelfUpdateCheck("panel-closed", { ignoreInUse: false });
}

/** Test seam: performs an interval-style check without waiting three hours. */
export function runScheduledUpdateCheckForTests(): Promise<void> {
  return runSelfUpdateCheck("interval", { ignoreInUse: false });
}

async function runSelfUpdateCheck(
  trigger: "startup" | "interval" | "panel-closed",
  options: { ignoreInUse: boolean },
): Promise<void> {
  try {
    const update = await findAvailableUpdate();
    if (!update) {
      pendingUpdateLink = null;
      return;
    }
    if (!options.ignoreInUse && isChatInUse()) {
      pendingUpdateLink = update.update_link ?? null;
      ztoolkit.log(
        `[SelfUpdate] ${trigger}: update ${update.version} available, deferred while PaperChat is in use`,
      );
      return;
    }
    pendingUpdateLink = null;
    await installUpdate(update);
  } catch (error) {
    ztoolkit.log(`[SelfUpdate] ${trigger} check failed: ${error}`);
  }
}

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

/** Returns the newest published release when it is newer than this build. */
export async function findAvailableUpdate(): Promise<AddonUpdateEntry | null> {
  const addonManager = getAddonManager();
  const addon = await addonManager.getAddonByID(config.addonID);
  if (!addon?.version) {
    return null;
  }
  const updateInfo = await loadUpdateManifestWithFallback();
  return findNewerUpdate(addon.version, updateInfo);
}

export async function installUpdate(update: AddonUpdateEntry): Promise<void> {
  if (!update.update_link) {
    ztoolkit.log(
      `[SelfUpdate] Skip update ${update.version}: missing update_link`,
    );
    return;
  }
  await installWithFallback(update.update_link);
}

export async function updateSelfIfNeed(): Promise<void> {
  if (!isProductionBuild()) {
    return;
  }
  try {
    const update = await findAvailableUpdate();
    if (!update) {
      return;
    }
    await installUpdate(update);
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
        ...NO_RETRY_ON_THROTTLE,
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
