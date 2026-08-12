// JSZip's setImmediate polyfill selects a postMessage strategy that does not
// dispatch in Firefox chrome windows. Esbuild injects this lexical shim only
// into the presentation renderer bundle, leaving Zotero's window untouched.
export function setImmediate(
  callback: (...args: unknown[]) => void,
  ...args: unknown[]
): ReturnType<typeof setTimeout> {
  return globalThis.setTimeout(callback, 0, ...args);
}
