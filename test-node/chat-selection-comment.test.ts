import { assert } from "chai";
import { setupChatSelectionComment } from "../src/modules/ui/chat-panel/ChatSelectionComment.ts";

type Listener = (event: any) => void;
class Target {
  listeners = new Map<string, Set<Listener>>();
  addEventListener(type: string, listener: Listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }
  removeEventListener(type: string, listener: Listener) {
    this.listeners.get(type)?.delete(listener);
  }
  dispatch(type: string, event: Record<string, unknown> = {}) {
    for (const listener of [...(this.listeners.get(type) || [])]) {
      listener({ preventDefault() {}, stopPropagation() {}, ...event });
    }
  }
}

class Element extends Target {
  nodeType = 1;
  style: Record<string, string> = {};
  children: Element[] = [];
  parentElement: Element | null = null;
  className = "";
  textContent = "";
  editable = false;
  constructor(
    readonly ownerDocument: any,
    readonly tagName: string,
  ) {
    super();
  }
  append(...children: Element[]) {
    for (const child of children) {
      child.parentElement = this;
      this.children.push(child);
    }
  }
  remove() {
    const siblings = this.parentElement?.children;
    if (siblings) siblings.splice(siblings.indexOf(this), 1);
    this.parentElement = null;
  }
  contains(node: any): boolean {
    return (
      node === this ||
      (!!node?.parentElement && this.contains(node.parentElement))
    );
  }
  closest(selector: string): Element | null {
    if (selector === ".chat-panel-root") return this.parentElement;
    return this.editable ? this : null;
  }
  setAttribute() {}
  getBoundingClientRect() {
    return { width: 28, height: 28 };
  }
}

function fixture() {
  const doc: any = new Target();
  const frames: (() => void)[] = [];
  const win: any = new Target();
  Object.assign(win, {
    innerWidth: 1200,
    innerHeight: 800,
    requestAnimationFrame: (callback: () => void) => frames.push(callback),
    cancelAnimationFrame() {},
    matchMedia: () => ({ matches: false }),
  });
  Object.assign(doc, {
    body: null,
    defaultView: win,
    createElementNS: (_ns: string, tag: string) => new Element(doc, tag),
  });
  const root = new Element(doc, "div");
  const history = new Element(doc, "div");
  const content = new Element(doc, "p");
  root.append(history);
  history.append(content);
  const text = { nodeType: 3, parentElement: content };
  const range = {
    startContainer: text,
    endContainer: text,
    getClientRects: () => [
      { left: 900, right: 1100, top: 200, bottom: 220, width: 200, height: 20 },
    ],
  };
  const selection = {
    isCollapsed: false,
    rangeCount: 1,
    getRangeAt: () => range,
    toString: () => "Selected chat passage",
  };
  doc.getSelection = () => selection;
  const flush = () => {
    while (frames.length) frames.shift()!();
  };
  return { doc, root, history, content, selection, flush };
}

describe("chat selection comment", function () {
  let previousAddon: unknown;

  beforeEach(function () {
    previousAddon = (globalThis as any).addon;
    (globalThis as any).addon = { data: {} };
  });

  afterEach(function () {
    if (previousAddon === undefined) delete (globalThis as any).addon;
    else (globalThis as any).addon = previousAddon;
  });

  it("shows a comment button and dialog in a chrome document without global Node or body", function () {
    assert.isUndefined((globalThis as any).Node);
    const f = fixture();
    const dispose = setupChatSelectionComment(f.history as any);
    f.doc.dispatch("pointerdown");
    f.doc.dispatch("selectionchange");
    f.flush();
    assert.lengthOf(
      f.root.children,
      1,
      "the action must wait until the drag is released",
    );
    f.doc.dispatch("pointerup", { clientX: 400, clientY: 400 });
    f.flush();
    const button = f.root.children.find((node) => node.tagName === "button");
    assert.exists(button, "a chat passage must produce a comment action");
    assert.equal(button!.className, "paperchat-chat-selection-comment-button");
    assert.equal(button!.children.length, 1);
    assert.equal(button!.style.left, "404px");
    assert.equal(button!.style.top, "386px");
    button!.dispatch("click");
    const dialog = f.root.children.find((node) => node.tagName === "section");
    assert.exists(dialog, "the comment action must open the comment editor");
    assert.equal(dialog!.children[0].textContent, "Selected chat passage");
    assert.equal(dialog!.children[1].tagName, "textarea");
    dialog!.children[2].children[0].dispatch("click");
    assert.notInclude(f.root.children, dialog);
    dispose();
    assert.deepEqual(f.root.children, [f.history]);
  });

  it("ignores selections in an editable field and removes stale actions", function () {
    const f = fixture();
    const dispose = setupChatSelectionComment(f.history as any);
    f.doc.dispatch("mouseup");
    f.flush();
    assert.lengthOf(f.root.children, 2);
    f.selection.isCollapsed = true;
    f.doc.dispatch("selectionchange");
    f.flush();
    assert.deepEqual(f.root.children, [f.history]);
    f.selection.isCollapsed = false;
    f.content.editable = true;
    f.doc.dispatch("pointerup");
    f.flush();
    assert.deepEqual(f.root.children, [f.history]);
    dispose();
  });
});
