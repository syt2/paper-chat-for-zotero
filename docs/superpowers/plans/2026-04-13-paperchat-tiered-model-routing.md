# PaperChat Tiered Model Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace PaperChat raw chat-model selection with stable `paperchat-mini / paperchat-pro / paperchat-plus` routing, add advanced per-tier manual overrides, persist per-session resolved models, and add same-tier dice reroute for transient failures.

**Architecture:** Add a focused PaperChat tier-routing module that owns pool derivation, sticky auto bindings, manual overrides, and repair logic. Keep `PaperChatProvider` responsible only for sending requests with a concrete model string, while `ChatManager` resolves and persists per-session model state before each request and handles hard/soft failure recovery. Extend preferences and chat UI so tier selection becomes the primary interaction and the advanced section exposes per-tier `Auto + all models` overrides.

**Tech Stack:** TypeScript, Zotero prefs, Zotero SQLite (`Zotero.DBConnection`), XUL/XHTML preferences UI, chat panel DOM rendering, Mocha/Chai tests via `zotero-plugin test`

---

## File structure

### New files
- Create: `src/modules/providers/paperchat-tier-routing.ts` — tier aliases, persistence shapes, auto/manual resolution, pool derivation, rebinding helpers, same-tier reroll helper
- Create: `test/paperchat-tier-routing.test.ts` — unit tests for tier derivation, sticky auto behavior, manual override fallback, and reroll logic

### Existing files to modify
- Modify: `src/types/chat.ts` — add session-scoped `selectedTier`, `resolvedModelId`, retry metadata for dice reroute if needed
- Modify: `src/types/provider.ts` — extend `PaperChatProviderConfig` with resolved-model override field or tier-state support if the provider must accept a concrete override
- Modify: `src/modules/chat/db/StorageDatabase.ts` — schema v5 migration adding `selected_tier` and `resolved_model_id` to `sessions`
- Modify: `src/modules/chat/SessionStorageService.ts` — persist/load new session model fields
- Modify: `src/modules/providers/PaperChatProvider.ts` — accept concrete model override from routing instead of always reading raw `defaultModel`
- Modify: `src/modules/providers/ProviderManager.ts` — stop defaulting PaperChat to raw concrete model semantics; keep provider config compatible with tier state
- Modify: `src/modules/preferences/ModelsFetcher.ts` — expose available chat models and ratios cleanly for tier routing
- Modify: `src/modules/preferences/PaperchatProviderUI.ts` — replace raw model dropdown with tier selector + advanced per-tier override dropdowns
- Modify: `src/modules/preferences/PreferencesManager.ts` — initialize/bind new PaperChat tier UI
- Modify: `typings/prefs.d.ts` — add pref keys for tier state
- Modify: `addon/content/preferences.xhtml` — add mini/pro/plus selector and advanced override controls
- Modify: `addon/locale/en-US/preferences.ftl` and `addon/locale/zh-CN/preferences.ftl` — add preference labels/help text
- Modify: `src/modules/auth/AuthManager.ts` — validate/repair tier state on periodic refresh instead of forcing `AUTO_MODEL_SMART`
- Modify: `src/modules/chat/ChatManager.ts` — resolve per-session model before send, persist session routing state, classify hard/soft failures, enable dice reroute
- Modify: `src/modules/ui/chat-panel/ChatPanelEvents.ts` — render tier selector text instead of raw model, switch current session tier from toolbar menu
- Modify: `src/modules/ui/chat-panel/MessageRenderer.ts` — render `🎲` action for rerollable soft-failure messages
- Modify: `src/modules/ui/chat-panel/types.ts` — extend panel context with reroll callback if needed
- Modify: `src/modules/ui/chat-panel/ChatPanelManager.ts` — wire reroll callback through panel context and keep message rendering consistent
- Modify: `addon/locale/en-US/addon.ftl` and `addon/locale/zh-CN/addon.ftl` — add chat tier labels, dice retry text, reroute notice text

### Tests / verification files
- Test: `test/paperchat-tier-routing.test.ts`
- Test: `test/startup.test.ts` (only if schema init coverage or boot behavior needs a regression guard)
- Test: `npm run build`
- Test: `npm run test`

---

### Task 1: Add tier types, pref shapes, and pure routing helpers

**Files:**
- Create: `src/modules/providers/paperchat-tier-routing.ts`
- Modify: `typings/prefs.d.ts`
- Test: `test/paperchat-tier-routing.test.ts`

- [ ] **Step 1: Write the failing routing tests**

```ts
import { assert } from "chai";
import {
  PAPERCHAT_TIERS,
  deriveTierPools,
  resolveTierModel,
  rerollTierModel,
  validateTierState,
  type PaperChatTierState,
} from "../src/modules/providers/paperchat-tier-routing";

describe("paperchat tier routing", function () {
  it("derives mini/pro/plus pools from ascending ratio order", function () {
    const pools = deriveTierPools(
      ["m1", "m2", "m3", "m4", "m5", "m6"],
      { m1: 1, m2: 2, m3: 3, m4: 4, m5: 5, m6: 6 },
    );

    assert.deepEqual(pools["paperchat-mini"], ["m1", "m2"]);
    assert.deepEqual(pools["paperchat-pro"], ["m3", "m4"]);
    assert.deepEqual(pools["paperchat-plus"], ["m5", "m6"]);
  });

  it("keeps existing auto bindings through boundary drift", function () {
    const state: PaperChatTierState = {
      selectedTier: "paperchat-pro",
      tiers: {
        "paperchat-mini": { mode: "auto", modelId: "m1" },
        "paperchat-pro": { mode: "auto", modelId: "m3" },
        "paperchat-plus": { mode: "auto", modelId: "m6" },
      },
    };

    const validated = validateTierState(
      state,
      ["m1", "m2", "m3", "m4", "m5", "m6", "m7"],
      { m1: 1, m2: 2, m3: 4, m4: 5, m5: 6, m6: 7, m7: 3 },
      () => "unused",
    );

    assert.equal(validated.tiers["paperchat-pro"].modelId, "m3");
  });

  it("falls back from manual to auto when the pinned model disappears", function () {
    const state: PaperChatTierState = {
      selectedTier: "paperchat-plus",
      tiers: {
        "paperchat-mini": { mode: "auto", modelId: "m1" },
        "paperchat-pro": { mode: "auto", modelId: "m3" },
        "paperchat-plus": { mode: "manual", modelId: "missing-model" },
      },
    };

    const validated = validateTierState(
      state,
      ["m1", "m2", "m3", "m4", "m5"],
      { m1: 1, m2: 2, m3: 3, m4: 4, m5: 5 },
      (candidates) => candidates[0],
    );

    assert.equal(validated.tiers["paperchat-plus"].mode, "auto");
    assert.equal(validated.tiers["paperchat-plus"].modelId, "m5");
  });

  it("rerolls within the same tier while excluding the current model", function () {
    const next = rerollTierModel(["m3", "m4", "m5"], "m4", (candidates) => candidates[0]);
    assert.equal(next, "m3");
  });

  it("resolves manual override before auto binding", function () {
    const state: PaperChatTierState = {
      selectedTier: "paperchat-mini",
      tiers: {
        "paperchat-mini": { mode: "manual", modelId: "manual-mini" },
        "paperchat-pro": { mode: "auto", modelId: "m3" },
        "paperchat-plus": { mode: "auto", modelId: "m5" },
      },
    };

    const resolved = resolveTierModel(
      state,
      "paperchat-mini",
      ["manual-mini", "m3", "m5"],
      { "manual-mini": 1, m3: 3, m5: 5 },
      (candidates) => candidates[0],
    );

    assert.equal(resolved.modelId, "manual-mini");
    assert.equal(resolved.state.tiers["paperchat-mini"].mode, "manual");
  });
});
```

