/**
 * MentionSelector - @ mention resource selector for chat input
 * Allows users to mention Items, Attachments, and Notes in the chat
 */

import type { ThemeColors } from "./types";
import { createElement } from "./ChatPanelBuilder";
import { chatColors } from "../../../utils/colors";

// Resource types that can be mentioned
export type MentionResourceType = "item" | "attachment" | "note";

// A mentionable resource
export interface MentionResource {
  type: MentionResourceType;
  key: string;
  title: string;
  icon: string;
  parentKey?: string;
  parentTitle?: string;
}

// Mention selector state
export interface MentionSelectorState {
  isVisible: boolean;
  query: string;
  resources: MentionResource[];
  filteredResources: MentionResource[];
  selectedIndex: number;
}

// Callback when a resource is selected
export type OnMentionSelectCallback = (resource: MentionResource) => void;

/**
 * Create the mention selector popup element
 */
export function createMentionSelector(
  doc: Document,
  theme: ThemeColors,
): HTMLElement {
  const popup = createElement(
    doc,
    "div",
    {
      display: "none",
      position: "absolute",
      bottom: "100%",
      left: "0",
      width: "100%",
      maxHeight: "250px",
      overflowY: "auto",
      background: theme.dropdownBg,
      border: `1px solid ${theme.borderColor}`,
      borderRadius: "8px",
      boxShadow: "0 4px 12px rgba(0, 0, 0, 0.15)",
      zIndex: "10003",
      marginBottom: "4px",
    },
    { id: "chat-mention-popup" },
  );

  return popup;
}

/**
 * Load all mentionable resources from Zotero
 */
export async function loadMentionResources(): Promise<MentionResource[]> {
  const resources: MentionResource[] = [];
  const libraryID = Zotero.Libraries.userLibraryID;

  try {
    const allItems = await Zotero.Items.getAll(libraryID);

    for (const item of allItems) {
      if (item.isAttachment?.()) {
        // Attachment resource
        const parentID = item.parentID;
        let parentTitle: string | undefined;
        let parentKey: string | undefined;

        if (parentID) {
          const parent = Zotero.Items.get(parentID);
          if (parent) {
            parentTitle = (parent.getField?.("title") as string) || undefined;
            parentKey = parent.key;
          }
        }

        resources.push({
          type: "attachment",
          key: item.key,
          title: (item.getField?.("title") as string) || "Untitled Attachment",
          icon: "📎",
          parentKey,
          parentTitle,
        });
      } else if (item.isNote?.()) {
        // Note resource
        const parentID = item.parentID;
        let parentTitle: string | undefined;
        let parentKey: string | undefined;

        if (parentID) {
          const parent = Zotero.Items.get(parentID);
          if (parent) {
            parentTitle = (parent.getField?.("title") as string) || undefined;
            parentKey = parent.key;
          }
        }

        const noteTitle = item.getNoteTitle?.() || "Untitled Note";
        resources.push({
          type: "note",
          key: item.key,
          title: noteTitle,
          icon: "📝",
          parentKey,
          parentTitle,
        });
      } else {
        // Regular item
        resources.push({
          type: "item",
          key: item.key,
          title: (item.getField?.("title") as string) || "Untitled",
          icon: "📄",
        });
      }
    }
  } catch (error) {
    ztoolkit.log("[MentionSelector] Error loading resources:", error);
  }

  return resources;
}

/**
 * Filter resources based on query string
 */
export function filterResources(
  resources: MentionResource[],
  query: string,
): MentionResource[] {
  if (!query) {
    // Return first 20 items when no query
    return resources.slice(0, 20);
  }

  const lowerQuery = query.toLowerCase();
  const filtered = resources.filter((r) => {
    const titleMatch = r.title.toLowerCase().includes(lowerQuery);
    const parentMatch = r.parentTitle?.toLowerCase().includes(lowerQuery);
    return titleMatch || parentMatch;
  });

  // Return max 20 filtered results
  return filtered.slice(0, 20);
}

/**
 * Render resources in the popup
 */
