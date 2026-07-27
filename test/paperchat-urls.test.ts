import { assert } from "chai";
import {
  DEFAULT_PAPERCHAT_SITE_BASE_URL,
  getPaperChatApiBaseUrl,
  getPaperChatSiteBaseUrl,
  getPaperChatUrl,
  normalizePaperChatSiteBaseUrl,
} from "../src/modules/providers/PaperChatUrls";

const PREF_KEY = "extensions.zotero.paperchat.paperchatBaseUrlOverride";

describe("PaperChat URL resolution", function () {
  let originalZotero: unknown;
  let originalEnv: unknown;
  let hadEnv: boolean;
  let prefStore: Map<string, unknown>;

  beforeEach(function () {
    originalZotero = (globalThis as any).Zotero;
    originalEnv = (globalThis as any).__env__;
    hadEnv = Object.prototype.hasOwnProperty.call(globalThis, "__env__");
    prefStore = new Map();
    (globalThis as any).__env__ = "development";
    (globalThis as any).Zotero = {
      Prefs: {
        get: (key: string) => prefStore.get(key),
      },
    };
  });

  afterEach(function () {
    (globalThis as any).Zotero = originalZotero;
    if (hadEnv) {
      (globalThis as any).__env__ = originalEnv;
    } else {
      delete (globalThis as any).__env__;
    }
  });

  it("normalizes service roots and optional v1 suffixes", function () {
    assert.equal(
      normalizePaperChatSiteBaseUrl(" http://localhost:9002/v1/ "),
      "http://localhost:9002",
    );
    assert.equal(
      normalizePaperChatSiteBaseUrl("https://example.test/paperchat/"),
      "https://example.test/paperchat",
    );
    assert.isNull(normalizePaperChatSiteBaseUrl("file:///tmp/paperchat"));
    assert.isNull(
      normalizePaperChatSiteBaseUrl("https://user:secret@example.test"),
    );
  });

  it("uses the override consistently for site and API URLs in development", function () {
    prefStore.set(PREF_KEY, "http://localhost:9002/v1");

    assert.equal(getPaperChatSiteBaseUrl(), "http://localhost:9002");
    assert.equal(getPaperChatApiBaseUrl(), "http://localhost:9002/v1");
    assert.equal(
      getPaperChatUrl("/api/pricing"),
      "http://localhost:9002/api/pricing",
    );
  });

  it("ignores a persisted override in production", function () {
    prefStore.set(PREF_KEY, "http://localhost:9002");
    (globalThis as any).__env__ = "production";

    assert.equal(getPaperChatSiteBaseUrl(), DEFAULT_PAPERCHAT_SITE_BASE_URL);
  });
});
