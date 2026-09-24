/**
 * Identifies this plugin build to the PaperChat backend so the backend can
 * tailor its responses - for example, only announcing per-model reasoning
 * capabilities to clients that understand them. Builds that predate these
 * headers send nothing, which the backend treats as legacy behaviour.
 */
import { version } from "../../package.json";

export const PAPERCHAT_CLIENT_HEADER = "X-PaperChat-Client";
export const PAPERCHAT_CLIENT_CAPS_HEADER = "X-PaperChat-Client-Caps";
export const PAPERCHAT_CLIENT_NAME = "paperchat";

/** Capabilities this build understands, sent as a comma-separated list. */
export const PAPERCHAT_CLIENT_CAPABILITIES = ["reasoning=1"] as const;

export function getPaperChatClientVersion(): string {
  return version;
}

export function getPaperChatClientHeaders(): Record<string, string> {
  return {
    [PAPERCHAT_CLIENT_HEADER]: `${PAPERCHAT_CLIENT_NAME}/${version}`,
    [PAPERCHAT_CLIENT_CAPS_HEADER]: PAPERCHAT_CLIENT_CAPABILITIES.join(","),
  };
}

/**
 * Same identity as a query string. Sent in addition to the headers because a
 * reverse proxy can drop custom headers, while the URL survives every hop and
 * shows up in access logs, which makes the gate easy to verify.
 */
export function getPaperChatClientQuery(): string {
  const params = new URLSearchParams({
    client: `${PAPERCHAT_CLIENT_NAME}/${version}`,
    caps: PAPERCHAT_CLIENT_CAPABILITIES.join(","),
  });
  return `?${params.toString()}`;
}