export function renderMentionPopup(
  popup: HTMLElement,
  filteredResources: MentionResource[],
  selectedIndex: number,
  theme: ThemeColors,
  onSelect: OnMentionSelectCallback,
): void {
  const doc = popup.ownerDocument!;
  popup.textContent = "";

  if (filteredResources.length === 0) {
    const emptyMsg = createElement(doc, "div", {
      padding: "12px",
      fontSize: "12px",
      color: theme.textMuted,
      textAlign: "center",
    });
    emptyMsg.textContent = "No matching resources";
    popup.appendChild(emptyMsg);
    return;
  }

  // Group by type
  const items = filteredResources.filter((r) => r.type === "item");
  const attachments = filteredResources.filter((r) => r.type === "attachment");
  const notes = filteredResources.filter((r) => r.type === "note");

  let globalIndex = 0;

  const renderGroup = (
    groupResources: MentionResource[],
    groupLabel: string,
  ) => {
    if (groupResources.length === 0) return;

    // Group header
    const header = createElement(doc, "div", {
      padding: "6px 12px",
      fontSize: "10px",
      fontWeight: "600",
      color: theme.textMuted,
      background: theme.buttonBg,
      textTransform: "uppercase",
      letterSpacing: "0.5px",
    });
    header.textContent = groupLabel;
    popup.appendChild(header);

    for (const resource of groupResources) {
      const isSelected = globalIndex === selectedIndex;
      const currentIndex = globalIndex;

      const item = createElement(doc, "div", {
        display: "flex",
        alignItems: "center",
        gap: "8px",
        padding: "8px 12px",
        cursor: "pointer",
        background: isSelected ? theme.dropdownItemHoverBg : "transparent",
        fontSize: "12px",
      });
      item.setAttribute("data-mention-index", String(currentIndex));
      item.setAttribute("data-resource-key", resource.key);

      // Icon
      const icon = createElement(doc, "span", {
        fontSize: "14px",
        flexShrink: "0",
      });
      icon.textContent = resource.icon;

      // Title container
      const titleContainer = createElement(doc, "div", {
        flex: "1",
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        gap: "2px",
      });

      // Main title
      const title = createElement(doc, "span", {
        color: theme.textPrimary,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      });
      title.textContent = resource.title;
      titleContainer.appendChild(title);

      // Parent title (for attachments and notes)
      if (resource.parentTitle) {
        const parent = createElement(doc, "span", {
          fontSize: "10px",
          color: theme.textMuted,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        });
        parent.textContent = `↳ ${resource.parentTitle}`;
        titleContainer.appendChild(parent);
      }

      item.appendChild(icon);
      item.appendChild(titleContainer);

      // Click handler
      item.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        onSelect(resource);
      });

      // Hover effect
      item.addEventListener("mouseenter", () => {
        item.style.background = theme.dropdownItemHoverBg;
      });
      item.addEventListener("mouseleave", () => {
        if (currentIndex !== selectedIndex) {
          item.style.background = "transparent";
        }
      });

      popup.appendChild(item);
      globalIndex++;
    }
  };

  renderGroup(items, "Items");
  renderGroup(attachments, "Attachments");
  renderGroup(notes, "Notes");
}

/**
 * Create a selected resource tag element (shown above input)
 */
export function createResourceTag(
  doc: Document,
  resource: MentionResource,
  onRemove: () => void,
): HTMLElement {
  const tag = createElement(doc, "span", {
    display: "inline-flex",
    alignItems: "center",
    gap: "4px",
    background: chatColors.attachmentBg,
    border: `1px solid ${chatColors.attachmentBorder}`,
    borderRadius: "12px",
    padding: "4px 8px 4px 10px",
    fontSize: "11px",
    color: chatColors.attachmentText,
    maxWidth: "200px",
  });
  tag.setAttribute("data-resource-key", resource.key);
  tag.setAttribute("data-resource-type", resource.type);

  // Icon + title
  const text = createElement(doc, "span", {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  });
  text.textContent = `${resource.icon} ${resource.title}`;
  tag.appendChild(text);

  // Remove button
  const removeBtn = createElement(doc, "button", {
    background: "transparent",
    border: "none",
    padding: "0 2px",
    cursor: "pointer",
    fontSize: "12px",
    color: chatColors.attachmentText,
    opacity: "0.7",
    lineHeight: "1",
  });
  removeBtn.textContent = "×";
  removeBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    onRemove();
  });
  removeBtn.addEventListener("mouseenter", () => {
    removeBtn.style.opacity = "1";
  });
  removeBtn.addEventListener("mouseleave", () => {
    removeBtn.style.opacity = "0.7";
  });

  tag.appendChild(removeBtn);
  return tag;
}

