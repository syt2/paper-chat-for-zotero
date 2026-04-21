import { version } from "../../../package.json";

export const ANALYTICS_EVENTS = {
  pluginStarted: "plugin_started",
  chatPanelOpened: "chat_panel_opened",
  chatSent: "chat_sent",
  chatCompleted: "chat_completed",
  paperChatQuotaError: "paperchat_quota_error",
  paperChatModelRerouted: "paperchat_model_rerouted",
  paperChatTopupOpened: "paperchat_topup_opened",
  aiSummaryBatchStarted: "ai_summary_batch_started",
} as const;

const ANALYTICS_ENABLED = true;
const ANALYTICS_APP_KEY = "A-SH-6952478977";
const ANALYTICS_HOST = "https://aptabase.zotero.store";
const SESSION_TIMEOUT_MS = 60 * 60 * 1000;

type AnalyticsEventName =
  (typeof ANALYTICS_EVENTS)[keyof typeof ANALYTICS_EVENTS];

export type AnalyticsEventProps = Record<
  string,
  string | number | boolean | null | undefined
>;

interface AnalyticsConfig {
  enabled: boolean;
  appKey: string;
  host?: string;
  endpoint?: string;
}

const CLOUD_ENDPOINTS: Record<string, string> = {
  US: "https://us.aptabase.com/api/v0/event",
  EU: "https://eu.aptabase.com/api/v0/event",
  DEV: "http://localhost:3000/api/v0/event",
};

function createSessionId(): string {
  return `${Math.floor(Date.now() / 1000)}${Math.floor(
    Math.random() * 1e8,
  )
    .toString()
    .padStart(8, "0")}`;
}

function resolveApiEndpoint(
  appKey: string,
  host?: string,
): string | undefined {
  const region = appKey.split("-")[1];
  if (region === "SH") {
    return host ? `${host}/api/v0/event` : undefined;
  }
  return CLOUD_ENDPOINTS[region];
}

function getSystemLocale(): string {
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

function normalizeHost(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.replace(/\/+$/, "");
}

function isSelfHostedAppKey(appKey: string): boolean {
  return appKey.split("-")[1] === "SH";
}

function normalizeEventProps(
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

function getAnalyticsHttpRequest():
  | typeof Zotero.HTTP.request
  | null {
  const request = (Zotero as typeof globalThis.Zotero | undefined)?.HTTP?.request;
  return typeof request === "function" ? request.bind(Zotero.HTTP) : null;
}

export class AnalyticsService {
  private initialized = false;
  private disabled = false;
  private initPromise: Promise<void> | null = null;
  private config: AnalyticsConfig | null = null;
  private sessionId = createSessionId();
  private lastActivityAt = Date.now();

  private getCurrentSessionId(): string {
    const now = Date.now();
    if (now - this.lastActivityAt > SESSION_TIMEOUT_MS) {
      this.sessionId = createSessionId();
    }
    this.lastActivityAt = now;
    return this.sessionId;
  }

  async init(): Promise<void> {
    if (this.initialized || this.disabled) {
      return;
    }

    if (this.initPromise) {
      return this.initPromise;
    }

    const config = this.loadConfig();
    if (!config.enabled) {
      this.disabled = true;
      return;
    }

    if (!getAnalyticsHttpRequest()) {
      this.disabled = true;
      return;
    }

    this.initPromise = Promise.resolve()
      .then(() => {
        this.config = config;
        this.initialized = true;
      })
      .catch((error) => {
        this.disabled = true;
        ztoolkit.log("[Analytics] init failed", error);
      })
      .finally(() => {
        this.initPromise = null;
      });

    return this.initPromise;
  }

  track(eventName: AnalyticsEventName, props?: AnalyticsEventProps): void {
    if (this.disabled) {
      return;
    }

    const normalizedProps = normalizeEventProps(props);
    const send = () => {
      if (!this.initialized || !this.config?.endpoint) {
        return;
      }

      const request = getAnalyticsHttpRequest();
      if (!request) {
        this.disabled = true;
        return;
      }

      void request("POST", this.config.endpoint, {
        headers: {
          "Content-Type": "application/json",
          "App-Key": this.config.appKey,
        },
        body: JSON.stringify({
          timestamp: new Date().toISOString(),
          sessionId: this.getCurrentSessionId(),
          eventName,
          systemProps: {
            locale: getSystemLocale(),
            isDebug: __env__ !== "production",
            appVersion: version,
            sdkVersion: "paper-chat-analytics/1",
          },
          props: normalizedProps,
        }),
        responseType: "text",
        successCodes: false as const,
      })
        .then((response) => {
          if (response.status >= 300) {
            ztoolkit.log("[Analytics] event send failed", {
              eventName,
              status: response.status,
              response: response.responseText || "",
            });
            return;
          }
        })
        .catch((error) => {
          if (error && typeof error === "object" && "status" in error) {
            const httpError = error as {
              status: number;
              responseText?: string;
            };
            ztoolkit.log("[Analytics] event send failed", {
              eventName,
              status: httpError.status,
              response: httpError.responseText || "",
            });
            return;
          }

          ztoolkit.log("[Analytics] event send failed", {
            eventName,
            props: normalizedProps || {},
            error,
          });
        });
    };

    if (this.initialized) {
      send();
      return;
    }

    void this.init().then(send).catch(() => {});
  }

  destroy(): void {
    this.initialized = false;
    this.disabled = false;
    this.initPromise = null;
    this.config = null;
  }

  private loadConfig(): AnalyticsConfig {
    const enabled = ANALYTICS_ENABLED;
    const appKey = ANALYTICS_APP_KEY.trim();
    const host = normalizeHost(ANALYTICS_HOST);

    if (!enabled || !appKey) {
      return {
        enabled: false,
        appKey: "",
      };
    }

    if (isSelfHostedAppKey(appKey) && !host) {
      return {
        enabled: false,
        appKey: "",
      };
    }

    const endpoint = resolveApiEndpoint(appKey, host);
    if (!endpoint) {
      return {
        enabled: false,
        appKey: "",
      };
    }

    return {
      enabled: true,
      appKey,
      host,
      endpoint,
    };
  }
}

let analyticsService: AnalyticsService | null = null;

export function getAnalyticsService(): AnalyticsService {
  if (!analyticsService) {
    analyticsService = new AnalyticsService();
  }
  return analyticsService;
}

export function destroyAnalyticsService(): void {
  analyticsService?.destroy();
  analyticsService = null;
}
