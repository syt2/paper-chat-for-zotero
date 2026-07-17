import { assert } from "chai";
import type {
  ChatHistoryMessagePage,
  ChatHistorySearchPage,
} from "../src/modules/chat/search/SearchTypes.ts";
import { MAX_SEARCH_QUERY_RAW_UTF16_LENGTH } from "../src/modules/chat/search/SearchQuery.ts";
import { darkTheme } from "../src/modules/ui/chat-panel/ChatPanelTheme.ts";
import {
  appendHighlightedSearchText,
  createHistoryDropdownState,
  populateHistoryDropdown,
  renderHistorySearchResults,
  setupHistoryDropdownSearch,
  type HistoryDropdownSearchCallbacks,
} from "../src/modules/ui/chat-panel/HistoryDropdown.ts";
import type { SessionInfo } from "../src/modules/ui/chat-panel/types.ts";

type Listener = (event: FakeEvent) => void;

class FakeEvent {
  readonly target: FakeNode;

  constructor(target: FakeNode) {
    this.target = target;
  }

  stopPropagation(): void {}
  preventDefault(): void {}
}

class FakeNode {
  parentElement: FakeElement | null = null;

  constructor(readonly ownerDocument: FakeDocument) {}

  get textContent(): string {
    return "";
  }

  set textContent(_value: string) {}
}

class FakeTextNode extends FakeNode {
  constructor(
    ownerDocument: FakeDocument,
    private value: string,
  ) {
    super(ownerDocument);
  }

  override get textContent(): string {
    return this.value;
  }

  override set textContent(value: string) {
    this.value = value;
  }
}

class FakeElement extends FakeNode {
  readonly style: Record<string, string> = {};
  readonly attributes = new Map<string, string>();
  readonly children: FakeNode[] = [];
  readonly listeners = new Map<string, Listener[]>();
  className = "";
  value = "";
  disabled = false;
  scrollTop = 0;
  private ownText = "";

  constructor(
    ownerDocument: FakeDocument,
    readonly tagName: string,
  ) {
    super(ownerDocument);
  }

  override get textContent(): string {
    return (
      this.ownText + this.children.map((child) => child.textContent).join("")
    );
  }

  override set textContent(value: string) {
    this.ownText = value;
    this.children.length = 0;
  }

  appendChild<T extends FakeNode>(child: T): T {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  remove(): void {
    if (!this.parentElement) return;
    const index = this.parentElement.children.indexOf(this);
    if (index >= 0) this.parentElement.children.splice(index, 1);
    this.parentElement = null;
  }

  replaceWith(replacement: FakeElement): void {
    if (!this.parentElement) return;
    const index = this.parentElement.children.indexOf(this);
    if (index < 0) return;
    replacement.parentElement = this.parentElement;
    this.parentElement.children[index] = replacement;
    this.parentElement = null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) || [];
    this.listeners.set(
      type,
      listeners.filter((candidate) => candidate !== listener),
    );
  }

  dispatch(type: string): void {
    const event = new FakeEvent(this);
    for (const listener of [...(this.listeners.get(type) || [])]) {
      listener(event);
    }
  }

  contains(node: FakeNode): boolean {
    if (node === this) return true;
    return this.children.some(
      (child) => child instanceof FakeElement && child.contains(node),
    );
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    const matches: FakeElement[] = [];
    const matchesSelector = (element: FakeElement) => {
      if (selector.startsWith("#")) {
        return element.getAttribute("id") === selector.slice(1);
      }
      if (selector.startsWith(".")) {
        return element.className.split(/\s+/).includes(selector.slice(1));
      }
      return element.tagName.toLowerCase() === selector.toLowerCase();
    };
    const visit = (element: FakeElement) => {
      for (const child of element.children) {
        if (!(child instanceof FakeElement)) continue;
        if (matchesSelector(child)) matches.push(child);
        visit(child);
      }
    };
    visit(this);
    return matches;
  }

  focus(): void {}
  select(): void {}
}

class FakeDocument {
  createElementNS(_namespace: string, tagName: string): FakeElement {
    return new FakeElement(this, tagName);
  }

  createTextNode(value: string): FakeTextNode {
    return new FakeTextNode(this, value);
  }
}

function asDocument(doc: FakeDocument): Document {
  return doc as unknown as Document;
}

