/**
 * UI Module Exports
 */

export { showAuthDialog, ensureLoggedIn } from "./AuthDialog";

export {
  registerToolbarButton,
  unregisterToolbarButton,
  togglePanel,
  showPanel,
  hidePanel,
  unregisterAll as unregisterChatPanel,
  getChatManager,
  stopChatSearchBackfillForShutdown,
  addSelectedTextAttachment,
} from "./chat-panel";
