export const GITHUB_RELEASE_UPDATE_TAG = "release";
export const GHPROXY_BASE = "https://gh-proxy.org/";
export const KKGITHUB_DOMAIN = "kkgithub.com";

export function getUpdateURLTemplate(version: string): string {
  return `https://github.com/{{owner}}/{{repo}}/releases/download/${GITHUB_RELEASE_UPDATE_TAG}/${
    version.includes("-") ? "update-beta.json" : "update.json"
  }`;
}

export const XPI_DOWNLOAD_LINK_TEMPLATE =
  "https://github.com/{{owner}}/{{repo}}/releases/download/V{{version}}/{{xpiName}}.xpi";

export function toGhProxyUrl(githubUrl: string): string {
  return `${GHPROXY_BASE}${githubUrl}`;
}

export function toKkGithubUrl(githubUrl: string): string {
  return githubUrl.replace("github.com", KKGITHUB_DOMAIN);
}

export function getGithubUrlCandidates(url: string): string[] {
  if (!url.includes("github.com")) {
    return [url];
  }
  return [url, toGhProxyUrl(url), toKkGithubUrl(url)];
}
