export interface ReadingLoopToolbarEventHandlers {
  togglePanel: () => void;
  isPanelShown: () => boolean;
  showPopover: (button: HTMLElement) => void;
  hidePopover: (doc: Document) => void;
}

export function bindReadingLoopToolbarButtonEvents(
  button: HTMLElement,
  handlers: ReadingLoopToolbarEventHandlers,
): void {
  const showPopover = (event: Event) => {
    const target = event.currentTarget as HTMLElement;
    target.style.backgroundColor = "var(--fill-quinary)";
    handlers.showPopover(target);
  };
  const hidePopover = (event: Event) => {
    const target = event.currentTarget as HTMLElement;
    if (!handlers.isPanelShown()) {
      target.style.backgroundColor = "transparent";
    }
    handlers.hidePopover(target.ownerDocument);
  };

  button.addEventListener("click", () => {
    handlers.togglePanel();
  });
  button.addEventListener("mouseenter", showPopover);
  button.addEventListener("mouseover", showPopover);
  button.addEventListener("mousemove", showPopover);
  button.addEventListener("mouseleave", hidePopover);
  button.addEventListener("mouseout", hidePopover);
  button.addEventListener("focus", (event: Event) => {
    handlers.showPopover(event.currentTarget as HTMLElement);
  });
  button.addEventListener("blur", (event: Event) => {
    handlers.hidePopover((event.currentTarget as HTMLElement).ownerDocument);
  });
}
