import type { CreateTokenRequest, TokenInfo } from "../../types/auth";

export const PLUGIN_TOKEN_NAME = "Paper-Chat-Plugin";
export const PLUGIN_TOKEN_GROUP = "auto";

export function buildPluginTokenCreateRequest(): CreateTokenRequest {
  return {
    name: PLUGIN_TOKEN_NAME,
    remain_quota: 0,
    remain_amount: 0,
    expired_time: -1,
    unlimited_quota: true,
    model_limits_enabled: false,
    model_limits: "",
    cross_group_retry: true,
    group: PLUGIN_TOKEN_GROUP,
    allow_ips: "",
  };
}

export function buildLegacyPluginTokenCreateRequest(): CreateTokenRequest {
  return {
    name: PLUGIN_TOKEN_NAME,
    unlimited_quota: true,
    expired_time: -1,
  };
}

export function normalizePluginApiKey(key: string): string {
  return key.startsWith("sk-") ? key : `sk-${key}`;
}

function isActivePluginToken(token: TokenInfo): boolean {
  return token.name === PLUGIN_TOKEN_NAME && token.status === 1;
}

function isTargetGroupToken(token: TokenInfo): boolean {
  return token.group === PLUGIN_TOKEN_GROUP;
}

function compareNewestToken(a: TokenInfo, b: TokenInfo): number {
  const createdDiff = (b.created_time || 0) - (a.created_time || 0);
  if (createdDiff !== 0) {
    return createdDiff;
  }
  return (b.id || 0) - (a.id || 0);
}

export function findActivePluginTokens(tokens: TokenInfo[]): TokenInfo[] {
  return tokens.filter(isActivePluginToken).sort(compareNewestToken);
}

export function findActiveAutoPluginToken(
  tokens: TokenInfo[],
): TokenInfo | undefined {
  return findActivePluginTokens(tokens).find(isTargetGroupToken);
}

export function findLegacyPluginToken(
  tokens: TokenInfo[],
): TokenInfo | undefined {
  return findActivePluginTokens(tokens).find(
    (token) => !isTargetGroupToken(token),
  );
}