- [ ] **Step 2: Run the new test file and verify it fails**

Run:
```bash
npm exec mocha --require ts-node/register test/paperchat-tier-routing.test.ts
```

Expected: FAIL with module-not-found / exported symbol errors for `paperchat-tier-routing`.

- [ ] **Step 3: Add pref-key declarations for tier state**

Add these entries in `typings/prefs.d.ts`:

```ts
"paperchatTierState": string;
"paperchatResolvedModel": string;
```

Keep `paperchatResolvedModel` only if you decide you need a lightweight current-session fallback pref; otherwise omit it and keep session state only in SQLite.

- [ ] **Step 4: Write the minimal routing module**

Create `src/modules/providers/paperchat-tier-routing.ts` with this initial implementation:

```ts
export const PAPERCHAT_TIERS = [
  "paperchat-mini",
  "paperchat-pro",
  "paperchat-plus",
] as const;

export type PaperChatTier = (typeof PAPERCHAT_TIERS)[number];
export type PaperChatTierMode = "auto" | "manual";

export interface PaperChatTierEntry {
  mode: PaperChatTierMode;
  modelId: string | null;
}

export interface PaperChatTierState {
  selectedTier: PaperChatTier;
  tiers: Record<PaperChatTier, PaperChatTierEntry>;
}

export type PaperChatTierPools = Record<PaperChatTier, string[]>;

function sortByRatio(models: string[], ratios: Record<string, number>): string[] {
  return [...models].sort((a, b) => {
    const ra = ratios[a];
    const rb = ratios[b];
    if (ra === undefined && rb === undefined) return a.localeCompare(b);
    if (ra === undefined) return 1;
    if (rb === undefined) return -1;
    return ra - rb;
  });
}

export function deriveTierPools(
  models: string[],
  ratios: Record<string, number>,
): PaperChatTierPools {
  const sorted = sortByRatio(models, ratios);
  if (sorted.length === 0) {
    return {
      "paperchat-mini": [],
      "paperchat-pro": [],
      "paperchat-plus": [],
    };
  }
  if (sorted.length === 1) {
    return {
      "paperchat-mini": [sorted[0]],
      "paperchat-pro": [sorted[0]],
      "paperchat-plus": [sorted[0]],
    };
  }
  if (sorted.length === 2) {
    return {
      "paperchat-mini": [sorted[0]],
      "paperchat-pro": [sorted[1]],
      "paperchat-plus": [sorted[1]],
    };
  }

  const base = Math.floor(sorted.length / 3);
  const remainder = sorted.length % 3;
  const firstSize = base + (remainder > 0 ? 1 : 0);
  const secondSize = base + (remainder > 1 ? 1 : 0);
  const mini = sorted.slice(0, firstSize);
  const pro = sorted.slice(firstSize, firstSize + secondSize);
  const plus = sorted.slice(firstSize + secondSize);

  return {
    "paperchat-mini": mini,
    "paperchat-pro": pro.length > 0 ? pro : [mini.at(-1)!],
    "paperchat-plus": plus.length > 0 ? plus : [sorted.at(-1)!],
  };
}

function defaultTierState(): PaperChatTierState {
  return {
    selectedTier: "paperchat-pro",
    tiers: {
      "paperchat-mini": { mode: "auto", modelId: null },
      "paperchat-pro": { mode: "auto", modelId: null },
      "paperchat-plus": { mode: "auto", modelId: null },
    },
  };
}

export function parseTierState(raw: string | undefined | null): PaperChatTierState {
  if (!raw) return defaultTierState();
  try {
    const parsed = JSON.parse(raw) as Partial<PaperChatTierState>;
    return {
      selectedTier: parsed.selectedTier ?? "paperchat-pro",
      tiers: {
        "paperchat-mini": parsed.tiers?.["paperchat-mini"] ?? { mode: "auto", modelId: null },
        "paperchat-pro": parsed.tiers?.["paperchat-pro"] ?? { mode: "auto", modelId: null },
        "paperchat-plus": parsed.tiers?.["paperchat-plus"] ?? { mode: "auto", modelId: null },
      },
    };
  } catch {
    return defaultTierState();
  }
}

export function rerollTierModel(
  candidates: string[],
  excludedModelId: string,
  pickRandom: (candidates: string[]) => string,
): string | null {
  const filtered = candidates.filter((candidate) => candidate !== excludedModelId);
  if (filtered.length === 0) return null;
  return pickRandom(filtered);
}

function ensureAutoBinding(
  entry: PaperChatTierEntry,
  pool: string[],
  pickRandom: (candidates: string[]) => string,
): PaperChatTierEntry {
  if (entry.mode === "manual") {
    return pool.includes(entry.modelId || "")
      ? entry
      : { mode: "auto", modelId: pool.length > 0 ? pickRandom(pool) : null };
  }
  if (entry.modelId && pool.length > 0) {
    return entry;
  }
  return { mode: "auto", modelId: pool.length > 0 ? pickRandom(pool) : null };
}

export function validateTierState(
  state: PaperChatTierState,
  models: string[],
  ratios: Record<string, number>,
  pickRandom: (candidates: string[]) => string,
): PaperChatTierState {
  const pools = deriveTierPools(models, ratios);
  return {
    selectedTier: state.selectedTier,
    tiers: {
      "paperchat-mini": ensureAutoBinding(state.tiers["paperchat-mini"], pools["paperchat-mini"], pickRandom),
      "paperchat-pro": ensureAutoBinding(state.tiers["paperchat-pro"], pools["paperchat-pro"], pickRandom),
      "paperchat-plus": ensureAutoBinding(state.tiers["paperchat-plus"], pools["paperchat-plus"], pickRandom),
    },
  };
}

export function resolveTierModel(
  state: PaperChatTierState,
  tier: PaperChatTier,
  models: string[],
  ratios: Record<string, number>,
  pickRandom: (candidates: string[]) => string,
): { state: PaperChatTierState; modelId: string | null; pools: PaperChatTierPools } {
  const nextState = validateTierState(state, models, ratios, pickRandom);
  const pools = deriveTierPools(models, ratios);
  return {
    state: nextState,
    modelId: nextState.tiers[tier].modelId,
    pools,
  };
}
```

