/** Small, immutable-by-convention snapshot of the selected passage's source. */
export interface SelectionTranslationContext {
  paperTitle?: string;
  before?: string;
  after?: string;
}

export function normalizeTranslationContext(
  context: SelectionTranslationContext = {},
): SelectionTranslationContext {
  const paperTitle = context.paperTitle?.trim().slice(0, 300);
  const before = context.before?.trim().slice(-200);
  const after = context.after?.trim().slice(0, 200);
  return {
    ...(paperTitle ? { paperTitle } : {}),
    ...(before ? { before } : {}),
    ...(after ? { after } : {}),
  };
}

/** Only use the live matching selection; never search another occurrence of it. */
export function captureTranslationContext(
  doc: Document,
  text: string,
  paperTitle?: string,
): SelectionTranslationContext {
  const context: SelectionTranslationContext = { paperTitle };
  try {
    const selection = doc.getSelection();
    const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
    if (
      !selection?.rangeCount ||
      normalize(selection.toString()) !== normalize(text)
    ) {
      return normalizeTranslationContext(context);
    }
    const first = selection.getRangeAt(0);
    const last = selection.getRangeAt(selection.rangeCount - 1);
    const layer = (node: Node) =>
      (node.nodeType === 1 ? (node as Element) : node.parentElement)?.closest(
        ".textLayer",
      );
    const startLayer = layer(first.startContainer);
    const endLayer = layer(last.endContainer);
    if (startLayer) {
      const before = doc.createRange();
      before.selectNodeContents(startLayer);
      before.setEnd(first.startContainer, first.startOffset);
      context.before = before.toString();
    }
    if (endLayer) {
      const after = doc.createRange();
      after.selectNodeContents(endLayer);
      after.setStart(last.endContainer, last.endOffset);
      context.after = after.toString();
    }
  } catch {
    // PDF.js can replace the text layer while its selection palette opens.
  }
  return normalizeTranslationContext(context);
}
