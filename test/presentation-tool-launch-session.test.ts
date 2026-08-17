import { assert } from "chai";
import { ChatManager } from "../src/modules/chat/ChatManager.ts";
import { getContextManager } from "../src/modules/chat/ContextManager.ts";
import { PdfToolManager } from "../src/modules/chat/pdf-tools/PdfToolManager.ts";
import { generatePaperContextPrompt } from "../src/modules/chat/pdf-tools/promptGenerator.ts";
import { isIssuedPresentationLaunchAuthorization } from "../src/modules/presentation/PresentationLaunchAuthorization.ts";
import {
  canLaunchPresentationFromChat,
  createPresentationChatLaunchSession,
  registerPresentationChatLaunchBridge,
  unregisterPresentationChatLaunchBridge,
} from "../src/modules/presentation/PresentationChatLaunchBridge.ts";
import { PresentationLaunchCoordinator } from "../src/modules/presentation/PresentationLaunchCoordinator.ts";
import { DEFAULT_PRESENTATION_LAUNCH_SETTINGS } from "../src/modules/presentation/PresentationLaunchSettings.ts";
import {
  createPresentationLaunchToolDefinition,
  createPresentationToolLaunchSession,
} from "../src/modules/presentation/PresentationToolLaunchSession.ts";
import { ToolScheduler } from "../src/modules/chat/tool-scheduler/ToolScheduler.ts";
import { getProviderManager } from "../src/modules/providers/ProviderManager.ts";
import type { ChatMessage, ChatSession } from "../src/types/chat.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createAllowedGuard() {
  return Promise.resolve({
    allowed: true as const,
    balance: { quota: 300_000, subscriptionRemaining: 0, available: 300_000 },
    settings: DEFAULT_PRESENTATION_LAUNCH_SETTINGS,
  });
}

