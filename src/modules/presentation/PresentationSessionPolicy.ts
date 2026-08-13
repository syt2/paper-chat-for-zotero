import type { ChatSession } from "../../types/chat";

export type PresentationPanelOpenSource =
  | "presentation_menu"
  | "presentation_button";

export interface PresentationSessionAccess {
  getActiveSession(): ChatSession | null;
  createNewSession(): Promise<ChatSession>;
  createItemSession?(
    itemKey: string,
    title: string,
    libraryID?: number,
  ): Promise<ChatSession>;
}

export interface PresentationSessionSelection {
  session: ChatSession;
  /** Session that owned the in-chat button before asynchronous launch gates. */
  expectedActiveSession: ChatSession | null;
}

/**
 * Sessions created before library IDs were persisted belong to the personal
 * library. Keep those chats usable while still rejecting an identically keyed
 * paper from a group library.
 */
export function isPresentationSessionCompatibleWithPaper(
  session: ChatSession,
  paper: { itemKey: string; libraryID: number },
  userLibraryID: number,
): boolean {
  if (!session.lastActiveItemKey) {
    return true;
  }
  return (
    session.lastActiveItemKey === paper.itemKey &&
    (session.lastActiveItemLibraryID ?? userLibraryID) === paper.libraryID
  );
}

/**
 * Library launches are isolated in a fresh conversation. The in-chat button
 * intentionally keeps the active conversation and creates one only when the
 * panel has no session yet.
 */
export async function selectPresentationSession(
  manager: PresentationSessionAccess,
  source: PresentationPanelOpenSource,
  expectedActiveSession: ChatSession | null = manager.getActiveSession(),
  paper?: { itemKey: string; title: string; libraryID?: number },
): Promise<PresentationSessionSelection | null> {
  if (source === "presentation_button") {
    // The button belongs to the chat that was active when it was clicked. If
    // the user navigated while the async launch dialogs were open, cancel
    // instead of silently rebinding the newly selected chat to the old paper.
    if (manager.getActiveSession() !== expectedActiveSession) {
      return null;
    }
    const session = expectedActiveSession || (await manager.createNewSession());
    if (manager.getActiveSession() !== session) {
      return null;
    }
    return { session, expectedActiveSession };
  }
  return {
    session:
      paper && manager.createItemSession
        ? await manager.createItemSession(
            paper.itemKey,
            paper.title,
            paper.libraryID,
          )
        : await manager.createNewSession(),
    expectedActiveSession: null,
  };
}