function asElement(element: FakeElement): HTMLElement {
  return element as unknown as HTMLElement;
}

function createShell(doc: FakeDocument): {
  dropdown: FakeElement;
  input: FakeElement;
  body: FakeElement;
} {
  const dropdown = new FakeElement(doc, "div");
  const header = new FakeElement(doc, "div");
  const input = new FakeElement(doc, "input");
  const body = new FakeElement(doc, "div");
  input.setAttribute("id", "chat-history-search-input");
  body.setAttribute("id", "chat-history-dropdown-body");
  header.appendChild(input);
  dropdown.appendChild(header);
  dropdown.appendChild(body);
  return { dropdown, input, body };
}

function match(id: string, snippet = "matched text") {
  return {
    messageId: id,
    role: "assistant" as const,
    messageTimestamp: 100,
    messageSeq: 1,
    snippet,
    highlightRanges: [{ start: 0, end: 7 }],
  };
}

function page(
  queryKey: string,
  sessionId: string,
  options: { nextMessageCursor?: string; nextSessionCursor?: string } = {},
): ChatHistorySearchPage {
  return {
    queryKey,
    searchRevision: 7,
    nextSessionCursor: options.nextSessionCursor,
    groups: [
      {
        sessionId,
        sessionTitle: `<${sessionId}>`,
        sessionUpdatedAt: 100,
        titleMatch: {
          kind: "contains",
          snippet: `<b>${sessionId}</b>`,
          highlightRanges: [{ start: 3, end: 3 + sessionId.length }],
        },
        totalMessageMatches: options.nextMessageCursor ? 4 : 1,
        matches: [match(`${sessionId}-m1`, `<script>${sessionId}</script>`)],
        nextMessageCursor: options.nextMessageCursor,
      },
    ],
  };
}

function callbacks(
  searchGroups: HistoryDropdownSearchCallbacks["searchGroups"],
  searchSessionMatches: HistoryDropdownSearchCallbacks["searchSessionMatches"] = async () => {
    throw new Error("unexpected expansion");
  },
): HistoryDropdownSearchCallbacks {
  return {
    searchGroups,
    searchSessionMatches,
    onSelectTitleMatch: () => {},
    onSelectMessageMatch: () => {},
  };
}