async function runChatManagerBridgeLifecycle(
  outcome: "success" | "provider_error" | "abort",
  scenario: {
    currentItem?: boolean;
    selectedPaper?: boolean;
    content?: string;
    previousMessages?: ChatMessage[];
    expectedMentionSources?: Array<{
      itemKey: string;
      libraryID?: number;
      title?: string;
    }>;
  } = {},
): Promise<void> {
  const runtime = globalThis as {
    Zotero?: unknown;
    ztoolkit?: unknown;
  };
  const originalZotero = runtime.Zotero;
  const originalZtoolkit = runtime.ztoolkit;
  runtime.Zotero = {
    Prefs: {
      get: () => undefined,
      set: () => true,
    },
    DataDirectory: { dir: "/tmp/zotero-test" },
    Libraries: { userLibraryID: 1 },
  };
  runtime.ztoolkit = { log: () => undefined };
  const providerManager = getProviderManager() as any;
  const originalGetActiveProviderId = providerManager.getActiveProviderId;
  const contextManager = getContextManager() as any;
  const originalCompactBeforeSendIfNeeded =
    contextManager.compactBeforeSendIfNeeded;
  const originalFilterMessages = contextManager.filterMessages;

  const item = {
    id: 1,
    key: "PAPER-A",
    libraryID: 1,
    getField: () => "Paper A",
  } as unknown as Zotero.Item;
  const hasCurrentItem = scenario.currentItem !== false;
  const session: ChatSession = {
    id: `chat-manager-ppt-${outcome}`,
    createdAt: 1,
    updatedAt: 1,
    lastActiveItemKey: hasCurrentItem ? item.key : null,
    lastActiveItemLibraryID: hasCurrentItem ? item.libraryID : undefined,
    messages: scenario.previousMessages ? [...scenario.previousMessages] : [],
  };
  const insertedMessages: ChatMessage[] = [];
  const provider = {
    config: { id: "paperchat", type: "paperchat" },
    getName: () => "PaperChat",
    isReady: () => true,
    supportsToolCalling: () => true,
    supportsPdfUpload: () => false,
    chatCompletionWithTools: async () => ({ content: "unused" }),
  };
  let capturedLocation:
    | { sessionId: string; assistantMessageId: string }
    | undefined;
  let bridgeAbortSignal: AbortSignal | undefined;
  let runtimeAbortSignal: AbortSignal | undefined;
  let finishEffects = 0;
  let finished = false;
  let resolveProviderStarted!: () => void;
  const providerStarted = new Promise<void>((resolve) => {
    resolveProviderStarted = resolve;
  });

  providerManager.getActiveProviderId = () => "test-paperchat";
  contextManager.compactBeforeSendIfNeeded = async () => false;
  contextManager.filterMessages = (targetSession: ChatSession) => ({
    messages: [...targetSession.messages],
    summaryTriggered: false,
  });

  registerPresentationChatLaunchBridge({
    canLaunch: (candidate) =>
      candidate === item ||
      (candidate === null && scenario.selectedPaper === true),
    createSession: (candidate, location, options) => {
      assert.strictEqual(candidate, hasCurrentItem ? item : null);
      assert.deepEqual(
        options?.mentionSources || [],
        scenario.expectedMentionSources || [],
      );
      capturedLocation = location;
      bridgeAbortSignal = options?.abortSignal;
      const finish = () => {
        if (finished) return;
        finished = true;
        finishEffects += 1;
      };
      bridgeAbortSignal?.addEventListener("abort", finish, { once: true });
      return {
        source: Object.freeze(
          hasCurrentItem
            ? { itemKey: item.key, libraryID: item.libraryID }
            : {},
        ),
        requestAuthorization: async () => ({
          allowed: false as const,
          reason: "turn_finished" as const,
        }),
        getAuthorization: () => undefined,
        finish,
      };
    },
  });

  try {
    const manager = Object.create(ChatManager.prototype) as any;
    manager.currentSession = session;
    manager.activeSessionRunIds = new Map();
    manager.sessionRunCounters = new Map();
    manager.activeSessionAbortControllers = new Map();
    manager.paperChatRerollSessions = new Set();
    manager.streamingSessions = new Map();
    manager.currentItemKey = hasCurrentItem ? item.key : null;
    manager.currentItemLibraryID = hasCurrentItem ? item.libraryID : null;
    manager.pdfExtractor = {
      hasPdfAttachment: async () => false,
    };
    manager.init = async () => undefined;
    manager.getActiveProvider = () => provider;
    manager.sessionStorage = {
      insertMessage: async (_sessionId: string, message: ChatMessage) => {
        insertedMessages.push(message);
      },
      updateSessionMeta: async () => undefined,
    };
    manager.sendMessageWithToolCalling = async (...args: unknown[]) => {
      runtimeAbortSignal = args[11] as AbortSignal | undefined;
      resolveProviderStarted();
      if (outcome === "provider_error") {
        throw new Error("provider failed");
      }
      if (outcome === "abort") {
        await new Promise<void>((resolve) => {
          runtimeAbortSignal?.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });
      }
      return true;
    };

    const send = manager.sendMessage(
      scenario.content || "为这篇论文生成一个 PPT",
      hasCurrentItem ? { item } : {},
    );
    await providerStarted;
    assert.equal(capturedLocation?.sessionId, session.id);
    assert.isTrue(
      insertedMessages.some(
        (message) => message.id === capturedLocation?.assistantMessageId,
      ),
    );
    assert.strictEqual(bridgeAbortSignal, runtimeAbortSignal);

    if (outcome === "abort") {
      manager.activeSessionAbortControllers.get(session.id)?.abort();
    }

    if (outcome === "provider_error") {
      let caught: unknown;
      try {
        await send;
      } catch (error) {
        caught = error;
      }
      assert.instanceOf(caught, Error);
      assert.equal((caught as Error).message, "provider failed");
    } else {
      assert.isTrue(await send);
    }

    assert.equal(finishEffects, 1);
    assert.isEmpty(manager.activeSessionRunIds);
    assert.isEmpty(manager.activeSessionAbortControllers);
    assert.isEmpty(manager.streamingSessions);
  } finally {
    unregisterPresentationChatLaunchBridge();
    providerManager.getActiveProviderId = originalGetActiveProviderId;
    contextManager.compactBeforeSendIfNeeded =
      originalCompactBeforeSendIfNeeded;
    contextManager.filterMessages = originalFilterMessages;
    runtime.Zotero = originalZotero;
    runtime.ztoolkit = originalZtoolkit;
  }
}

