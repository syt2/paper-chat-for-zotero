import { defineConfig } from "zotero-plugin-scaffold";
import pkg from "./package.json";
import {
  getUpdateURLTemplate,
  XPI_DOWNLOAD_LINK_TEMPLATE,
} from "./src/utils/updateUrls";

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
    ],
  },

  test: {
    waitForPlugin: `() => Zotero.${pkg.config.addonInstance}.data.initialized`,
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
