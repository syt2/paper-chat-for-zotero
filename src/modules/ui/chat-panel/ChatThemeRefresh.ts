/** Refresh theme-dependent DOM without losing in-progress form edits. */
export function refreshChatThemeContent(
  container: HTMLElement,
  render: () => void,
): void {
  const selector =
    "#chat-history input, #chat-history textarea, #chat-history select, #chat-execution-approval-panel input, #chat-execution-approval-panel textarea, #chat-execution-approval-panel select";
  type Control = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
  const active = container.ownerDocument.activeElement;
  const saved = (
    Array.from(container.querySelectorAll(selector)) as Control[]
  ).map((element) => ({
    tag: element.tagName,
    name: element.name,
    type: element.type,
    value: element.value,
    checked: (element as HTMLInputElement).checked,
    focused: element === active,
    start: "selectionStart" in element ? element.selectionStart : null,
    end: "selectionEnd" in element ? element.selectionEnd : null,
  }));
  render();
  const controls = Array.from(
    container.querySelectorAll(selector),
  ) as Control[];
  controls.forEach((element, index) => {
    const state = saved[index];
    if (
      !state ||
      state.tag !== element.tagName ||
      state.name !== element.name ||
      state.type !== element.type
    )
      return;
    if (element.type === "file") return;
    element.value = state.value;
    if (typeof state.checked === "boolean")
      (element as HTMLInputElement).checked = state.checked;
    if (state.focused) {
      element.focus({ preventScroll: true });
      if (
        state.start !== null &&
        state.end !== null &&
        "setSelectionRange" in element
      )
        element.setSelectionRange(state.start, state.end);
    }
  });
}
