import type { ChatMessage } from "../../../types/chat";
import { getString } from "../../../utils/locale";
import {
  scrollToAndHighlightMessage,
  syncChatHistoryAfterLayout,
} from "./MessageRenderer";

export interface ConversationTurn {
  messageId: string;
  question: string;
  answer: string;
  complete: boolean;
}

/** One entry per visible user turn, regardless of intermediate tool messages. */
export function collectConversationTurns(
  messages: ChatMessage[],
): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  let turn: ConversationTurn | undefined;
  for (const message of messages) {
    if (message.apiOnly || message.isSystemNotice) continue;
    if (message.role === "user") {
      const questionMarker = message.content.lastIndexOf("[Question]:");
      turn = {
        messageId: message.id,
        question: previewText(
          questionMarker >= 0
            ? message.content.slice(questionMarker + "[Question]:".length)
            : message.content,
        ),
        answer: "",
        complete: false,
      };
      turns.push(turn);
    } else if (
      turn &&
      message.role === "assistant" &&
      !message.tool_calls?.length
    ) {
      turn.answer = previewText(message.content);
      turn.complete = !message.streamingState && !!turn.answer;
    } else if (turn && message.role === "error") {
      turn.complete = false;
    }
  }
  return turns;
}

function previewText(content: string): string {
  return content.replace(/\s+/g, " ").trim().slice(0, 180);
}

export function shouldShowConversationNavigator(
  turns: ConversationTurn[],
): boolean {
  return turns.filter((turn) => turn.complete).length > 5;
}

export const CONVERSATION_NAV_MIN_WIDTH = 400;
const RAIL_MARGIN = 24;
const MARKER_SIZE = 7;
const MARKER_GAP = 2;

export interface ConversationTurnGroup {
  start: number;
  end: number;
}

/** Balanced, consecutive ranges cover every turn exactly once. */
export function groupConversationTurns(
  count: number,
  capacity: number,
): ConversationTurnGroup[] {
  if (count <= 0 || capacity < 1) return [];
  const groups = Math.min(count, Math.floor(capacity));
  return Array.from({ length: groups }, (_, index) => ({
    start: Math.floor((index * count) / groups),
    end: Math.floor(((index + 1) * count) / groups) - 1,
  }));
}

export function getConversationNavigatorCapacity(
  width: number,
  availableHeight: number,
): number {
  if (width <= CONVERSATION_NAV_MIN_WIDTH) return 0;
  return Math.max(
    0,
    Math.floor(
      (availableHeight - RAIL_MARGIN * 2 + MARKER_GAP) /
        (MARKER_SIZE + MARKER_GAP),
    ),
  );
}

const navigators = new WeakMap<HTMLElement, ConversationNavigator>();

/** Panel-local navigation; it never changes the session or message renderer. */
export class ConversationNavigator {
  private readonly rail: HTMLElement;
  private readonly preview: HTMLElement;
  private readonly question: HTMLElement;
  private readonly answer: HTMLElement;
  private readonly win: Window;
  private readonly resizeObserver?: ResizeObserver;
  private turns: ConversationTurn[] = [];
  private anchors: HTMLElement[] = [];
  private groups: ConversationTurnGroup[] = [];
  private buttons: HTMLButtonElement[] = [];
  private frame: number | null = null;
  private activeIndex = -1;
  private previewIndex = -1;
  private disposed = false;
  private groupsDirty = true;

  static attach(container: HTMLElement): () => void {
    navigators.get(container)?.dispose();
    const viewport = container.querySelector<HTMLElement>("#chat-viewport");
    const history = container.querySelector<HTMLElement>("#chat-history");
    if (!viewport || !history || !container.ownerDocument.defaultView)
      return () => {};
    const navigator = new ConversationNavigator(viewport, history);
    navigators.set(container, navigator);
    return () => {
      navigator.dispose();
      if (navigators.get(container) === navigator) navigators.delete(container);
    };
  }

  static update(container: HTMLElement, messages: ChatMessage[]): void {
    navigators.get(container)?.update(messages);
  }

