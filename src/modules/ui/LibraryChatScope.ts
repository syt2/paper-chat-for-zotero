/**
 * LibraryChatScope - library-side entry points that start a scoped chat.
 *
 * - Item context menu: "Compare selected papers in chat" (2+ items selected)
 * - Collection context menu: "Chat about this collection"
 *
 * Both build a SessionScope, start a fresh scoped session, and open the panel
 * so the conversation begins with the working set already established.
 */

import { getString } from "../../utils/locale";
import { getErrorMessage } from "../../utils/common";
import { buildScopeFromItems, type SessionScope } from "../chat/session-scope";
import { getChatManager, showPanel } from "./chat-panel";
import { getSingleSelectedCollection } from "./library-chat-scope-selection";

const ITEM_MENU_ID = "paperchat-scope-selection-menuitem";
const COLLECTION_MENU_ID = "paperchat-scope-collection-menuitem";

async function startScopedChat(scope: SessionScope | null): Promise<void> {
  if (!scope) {
    return;
  }
  try {
    await getChatManager().startScopedSession(scope);
    showPanel("library_scope");
  } catch (error) {
    ztoolkit.log(
      "[LibraryChatScope] Failed to start scoped chat:",
      getErrorMessage(error),
    );
  }
}

function scopeFromSelectedItems(): SessionScope | null {
  const pane = Zotero.getActiveZoteroPane();
  const selected =
    (pane?.getSelectedItems() as Zotero.Item[] | undefined) || [];
  if (selected.length < 2) {
    return null;
  }
  return buildScopeFromItems(
    selected,
    getString("chat-scope-selection-label", {
      args: { count: selected.length },
    }),
  );
}

function scopeFromSelectedCollection(): SessionScope | null {
  const pane = Zotero.getActiveZoteroPane();
  const collection = getSingleSelectedCollection(pane);
  if (!collection) {
    return null;
  }
  const items = collection.getChildItems() as Zotero.Item[] | false;
  if (!items || items.length === 0) {
    return null;
  }
  return buildScopeFromItems(items, collection.name);
}

export function registerLibraryChatScopeMenus(): void {
  ztoolkit.Menu.register("item", {
    tag: "menuitem",
    id: ITEM_MENU_ID,
    label: getString("chat-scope-selection"),
    icon: `chrome://${addon.data.config.addonRef}/content/icons/favicon.svg`,
    // Only meaningful for a multi-item selection; a single item is already
    // covered by opening the paper in the reader.
    getVisibility: () => {
      const pane = Zotero.getActiveZoteroPane();
      const selected = pane?.getSelectedItems() as Zotero.Item[] | undefined;
      return (selected?.length || 0) >= 2;
    },
    commandListener: () => {
      void startScopedChat(scopeFromSelectedItems());
    },
  });

  ztoolkit.Menu.register("collection", {
    tag: "menuitem",
    id: COLLECTION_MENU_ID,
    label: getString("chat-scope-collection"),
    icon: `chrome://${addon.data.config.addonRef}/content/icons/favicon.svg`,
    commandListener: () => {
      void startScopedChat(scopeFromSelectedCollection());
    },
  });

  ztoolkit.log("[LibraryChatScope] Scope menus registered");
}

export function unregisterLibraryChatScopeMenus(): void {
  ztoolkit.Menu.unregister(ITEM_MENU_ID);
  ztoolkit.Menu.unregister(COLLECTION_MENU_ID);
}
