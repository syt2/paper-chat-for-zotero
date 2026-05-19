import { assert } from "chai";
import { config } from "../package.json";
import { compareVersion, findNewerUpdate } from "../src/utils/selfUpdate.ts";
import {
  getGithubUrlCandidates,
  getUpdateURLTemplate,
  toGhProxyUrl,
  toKkGithubUrl,
} from "../src/utils/updateUrls.ts";

describe("self update helpers", function () {
  it("builds release update json paths from version channel", function () {
    assert.equal(
      getUpdateURLTemplate("2.2.1"),
      "https://github.com/{{owner}}/{{repo}}/releases/download/release/update.json",
    );
    assert.equal(
      getUpdateURLTemplate("2.2.1-beta.1"),
      "https://github.com/{{owner}}/{{repo}}/releases/download/release/update-beta.json",
    );
  });

  it("builds GitHub fallback candidates in direct, ghproxy, kkgithub order", function () {
    const githubUrl =
      "https://github.com/syt2/paper-chat-for-zotero/releases/download/release/update.json";

    assert.equal(toGhProxyUrl(githubUrl), `https://gh-proxy.org/${githubUrl}`);
    assert.equal(
      toKkGithubUrl(githubUrl),
      "https://kkgithub.com/syt2/paper-chat-for-zotero/releases/download/release/update.json",
    );
    assert.deepEqual(getGithubUrlCandidates(githubUrl), [
      githubUrl,
      `https://gh-proxy.org/${githubUrl}`,
      "https://kkgithub.com/syt2/paper-chat-for-zotero/releases/download/release/update.json",
    ]);
  });

  it("selects the newest update only when it is newer than the installed version", function () {
    const updateInfo = {
      addons: {
        [config.addonID]: {
          updates: [
            {
              version: "2.2.2",
              update_link: "https://github.com/example/release/2.2.2.xpi",
            },
            {
              version: "2.3.0",
              update_link: "https://github.com/example/release/2.3.0.xpi",
            },
          ],
        },
      },
    };

    assert.equal(
      findNewerUpdate("2.2.1", updateInfo)?.update_link,
      "https://github.com/example/release/2.3.0.xpi",
    );
    assert.isNull(findNewerUpdate("2.3.0", updateInfo));
  });

  it("compares dotted versions without Zotero Services", function () {
    assert.equal(compareVersion("2.2.1", "2.2.2"), -1);
    assert.equal(compareVersion("2.2.2", "2.2.1"), 1);
    assert.equal(compareVersion("2.2.1", "2.2.1"), 0);
  });
});
