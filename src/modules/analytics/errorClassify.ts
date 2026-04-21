export function extractStatusCode(message: string): number | null {
  const match = message.match(/\b([45]\d{2})\b/);
  return match ? Number.parseInt(match[1], 10) : null;
}

export function isNetworkErrorMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("network error") ||
    normalized.includes("networkerror") ||
    normalized.includes("网络错误") ||
    normalized.includes("failed to fetch") ||
    normalized.includes("timeout") ||
    normalized.includes("timed out")
  );
}