function session(index: number): SessionInfo {
  return {
    id: `s${index}`,
    createdAt: index,
    updatedAt: index,
    messageCount: 1,
    lastMessagePreview: `preview ${index}`,
    lastMessageTime: index,
    title: `Session ${index}`,
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function wait(ms = 0): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe("history dropdown grouped search UI", function () {
  let originalAddon: unknown;

  beforeEach(function () {
    originalAddon = (globalThis as { addon?: unknown }).addon;
    (globalThis as { addon?: unknown }).addon = {
      data: {
        locale: {
          current: {
            formatMessagesSync: ([request]: Array<{
              id: string;
              args?: any;
            }>) => [
              {
                value: request.args?.count
                  ? `${request.id}:${request.args.count}`
                  : request.id,
                attributes: null,
              },
            ],
          },
        },
      },
    };
  });

  afterEach(function () {
    (globalThis as { addon?: unknown }).addon = originalAddon;
  });

  it("initializes persistent ordinary and search state", function () {
    const state = createHistoryDropdownState();
    assert.deepInclude(state, {
      displayedCount: 0,
      query: "",
      normalizedQuery: "",
      cache: null,
      scrollTop: 0,
      generation: 0,
      isComposing: false,
      searchPending: false,
    });
    assert.deepEqual(state.groups, []);
    assert.deepEqual(state.expandedCounts, {});
    assert.instanceOf(state.pendingExpansionSessionIds, Set);
  });

  it("applies the API raw input limit to the search field", function () {
    const doc = new FakeDocument();
    const { dropdown, input } = createShell(doc);
    setupHistoryDropdownSearch(
      asElement(dropdown),
      asDocument(doc),
      createHistoryDropdownState(),
      darkTheme,
      callbacks(async () => page("q", "session")),
    );

    assert.equal(
      input.getAttribute("maxlength"),
      String(MAX_SEARCH_QUERY_RAW_UTF16_LENGTH),
    );
    assert.equal(darkTheme.inputFocusBorderColor, "#9ca3af");
  });

  it("clears ordinary history while the first search is pending", function () {
    const doc = new FakeDocument();
    const { dropdown, input, body } = createShell(doc);
    const state = createHistoryDropdownState();
    const dispose = setupHistoryDropdownSearch(
      asElement(dropdown),
      asDocument(doc),
      state,
      darkTheme,
      callbacks(async () => page("q", "session")),
    );
    populateHistoryDropdown(
      asElement(dropdown),
      asDocument(doc),
      [session(1)],
      state,
      darkTheme,
      () => {},
    );
    assert.isAbove(body.children.length, 0);

    input.value = "topic";
    input.dispatch("input");

    assert.equal(body.children.length, 0);
    dispose();
  });

  it("resets expansion state when the normalized query changes", function () {
    const doc = new FakeDocument();
    const { dropdown, input } = createShell(doc);
    const state = createHistoryDropdownState();
    state.query = "first";
    state.normalizedQuery = "first";
    state.expandedCounts = { shared: 13 };
    const dispose = setupHistoryDropdownSearch(
      asElement(dropdown),
      asDocument(doc),
      state,
      darkTheme,
      callbacks(async () => page("q", "session")),
    );

    input.value = "second";
    input.dispatch("input");

    assert.deepEqual(state.expandedCounts, {});
    dispose();
  });

  it("renders highlight ranges as literal text nodes without markup parsing", function () {
    const doc = new FakeDocument();
    const container = new FakeElement(doc, "div");
    const unsafe = `before <img onerror="boom"> after`;
    appendHighlightedSearchText(
      asElement(container),
      unsafe,
      [{ start: 7, end: 27 }],
      asDocument(doc),
      darkTheme,
    );

    assert.equal(container.textContent, unsafe);
    assert.isNull(container.querySelector("img"));
    assert.lengthOf(container.querySelectorAll(".history-search-highlight"), 1);
  });

  it("renders passive groups with separate clickable title and message rows", function () {
    const doc = new FakeDocument();
    const { dropdown, body } = createShell(doc);
    const state = createHistoryDropdownState();
    state.query = "topic";
    state.groups = page("q", "session", {
      nextMessageCursor: "message-cursor",
    }).groups;
    state.sessionCursor = "session-cursor";
    let titleSelection = "";
    let messageSelection = "";
    const cb: HistoryDropdownSearchCallbacks = {
      ...callbacks(async () => page("q", "session")),
      onSelectTitleMatch: (sessionId) => {
        titleSelection = sessionId;
      },
      onSelectMessageMatch: (sessionId, messageId) => {
        messageSelection = `${sessionId}:${messageId}`;
      },
    };

    renderHistorySearchResults(
      asElement(dropdown),
      asDocument(doc),
      state,
      darkTheme,
      cb,
      () => {},
      () => {},
    );

    assert.lengthOf(body.querySelectorAll(".history-search-group-header"), 1);
    assert.lengthOf(body.querySelectorAll(".history-search-title-match"), 1);
    assert.lengthOf(body.querySelectorAll(".history-search-message-match"), 1);
    assert.lengthOf(body.querySelectorAll(".history-search-expand-matches"), 1);
    assert.lengthOf(body.querySelectorAll(".history-search-next-sessions"), 1);
    assert.equal(
      body.querySelector(".history-search-expand-matches")?.style.color,
      darkTheme.textSecondary,
    );
    assert.equal(
      body.querySelector(".history-search-next-sessions")?.style.color,
      darkTheme.textSecondary,
    );
    body.querySelector(".history-search-title-match")?.dispatch("click");
    body.querySelector(".history-search-message-match")?.dispatch("click");
    assert.equal(titleSelection, "session");
    assert.equal(messageSelection, "session:session-m1");
  });

  it("disables an old session cursor after the query changes", function () {
    const doc = new FakeDocument();
    const { dropdown, body } = createShell(doc);
    const state = createHistoryDropdownState();
    state.query = "new query";
    state.normalizedQuery = "new query";
    state.cache = {
      normalizedQuery: "old query",
      queryKey: "old-key",
      searchRevision: 7,
    };
    state.groups = page("old-key", "old-session").groups;
    state.sessionCursor = "old-cursor";

    renderHistorySearchResults(
      asElement(dropdown),
      asDocument(doc),
      state,
      darkTheme,
      callbacks(async () => page("new-key", "new-session")),
      () => {},
      () => {},
    );

    const next = body.querySelector(
      ".history-search-next-sessions",
    ) as FakeElement | null;
    assert.isTrue(next?.disabled);
  });

  it("keeps one-code-point queries on ordinary 20-session pagination", async function () {
    const doc = new FakeDocument();
    const { dropdown, input, body } = createShell(doc);
    const state = createHistoryDropdownState();
    let searchCalls = 0;
    setupHistoryDropdownSearch(
      asElement(dropdown),
      asDocument(doc),
      state,
      darkTheme,
      callbacks(async () => {
        searchCalls += 1;
        return page("q", "search");
      }),
    );
    populateHistoryDropdown(
      asElement(dropdown),
      asDocument(doc),
      Array.from({ length: 21 }, (_, index) => session(index)),
      state,
      darkTheme,
      () => {},
    );

    input.value = "中";
    input.dispatch("input");
    await wait(230);
    assert.equal(searchCalls, 0);
    assert.equal(state.displayedCount, 20);
    assert.lengthOf(body.querySelectorAll(".load-more-btn"), 1);
  });

  it("runs one primary request and keeps only the newest pending query", async function () {
    this.timeout(3000);
    const doc = new FakeDocument();
    const { dropdown, input, body } = createShell(doc);
    const state = createHistoryDropdownState();
    const first = deferred<ChatHistorySearchPage>();
    const third = deferred<ChatHistorySearchPage>();
    const queries: string[] = [];
    let activeRequests = 0;
    let maxActiveRequests = 0;
    setupHistoryDropdownSearch(
      asElement(dropdown),
      asDocument(doc),
      state,
      darkTheme,
      callbacks(async ({ query }) => {
        queries.push(query);
        activeRequests += 1;
        maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
        try {
          return await (query === "first" ? first.promise : third.promise);
        } finally {
          activeRequests -= 1;
        }
      }),
    );

    input.value = "first";
    input.dispatch("input");
    await wait(220);
    input.value = "second";
    input.dispatch("input");
    await wait(220);
    input.value = "third";
    input.dispatch("input");
    await wait(220);

    assert.deepEqual(queries, ["first"]);
    third.resolve(page("third-key", "third"));
    first.resolve(page("first-key", "first"));
    await wait(20);

    assert.deepEqual(queries, ["first", "third"]);
    assert.equal(maxActiveRequests, 1);
    assert.deepEqual(
      state.groups.map((group) => group.sessionId),
      ["third"],
    );
    assert.equal(state.cache?.queryKey, "third-key");
    assert.equal(
      body
        .querySelector(".history-search-group")
        ?.getAttribute("data-session-id"),
      "third",
    );
  });

  it("waits for IME composition end before scheduling a search", async function () {
    const doc = new FakeDocument();
    const { dropdown, input } = createShell(doc);
    const state = createHistoryDropdownState();
    let calls = 0;
    setupHistoryDropdownSearch(
      asElement(dropdown),
      asDocument(doc),
      state,
      darkTheme,
      callbacks(async () => {
        calls += 1;
        return page("q", "ime");
      }),
    );

    input.dispatch("compositionstart");
    input.value = "中文";
    input.dispatch("input");
    await wait(230);
    assert.equal(calls, 0);
    input.dispatch("compositionend");
    await wait(230);
    assert.equal(calls, 1);
  });

  it("coalesces expansion clicks and appends at most ten message matches", async function () {
    this.timeout(3000);
    const doc = new FakeDocument();
    const { dropdown, input, body } = createShell(doc);
    const state = createHistoryDropdownState();
    const expansion = deferred<ChatHistoryMessagePage>();
    let expansionCalls = 0;
    let expansionLimit = 0;
    setupHistoryDropdownSearch(
      asElement(dropdown),
      asDocument(doc),
      state,
      darkTheme,
      callbacks(
        async () => page("q", "expand", { nextMessageCursor: "cursor-1" }),
        async (request) => {
          expansionCalls += 1;
          expansionLimit = request.limit || 0;
          return expansion.promise;
        },
      ),
    );
    input.value = "expand";
    input.dispatch("input");
    await wait(230);
    const expand = body.querySelector(".history-search-expand-matches");
    assert.isNotNull(expand);
    expand?.dispatch("click");
    expand?.dispatch("click");
    assert.equal(expansionCalls, 1);
    assert.equal(expansionLimit, 10);

    expansion.resolve({
      queryKey: "q",
      searchRevision: 7,
      sessionId: "expand",
      totalMessageMatches: 3,
      matches: [match("expand-m2"), match("expand-m3")],
    });
    await wait();
    assert.deepEqual(
      state.groups[0].matches.map((candidate) => candidate.messageId),
      ["expand-m1", "expand-m2", "expand-m3"],
    );
    assert.equal(state.expandedCounts.expand, 3);
  });

  it("re-enables session pagination after a request error", async function () {
    this.timeout(3000);
    const doc = new FakeDocument();
    const { dropdown, input, body } = createShell(doc);
    const state = createHistoryDropdownState();
    let calls = 0;
    let errors = 0;
    setupHistoryDropdownSearch(
      asElement(dropdown),
      asDocument(doc),
      state,
      darkTheme,
      {
        ...callbacks(async () => {
          calls += 1;
          if (calls === 2) throw new Error("page failed");
          return page("q", "session", { nextSessionCursor: "next" });
        }),
        onSearchError: () => {
          errors += 1;
        },
      },
    );

    input.value = "session";
    input.dispatch("input");
    await wait(230);
    body.querySelector(".history-search-next-sessions")?.dispatch("click");
    await wait();

    const retry = body.querySelector(
      ".history-search-next-sessions",
    ) as FakeElement | null;
    assert.equal(calls, 2);
    assert.equal(errors, 1);
    assert.isFalse(retry?.disabled);
    retry?.dispatch("click");
    await wait();
    assert.equal(calls, 3);
  });

  it("ignores an old expansion failure after the query changes", async function () {
    this.timeout(3000);
    const doc = new FakeDocument();
    const { dropdown, input, body } = createShell(doc);
    const state = createHistoryDropdownState();
    const oldExpansion = deferred<ChatHistoryMessagePage>();
    let expansionCalls = 0;
    let errors = 0;
    setupHistoryDropdownSearch(
      asElement(dropdown),
      asDocument(doc),
      state,
      darkTheme,
      {
        ...callbacks(
          async ({ query }) =>
            page(query, "shared", { nextMessageCursor: `${query}-cursor` }),
          async ({ queryKey, sessionId }) => {
            expansionCalls += 1;
            if (expansionCalls === 1) return oldExpansion.promise;
            return {
              queryKey,
              searchRevision: 7,
              sessionId,
              totalMessageMatches: 2,
              matches: [match("shared-m2")],
            };
          },
        ),
        onSearchError: () => {
          errors += 1;
        },
      },
    );

    input.value = "first";
    input.dispatch("input");
    await wait(230);
    body.querySelector(".history-search-expand-matches")?.dispatch("click");
    assert.equal(expansionCalls, 1);

    input.value = "second";
    input.dispatch("input");
    await wait(230);
    oldExpansion.reject(new Error("old query failed"));
    await wait();

    assert.equal(errors, 0);
    const currentExpand = body.querySelector(
      ".history-search-expand-matches",
    ) as FakeElement | null;
    assert.isFalse(currentExpand?.disabled);
    currentExpand?.dispatch("click");
    await wait();
    assert.equal(expansionCalls, 2);
  });

  it("preserves cached search rows and scroll when ordinary history refreshes", function () {
    const doc = new FakeDocument();
    const { dropdown, body } = createShell(doc);
    const state = createHistoryDropdownState();
    state.query = "cached";
    state.normalizedQuery = "cached";
    state.groups = page("q", "cached").groups;
    state.cache = {
      normalizedQuery: "cached",
      queryKey: "q",
      searchRevision: 7,
    };
    state.scrollTop = 84;
    setupHistoryDropdownSearch(
      asElement(dropdown),
      asDocument(doc),
      state,
      darkTheme,
      callbacks(async () => page("q", "cached")),
    );
    populateHistoryDropdown(
      asElement(dropdown),
      asDocument(doc),
      [session(1)],
      state,
      darkTheme,
      () => {},
    );

    assert.equal(body.scrollTop, 84);
    assert.equal(
      body
        .querySelector(".history-search-group")
        ?.getAttribute("data-session-id"),
      "cached",
    );
    assert.lengthOf(body.querySelectorAll(".load-more-btn"), 0);
  });
});