- [ ] **Step 5: Run the routing tests and make them pass**

Run:
```bash
npm exec mocha --require ts-node/register test/paperchat-tier-routing.test.ts
```

Expected: PASS for all five tests.

- [ ] **Step 6: Commit the routing foundation**

```bash
git add typings/prefs.d.ts src/modules/providers/paperchat-tier-routing.ts test/paperchat-tier-routing.test.ts
git commit -m "feat: add paperchat tier routing primitives"
```

### Task 2: Persist selected tier and resolved model on sessions

**Files:**
- Modify: `src/types/chat.ts`
- Modify: `src/modules/chat/db/StorageDatabase.ts`
- Modify: `src/modules/chat/SessionStorageService.ts`
- Test: `test/paperchat-tier-routing.test.ts`

- [ ] **Step 1: Write the failing session persistence test**

Append this test to `test/paperchat-tier-routing.test.ts` using a mocked row transform helper you will expose from `SessionStorageService` or a small dedicated pure helper:

```ts
import { mapSessionRowToChatSession } from "../src/modules/chat/SessionStorageService";

it("maps selected tier and resolved model from sqlite rows", function () {
  const session = mapSessionRowToChatSession(
    {
      id: "s1",
      created_at: 1,
      updated_at: 2,
      last_active_item_key: null,
      last_active_item_keys: null,
      context_summary: null,
      context_state: null,
      memory_extracted_at: null,
      memory_extracted_msg_count: null,
      selected_tier: "paperchat-plus",
      resolved_model_id: "claude-opus-4-5-20251101",
    },
    [],
  );

  assert.equal(session.selectedTier, "paperchat-plus");
  assert.equal(session.resolvedModelId, "claude-opus-4-5-20251101");
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run:
```bash
npm exec mocha --require ts-node/register test/paperchat-tier-routing.test.ts
```

Expected: FAIL because `mapSessionRowToChatSession` and the new fields do not exist.

- [ ] **Step 3: Extend `ChatSession` with session routing fields**

Add these fields in `src/types/chat.ts`:

```ts
selectedTier?: "paperchat-mini" | "paperchat-pro" | "paperchat-plus";
resolvedModelId?: string;
lastRetryableUserMessageId?: string;
lastRetryableErrorMessageId?: string;
lastRetryableFailedModelId?: string;
```

Keep the retryable fields optional and session-scoped so dice reroute can locate the last failed exchange without inventing a new table.

- [ ] **Step 4: Add schema v5 migration for session model state**

In `src/modules/chat/db/StorageDatabase.ts`:

```ts
const SCHEMA_VERSION = 5;
```

Add columns to fresh schema creation:

```sql
selected_tier TEXT,
resolved_model_id TEXT
```

Add this migration and invoke it from `initSchemaVersion`:

```ts
if (currentVersion < 5) {
  await this.upgradeToV5(db);
}
```

```ts
private async upgradeToV5(db: ZoteroDBConnection): Promise<void> {
  ztoolkit.log("[StorageDatabase] Upgrading schema v4 → v5...");
  await db.queryAsync("ALTER TABLE sessions ADD COLUMN selected_tier TEXT");
  await db.queryAsync("ALTER TABLE sessions ADD COLUMN resolved_model_id TEXT");
  await db.queryAsync(
    "UPDATE schema_version SET version = ?, updated_at = ? WHERE id = 1",
    [5, Date.now()],
  );
}
```

Wrap each `ALTER TABLE` in a small helper if you need duplicate-column protection during dev reruns.

- [ ] **Step 5: Persist and load the new session fields**

Update `SessionStorageService.ts` inserts / updates / loads with these exact values:

```ts
selected_tier = session.selectedTier || null,
resolved_model_id = session.resolvedModelId || null,
```

And when loading:

```ts
selectedTier: row.selected_tier || undefined,
resolvedModelId: row.resolved_model_id || undefined,
```

Add a small pure export near the loader to support the test:

```ts
export function mapSessionRowToChatSession(row: any, messages: ChatMessage[]): ChatSession {
  return {
    id: row.id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastActiveItemKey: row.last_active_item_key || null,
    lastActiveItemKeys: row.last_active_item_keys ? JSON.parse(row.last_active_item_keys) : undefined,
    messages: filterValidMessages(messages),
    contextSummary: row.context_summary ? JSON.parse(row.context_summary) : undefined,
    contextState: row.context_state ? JSON.parse(row.context_state) : undefined,
    memoryExtractedAt: row.memory_extracted_at != null ? (row.memory_extracted_at as number) : undefined,
    memoryExtractedMsgCount: row.memory_extracted_msg_count != null ? (row.memory_extracted_msg_count as number) : undefined,
    selectedTier: row.selected_tier || undefined,
    resolvedModelId: row.resolved_model_id || undefined,
  };
}
```

- [ ] **Step 6: Run the routing test file and verify it passes**

Run:
```bash
npm exec mocha --require ts-node/register test/paperchat-tier-routing.test.ts
```

Expected: PASS including the SQLite row mapping test.

- [ ] **Step 7: Commit the session persistence changes**

```bash
git add src/types/chat.ts src/modules/chat/db/StorageDatabase.ts src/modules/chat/SessionStorageService.ts test/paperchat-tier-routing.test.ts
git commit -m "feat: persist paperchat session routing state"
```

### Task 3: Add persisted global tier state and PaperChat settings UI

**Files:**
- Modify: `src/modules/preferences/ModelsFetcher.ts`
- Modify: `src/modules/preferences/PaperchatProviderUI.ts`
- Modify: `src/modules/preferences/PreferencesManager.ts`
- Modify: `addon/content/preferences.xhtml`
- Modify: `addon/locale/en-US/preferences.ftl`
- Modify: `addon/locale/zh-CN/preferences.ftl`
- Modify: `typings/prefs.d.ts`
- Test: `test/paperchat-tier-routing.test.ts`

- [ ] **Step 1: Write the failing tier-state pref test**

Append this test to `test/paperchat-tier-routing.test.ts`:

```ts
import { parseTierState } from "../src/modules/providers/paperchat-tier-routing";

