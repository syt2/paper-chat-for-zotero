import { getString, initLocale } from "./utils/locale";
import { registerPrefsScripts } from "./modules/preferences";
import { createZToolkit } from "./utils/ztoolkit";
import { registerToolbarButton, unregisterChatPanel, togglePanel } from "./modules/ui";
import { getAuthManager, destroyAuthManager } from "./modules/auth";
import { destroyProviderManager } from "./modules/providers";
import {
  initAISummary,
  getAISummaryManager,
  initAISummaryService,
  destroyAISummaryService,
  getAISummaryService,
  openTaskWindow,
} from "./modules/ai-summary";
import {
  destroyRAGService,
  destroyVectorStore,
  destroyEmbeddingProviderFactory,
} from "./modules/embedding";
import { getStorageDatabase, destroyStorageDatabase } from "./modules/chat/db/StorageDatabase";
import { checkAndMigrateToV3 } from "./modules/chat/migration/migrateToSQLite";
import { destroyMemoryStores, getMemoryStore } from "./modules/chat/memory/MemoryStore";

async function onStartup() {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  initLocale();

  // Register preference pane first — must not be blocked by storage/migration errors
  Zotero.PreferencePanes.register({
    pluginID: addon.data.config.addonID,
    id: "paperchat-prefpane",
    src: rootURI + "content/preferences.xhtml",
    label: getString("prefs-title"),
    image: `chrome://${addon.data.config.addonRef}/content/icons/favicon.svg`,
  });

  // Initialize StorageDatabase + run migration
  // Wrapped in try/catch so that DB failure on Windows does not block UI registration
  try {
    await getStorageDatabase().init();
    await checkAndMigrateToV3();
    // Kick off memory embedding check after DB is ready (fire-and-forget)
    getMemoryStore().checkAndReindex().catch((err) => {
      ztoolkit.log("[Startup] Memory reindex failed:", err);
    });
  } catch (error) {
    ztoolkit.log("[Startup] StorageDatabase init failed (will retry on first use):", error);
  }

  // Initialize auth manager
  const authManager = getAuthManager();
  await authManager.initialize();

  // Initialize AISummary
  try {
    await initAISummary();
    initAISummaryService();
    getAISummaryService().setOnOpenTaskWindow(openTaskWindow);
  } catch (error) {
    ztoolkit.log("[Startup] AISummary init failed:", error);
  }

  // Register UI (toolbar button, menus) — must always run
  await Promise.all(
    Zotero.getMainWindows().map((win) => onMainWindowLoad(win)),
  );

  addon.data.initialized = true;
}

async function onMainWindowLoad(win: _ZoteroTypes.MainWindow): Promise<void> {
  addon.data.ztoolkit = createZToolkit();

  win.MozXULElement.insertFTLIfNeeded(
    `${addon.data.config.addonRef}-mainWindow.ftl`,
  );

  // Register stylesheet
  const doc = win.document;
  const styles = ztoolkit.UI.createElement(doc, "link", {
    properties: {
      type: "text/css",
      rel: "stylesheet",
      href: `chrome://${addon.data.config.addonRef}/content/zoteroPane.css`,
    },
  });
  doc.documentElement?.appendChild(styles);

  // Register toolbar button for chat panel
  try {
    registerToolbarButton();
  } catch (error) {
    ztoolkit.log("Failed to register toolbar button:", error);
  }

  // Register AISummary menus (must be after createZToolkit)
  getAISummaryService().registerMenus();

  // Register Chat Panel menu in Tools menu
  ztoolkit.Menu.register("menuTools", {
    tag: "menuitem",
    id: "paperchat-chat-menuitem",
    label: getString("chat-menu-open"),
    icon: `chrome://${addon.data.config.addonRef}/content/icons/favicon.svg`,
    commandListener: () => {
      togglePanel();
    },
  });
}

async function onMainWindowUnload(_win: Window): Promise<void> {
  ztoolkit.unregisterAll();
  addon.data.dialog?.window?.close();
}

async function onShutdown(): Promise<void> {
  ztoolkit.unregisterAll();
  ztoolkit.Menu.unregister("paperchat-chat-menuitem");
  getAISummaryService().unregisterMenus();
  // Await so ChatManager.destroy() (session meta write, extraction) finishes
  // before StorageDatabase is torn down below.
  await unregisterChatPanel();
  destroyProviderManager();
  destroyAuthManager();
  // Destroy AISummary
  destroyAISummaryService();
  getAISummaryManager().destroy();
  // Destroy Embedding/RAG
  destroyRAGService();
  destroyEmbeddingProviderFactory();
  destroyVectorStore();
  // Destroy Memory stores
  destroyMemoryStores();
  // Destroy StorageDatabase
  destroyStorageDatabase();
  addon.data.dialog?.window?.close();
  addon.data.alive = false;
  // @ts-expect-error - Plugin instance is not typed
  delete Zotero[addon.data.config.addonInstance];
}

/**
 * Preference UI events dispatcher
 */
async function onPrefsEvent(type: string, data: { [key: string]: unknown }) {
  switch (type) {
    case "load":
      registerPrefsScripts(data.window as Window);
      break;
    default:
      return;
  }
}

export default {
  onStartup,
  onShutdown,
  onMainWindowLoad,
  onMainWindowUnload,
  onPrefsEvent,
};
