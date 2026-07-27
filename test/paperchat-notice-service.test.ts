import { assert } from "chai";
import {
  getCachedPaperChatNotice,
  refreshPaperChatNotice,
  resetPaperChatNoticeCache,
} from "../src/modules/providers/PaperChatNoticeService";

const PREF_KEY = "extensions.zotero.paperchat.paperchatBaseUrlOverride";

describe("PaperChat notice service", function () {
  let originalEnv: unknown;
  let originalFetch: unknown;
  let originalZotero: unknown;
  let originalZtoolkit: unknown;
  let hadEnv: boolean;
  let prefStore: Map<string, unknown>;

  beforeEach(function () {
    originalEnv = (globalThis as any).__env__;
    originalFetch = (globalThis as any).fetch;
    originalZotero = (globalThis as any).Zotero;
    originalZtoolkit = (globalThis as any).ztoolkit;
    hadEnv = Object.prototype.hasOwnProperty.call(globalThis, "__env__");
    prefStore = new Map();
    (globalThis as any).__env__ = "development";
    (globalThis as any).Zotero = {
      Prefs: { get: (key: string) => prefStore.get(key) },
    };
    (globalThis as any).ztoolkit = { log: () => undefined };
    resetPaperChatNoticeCache();
  });

  afterEach(function () {
    resetPaperChatNoticeCache();
    (globalThis as any).fetch = originalFetch;
    (globalThis as any).Zotero = originalZotero;
    (globalThis as any).ztoolkit = originalZtoolkit;
    if (hadEnv) {
      (globalThis as any).__env__ = originalEnv;
    } else {
      delete (globalThis as any).__env__;
    }
  });

  it("does not let an old environment request overwrite the new cache", async function () {
    let resolveOfficial: ((response: Response) => void) | undefined;
    const urls: string[] = [];
    (globalThis as any).fetch = async (input: string | URL | Request) => {
      const url = String(input);
      urls.push(url);
      if (url.startsWith("https://paperchat.zotero.store")) {
        return new Promise<Response>((resolve) => {
          resolveOfficial = resolve;
        });
      }
      return noticeResponse("development notice");
    };

    const officialRequest = refreshPaperChatNotice();
    resetPaperChatNoticeCache();
    prefStore.set(PREF_KEY, "http://localhost:9002");
    await refreshPaperChatNotice();
    resolveOfficial?.(noticeResponse("official notice"));
    await officialRequest;

    assert.deepEqual(urls, [
      "https://paperchat.zotero.store/api/notice",
      "http://localhost:9002/api/notice",
    ]);
    assert.equal(getCachedPaperChatNotice(), "development notice");
  });
});

function noticeResponse(notice: string): Response {
  return new Response(JSON.stringify({ success: true, data: notice }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
