import { defineConfig } from "zotero-plugin-scaffold";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import pkg from "./package.json";
import {
  getUpdateURLTemplate,
  XPI_DOWNLOAD_LINK_TEMPLATE,
} from "./src/utils/updateUrls";

const onlineReleaseUpgradeStage =
  process.env.PAPERCHAT_ONLINE_RELEASE_UPGRADE_STAGE;
const isOnlineReleaseUpgradeTest =
  onlineReleaseUpgradeStage === "upgrade" ||
  onlineReleaseUpgradeStage === "idempotency";
const isPresentationProbe = process.env.PAPERCHAT_PRESENTATION_PROBE === "1";
const presentationProbeOutputPath = resolve(
  ".scaffold/presentation-probe/paperchat-presentation-probe.pptx",
);
const presentationMediaProbeItemKey =
  process.env.PAPERCHAT_PRESENTATION_MEDIA_PROBE_ITEM_KEY;
const presentationMediaProbeOutputPath =
  process.env.PAPERCHAT_PRESENTATION_MEDIA_PROBE_OUTPUT;

const onlineReleaseFixturePath = resolve(
  "test/fixtures/storage-v2.6.1-online.sqlite.gz.base64",
);
const onlineReleaseProvenancePath = resolve(
  "test/fixtures/storage-v2.6.1-online.provenance.json",
);
const onlineReleaseStageDir = resolve(".scaffold/online-release-upgrade");
const onlineReleaseStageStoragePath = resolve(
  onlineReleaseStageDir,
  "storage-v9",
);
const onlineReleaseTestDataDir = resolve(".scaffold/test/data/paper-chat");

const expectedOnlineReleaseProvenance = {
  releaseVersion: "2.6.1",
  releaseTag: "V2.6.1",
  releaseCommit: "586f0b18d69d4c41dfbff9a40b694f4bac048ded",
  xpiSourceURI:
    "https://github.com/syt2/paper-chat-for-zotero/releases/download/V2.6.1/ai-paper-chat.xpi",
  xpiSha256: "344cd422d02a9e522820a0495e9f4ab67c139922fa25b488079f75333738a579",
  xpiBundleSha256:
    "5cc9d30f66c6bcc65e000e9863a7cc9645e8e9500bd150f4664ff05a3cfc73b7",
  zoteroVersion: "9.0.6",
  schemaVersion: 8,
  fixtureSha256:
    "2ca0cb72505adb4afdd2c9cba5d15cbf5b3775153c4bdbb57134c05b53aae49b",
  fixtureGzipSha256:
    "3aeba4e52427e8052fc408c14209fe7e3a9a43078ddecb4b8e46766eb7172367",
  containsSyntheticDataOnly: true,
  expectedRows: {
    sessions: 2,
    messages: 3,
    session_meta: 2,
    paperchat_session_state: 1,
  },
  generation:
    "The byte-verified official V2.6.1 XPI initialized a clean isolated Zotero data directory. The harness then inserted two deterministic synthetic sessions and three synthetic messages, including a non-empty reasoning value, through Zotero.DBConnection before checkpointing the v8 database.",
} as const;

function materializeOnlineReleaseFixture(): Buffer {
  const encoded = readFileSync(onlineReleaseFixturePath, "utf8").replace(
    /\s+/g,
    "",
  );
  const compressedFixture = Buffer.from(encoded, "base64");
  const gzipSha256 = createHash("sha256")
    .update(compressedFixture)
    .digest("hex");
  if (gzipSha256 !== expectedOnlineReleaseProvenance.fixtureGzipSha256) {
    throw new Error(`Online release gzip hash mismatch: ${gzipSha256}`);
  }
  const fixture = gunzipSync(compressedFixture);
  const fixtureSha256 = createHash("sha256").update(fixture).digest("hex");
  if (fixtureSha256 !== expectedOnlineReleaseProvenance.fixtureSha256) {
    throw new Error(`Online release fixture hash mismatch: ${fixtureSha256}`);
  }
  const provenance = JSON.parse(
    readFileSync(onlineReleaseProvenancePath, "utf8"),
  );
  if (
    JSON.stringify(provenance) !==
    JSON.stringify(expectedOnlineReleaseProvenance)
  ) {
    throw new Error("Online release fixture provenance mismatch");
  }
  return fixture;
}

