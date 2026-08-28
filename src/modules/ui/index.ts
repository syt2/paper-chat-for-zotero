/**
 * UI Module Exports
 */

export { showAuthDialog, ensureLoggedIn } from "./AuthDialog";

export {
  registerToolbarButton,
  unregisterToolbarButton,
  togglePanel,
  showPanel,
  showPanelWithImageAttachment,
  showPanelForItem,
  hidePanel,
  unregisterAll as unregisterChatPanel,
  getChatManager,
  stopChatSearchBackfillForShutdown,
  addSelectedTextAttachment,
  addImageAttachment,
  openPresentationForItem,
  focusRunningPresentationTask,
} from "./chat-panel";
