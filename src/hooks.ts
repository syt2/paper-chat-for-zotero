import { getString, initLocale } from "./utils/locale";
import { registerPrefsScripts } from "./modules/preferences";
import { createZToolkit } from "./utils/ztoolkit";
import { registerToolbarButton, unregisterChatPanel } from "./modules/ui";
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

async function onStartup() {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  initLocale();

  // Register preference pane
  Zotero.PreferencePanes.register({
    pluginID: addon.data.config.addonID,
    id: "paperchat-prefpane",
    src: rootURI + "content/preferences.xhtml",
    label: getString("prefs-title"),
    image: `chrome://${addon.data.config.addonRef}/content/icons/favicon.svg`,
  });

  // Initialize auth manager
  const authManager = getAuthManager();
  await authManager.initialize();

  // Initialize AISummary
  await initAISummary();

  // Initialize AISummary Service (item notifier + context menu)
  initAISummaryService();

  // 注入打开任务窗口的回调（避免循环依赖）
  getAISummaryService().setOnOpenTaskWindow(openTaskWindow);

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
  registerToolbarButton();
}

async function onMainWindowUnload(_win: Window): Promise<void> {
  ztoolkit.unregisterAll();
  addon.data.dialog?.window?.close();
}

function onShutdown(): void {
  ztoolkit.unregisterAll();
  unregisterChatPanel();
  destroyProviderManager();
  destroyAuthManager();
  // Destroy AISummary
  destroyAISummaryService();
  getAISummaryManager().destroy();
  // Destroy Embedding/RAG
  destroyRAGService();
  destroyEmbeddingProviderFactory();
  destroyVectorStore();
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
