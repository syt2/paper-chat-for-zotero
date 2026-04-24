export interface AnalyticsHttpRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

export interface AnalyticsHttpResponse {
  status: number;
  responseText: string;
}

export type AnalyticsHttpTransport = (
  request: AnalyticsHttpRequest,
) => Promise<AnalyticsHttpResponse>;

export interface AnalyticsLogger {
  log: (message: string, context?: unknown) => void;
}

export type AnalyticsEventProps = Record<
  string,
  string | number | boolean | null | undefined
>;

export interface AnalyticsServiceOptions {
  appKey: string;
  endpoint: string;
  appVersion: string;
  isDebug: boolean;
  sdkVersion?: string;
  http: AnalyticsHttpTransport;
  logger?: AnalyticsLogger;
  sessionTimeoutMs?: number;
  getLocale?: () => string;
  getOsName?: () => string;
  getZoteroVersion?: () => string;
  getSystemVersion?: () => string;
  getUserId?: () => string | number | null | undefined;
  now?: () => number;
  randomSessionIdSuffix?: () => string;
  maxBatchSize?: number;
  flushIntervalMs?: number;
  maxQueueSize?: number;
  maxConsecutiveFailures?: number;
}

interface AnalyticsEvent {
  timestamp: string;
  sessionId: string;
  eventName: string;
  systemProps: {
    locale: string;
    osName: string;
    osVersion: string;
    deviceModel: string;
    isDebug: boolean;
    appVersion: string;
    sdkVersion: string;
  };
  props?: Record<string, string | number | boolean>;
}

const DEFAULT_SESSION_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_SDK_VERSION = "analytics/1";
const DEFAULT_MAX_BATCH_SIZE = 25;
const DEFAULT_FLUSH_INTERVAL_MS = 10_000;
const DEFAULT_MAX_QUEUE_SIZE = 500;
const DEFAULT_MAX_CONSECUTIVE_FAILURES = 3;

function defaultRandomSuffix(): string {
  return Math.floor(Math.random() * 1e8)
    .toString()
    .padStart(8, "0");
}

export function createSessionId(
  now: () => number = Date.now,
  randomSuffix: () => string = defaultRandomSuffix,
): string {
  return `${Math.floor(now() / 1000)}${randomSuffix()}`;
}