  constructor(
    private readonly viewport: HTMLElement,
    private readonly history: HTMLElement,
  ) {
    const doc = viewport.ownerDocument;
    this.win = doc.defaultView!;
    const create = (tag: string, className: string) => {
      const element = doc.createElementNS("http://www.w3.org/1999/xhtml", tag);
      element.className = className;
      return element;
    };
    this.rail = create("nav", "chat-turn-rail");
    this.rail.setAttribute("aria-label", getString("chat-turn-navigation"));
    this.rail.style.setProperty("--turn-marker-size", `${MARKER_SIZE}px`);
    this.rail.style.setProperty("--turn-marker-gap", `${MARKER_GAP}px`);
    this.preview = create("div", "chat-turn-preview");
    this.preview.setAttribute("aria-hidden", "true");
    this.question = create("div", "chat-turn-preview-question");
    this.answer = create("div", "chat-turn-preview-answer");
    this.preview.append(this.question, this.answer);
    this.preview.style.display = "none";
    this.rail.style.display = "none";
    viewport.append(this.rail, this.preview);
    this.rail.addEventListener("mouseleave", this.hideHoverPreview);
    history.addEventListener("scroll", this.scheduleUpdate, { passive: true });
    this.win.addEventListener("resize", this.scheduleUpdate);
    if (this.win.ResizeObserver) {
      this.resizeObserver = new this.win.ResizeObserver(this.scheduleUpdate);
      this.resizeObserver?.observe(viewport);
    }
  }

  update(messages: ChatMessage[]): void {
    const elements = new Map(
      Array.from(this.history.children).map((node) => [
        node.getAttribute("data-message-id"),
        node as HTMLElement,
      ]),
    );
    const turns = collectConversationTurns(messages).filter((turn) =>
      elements.has(turn.messageId),
    );
    this.groupsDirty ||=
      turns.length !== this.turns.length ||
      turns.some(
        (turn, index) => turn.messageId !== this.turns[index]?.messageId,
      );
    this.turns = turns;
    this.anchors = turns.map((turn) => elements.get(turn.messageId)!);
    // Streaming changes preview text, not the marker's identity or focus.
    if (this.groupsDirty) {
      this.closePreview();
    } else {
      this.buttons.forEach((button, index) =>
        button.setAttribute(
          "aria-label",
          this.turnLabel(this.groups[index].start),
        ),
      );
      if (this.previewIndex >= 0) this.showPreview(this.previewIndex);
    }
    this.resizeObserver?.disconnect();
    // Keep observing the viewport even while hidden, so widening reveals the rail.
    this.resizeObserver?.observe(this.viewport);
    if (shouldShowConversationNavigator(this.turns)) {
      for (const element of Array.from(this.history.children))
        this.resizeObserver?.observe(element);
      for (const selector of [
        "#chat-execution-plan-panel",
        "#chat-execution-approval-panel",
      ]) {
        const panel = this.viewport.querySelector(selector);
        if (panel) this.resizeObserver?.observe(panel);
      }
    }
    this.scheduleUpdate();
  }

  private rebuildGroups(groups: ConversationTurnGroup[]): void {
    this.closePreview();
    this.groups = groups;
    this.groupsDirty = false;
    this.rail.textContent = "";
    this.activeIndex = -1;
    this.buttons = groups.map((group, index) => {
      const button = this.viewport.ownerDocument.createElementNS(
        "http://www.w3.org/1999/xhtml",
        "button",
      ) as HTMLButtonElement;
      button.type = "button";
      button.className = "chat-turn-tick";
      button.tabIndex = -1;
      button.setAttribute("aria-label", this.turnLabel(group.start));
      button.addEventListener("mouseenter", () => this.showPreview(index));
      button.addEventListener("focus", () => this.showPreview(index));
      button.addEventListener("blur", this.hideHoverPreview);
      button.addEventListener("click", () => {
        this.jumpToTurn(group.start);
      });
      button.addEventListener("keydown", (event) =>
        this.onKeyDown(event, index),
      );
      this.rail.appendChild(button);
      return button;
    });
  }

  private turnLabel(index: number): string {
    return getString("chat-turn-jump", {
      args: {
        index: index + 1,
        question:
          this.turns[index].question || getString("chat-turn-attachment"),
      },
    });
  }

  private readonly scheduleUpdate = () => {
    if (this.disposed || this.frame !== null) return;
    this.frame = this.win.requestAnimationFrame(() => {
      this.frame = null;
      this.updatePosition();
    });
  };

