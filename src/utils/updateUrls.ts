export const GITHUB_RELEASE_UPDATE_TAG = "release";
export const GHPROXY_BASE = "https://gh-proxy.org/";
/**
 * Mirrors tried after the direct GitHub URL. They are third-party services, so
 * keep several and drop the dead ones: kkgithub.com expired and now resolves to
 * a domain-parking page.
 */
export const GITHUB_PROXY_BASES = [
  GHPROXY_BASE,
  "https://gh-proxy.com/",
  "https://ghfast.top/",
  "https://ghproxy.net/",
] as const;

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

export function toProxyUrl(proxyBase: string, githubUrl: string): string {
  return `${proxyBase}${githubUrl}`;
}

export function getGithubUrlCandidates(url: string): string[] {
  if (!url.includes("github.com")) {
    return [url];
  }
  return [url, ...GITHUB_PROXY_BASES.map((base) => toProxyUrl(base, url))];
}