function prepareOnlineReleaseUpgradeData(): void {
  mkdirSync(onlineReleaseTestDataDir, { recursive: true });
  const fixture = materializeOnlineReleaseFixture();
  writeFileSync(resolve(onlineReleaseTestDataDir, "baseline-v8"), fixture);
  writeFileSync(resolve(onlineReleaseTestDataDir, "rollback-v8"), fixture);
  writeFileSync(resolve(onlineReleaseTestDataDir, "wal-v8"), fixture);

  const storagePath = resolve(onlineReleaseTestDataDir, "storage");
  if (onlineReleaseUpgradeStage === "upgrade") {
    writeFileSync(storagePath, fixture);
    return;
  }

  if (!existsSync(onlineReleaseStageStoragePath)) {
    throw new Error(
      "Missing first-pass v9 database for idempotency verification",
    );
  }
  copyFileSync(onlineReleaseStageStoragePath, storagePath);
}

export default defineConfig({
  source: ["src", "addon"],
  dist: ".scaffold/build",
  name: pkg.config.addonName,
  id: pkg.config.addonID,
  namespace: pkg.config.addonRef,
  updateURL: getUpdateURLTemplate(pkg.version),
  xpiDownloadLink: XPI_DOWNLOAD_LINK_TEMPLATE,

  build: {
    assets: ["addon/**/*.*"],
    define: {
      ...pkg.config,
      author: pkg.author,
      description: pkg.description,
      homepage: pkg.homepage,
      buildVersion: pkg.version,
      buildTime: "{{buildTime}}",
    },
    prefs: {
      prefix: pkg.config.prefsPrefix,
    },
    esbuildOptions: [
      {
        entryPoints: ["src/index.ts"],
        define: {
          __env__: `"${process.env.NODE_ENV}"`,
        },
        bundle: true,
        target: "firefox115",
        outfile: `.scaffold/build/addon/content/scripts/${pkg.config.addonRef}.js`,
      },
      {
        entryPoints: [
          "src/modules/presentation/renderer/presentation-renderer-entry.ts",
        ],
        bundle: true,
        format: "iife",
        globalName: "PaperChatPresentationRendererBundle",
        platform: "browser",
        target: "firefox115",
        inject: [
          "src/modules/presentation/renderer/set-immediate-browser-shim.ts",
        ],
        outfile:
          ".scaffold/build/addon/content/scripts/paperchat-ppt-renderer.js",
      },
    ],
  },

  test: {
    waitForPlugin: `() => Zotero.${pkg.config.addonInstance}.data.initialized`,
    ...(isOnlineReleaseUpgradeTest
      ? {
          entries: "test-online-release-upgrade",
          startupDelay: 2000,
          mocha: { timeout: 30000 },
          prefs: {
            "extensions.zotero.paperchat.onlineReleaseUpgradeStage":
              onlineReleaseUpgradeStage!,
          },
          hooks: {
            "test:init": prepareOnlineReleaseUpgradeData,
          },
        }
      : isPresentationProbe
        ? {
            entries: "test-presentation-probe",
            startupDelay: 2000,
            mocha: { timeout: 30000 },
            prefs: {
              "extensions.zotero.paperchat.presentationProbeOutputPath":
                presentationProbeOutputPath,
              ...(presentationMediaProbeItemKey
                ? {
                    "extensions.zotero.paperchat.presentationMediaProbeItemKey":
                      presentationMediaProbeItemKey,
                  }
                : {}),
              ...(presentationMediaProbeOutputPath
                ? {
                    "extensions.zotero.paperchat.presentationMediaProbeOutputPath":
                      presentationMediaProbeOutputPath,
                  }
                : {}),
            },
          }
        : {}),
  },

  release: {
    bumpp: {
      commit: "chore(publish): release V%s",
      tag: "V%s",
    },
  },

  // If you need to see a more detailed log, uncomment the following line:
  // logLevel: "trace",
});
