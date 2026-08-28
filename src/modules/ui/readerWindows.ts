/**
 * Return the PDF reader iframe windows exposed by Zotero's reader wrapper.
 *
 * These fields are private Zotero implementation details. Keep their access in
 * one defensive adapter so a reader being replaced or unloaded cannot make
 * each UI consumer maintain a subtly different lookup sequence.
 */
type ReaderWindowView = {
  _iframeWindow?: Window;
};

type ReaderWindowCarrier = _ZoteroTypes.ReaderInstance & {
  _iframeWindow?: Window;
  _internalReader?: {
    _lastView?: ReaderWindowView;
    _primaryView?: ReaderWindowView;
  };
};

export function getReaderWindows(
  reader: _ZoteroTypes.ReaderInstance | null | undefined,
): Window[] {
  if (!reader) return [];
  const readerLike = reader as ReaderWindowCarrier;
  const windows: Window[] = [];

  try {
    const internalReader = readerLike._internalReader;
    windows.push(
      ...(internalReader?._lastView?._iframeWindow
        ? [internalReader._lastView._iframeWindow]
        : []),
      ...(internalReader?._primaryView?._iframeWindow
        ? [internalReader._primaryView._iframeWindow]
        : []),
    );
  } catch {
    // Zotero may invalidate the private wrapper while a tab is closing.
  }

  try {
    if (readerLike._iframeWindow) {
      windows.push(readerLike._iframeWindow);
    }
  } catch {
    // Ignore a stale outer reader wrapper as well.
  }

  return Array.from(new Set(windows));
}