it("defaults to paperchat-pro with auto mini/pro/plus bindings", function () {
  const state = parseTierState(undefined);

  assert.equal(state.selectedTier, "paperchat-pro");
  assert.equal(state.tiers["paperchat-mini"].mode, "auto");
  assert.equal(state.tiers["paperchat-pro"].mode, "auto");
  assert.equal(state.tiers["paperchat-plus"].mode, "auto");
});
```

If this already passes from Task 1, proceed immediately to Step 2 and treat the test as coverage already in place.

- [ ] **Step 2: Add preference keys for tier state if still missing**

Ensure `typings/prefs.d.ts` contains:

```ts
"paperchatTierState": string;
```

Do not add separate pref keys per tier; keep one serialized state blob.

- [ ] **Step 3: Replace the PaperChat settings markup**

Update `addon/content/preferences.xhtml` so the primary selector becomes tier-based and the advanced section contains per-tier overrides:

```xml
<hbox align="center" style="margin-top: 16px; margin-bottom: 8px">
  <label
    for="pref-paperchat-tier"
    data-l10n-id="pref-paperchat-tier"
    style="width: 70px; text-align: right"
  ></label>
  <menulist
    id="pref-paperchat-tier"
    style="flex: 1; margin-left: 8px; min-width: 150px"
  >
    <menupopup id="pref-paperchat-tier-popup">
      <menuitem value="paperchat-mini" data-l10n-id="pref-paperchat-tier-mini"></menuitem>
      <menuitem value="paperchat-pro" data-l10n-id="pref-paperchat-tier-pro"></menuitem>
      <menuitem value="paperchat-plus" data-l10n-id="pref-paperchat-tier-plus"></menuitem>
    </menupopup>
  </menulist>
  <button
    id="pref-paperchat-refresh-models"
    data-l10n-id="pref-refresh-models"
    style="margin-left: 8px"
  ></button>
</hbox>
```

Add these advanced rows inside the existing `<html:details>`:

```xml
<hbox align="center" style="margin-bottom: 8px; margin-left: 12px">
  <label for="pref-paperchat-mini-model" data-l10n-id="pref-paperchat-mini-model" style="width: 70px; text-align: right"></label>
  <menulist id="pref-paperchat-mini-model" style="flex: 1; margin-left: 8px; min-width: 180px">
    <menupopup id="pref-paperchat-mini-model-popup"></menupopup>
  </menulist>
</hbox>
<hbox align="center" style="margin-bottom: 8px; margin-left: 12px">
  <label for="pref-paperchat-pro-model" data-l10n-id="pref-paperchat-pro-model" style="width: 70px; text-align: right"></label>
  <menulist id="pref-paperchat-pro-model" style="flex: 1; margin-left: 8px; min-width: 180px">
    <menupopup id="pref-paperchat-pro-model-popup"></menupopup>
  </menulist>
</hbox>
<hbox align="center" style="margin-bottom: 8px; margin-left: 12px">
  <label for="pref-paperchat-plus-model" data-l10n-id="pref-paperchat-plus-model" style="width: 70px; text-align: right"></label>
  <menulist id="pref-paperchat-plus-model" style="flex: 1; margin-left: 8px; min-width: 180px">
    <menupopup id="pref-paperchat-plus-model-popup"></menupopup>
  </menulist>
</hbox>
```

- [ ] **Step 4: Add locale strings for the new controls**

Add these keys to `addon/locale/en-US/preferences.ftl` and mirror them in `addon/locale/zh-CN/preferences.ftl`:

```ftl
pref-paperchat-tier = Tier
pref-paperchat-tier-mini = Mini
pref-paperchat-tier-pro = Pro
pref-paperchat-tier-plus = Plus
pref-paperchat-mini-model = Mini Model
pref-paperchat-pro-model = Pro Model
pref-paperchat-plus-model = Plus Model
pref-paperchat-model-auto = Auto
pref-paperchat-model-auto-desc = Follow automatic tier routing
```

Use natural Chinese translations in the zh-CN file instead of copying English text.

- [ ] **Step 5: Update `PaperchatProviderUI.ts` to populate/save tier state**

Add these helpers near the top of `PaperchatProviderUI.ts`:

```ts
import {
  PAPERCHAT_TIERS,
  parseTierState,
  type PaperChatTier,
  type PaperChatTierState,
} from "../providers/paperchat-tier-routing";

const TIER_MODEL_SELECTORS: Record<PaperChatTier, string> = {
  "paperchat-mini": "pref-paperchat-mini-model",
  "paperchat-pro": "pref-paperchat-pro-model",
  "paperchat-plus": "pref-paperchat-plus-model",
};

const TIER_MODEL_POPUPS: Record<PaperChatTier, string> = {
  "paperchat-mini": "pref-paperchat-mini-model-popup",
  "paperchat-pro": "pref-paperchat-pro-model-popup",
  "paperchat-plus": "pref-paperchat-plus-model-popup",
};

function loadTierState(): PaperChatTierState {
  return parseTierState(getPref("paperchatTierState") as string | undefined);
}

