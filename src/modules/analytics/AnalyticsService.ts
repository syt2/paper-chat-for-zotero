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
  now?: () => number;
  randomSessionIdSuffix?: () => string;
}

const DEFAULT_SESSION_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_SDK_VERSION = "analytics/1";

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
  private readonly now: () => number;
  private readonly randomSessionIdSuffix: () => string;

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
    this.now = options.now ?? Date.now;
    this.randomSessionIdSuffix =
      options.randomSessionIdSuffix ?? defaultRandomSuffix;
    this.sessionId = createSessionId(this.now, this.randomSessionIdSuffix);
    this.lastActivityAt = this.now();
  }

  track(eventName: string, props?: AnalyticsEventProps): void {
    const normalizedProps = normalizeEventProps(props);
    const payload = {
      timestamp: new Date(this.now()).toISOString(),
      sessionId: this.getCurrentSessionId(),
      eventName,
      systemProps: {
        locale: this.getLocale(),
        isDebug: this.isDebug,
        appVersion: this.appVersion,
        sdkVersion: this.sdkVersion,
      },
      props: normalizedProps,
    };

    void Promise.resolve()
      .then(() =>
        this.http({
          method: "POST",
          url: this.endpoint,
          headers: {
            "Content-Type": "application/json",
            "App-Key": this.appKey,
          },
          body: JSON.stringify(payload),
        }),
      )
      .then((response) => {
        if (response.status >= 300) {
          this.logger?.log("[Analytics] event send failed", {
            eventName,
            status: response.status,
            response: response.responseText || "",
          });
        }
      })
      .catch((error) => {
        if (error && typeof error === "object" && "status" in error) {
          const httpError = error as {
            status: number;
            responseText?: string;
          };
          this.logger?.log("[Analytics] event send failed", {
            eventName,
            status: httpError.status,
            response: httpError.responseText || "",
          });
          return;
        }

        this.logger?.log("[Analytics] event send failed", {
          eventName,
          props: normalizedProps || {},
          error,
        });
      });
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