describe("presentation model launch session", function () {
  afterEach(function () {
    unregisterPresentationChatLaunchBridge();
  });

  it("exposes a low-risk launcher with optional structured suggestions", function () {
    const definition = createPresentationLaunchToolDefinition();
    assert.equal(definition.function.name, "request_presentation");
    assert.deepEqual(
      Object.keys(definition.function.parameters.properties || {}).sort(),
      [
        "designSystem",
        "instructions",
        "slideCount",
        "sourceItemKey",
        "sourceLibraryID",
      ],
    );
    assert.include(
      definition.function.description,
      "native presentation settings",
    );
    assert.include(definition.function.description, "重试下");
  });

  it("keeps the launcher and private capability independently selectable", function () {
    const manager = new PdfToolManager();
    const defaultTools = manager
      .getToolDefinitions(true)
      .map((tool) => tool.function.name);
    const launcherTools = manager
      .getToolDefinitions(true, { includePresentationLauncher: true })
      .map((tool) => tool.function.name);
    const privateTools = manager
      .getToolDefinitions(true, { includePresentation: true })
      .map((tool) => tool.function.name);

    assert.notInclude(defaultTools, "request_presentation");
    assert.notInclude(defaultTools, "presentation");
    assert.include(launcherTools, "request_presentation");
    assert.notInclude(launcherTools, "presentation");
    assert.include(privateTools, "presentation");
    assert.notInclude(privateTools, "request_presentation");
  });

  it("keeps the chat bridge replaceable and inert after unregistering", function () {
    const item = {} as Zotero.Item;
    const launchSession = createPresentationToolLaunchSession({
      coordinator: new PresentationLaunchCoordinator(1),
      source: { itemKey: "PAPER-A", libraryID: 1 },
      runGuard: () => createAllowedGuard(),
    });
    registerPresentationChatLaunchBridge({
      canLaunch: (candidate) => candidate === item,
      createSession: (candidate) => (candidate === item ? launchSession : null),
    });

    assert.isTrue(canLaunchPresentationFromChat(item));
    assert.strictEqual(
      createPresentationChatLaunchSession(item, {
        sessionId: "session-a",
        assistantMessageId: "assistant-a",
      }),
      launchSession,
    );

    unregisterPresentationChatLaunchBridge();
    assert.isFalse(canLaunchPresentationFromChat(item));
    assert.isNull(
      createPresentationChatLaunchSession(item, {
        sessionId: "session-a",
        assistantMessageId: "assistant-a",
      }),
    );
    launchSession.finish();
  });

  it("isolates ordinary chat from a failing optional presentation adapter", function () {
    const runtime = globalThis as { ztoolkit?: unknown };
    const originalZtoolkit = runtime.ztoolkit;
    const logs: unknown[][] = [];
    const item = {} as Zotero.Item;
    runtime.ztoolkit = {
      log: (...args: unknown[]) => logs.push(args),
    };

    try {
      registerPresentationChatLaunchBridge({
        canLaunch: () => {
          throw new Error("adapter unavailable");
        },
        createSession: () => {
          throw new Error("adapter unavailable");
        },
      });

      assert.isFalse(canLaunchPresentationFromChat(item));
      assert.isNull(
        createPresentationChatLaunchSession(item, {
          sessionId: "session-a",
          assistantMessageId: "assistant-a",
        }),
      );
      assert.lengthOf(logs, 2);
      assert.include(String(logs[0][0]), "adapter canLaunch failed");
      assert.include(String(logs[1][0]), "adapter createSession failed");
    } finally {
      runtime.ztoolkit = originalZtoolkit;
    }
  });

  it("aligns system guidance with the launcher instead of hidden presentation", function () {
    const launcherPrompt = generatePaperContextPrompt(
      undefined,
      "PAPER-A",
      "Paper A",
      true,
      undefined,
      undefined,
      "unified",
      "launcher",
    );
    const unavailablePrompt = generatePaperContextPrompt(
      undefined,
      "PAPER-A",
      "Paper A",
      true,
      undefined,
      undefined,
      "unified",
      "unavailable",
    );

    assert.include(launcherPrompt, "=== PRESENTATION LAUNCH FLOW ===");
    assert.include(launcherPrompt, "call request_presentation");
    assert.include(launcherPrompt, "sourceLibraryID");
    assert.include(launcherPrompt, 'follow-up such as "重试下"');
    assert.include(
      launcherPrompt,
      "Do not call it in the same model response as request_presentation",
    );
    assert.notInclude(unavailablePrompt, "=== PRESENTATION TOOL ===");
    assert.notInclude(unavailablePrompt, "=== PRESENTATION LAUNCH FLOW ===");
  });

  it("includes launcher guidance when a paper is supplied only by mention", function () {
    const prompt = generatePaperContextPrompt(
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      "unified",
      "launcher",
    );

    assert.include(prompt, "=== PRESENTATION LAUNCH FLOW ===");
    assert.include(prompt, "call request_presentation");
  });

  it("creates a launcher for the single Zotero selection without a reader paper", async function () {
    await runChatManagerBridgeLifecycle("success", {
      currentItem: false,
      selectedPaper: true,
      content: "为选中的论文生成一个 PPT",
    });
  });

  it("mints one private authorization after confirmation and reuses it", async function () {
    const session = createPresentationToolLaunchSession({
      coordinator: new PresentationLaunchCoordinator(1),
      source: { itemKey: "PAPER-A", libraryID: 1 },
      runGuard: () => createAllowedGuard(),
    });

    const first = await session.requestAuthorization();
    const second = await session.requestAuthorization();

    assert.isTrue(first.allowed);
    assert.isTrue(second.allowed);
    if (!first.allowed || !second.allowed) return;
    assert.strictEqual(first.authorization, second.authorization);
    assert.strictEqual(session.getAuthorization(), first.authorization);
    assert.isTrue(isIssuedPresentationLaunchAuthorization(first.authorization));
    session.finish();
    assert.isUndefined(session.getAuthorization());
    assert.deepEqual(await session.requestAuthorization(), {
      allowed: false,
      reason: "turn_finished",
    });
  });

  it("does not let a second launcher call change the paper or settings", async function () {
    const session = createPresentationToolLaunchSession({
      coordinator: new PresentationLaunchCoordinator(1),
      source: { itemKey: "PAPER-A", libraryID: 1 },
      runGuard: () => createAllowedGuard(),
    });

    const first = await session.requestAuthorization({ slideCount: 10 });
    const second = await session.requestAuthorization({ slideCount: 15 });

    assert.isTrue(first.allowed);
    assert.deepEqual(second, { allowed: false, reason: "already_active" });
    session.finish();
  });

  it("passes model suggestions to the native guard while keeping the resolved source app-owned", async function () {
    let suggestedSettings: unknown;
    const session = createPresentationToolLaunchSession({
      coordinator: new PresentationLaunchCoordinator(1),
      source: { itemKey: "PAPER-A", libraryID: 1 },
      resolveSource: (intent) => ({
        allowed: true,
        source: {
          itemKey: intent.sourceItemKey || "PAPER-A",
          libraryID: intent.sourceLibraryID || 1,
        },
      }),
      runGuard: async (_focus, suggestions) => {
        suggestedSettings = suggestions;
        return createAllowedGuard();
      },
    });

    const result = await session.requestAuthorization({
      sourceItemKey: "PAPER-B",
      sourceLibraryID: 5,
      slideCount: 10,
      designSystem: "deep-blue-atlas",
      instructions: "Focus on the ablation study.",
    });
    assert.isTrue(result.allowed);
    assert.deepEqual(suggestedSettings, {
      slideCount: 10,
      designSystem: "deep-blue-atlas",
      userInstructions: "Focus on the ablation study.",
    });
    assert.deepEqual(session.getAuthorization()?.source, {
      itemKey: "PAPER-B",
      libraryID: 5,
    });
    session.finish();
  });

  it("uses the real scheduler to pass suggestions without letting them mint authorization", async function () {
    const originalZotero = (globalThis as { Zotero?: unknown }).Zotero;
    (globalThis as { Zotero?: unknown }).Zotero = {
      Prefs: {
        get: () => "",
        set: () => true,
      },
      DataDirectory: { dir: "/tmp/zotero" },
    };
    const launchSession = createPresentationToolLaunchSession({
      coordinator: new PresentationLaunchCoordinator(1),
      source: { itemKey: "PAPER-A", libraryID: 1 },
      runGuard: () => createAllowedGuard(),
    });
    const manager = new PdfToolManager();
    const scheduler = new ToolScheduler(
      (
        toolCall,
        fallbackStructure,
        args,
        currentItemKey,
        executionContext,
        abortSignal,
      ) =>
        manager.executeToolCall(
          toolCall,
          fallbackStructure,
          args,
          currentItemKey,
          executionContext,
          abortSignal,
        ),
    );

    try {
      const result = await scheduler.execute({
        toolCall: {
          id: "launcher-through-scheduler",
          type: "function",
          function: {
            name: "request_presentation",
            arguments: JSON.stringify({
              slideCount: 30,
              designSystem: "model-invented",
            }),
          },
        },
        sessionId: "session-a",
        executionContext: { presentationLaunchSession: launchSession },
      });

      assert.equal(result.status, "completed");
      assert.deepEqual(result.args, {
        slideCount: 30,
        designSystem: "model-invented",
      });
      assert.deepEqual(
        launchSession.getAuthorization()?.settings,
        DEFAULT_PRESENTATION_LAUNCH_SETTINGS,
      );
      assert.include(
        result.content,
        "private presentation tool is now available",
      );
    } finally {
      launchSession.finish();
      (globalThis as { Zotero?: unknown }).Zotero = originalZotero;
    }
  });

  it("focuses an existing same-paper task and returns without waiting for it", async function () {
    const coordinator = new PresentationLaunchCoordinator(1);
    let taskFocuses = 0;
    const first = createPresentationToolLaunchSession({
      coordinator,
      source: { itemKey: "PAPER-A", libraryID: 1 },
      runGuard: () => createAllowedGuard(),
      focusTask: () => {
        taskFocuses += 1;
      },
    });
    assert.isTrue((await first.requestAuthorization()).allowed);

    const duplicate = createPresentationToolLaunchSession({
      coordinator,
      source: { itemKey: "PAPER-A", libraryID: 1 },
      runGuard: () => {
        throw new Error("duplicate guard must not run");
      },
    });
    assert.deepEqual(await duplicate.requestAuthorization(), {
      allowed: false,
      reason: "already_active",
    });
    assert.equal(taskFocuses, 1);

    duplicate.finish();
    first.finish();
  });

  it("focuses an existing settings window while its guard is pending", async function () {
    const coordinator = new PresentationLaunchCoordinator(1);
    const guard = deferred<{
      allowed: false;
      reason: "cancelled";
    }>();
    let configurationFocuses = 0;
    const first = createPresentationToolLaunchSession({
      coordinator,
      source: { itemKey: "PAPER-A", libraryID: 1 },
      runGuard: async (onSettingsFocusReady) => {
        onSettingsFocusReady(() => {
          configurationFocuses += 1;
        });
        return guard.promise;
      },
    });
    const firstRequest = first.requestAuthorization();
    await Promise.resolve();
    await Promise.resolve();

    const duplicate = createPresentationToolLaunchSession({
      coordinator,
      source: { itemKey: "PAPER-A", libraryID: 1 },
      runGuard: () => createAllowedGuard(),
    });
    assert.deepEqual(await duplicate.requestAuthorization(), {
      allowed: false,
      reason: "already_active",
    });
    assert.equal(configurationFocuses, 1);

    guard.resolve({ allowed: false, reason: "cancelled" });
    assert.deepEqual(await firstRequest, {
      allowed: false,
      reason: "cancelled",
    });
    duplicate.finish();
    first.finish();
  });

  it("cancels a pending native guard and releases the paper on turn abort", async function () {
    const coordinator = new PresentationLaunchCoordinator(1);
    const abortController = new AbortController();
    const guard = deferred<{
      allowed: true;
      balance: {
        quota: number;
        subscriptionRemaining: number;
        available: number;
      };
      settings: typeof DEFAULT_PRESENTATION_LAUNCH_SETTINGS;
    }>();
    const first = createPresentationToolLaunchSession({
      coordinator,
      source: { itemKey: "PAPER-A", libraryID: 1 },
      abortSignal: abortController.signal,
      runGuard: () => guard.promise,
    });

    const pending = first.requestAuthorization();
    await Promise.resolve();
    abortController.abort();

    assert.deepEqual(await pending, {
      allowed: false,
      reason: "turn_finished",
    });
    assert.isUndefined(first.getAuthorization());

    const replacement = createPresentationToolLaunchSession({
      coordinator,
      source: { itemKey: "PAPER-A", libraryID: 1 },
      runGuard: () => createAllowedGuard(),
    });
    assert.isTrue((await replacement.requestAuthorization()).allowed);

    // A late dialog result cannot mint authorization for the aborted turn.
    guard.resolve({
      allowed: true,
      balance: {
        quota: 300_000,
        subscriptionRemaining: 0,
        available: 300_000,
      },
      settings: DEFAULT_PRESENTATION_LAUNCH_SETTINGS,
    });
    await Promise.resolve();
    assert.isUndefined(first.getAuthorization());
    replacement.finish();
  });

  it("does not open the guard when the turn was already aborted", async function () {
    const abortController = new AbortController();
    abortController.abort();
    let guardCalls = 0;
    const session = createPresentationToolLaunchSession({
      coordinator: new PresentationLaunchCoordinator(1),
      source: { itemKey: "PAPER-A", libraryID: 1 },
      abortSignal: abortController.signal,
      runGuard: () => {
        guardCalls += 1;
        return createAllowedGuard();
      },
    });

    assert.deepEqual(await session.requestAuthorization(), {
      allowed: false,
      reason: "turn_finished",
    });
    assert.equal(guardCalls, 0);
  });

  it("settles launch failure even when the diagnostic observer throws", async function () {
    const session = createPresentationToolLaunchSession({
      coordinator: new PresentationLaunchCoordinator(1),
      source: { itemKey: "PAPER-A", libraryID: 1 },
      runGuard: async () => {
        throw new Error("guard failed");
      },
      onError: () => {
        throw new Error("observer failed");
      },
    });

    assert.deepEqual(await session.requestAuthorization(), {
      allowed: false,
      reason: "launch_failed",
    });
    session.finish();
  });

  it("keeps the running slot and same-paper lock after a post-confirmation abort", async function () {
    const coordinator = new PresentationLaunchCoordinator(1);
    const abortController = new AbortController();
    const first = createPresentationToolLaunchSession({
      coordinator,
      source: { itemKey: "PAPER-A", libraryID: 1 },
      abortSignal: abortController.signal,
      runGuard: () => createAllowedGuard(),
    });
    assert.isTrue((await first.requestAuthorization()).allowed);

    abortController.abort();
    assert.isDefined(first.getAuthorization());

    let duplicateGuardCalls = 0;
    const duplicate = createPresentationToolLaunchSession({
      coordinator,
      source: { itemKey: "PAPER-A", libraryID: 1 },
      runGuard: () => {
        duplicateGuardCalls += 1;
        return createAllowedGuard();
      },
    });
    assert.deepEqual(await duplicate.requestAuthorization(), {
      allowed: false,
      reason: "already_active",
    });
    assert.equal(duplicateGuardCalls, 0);

    duplicate.finish();
    first.finish();
  });

  it("shares the three-task capacity limit with other presentation entries", async function () {
    const coordinator = new PresentationLaunchCoordinator();
    const active = ["PAPER-A", "PAPER-B", "PAPER-C"].map((itemKey) =>
      createPresentationToolLaunchSession({
        coordinator,
        source: { itemKey, libraryID: 1 },
        runGuard: () => createAllowedGuard(),
      }),
    );
    const activeResults = await Promise.all(
      active.map((session) => session.requestAuthorization()),
    );
    assert.isTrue(activeResults.every((result) => result.allowed));

    let capacityWarnings = 0;
    const fourth = createPresentationToolLaunchSession({
      coordinator,
      source: { itemKey: "PAPER-D", libraryID: 1 },
      runGuard: () => createAllowedGuard(),
      onCapacityExceeded: () => {
        capacityWarnings += 1;
      },
    });
    assert.deepEqual(await fourth.requestAuthorization(), {
      allowed: false,
      reason: "capacity_exceeded",
    });
    assert.equal(capacityWarnings, 1);

    fourth.finish();
    active.forEach((session) => session.finish());
  });

  it("binds and releases the ChatManager launch session on success", async function () {
    await runChatManagerBridgeLifecycle("success");
  });

  it("binds and releases the ChatManager launch session on provider error", async function () {
    await runChatManagerBridgeLifecycle("provider_error");
  });

  it("binds and releases the ChatManager launch session on abort", async function () {
    await runChatManagerBridgeLifecycle("abort");
  });

  it("creates a launcher without a current paper and preserves the explicit mention source", async function () {
    await runChatManagerBridgeLifecycle("success", {
      currentItem: false,
      content:
        "为 @[Mentioned paper](library:5,key:PAPER-B) 生成一份 10 页 PPT",
      expectedMentionSources: [
        { itemKey: "PAPER-B", libraryID: 5, title: "Mentioned paper" },
      ],
    });
  });

  it("recovers the mentioned paper for a short retry in the next turn", async function () {
    await runChatManagerBridgeLifecycle("success", {
      currentItem: false,
      content: "重试下",
      previousMessages: [
        {
          id: "previous-user",
          role: "user",
          content: "为 @[Mentioned paper](library:5,key:PAPER-B) 生成一份 PPT",
          timestamp: 1,
        },
      ],
      expectedMentionSources: [
        { itemKey: "PAPER-B", libraryID: 5, title: "Mentioned paper" },
      ],
    });
  });
});
