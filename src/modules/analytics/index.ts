import { version } from "../../../package.json";
import {
  AnalyticsService,
  type AnalyticsEventProps,
  type AnalyticsHttpTransport,
  type AnalyticsLogger,
} from "./AnalyticsService";

export { AnalyticsService } from "./AnalyticsService";
export type {
  AnalyticsEventProps,
  AnalyticsHttpRequest,
  AnalyticsHttpResponse,
  AnalyticsHttpTransport,
  AnalyticsLogger,
  AnalyticsServiceOptions,
} from "./AnalyticsService";
export { ANALYTICS_EVENTS, type AnalyticsEventName } from "./events";

const ANALYTICS_ENABLED = true;
const ANALYTICS_APP_KEY = "A-SH-9454265759";
const ANALYTICS_HOST = "https://aptabase.zotero.store";
const ANALYTICS_SDK_VERSION = "paper-chat-analytics/1";

const APTABASE_CLOUD_ENDPOINTS: Record<string, string> = {
  US: "https://us.aptabase.com/api/v0/events",
  EU: "https://eu.aptabase.com/api/v0/events",
  DEV: "http://localhost:3000/api/v0/events",
};

export interface Analytics {
  track(eventName: string, props?: AnalyticsEventProps): void;
  destroy(): Promise<void>;
}

class NoopAnalyticsService implements Analytics {
  track(): void {
    // intentionally empty
  }
  async destroy(): Promise<void> {
    // intentionally empty
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

function resolveAptabaseEndpoint(
  appKey: string,
  host: string | undefined,
): string | undefined {
  const region = appKey.split("-")[1];
  if (region === "SH") {
    return host ? `${host}/api/v0/events` : undefined;
  }
  return APTABASE_CLOUD_ENDPOINTS[region];
}

function createZoteroHttpTransport(): AnalyticsHttpTransport | null {
  const request = (Zotero as typeof globalThis.Zotero | undefined)?.HTTP
    ?.request;
  if (typeof request !== "function") {
    return null;
  }
  const boundRequest = request.bind(Zotero.HTTP);
  return async ({ method, url, headers, body }) => {
    const response = await boundRequest(method, url, {
      headers,
      body,
      responseType: "text",
      successCodes: false as const,
    });
    return {
      status: response.status,
      responseText: response.responseText || "",
    };
  };
}

const pluginLogger: AnalyticsLogger = {
  log: (message, context) => {
    if (typeof ztoolkit !== "undefined" && ztoolkit?.log) {
      ztoolkit.log(message, context);
    }
  },
};

let analyticsService: Analytics | null = null;

function buildAnalyticsService(): Analytics {
  if (!ANALYTICS_ENABLED) {
    return new NoopAnalyticsService();
  }
  const appKey = ANALYTICS_APP_KEY.trim();
  if (!appKey) {
    return new NoopAnalyticsService();
  }
  const host = normalizeHost(ANALYTICS_HOST);
  if (isSelfHostedAppKey(appKey) && !host) {
    return new NoopAnalyticsService();
  }
  const endpoint = resolveAptabaseEndpoint(appKey, host);
  if (!endpoint) {
    return new NoopAnalyticsService();
  }
  const http = createZoteroHttpTransport();
  if (!http) {
    return new NoopAnalyticsService();
  }

  return new AnalyticsService({
    appKey,
    endpoint,
    appVersion: version,
    isDebug: __env__ !== "production",
    sdkVersion: ANALYTICS_SDK_VERSION,
    http,
    logger: pluginLogger,
  });
}

export function getAnalyticsService(): Analytics {
  if (!analyticsService) {
    analyticsService = buildAnalyticsService();
  }
  return analyticsService;
}

export async function destroyAnalyticsService(): Promise<void> {
  await analyticsService?.destroy();
  analyticsService = null;
}
