/**
 * Chat Panel Module Exports
 */

// Main panel lifecycle functions
export {
  showPanel,
  hidePanel,
  togglePanel,
  isPanelShown,
  registerToolbarButton,
  unregisterToolbarButton,
  unregisterAll,
  getChatManager,
  addSelectedTextAttachment,
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
