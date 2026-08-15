/**
 * UI Module Exports
 */

export { showAuthDialog, ensureLoggedIn } from "./AuthDialog";

export {
  registerToolbarButton,
  unregisterToolbarButton,
  togglePanel,
  showPanel,
  showPanelForItem,
  hidePanel,
  unregisterAll as unregisterChatPanel,
  getChatManager,
  stopChatSearchBackfillForShutdown,
  addSelectedTextAttachment,
  openPresentationForItem,
  focusRunningPresentationTask,
} from "./chat-panel";
