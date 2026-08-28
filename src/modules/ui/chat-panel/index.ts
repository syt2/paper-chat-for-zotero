/**
 * Chat Panel Module Exports
 */

// Main panel lifecycle functions
export {
  showPanel,
  showPanelWithSelectedText,
  showPanelWithImageAttachment,
  showPanelForItem,
  hidePanel,
  togglePanel,
  isPanelShown,
  registerToolbarButton,
  unregisterToolbarButton,
  unregisterAll,
  getChatManager,
  stopChatSearchBackfillForShutdown,
  addSelectedTextAttachment,
  addImageAttachment,
  openPresentationForItem,
  focusRunningPresentationTask,
} from "./ChatPanelManager";

// Theme utilities
export { getCurrentTheme, isDarkMode } from "./ChatPanelTheme";

// Types
export type {
  ThemeColors,
  ChatPanelContext,
  SessionInfo,
  AttachmentState,
} from "./types";
