/**
 * Resolve the collection that can safely seed a collection-scoped chat.
 *
 * Zotero 10 allows multiple collection-tree rows to be selected, including a
 * mix of collections and saved searches. A scoped chat must therefore start
 * only when exactly one selected row is a collection. Zotero 9 does not have
 * the plural selection APIs, so retain its single-selection getter as a
 * compatibility fallback.
 */

type CollectionScopePane = {
  getCollectionTreeRows?: () => unknown[];
  getSelectedCollections?: () => Zotero.Collection[];
  getSelectedCollection?: () => Zotero.Collection | undefined;
};

export function getSingleSelectedCollection(
  pane: CollectionScopePane | null | undefined,
): Zotero.Collection | null {
  if (!pane) {
    return null;
  }

  if (typeof pane.getSelectedCollections === "function") {
    const rows = pane.getCollectionTreeRows?.() || [];
    const collections = pane.getSelectedCollections();
    return rows.length === 1 && collections.length === 1
      ? collections[0]
      : null;
  }

  return pane.getSelectedCollection?.() || null;
}