function saveTierState(state: PaperChatTierState): void {
  setPref("paperchatTierState", JSON.stringify(state));
}
```

Replace raw model dropdown population with tier-dropdown population and add a shared override popup renderer:

```ts
function populateTierOverridePopup(
  doc: Document,
  tier: PaperChatTier,
  models: string[],
  state: PaperChatTierState,
): void {
  const popup = doc.getElementById(TIER_MODEL_POPUPS[tier]);
  const select = doc.getElementById(TIER_MODEL_SELECTORS[tier]) as unknown as XULMenuListElement;
  if (!popup || !select) return;
  clearElement(popup);

  const autoItem = doc.createXULElement("menuitem");
  autoItem.setAttribute("label", getString("pref-paperchat-model-auto"));
  autoItem.setAttribute("value", "auto");
  popup.appendChild(autoItem);

  for (const model of models) {
    const item = doc.createXULElement("menuitem");
    item.setAttribute("label", formatModelLabel(model, "paperchat"));
    item.setAttribute("value", model);
    popup.appendChild(item);
  }

  const entry = state.tiers[tier];
  select.value = entry.mode === "manual" && entry.modelId ? entry.modelId : "auto";
}
```

Save state from UI like this:

```ts
export function savePaperchatConfig(doc: Document): void {
  const providerManager = getProviderManager();
  const tierSelect = doc.getElementById("pref-paperchat-tier") as unknown as XULMenuListElement;
  const maxTokensEl = doc.getElementById("pref-paperchat-maxtokens") as HTMLInputElement;
  const temperatureEl = doc.getElementById("pref-paperchat-temperature") as HTMLInputElement;
  const systemPromptEl = doc.getElementById("pref-paperchat-systemprompt") as HTMLTextAreaElement;

  const state = loadTierState();
  state.selectedTier = (tierSelect?.value || "paperchat-pro") as PaperChatTier;

  for (const tier of PAPERCHAT_TIERS) {
    const select = doc.getElementById(TIER_MODEL_SELECTORS[tier]) as unknown as XULMenuListElement;
    const value = select?.value || "auto";
    state.tiers[tier] = value === "auto"
      ? { mode: "auto", modelId: state.tiers[tier]?.modelId || null }
      : { mode: "manual", modelId: value };
  }

  saveTierState(state);
  providerManager.updateProviderConfig("paperchat", {
    maxTokens: parseInt(maxTokensEl?.value) || 4096,
    temperature: parseFloat(temperatureEl?.value) || 0.7,
    systemPrompt: systemPromptEl?.value || "",
  });
}
```

Do not keep writing `pref("model")` for PaperChat chat routing.

- [ ] **Step 6: Initialize and bind the new controls in `PreferencesManager.ts`**

Replace the old model initialization with tier initialization:

```ts
populatePaperchatModels(doc);
```

should stay as the entry point, but that function now populates tier and override controls instead of a raw chat-model dropdown.

Bind all four PaperChat selectors:

```ts
const ids = [
  "pref-paperchat-tier",
  "pref-paperchat-mini-model",
  "pref-paperchat-pro-model",
  "pref-paperchat-plus-model",
];
for (const id of ids) {
  const el = doc.getElementById(id) as unknown as XULMenuListElement | null;
  el?.addEventListener("command", () => savePaperchatConfig(doc));
}
```

- [ ] **Step 7: Run build and focused tests**

Run:
```bash
npm exec mocha --require ts-node/register test/paperchat-tier-routing.test.ts && npm run build
```

Expected: routing tests PASS, build succeeds.

- [ ] **Step 8: Commit the settings UI changes**

```bash
git add addon/content/preferences.xhtml addon/locale/en-US/preferences.ftl addon/locale/zh-CN/preferences.ftl src/modules/preferences/PaperchatProviderUI.ts src/modules/preferences/PreferencesManager.ts typings/prefs.d.ts src/modules/preferences/ModelsFetcher.ts
git commit -m "feat: add paperchat mini pro plus settings"
```

### Task 4: Resolve per-session models before PaperChat requests

**Files:**
- Modify: `src/modules/chat/ChatManager.ts`
- Modify: `src/modules/providers/PaperChatProvider.ts`
- Modify: `src/types/provider.ts`
- Test: `test/paperchat-tier-routing.test.ts`

- [ ] **Step 1: Write the failing resolution-flow test**

Append this pure helper test to `test/paperchat-tier-routing.test.ts` after adding an export from `ChatManager.ts` or a small helper module:

```ts
import { resolveSessionPaperChatModel } from "../src/modules/chat/ChatManager";

