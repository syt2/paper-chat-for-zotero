/** Dispatch from the input's own window; Zotero's plugin sandbox has no Event. */
export function dispatchInputEvent(input: HTMLTextAreaElement): void {
  const win = input.ownerDocument.defaultView as Window & typeof globalThis;
  input.dispatchEvent(new win.Event("input", { bubbles: true }));
}