export function normalizeEventProps(
  props?: AnalyticsEventProps,
): Record<string, string | number | boolean> | undefined {
  if (!props) {
    return undefined;
  }

  const normalized = Object.fromEntries(
    Object.entries(props).filter(([, value]) => {
      return (
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean"
      );
    }),
  ) as Record<string, string | number | boolean>;

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function defaultGetLocale(): string {
  if (typeof navigator !== "undefined") {
    if (Array.isArray(navigator.languages) && navigator.languages.length > 0) {
      return navigator.languages[0];
    }
    if (navigator.language) {
      return navigator.language;
    }
  }

  try {
    return Intl.DateTimeFormat().resolvedOptions().locale || "unknown";
  } catch {
    return "unknown";
  }
}

function getMozillaServices():
  | {
      appinfo?: { OS?: string };
      sysinfo?: { getProperty?: (name: string) => string };
    }
  | undefined {
  const maybeServices = (globalThis as { Services?: unknown }).Services;
  if (!maybeServices || typeof maybeServices !== "object") {
    return undefined;
  }
  return maybeServices as {
    appinfo?: { OS?: string };
    sysinfo?: { getProperty?: (name: string) => string };
  };
}

function normalizeOsName(raw: string | undefined): string {
  switch (raw) {
    case "WINNT":
      return "Windows";
    case "Darwin":
      return "macOS";
    case "Linux":
      return "Linux";
    default:
      return raw && raw.trim() ? raw : "unknown";
  }
}

function defaultGetOsName(): string {
  const services = getMozillaServices();
  const appinfoOs = services?.appinfo?.OS;
  if (typeof appinfoOs === "string") {
    return normalizeOsName(appinfoOs);
  }

  if (typeof navigator !== "undefined" && typeof navigator.platform === "string") {
    return normalizeOsName(navigator.platform);
  }

  return "unknown";
}

function defaultGetSystemVersion(): string {
  const services = getMozillaServices();
  const getProperty = services?.sysinfo?.getProperty;
  if (typeof getProperty === "function") {
    for (const key of ["version", "kernel_version"]) {
      try {
        const value = getProperty(key);
        if (typeof value === "string" && value.trim()) {
          return value.trim();
        }
      } catch {
        // Try next known property.
      }
    }
  }

  return "unknown";
}

function defaultGetZoteroVersion(): string {
  const zotero = (globalThis as { Zotero?: { version?: unknown } }).Zotero;
  const version = zotero?.version;
  return typeof version === "string" && version.trim() ? version.trim() : "unknown";
}

export class AnalyticsService {
  private sessionId: string;
  private lastActivityAt: number;
  private readonly appKey: string;
  private readonly endpoint: string;
  private readonly appVersion: string;
  private readonly isDebug: boolean;
  private readonly http: AnalyticsHttpTransport;
  private readonly logger: AnalyticsLogger | undefined;
  private readonly sessionTimeoutMs: number;
  private readonly sdkVersion: string;
  private readonly getLocale: () => string;
  private readonly getOsName: () => string;
  private readonly getZoteroVersion: () => string;
  private readonly getSystemVersion: () => string;
  private readonly getUserId: () => string | number | null | undefined;
  private readonly now: () => number;
  private readonly randomSessionIdSuffix: () => string;
  private readonly maxBatchSize: number;
  private readonly maxQueueSize: number;
  private readonly maxConsecutiveFailures: number;

  private pendingEvents: AnalyticsEvent[] = [];
  private consecutiveFailures = 0;
  private skipTicksRemaining = 0;
  private acceptingEvents = true;
  private destroyed = false;
  private activeFlushPromise: Promise<boolean> | null = null;
  private destroyPromise: Promise<void> | null = null;
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: AnalyticsServiceOptions) {
    this.appKey = options.appKey;
    this.endpoint = options.endpoint;
    this.appVersion = options.appVersion;
    this.isDebug = options.isDebug;
    this.http = options.http;
    this.logger = options.logger;
    this.sessionTimeoutMs =
      options.sessionTimeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS;
    this.sdkVersion = options.sdkVersion ?? DEFAULT_SDK_VERSION;
    this.getLocale = options.getLocale ?? defaultGetLocale;
    this.getOsName = options.getOsName ?? defaultGetOsName;
    this.getZoteroVersion =
      options.getZoteroVersion ?? defaultGetZoteroVersion;
    this.getSystemVersion =
      options.getSystemVersion ?? defaultGetSystemVersion;
    this.getUserId = options.getUserId ?? (() => "");
    this.now = options.now ?? Date.now;
    this.randomSessionIdSuffix =
      options.randomSessionIdSuffix ?? defaultRandomSuffix;
    this.maxBatchSize = options.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE;
    this.maxQueueSize = options.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE;
    this.maxConsecutiveFailures =
      options.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES;
    this.sessionId = createSessionId(this.now, this.randomSessionIdSuffix);
    this.lastActivityAt = this.now();

    const flushIntervalMs =
      options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    if (flushIntervalMs > 0) {
      this.flushTimer = setInterval(() => {
        this.onTimerTick();
      }, flushIntervalMs);
    }
  }

  track(eventName: string, props?: AnalyticsEventProps): void {
    if (!this.acceptingEvents || this.destroyed) {
      return;
    }

    const eventProps: AnalyticsEventProps = {
      userId: this.getUserId() ?? "",
      ...props,
    };

    const event: AnalyticsEvent = {
      timestamp: new Date(this.now()).toISOString(),
      sessionId: this.getCurrentSessionId(),
      eventName,
      systemProps: {
        locale: this.getLocale(),
        osName: this.getOsName(),
        osVersion: this.getZoteroVersion(),
        deviceModel: this.getSystemVersion(),
        isDebug: this.isDebug,
        appVersion: this.appVersion,
        sdkVersion: this.sdkVersion,
      },
      props: normalizeEventProps(eventProps),
    };

    if (this.pendingEvents.length >= this.maxQueueSize) {
      const dropped = this.pendingEvents.shift();
      this.logger?.log("[Analytics] queue overflow, dropped oldest event", {
        droppedEventName: dropped?.eventName,
        queueLimit: this.maxQueueSize,
      });
    }
    this.pendingEvents.push(event);

    if (this.pendingEvents.length >= this.maxBatchSize) {
      void this.flushOnce();
    }
  }

  async flush(): Promise<void> {
    while (!this.destroyed && this.pendingEvents.length > 0) {
      const sent = await this.flushOnce();
      if (!sent) {
        break;
      }
    }
  }

  async destroy(): Promise<void> {
    if (this.destroyPromise) {
      return this.destroyPromise;
    }

    this.acceptingEvents = false;
    this.destroyPromise = (async () => {
      if (this.flushTimer) {
        clearInterval(this.flushTimer);
        this.flushTimer = null;
      }

      if (this.activeFlushPromise) {
        await this.activeFlushPromise;
      }

      await this.flush();

      if (this.pendingEvents.length > 0) {
        this.logger?.log("[Analytics] dropping pending events during destroy", {
          droppedCount: this.pendingEvents.length,
        });
        this.pendingEvents = [];
      }

      this.destroyed = true;
      this.activeFlushPromise = null;
    })();

    return this.destroyPromise;
  }

  private onTimerTick(): void {
    if (this.destroyed || !this.acceptingEvents) {
      return;
    }
    if (this.flushTimer) {
      if (this.skipTicksRemaining > 0) {
        this.skipTicksRemaining -= 1;
        return;
      }
      void this.flushOnce();
    }
  }

  private flushOnce(): Promise<boolean> {
    if (this.activeFlushPromise) {
      return this.activeFlushPromise;
    }
    if (this.destroyed || this.pendingEvents.length === 0) {
      return Promise.resolve(false);
    }

    const batch = this.pendingEvents.splice(0, this.maxBatchSize);
    const flushPromise = (async (): Promise<boolean> => {
      try {
        const response = await this.http({
          method: "POST",
          url: this.endpoint,
          headers: {
            "Content-Type": "application/json",
            "App-Key": this.appKey,
          },
          body: JSON.stringify(batch),
        });

        if (response.status >= 200 && response.status < 300) {
          this.consecutiveFailures = 0;
          this.skipTicksRemaining = 0;
          return true;
        }

        if (
          response.status >= 400 &&
          response.status < 500 &&
          response.status !== 429
        ) {
          this.logger?.log("[Analytics] batch rejected, dropping", {
            status: response.status,
            response: response.responseText || "",
            batchSize: batch.length,
          });
          this.consecutiveFailures = 0;
          this.skipTicksRemaining = 0;
          return true;
        }

        return this.requeueAfterFailure(batch, {
          reason: "retriable_status",
          status: response.status,
          response: response.responseText || "",
        });
      } catch (error) {
        return this.requeueAfterFailure(batch, {
          reason: "transport_error",
          error,
        });
      } finally {
        this.activeFlushPromise = null;
      }
    })();

    this.activeFlushPromise = flushPromise;
    return flushPromise;
  }

  private requeueAfterFailure(
    batch: AnalyticsEvent[],
    context: Record<string, unknown>,
  ): boolean {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures > this.maxConsecutiveFailures) {
      this.logger?.log(
        "[Analytics] dropping batch after max consecutive failures",
        {
          ...context,
          batchSize: batch.length,
          maxConsecutiveFailures: this.maxConsecutiveFailures,
        },
      );
      this.consecutiveFailures = 0;
      this.skipTicksRemaining = 0;
      return true;
    }

    this.logger?.log("[Analytics] batch send failed, will retry", {
      ...context,
      attempt: this.consecutiveFailures,
      batchSize: batch.length,
    });
    this.skipTicksRemaining = this.consecutiveFailures;
    this.pendingEvents.unshift(...batch);
    return false;
  }

  private getCurrentSessionId(): string {
    const now = this.now();
    if (now - this.lastActivityAt > this.sessionTimeoutMs) {
      this.sessionId = createSessionId(this.now, this.randomSessionIdSuffix);
    }
    this.lastActivityAt = now;
    return this.sessionId;
  }
}