it("prefers the session resolved model while it remains available", function () {
  const result = resolveSessionPaperChatModel(
    {
      id: "s1",
      createdAt: 1,
      updatedAt: 1,
      lastActiveItemKey: null,
      messages: [],
      selectedTier: "paperchat-pro",
      resolvedModelId: "m3",
    },
    parseTierState(JSON.stringify({
      selectedTier: "paperchat-pro",
      tiers: {
        "paperchat-mini": { mode: "auto", modelId: "m1" },
        "paperchat-pro": { mode: "auto", modelId: "m4" },
        "paperchat-plus": { mode: "auto", modelId: "m6" },
      },
    })),
    ["m1", "m3", "m4", "m6"],
    { m1: 1, m3: 3, m4: 4, m6: 6 },
    (candidates) => candidates[0],
  );

  assert.equal(result.modelId, "m3");
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run:
```bash
npm exec mocha --require ts-node/register test/paperchat-tier-routing.test.ts
```

Expected: FAIL because `resolveSessionPaperChatModel` is missing.

- [ ] **Step 3: Extend PaperChat provider config with a resolved override**

Add this optional field to `PaperChatProviderConfig` in `src/types/provider.ts`:

```ts
resolvedModelOverride?: string;
```

Update `PaperChatProvider.createDelegateConfig()` so it prefers the override:

```ts
let model = this._config.resolvedModelOverride || this._config.defaultModel;
```

- [ ] **Step 4: Add a pure session-resolution helper to `ChatManager.ts`**

Add and export this helper near the top of `ChatManager.ts`:

```ts
import {
  parseTierState,
  resolveTierModel,
  type PaperChatTier,
  type PaperChatTierState,
} from "../providers/paperchat-tier-routing";

export function resolveSessionPaperChatModel(
  session: ChatSession,
  tierState: PaperChatTierState,
  availableModels: string[],
  ratios: Record<string, number>,
  pickRandom: (candidates: string[]) => string,
): { modelId: string | null; session: ChatSession; tierState: PaperChatTierState } {
  if (session.resolvedModelId && availableModels.includes(session.resolvedModelId)) {
    return { modelId: session.resolvedModelId, session, tierState };
  }

  const tier = (session.selectedTier || tierState.selectedTier || "paperchat-pro") as PaperChatTier;
  const resolved = resolveTierModel(tierState, tier, availableModels, ratios, pickRandom);
  return {
    modelId: resolved.modelId,
    session: {
      ...session,
      selectedTier: tier,
      resolvedModelId: resolved.modelId || undefined,
    },
    tierState: resolved.state,
  };
}
```

- [ ] **Step 5: Resolve and persist PaperChat session models before sending**

In `ChatManager.sendMessage(...)`, before the provider call block, add this PaperChat-only branch:

```ts
const providerManager = getProviderManager();
const activeProviderId = providerManager.getActiveProviderId();

if (activeProviderId === "paperchat") {
  const availableModels = await provider.getAvailableModels();
  const ratios = getModelRatios();
  const tierState = parseTierState(getPref("paperchatTierState") as string | undefined);
  const resolved = resolveSessionPaperChatModel(
    sendingSession,
    tierState,
    availableModels,
    ratios,
    (candidates) => candidates[Math.floor(Math.random() * candidates.length)],
  );

  this.currentSession = this.currentSession?.id === sendingSession.id ? resolved.session : this.currentSession;
  sendingSession.selectedTier = resolved.session.selectedTier;
  sendingSession.resolvedModelId = resolved.session.resolvedModelId;
  setPref("paperchatTierState", JSON.stringify(resolved.tierState));
  await this.sessionStorage.updateSessionMeta(sendingSession);
  provider.updateConfig({ resolvedModelOverride: resolved.modelId || undefined });
}
```

Do not apply this to non-PaperChat providers.

- [ ] **Step 6: Persist the chosen tier on new sessions**

In `createNewSession()` and/or `SessionStorageService.createSession()`, initialize new sessions like this:

```ts
const tierState = parseTierState(getPref("paperchatTierState") as string | undefined);
session.selectedTier = tierState.selectedTier;
```

Leave `resolvedModelId` empty until the first send or until you intentionally resolve on creation.

- [ ] **Step 7: Run build and the routing tests**

Run:
```bash
npm exec mocha --require ts-node/register test/paperchat-tier-routing.test.ts && npm run build
```

Expected: PASS.

- [ ] **Step 8: Commit the session-resolution integration**

```bash
git add src/types/provider.ts src/modules/providers/PaperChatProvider.ts src/modules/chat/ChatManager.ts test/paperchat-tier-routing.test.ts
git commit -m "feat: resolve paperchat tiers per session"
```

### Task 5: Repair tier state during model refresh and hard failures

**Files:**
- Modify: `src/modules/auth/AuthManager.ts`
- Modify: `src/modules/chat/ChatManager.ts`
- Modify: `src/modules/providers/paperchat-tier-routing.ts`
- Test: `test/paperchat-tier-routing.test.ts`

- [ ] **Step 1: Write the failing hard-failure classification test**

Append these tests:

```ts
import { isPaperChatModelHardFailure } from "../src/modules/chat/ChatManager";

it("classifies unsupported-model errors as hard failures", function () {
  assert.isTrue(isPaperChatModelHardFailure(new Error("API Error: 400 - model not found")));
  assert.isTrue(isPaperChatModelHardFailure(new Error("API Error: 404 - unsupported model")));
  assert.isFalse(isPaperChatModelHardFailure(new Error("API Error: 429 - rate limit exceeded")));
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run:
```bash
npm exec mocha --require ts-node/register test/paperchat-tier-routing.test.ts
```

Expected: FAIL because `isPaperChatModelHardFailure` is missing.

- [ ] **Step 3: Add a hard-failure classifier**

Export this helper from `ChatManager.ts`:

```ts
export function isPaperChatModelHardFailure(error: Error): boolean {
  const message = error.message.toLowerCase();
  return message.includes("model not found") || message.includes("unsupported model");
}
```

- [ ] **Step 4: Repair tier state inside `AuthManager.fetchAndSetDefaultModel()`**

Replace the PaperChat raw-model-switching branch with tier-state repair:

```ts
const tierState = parseTierState(getPref("paperchatTierState") as string | undefined);
const repaired = validateTierState(
  tierState,
  chatModels,
  getModelRatios(),
  (candidates) => candidates[Math.floor(Math.random() * candidates.length)],
);
setPref("paperchatTierState", JSON.stringify(repaired));
providerManager.updateProviderConfig("paperchat", {
  availableModels: chatModels,
});
```

Delete the logic that force-switches `pref("model")` to `AUTO_MODEL_SMART`.

- [ ] **Step 5: Repair tier state on hard request failures**

In `ChatManager.sendMessage(...)`, inside the all-providers-failed `catch`, add a PaperChat-specific branch before inserting the final error message:

```ts
if (providerManager.getActiveProviderId() === "paperchat" && error instanceof Error && isPaperChatModelHardFailure(error)) {
  const availableModels = await provider.getAvailableModels();
  const tierState = parseTierState(getPref("paperchatTierState") as string | undefined);
  const repaired = resolveTierModel(
    validateTierState(tierState, availableModels, getModelRatios(), (candidates) => candidates[Math.floor(Math.random() * candidates.length)]),
    (sendingSession.selectedTier || tierState.selectedTier) as any,
    availableModels,
    getModelRatios(),
    (candidates) => candidates[Math.floor(Math.random() * candidates.length)],
  );
  setPref("paperchatTierState", JSON.stringify(repaired.state));
  sendingSession.resolvedModelId = repaired.modelId || undefined;
  await this.sessionStorage.updateSessionMeta(sendingSession);
}
```

This repairs session state before the user retries manually.

- [ ] **Step 6: Run build and tests**

Run:
```bash
npm exec mocha --require ts-node/register test/paperchat-tier-routing.test.ts && npm run build
```

Expected: PASS.

- [ ] **Step 7: Commit the repair logic**

```bash
git add src/modules/auth/AuthManager.ts src/modules/chat/ChatManager.ts src/modules/providers/paperchat-tier-routing.ts test/paperchat-tier-routing.test.ts
git commit -m "feat: repair paperchat tier state on invalid models"
```

### Task 6: Replace chat-panel model selector with mini/pro/plus session routing

**Files:**
- Modify: `src/modules/ui/chat-panel/ChatPanelEvents.ts`
- Modify: `addon/locale/en-US/addon.ftl`
- Modify: `addon/locale/zh-CN/addon.ftl`
- Test: `npm run build`

- [ ] **Step 1: Add the new chat-panel locale strings**

Add to `addon/locale/en-US/addon.ftl` and translate in `addon/locale/zh-CN/addon.ftl`:

```ftl
paperchat-chat-tier-mini = Mini
paperchat-chat-tier-pro = Pro
paperchat-chat-tier-plus = Plus
paperchat-chat-tier-auto-reroute = Auto tier routing
paperchat-chat-model-rerouted = Switched { $tier } from { $old } to { $new }
paperchat-chat-reroll-model = Try another same-tier model
```

- [ ] **Step 2: Update model-selector display text to use tier + resolved model**

Replace `updateModelSelectorDisplay(...)` in `ChatPanelEvents.ts` with:

```ts
export function updateModelSelectorDisplay(container: HTMLElement): void {
  const label = container.querySelector("#chat-model-selector-text") as HTMLElement | null;
  if (!label) return;

  const providerManager = getProviderManager();
  const activeProvider = providerManager.getActiveProvider();
  if (!activeProvider) {
    label.textContent = getString("chat-select-model");
    return;
  }

  if (providerManager.getActiveProviderId() !== "paperchat") {
    label.textContent = activeProvider.getName();
    return;
  }

  const tierState = parseTierState(getPref("paperchatTierState") as string | undefined);
  const chatManager = getChatManager();
  const session = chatManager.getActiveSession();
  const tier = session?.selectedTier || tierState.selectedTier;
  const resolved = session?.resolvedModelId;
  const tierLabelKey =
    tier === "paperchat-mini"
      ? "chat-tier-mini"
      : tier === "paperchat-plus"
        ? "chat-tier-plus"
        : "chat-tier-pro";

  label.textContent = resolved
    ? `PaperChat: ${getString(tierLabelKey)} · ${resolved}`
    : `PaperChat: ${getString(tierLabelKey)}`;
}
```

Adjust the `getString` keys to match the locale IDs you actually add.

- [ ] **Step 3: Replace the PaperChat dropdown options with tiers**

In `populateModelDropdown(...)`, replace the PaperChat-specific `AUTO_MODEL` / `AUTO_MODEL_SMART` block with this block:

```ts
if (config.id === "paperchat") {
  const tierState = parseTierState(getPref("paperchatTierState") as string | undefined);
  const tierOptions = [
    { value: "paperchat-mini", label: getString("chat-tier-mini") },
    { value: "paperchat-pro", label: getString("chat-tier-pro") },
    { value: "paperchat-plus", label: getString("chat-tier-plus") },
  ] as const;

  for (const opt of tierOptions) {
    const isSelected = isActiveProvider && tierState.selectedTier === opt.value;
    const item = createElement(doc, "div", {
      padding: "8px 12px",
      fontSize: "12px",
      color: isSelected ? theme.inputFocusBorderColor : theme.textPrimary,
      cursor: "pointer",
      background: isSelected ? theme.dropdownItemHoverBg : "transparent",
      display: "flex",
      alignItems: "center",
      gap: "8px",
    });
    const label = createElement(doc, "span", {});
    label.textContent = opt.label;
    item.appendChild(label);
    item.addEventListener("click", async () => {
      if (!isActiveProvider) providerManager.setActiveProvider(config.id);
      const state = parseTierState(getPref("paperchatTierState") as string | undefined);
      state.selectedTier = opt.value;
      setPref("paperchatTierState", JSON.stringify(state));
      const session = context.chatManager.getActiveSession();
      if (session) {
        session.selectedTier = opt.value;
        session.resolvedModelId = undefined;
      }
      updateModelSelectorDisplay(container);
      dropdown.style.display = "none";
      context.updateUserBar();
      context.renderMessages(context.chatManager.getMessages());
    });
    dropdown.appendChild(item);
  }
  continue;
}
```

When you wire this, use the actual `ChatManager` methods available; if there is no `getMessages()`, call only the existing render/update hooks you already have.

- [ ] **Step 4: Remove the PaperChat raw-model write path from chat-panel selection**

Delete the `setPref("model", ...)` and `providerManager.updateProviderConfig(config.id, { defaultModel: opt.value })` behavior from the PaperChat branch only. Keep raw model selection for non-PaperChat providers unchanged.

- [ ] **Step 5: Run build and verify the chat panel compiles**

Run:
```bash
npm run build
```

Expected: PASS.

- [ ] **Step 6: Commit the chat-panel tier selector**

```bash
git add src/modules/ui/chat-panel/ChatPanelEvents.ts addon/locale/en-US/addon.ftl addon/locale/zh-CN/addon.ftl
git commit -m "feat: switch paperchat chat selector to tiers"
```

### Task 7: Add soft-failure dice reroute in the chat UI

**Files:**
- Modify: `src/modules/chat/ChatManager.ts`
- Modify: `src/modules/ui/chat-panel/MessageRenderer.ts`
- Modify: `src/modules/ui/chat-panel/types.ts`
- Modify: `src/modules/ui/chat-panel/ChatPanelManager.ts`
- Modify: `addon/locale/en-US/addon.ftl`
- Modify: `addon/locale/zh-CN/addon.ftl`
- Test: `test/paperchat-tier-routing.test.ts`

- [ ] **Step 1: Write the failing reroll helper test**

Append this test:

```ts
it("returns null when no same-tier alternative exists", function () {
  const next = rerollTierModel(["m4"], "m4", (candidates) => candidates[0]);
  assert.isNull(next);
});
```

If this already passes from Task 1, treat it as covered and continue.

- [ ] **Step 2: Add retryable failure markers on the session during soft failures**

In `ChatManager.sendMessage(...)`, inside the all-providers-failed `catch`, after classifying the error as soft failure, set these fields before inserting the error message:

```ts
const softFailure = error instanceof Error && !isPaperChatModelHardFailure(error);
sendingSession.lastRetryableUserMessageId = softFailure ? userMessage.id : undefined;
sendingSession.lastRetryableErrorMessageId = softFailure ? errorMessage.id : undefined;
sendingSession.lastRetryableFailedModelId = softFailure ? sendingSession.resolvedModelId : undefined;
await this.sessionStorage.updateSessionMeta(sendingSession);
```

Move the `errorMessage` object construction above the metadata assignment so the IDs are available.

- [ ] **Step 3: Add a `rerollCurrentPaperChatTier` method to `ChatManager`**

Add this public method:

```ts
async rerollCurrentPaperChatTier(): Promise<{ previousModel: string; nextModel: string; tier: string } | null> {
  await this.init();
  const session = this.currentSession;
  if (!session || !session.selectedTier || !session.resolvedModelId) return null;

  const provider = this.getActiveProvider();
  if (!provider || getProviderManager().getActiveProviderId() !== "paperchat") return null;

  const availableModels = await provider.getAvailableModels();
  const pools = deriveTierPools(availableModels, getModelRatios());
  const nextModel = rerollTierModel(
    pools[session.selectedTier],
    session.resolvedModelId,
    (candidates) => candidates[Math.floor(Math.random() * candidates.length)],
  );
  if (!nextModel) return null;

  const previousModel = session.resolvedModelId;
  session.resolvedModelId = nextModel;
  await this.sessionStorage.updateSessionMeta(session);
  return { previousModel, nextModel, tier: session.selectedTier };
}
```

- [ ] **Step 4: Add a context callback for dice reroute**

Extend `ChatPanelContext` in `src/modules/ui/chat-panel/types.ts`:

```ts
rerollPaperChatTierForCurrentSession: () => Promise<{ previousModel: string; nextModel: string; tier: string } | null>;
```

Wire it in `ChatPanelManager.createContext(...)`:

```ts
rerollPaperChatTierForCurrentSession: async () => manager.rerollCurrentPaperChatTier(),
```

- [ ] **Step 5: Render the `🎲` button on retryable error bubbles**

In `MessageRenderer.ts`, add an optional message-action renderer for `error` messages. Use this button implementation:

```ts
function createRerollButton(
  doc: Document,
  theme: ThemeColors,
  onClick: () => void,
): HTMLElement {
  const btn = createElement(
    doc,
    "button",
    {
      position: "absolute",
      bottom: "4px",
      right: "36px",
      background: theme.copyBtnBg,
      border: "none",
      borderRadius: "4px",
      padding: "4px 8px",
      fontSize: "12px",
      cursor: "pointer",
      opacity: "0",
      transition: "opacity 0.2s",
    },
    { class: "reroll-btn", title: getString("chat-reroll-model") },
  );
  btn.textContent = "🎲";
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    e.preventDefault();
    onClick();
  });
  return btn;
}
```

Show it only when the message ID matches the session's `lastRetryableErrorMessageId` and the provider is PaperChat. Follow the same hover behavior as the copy button.

- [ ] **Step 6: Hook the reroll button to switch models and show a notice**

In the place where messages are rendered (via `ChatPanelManager` context), when the reroll callback succeeds, append a system notice using existing chat messaging flow or rerender after inserting a local notice with this content:

```ts
getString("chat-model-rerouted", {
  args: {
    tier: reroute.tier,
    old: reroute.previousModel,
    new: reroute.nextModel,
  },
});
```

Do not change global tier state here.

- [ ] **Step 7: Run build and tests**

Run:
```bash
npm exec mocha --require ts-node/register test/paperchat-tier-routing.test.ts && npm run build
```

Expected: PASS.

- [ ] **Step 8: Commit the dice reroute flow**

```bash
git add src/modules/chat/ChatManager.ts src/modules/ui/chat-panel/MessageRenderer.ts src/modules/ui/chat-panel/types.ts src/modules/ui/chat-panel/ChatPanelManager.ts addon/locale/en-US/addon.ftl addon/locale/zh-CN/addon.ftl test/paperchat-tier-routing.test.ts
git commit -m "feat: add same-tier dice reroute for paperchat"
```

### Task 8: End-to-end verification and cleanup

**Files:**
- Modify: any touched files from prior tasks if fixes are needed
- Test: `test/paperchat-tier-routing.test.ts`
- Test: `npm run build`
- Test: `npm run test`

- [ ] **Step 1: Run the focused routing test suite**

Run:
```bash
npm exec mocha --require ts-node/register test/paperchat-tier-routing.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run the existing test suite**