/**
 * MentionSelector class - manages the mention selector state and UI
 */
export class MentionSelector {
  private popup: HTMLElement;
  private state: MentionSelectorState;
  private theme: ThemeColors;
  private onSelect: OnMentionSelectCallback;
  private resourcesLoaded: boolean = false;

  constructor(
    popup: HTMLElement,
    theme: ThemeColors,
    onSelect: OnMentionSelectCallback,
  ) {
    this.popup = popup;
    this.theme = theme;
    this.onSelect = onSelect;
    this.state = {
      isVisible: false,
      query: "",
      resources: [],
      filteredResources: [],
      selectedIndex: 0,
    };
  }

  /**
   * Show the selector popup
   */
  async show(): Promise<void> {
    // Load resources if not loaded
    if (!this.resourcesLoaded) {
      this.state.resources = await loadMentionResources();
      this.resourcesLoaded = true;
    }

    this.state.isVisible = true;
    this.state.query = "";
    this.state.selectedIndex = 0;
    this.state.filteredResources = filterResources(this.state.resources, "");

    this.popup.style.display = "block";
    this.render();
  }

  /**
   * Hide the selector popup
   */
  hide(): void {
    this.state.isVisible = false;
    this.popup.style.display = "none";
  }

  /**
   * Check if selector is visible
   */
  isVisible(): boolean {
    return this.state.isVisible;
  }

  /**
   * Update filter query
   */
  filter(query: string): void {
    this.state.query = query;
    this.state.filteredResources = filterResources(this.state.resources, query);
    this.state.selectedIndex = 0;
    this.render();
  }

  /**
   * Move selection up
   */
  moveUp(): void {
    if (this.state.filteredResources.length === 0) return;
    this.state.selectedIndex =
      (this.state.selectedIndex - 1 + this.state.filteredResources.length) %
      this.state.filteredResources.length;
    this.render();
    this.scrollToSelected();
  }

  /**
   * Move selection down
   */
  moveDown(): void {
    if (this.state.filteredResources.length === 0) return;
    this.state.selectedIndex =
      (this.state.selectedIndex + 1) % this.state.filteredResources.length;
    this.render();
    this.scrollToSelected();
  }

  /**
   * Select current item
   */
  selectCurrent(): void {
    const resource = this.state.filteredResources[this.state.selectedIndex];
    if (resource) {
      this.onSelect(resource);
    }
    this.hide();
  }

  /**
   * Get selected resource
   */
  getSelectedResource(): MentionResource | null {
    return this.state.filteredResources[this.state.selectedIndex] || null;
  }

  /**
   * Reload resources (call when Zotero library changes)
   */
  async reload(): Promise<void> {
    this.state.resources = await loadMentionResources();
    this.resourcesLoaded = true;
    if (this.state.isVisible) {
      this.state.filteredResources = filterResources(
        this.state.resources,
        this.state.query,
      );
      this.render();
    }
  }

  /**
   * Render the popup contents
   */
  private render(): void {
    renderMentionPopup(
      this.popup,
      this.state.filteredResources,
      this.state.selectedIndex,
      this.theme,
      (resource) => {
        this.onSelect(resource);
        this.hide();
      },
    );
  }

  /**
   * Scroll to keep selected item visible
   */
  private scrollToSelected(): void {
    const selectedEl = this.popup.querySelector(
      `[data-mention-index="${this.state.selectedIndex}"]`,
    );
    if (selectedEl) {
      selectedEl.scrollIntoView({ block: "nearest" });
    }
  }
}