  private updatePosition(): void {
    const topInset = Number(
      this.viewport.querySelector<HTMLElement>("#chat-execution-plan-panel")
        ?.dataset.visibleHeight || 0,
    );
    const bottomInset = Number(
      this.viewport.querySelector<HTMLElement>("#chat-execution-approval-panel")
        ?.dataset.visibleHeight || 0,
    );
    const available = Math.max(
      0,
      this.viewport.clientHeight - topInset - bottomInset,
    );
    const capacity = getConversationNavigatorCapacity(
      this.viewport.clientWidth,
      available,
    );
    const visible = capacity > 0 && shouldShowConversationNavigator(this.turns);
    const changed =
      visible !== this.viewport.hasAttribute("data-turn-navigation");
    this.viewport.toggleAttribute("data-turn-navigation", visible);
    this.rail.style.display = visible ? "flex" : "none";
    if (!visible) {
      if (this.buttons.length) this.rebuildGroups([]);
      this.closePreview();
      if (changed) syncChatHistoryAfterLayout(this.history);
      return;
    }
    const count = Math.min(this.turns.length, capacity);
    if (this.groupsDirty || this.groups.length !== count) {
      this.rebuildGroups(groupConversationTurns(this.turns.length, capacity));
    }
    const height =
      this.groups.length * MARKER_SIZE + (this.groups.length - 1) * MARKER_GAP;
    this.rail.style.height = `${height}px`;
    this.rail.style.top = `${topInset + (available - height) / 2}px`;
    if (changed) syncChatHistoryAfterLayout(this.history);
    const readingLine =
      this.history.getBoundingClientRect().top +
      topInset +
      Math.max(0, this.history.clientHeight - topInset - bottomInset) / 2;
    let activeTurn = 0;
    for (let index = 0; index < this.anchors.length; index++) {
      if (this.anchors[index].getBoundingClientRect().top > readingLine) break;
      activeTurn = index;
    }
    if (this.history.scrollTop <= 0) activeTurn = 0;
    else if (
      this.history.scrollHeight -
        this.history.scrollTop -
        this.history.clientHeight <=
      24
    ) {
      activeTurn = this.turns.length - 1;
    }
    const active = this.groups.findIndex(
      (group) => group.start <= activeTurn && group.end >= activeTurn,
    );
    if (active !== this.activeIndex) {
      this.buttons[this.activeIndex]?.removeAttribute("aria-current");
      this.buttons[this.activeIndex]?.setAttribute("tabindex", "-1");
      this.buttons[active].setAttribute("aria-current", "step");
      this.buttons[active].tabIndex = 0;
      this.activeIndex = active;
    }
    if (this.previewIndex >= 0) this.positionPreview();
  }

  private showPreview(index: number): void {
    const group = this.groups[index];
    if (!group) return;
    this.previewIndex = index;
    const turn = this.turns[group.start];
    this.question.textContent =
      turn.question || getString("chat-turn-attachment");
    this.answer.textContent = turn.answer || getString("chat-turn-no-answer");
    this.preview.style.display = "block";
    this.positionPreview();
  }

  private jumpToTurn(index: number): void {
    this.closePreview();
    scrollToAndHighlightMessage(this.history, this.turns[index].messageId);
    this.scheduleUpdate();
  }

  private positionPreview(): void {
    const relativeTop =
      this.buttons[this.previewIndex].getBoundingClientRect().top -
      this.viewport.getBoundingClientRect().top;
    this.preview.style.maxHeight = `${Math.max(0, this.viewport.clientHeight - 16)}px`;
    this.preview.style.top = `${Math.max(8, Math.min(relativeTop - this.preview.offsetHeight / 2, this.viewport.clientHeight - this.preview.offsetHeight - 8))}px`;
  }

  private readonly hideHoverPreview = () => {
    this.closePreview();
  };

  private closePreview(): void {
    this.previewIndex = -1;
    this.preview.style.display = "none";
  }

  private onKeyDown(event: KeyboardEvent, index: number): void {
    if (event.key === "Escape") {
      this.closePreview();
      return;
    }
    const next =
      event.key === "ArrowUp"
        ? index - 1
        : event.key === "ArrowDown"
          ? index + 1
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? this.buttons.length - 1
              : null;
    if (next === null) return;
    event.preventDefault();
    const target = Math.max(0, Math.min(next, this.buttons.length - 1));
    this.buttons[target].focus({ preventScroll: true });
  }

  dispose(): void {
    this.disposed = true;
    if (this.frame !== null) this.win.cancelAnimationFrame(this.frame);
    this.resizeObserver?.disconnect();
    this.history.removeEventListener("scroll", this.scheduleUpdate);
    this.win.removeEventListener("resize", this.scheduleUpdate);
    this.rail.remove();
    this.preview.remove();
    this.viewport.removeAttribute("data-turn-navigation");
  }
}