Run:
```bash
npm run test
```

Expected: PASS with existing startup / memory / web-search coverage still green.

- [ ] **Step 3: Run the full build**

Run:
```bash
npm run build
```

Expected: PASS with no TypeScript errors.

- [ ] **Step 4: Manually verify the PaperChat preferences UI**

Check these behaviors in Zotero preferences:

1. `Tier` selector shows Mini / Pro / Plus
2. Advanced section shows Mini Model / Pro Model / Plus Model dropdowns
3. Each override dropdown includes `Auto` plus current models
4. Selecting a manual model persists after reopening preferences
5. If a manually pinned model is removed from available models, the tier falls back to `Auto`

Expected: all five checks succeed.

- [ ] **Step 5: Manually verify the chat-panel routing UX**

Check these behaviors in the chat panel:

1. PaperChat selector shows Mini / Pro / Plus instead of raw models
2. New session inherits current global tier
3. Switching session preserves each session's resolved model
4. Switching tier updates the current session's resolved model
5. A transient failure shows an error plus `🎲`
6. Clicking `🎲` switches only the current session to another same-tier model

Expected: all six checks succeed.

- [ ] **Step 6: Commit final verification fixes**

```bash
git add src/types/chat.ts src/types/provider.ts src/modules/chat/db/StorageDatabase.ts src/modules/chat/SessionStorageService.ts src/modules/chat/ChatManager.ts src/modules/providers/paperchat-tier-routing.ts src/modules/providers/PaperChatProvider.ts src/modules/providers/ProviderManager.ts src/modules/preferences/ModelsFetcher.ts src/modules/preferences/PaperchatProviderUI.ts src/modules/preferences/PreferencesManager.ts src/modules/ui/chat-panel/types.ts src/modules/ui/chat-panel/ChatPanelManager.ts src/modules/ui/chat-panel/ChatPanelEvents.ts src/modules/ui/chat-panel/MessageRenderer.ts addon/content/preferences.xhtml addon/locale/en-US/preferences.ftl addon/locale/zh-CN/preferences.ftl addon/locale/en-US/addon.ftl addon/locale/zh-CN/addon.ftl test/paperchat-tier-routing.test.ts
git commit -m "feat: ship paperchat tiered model routing"
```

---

## Self-review

### Spec coverage
- Tier rename to `paperchat-mini / pro / plus`: covered in Tasks 1, 3, and 6
- Sticky auto bindings and manual overrides: covered in Tasks 1, 3, and 5
- Session snapshot persistence: covered in Tasks 2 and 4
- Soft-failure dice retry: covered in Task 7
- Refresh-time repair behavior: covered in Task 5
- Preferences advanced per-tier dropdowns: covered in Task 3

### Placeholder scan
- No `TODO`, `TBD`, or “write tests later” placeholders remain.
- Every code-changing task contains concrete code snippets, commands, and target files.

### Type consistency
- Tier names are consistently `paperchat-mini`, `paperchat-pro`, `paperchat-plus`
- Global tier state key is consistently `paperchatTierState`
- Session fields are consistently `selectedTier` and `resolvedModelId`

