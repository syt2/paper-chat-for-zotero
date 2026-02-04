/**
 * Chat Panel Types - Shared interfaces for chat panel modules
 */

import type { ChatManager, ChatMessage } from "../../chat";
import type { AuthManager } from "../../auth";

// Theme colors interface
export interface ThemeColors {
  // Backgrounds
  containerBg: string;
  chatHistoryBg: string;
  toolbarBg: string;
  inputAreaBg: string;
  inputBg: string;
  assistantBubbleBg: string;
  attachmentPreviewBg: string;
  buttonBg: string;
  buttonHoverBg: string;
  dropdownBg: string;
  dropdownItemHoverBg: string;
  hoverBg: string;
  // Borders
  borderColor: string;
  inputBorderColor: string;
  inputFocusBorderColor: string;
  // Text
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  // Code
  inlineCodeBg: string;
  inlineCodeColor: string;
  codeBlockBg: string;
  codeBlockColor: string;
  // Other
  scrollbarThumb: string;
  scrollbarThumbHover: string;
  copyBtnBg: string;
}

// Session info for history dropdown (matches SessionMeta from chat types)
export interface SessionInfo {
  id: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  lastMessagePreview: string;
  lastMessageTime: number;
}

// Attachment state for pending uploads
export interface AttachmentState {
  pendingImages: import("../../../types/chat").ImageAttachment[];
  pendingFiles: import("../../../types/chat").FileAttachment[];
  pendingSelectedText: string | null;
}

// Context passed to event handlers
export interface ChatPanelContext {
  container: HTMLElement;
  chatManager: ChatManager;
  authManager: AuthManager;
  getCurrentItem: () => Zotero.Item | null;
  setCurrentItem: (item: Zotero.Item | null) => void;
  getTheme: () => ThemeColors;
  getAttachmentState: () => AttachmentState;
  clearAttachments: () => void;
  updateAttachmentsPreview: () => void;
  updateUserBar: () => void;
  updatePdfCheckboxVisibility: (item: Zotero.Item | null) => Promise<void>;
  renderMessages: (messages: ChatMessage[]) => void;
  appendError: (errorMessage: string) => void;
  // Callbacks reference for multi-doc selector
  callbacks?: {
    onMessageUpdate?: (messages: ChatMessage[]) => void;
    onStreamingUpdate?: (content: string) => void;
    onError?: (error: Error) => void;
    onPdfAttached?: () => void;
    onMessageComplete?: () => void;
    onSelectedItemsChange?: (itemKeys: string[]) => void;
  };
}

// HTML namespace for XHTML environment
export const HTML_NS = "http://www.w3.org/1999/xhtml";
