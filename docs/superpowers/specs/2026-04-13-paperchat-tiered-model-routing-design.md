# PaperChat Tiered Model Routing Design

## Goal

Introduce a stable tier-based model-selection layer for the PaperChat backend so users choose a PaperChat routing tier instead of a raw model ID, while preserving consistent behavior inside each chat session and allowing advanced users to pin explicit models per tier.

## User-facing behavior

### Tier semantics
PaperChat exposes three logical chat tiers:

- `paperchat-mini`
- `paperchat-pro`
- `paperchat-plus`

These tiers are routing slots, not hard capability guarantees. By default they follow pricing-derived grouping, but advanced users may explicitly bind any available chat-capable model to any tier.

### Global tier configuration
Each tier has persisted global routing state:

- selected mode: `auto` or `manual`
- selected / bound concrete model ID

In `auto` mode, the tier has one persisted globally assigned concrete model ID:

- `mini -> modelA`
- `pro -> modelB`
- `plus -> modelC`

Auto bindings are sticky and do **not** change when ratio boundaries drift.

They only change when:

1. the bound model is no longer available in the PaperChat model list,
2. the backend rejects it as unsupported / not found, or
3. the user explicitly requests a manual refresh / reroll in the future.

In `manual` mode, the tier uses the user-selected concrete model directly. If that manual model later disappears, the tier automatically falls back to `auto` mode and rebinds from the current tier pool.

### New session behavior
When a new chat session is created:

1. inherit the current global tier selection,
2. resolve the current concrete model for that tier,
3. snapshot that concrete model into the session as `resolvedModelId`.

A new session does **not** randomly choose a different model if the tier already has a valid global resolution.

### Existing session behavior
Each session persists both:

- `selectedTier`
- `resolvedModelId`

Switching between session A and session B restores each session's own saved model snapshot. Session A does not drift because session B changed, and vice versa.

### Switching tier inside a session
When the user switches tier within the current session:

1. update `selectedTier`,
2. resolve the target tier's current global configuration,
3. set the session's `resolvedModelId` to that resolved model.

If the user later switches back to the original tier, the session uses that tier's current global resolution at that time.

## Tier pool derivation

### Inputs
Auto tier derivation uses:

- fetched PaperChat chat-capable models,
- fetched PaperChat pricing ratios,
- existing embedding filtering logic.

Only non-chat models are excluded. All chat-capable models may participate in tiering.

### Pool generation
When the system needs to assign or reassign an auto tier binding:

1. take all chat-capable models,
2. sort by ratio ascending,
3. split the list into three roughly equal pools:
   - low-cost third -> `mini`
   - middle third -> `pro`
   - high-cost third -> `plus`

This pool derivation is used only for choosing / replacing auto tier bindings. It does not continuously reclassify already-bound models.

### Boundary drift rule
An auto tier binding remains valid even if later model-list changes would place that model in a different third. Boundary drift alone is **not** a reason to rebind.

This favors stability over mathematically perfect tier boundaries.

### Small model-count fallback
If there are too few models for clean thirds:

- 1 model: all three tiers bind to the same model
- 2 models: `mini` uses the cheaper model, `plus` uses the more expensive model, `pro` also uses the more expensive model
- 3+ models: normal three-way partitioning

## Persistence design

### Global persistence
Persist PaperChat tier state separately from raw `pref("model")` values.

Global state must include:

- current selected global tier,
- each tier's routing mode,
- each tier's current concrete binding or manual selection,
- optionally cached tier pools / last derived metadata if helpful for debugging.

Suggested shape:

```ts
interface PaperChatTierState {
  selectedTier: "paperchat-mini" | "paperchat-pro" | "paperchat-plus";
  tiers: {
    "paperchat-mini": { mode: "auto" | "manual"; modelId: string | null };
    "paperchat-pro": { mode: "auto" | "manual"; modelId: string | null };
    "paperchat-plus": { mode: "auto" | "manual"; modelId: string | null };
  };
}
```

Semantics:

- `mode = "manual"`: `modelId` is the user-selected concrete model
- `mode = "auto"`: `modelId` is the current sticky auto binding for that tier

### Session persistence
Extend chat-session persistence with:

```ts
interface ChatSessionModelState {
  selectedTier?: "paperchat-mini" | "paperchat-pro" | "paperchat-plus";
  resolvedModelId?: string;
}
```

These values belong to the `sessions` table and the `ChatSession` type because they are session-scoped behavior, not message-scoped data.

## Resolution flow

### Resolving a tier
When resolving a tier for a new session or a tier switch:

1. load the tier config,
2. if the tier is in `manual` mode and its selected model is available, use it,
3. if the tier is in `manual` mode but its selected model is unavailable:
   - switch that tier back to `auto`,
   - derive the current pool,
   - choose a replacement auto binding,
   - persist the repaired tier state,
4. if the tier is already in `auto` mode and its bound model is valid, use it,
5. otherwise rebuild the pool, choose a replacement auto binding, and persist it.

### Before sending a request
For the active session:

1. read session `resolvedModelId`,
2. pre-check whether that model is present in the latest available PaperChat models list,
3. if yes, use it,
4. if not, resolve the session's tier using the global tier config,
5. update the session `resolvedModelId` with the repaired resolution if needed.

### During request failures
Use a mixed validation strategy:

1. **pre-check** against cached/refreshed `/models` list,
2. **runtime fallback** if the request still fails because the list was stale.

#### Hard failures
Treat these as model invalidation events:

- model missing from `/models`,
- explicit backend `model not found`,
- explicit backend `unsupported model`.

For hard failures:

1. invalidate the session model,
2. re-resolve the current tier using global tier config,
3. if necessary, repair the tier's auto binding or fall back from manual to auto,
4. persist repaired global state,
5. update the current session's `resolvedModelId`.

#### Soft failures
Treat these as transient failures:

- timeout,
- network error,
- HTTP 429,
- HTTP 5xx.

For soft failures:

1. retry the same model once,
2. if it still fails, show an error,
3. do **not** automatically modify the tier's global state.

This preserves stability and avoids global rebinding due to temporary outages.

## Retry UX

### Dice action
For soft-failure error messages, show a `🎲` action on the failed message.

When the user clicks it:

1. derive the current session tier pool,
2. exclude the currently failed `resolvedModelId`,
3. randomly choose another model from the same tier,
4. update only the current session's `resolvedModelId`,
5. retry the failed message.

### Dice scope
The `🎲` action affects only the current session.

It does **not** modify global tier state, because the failure may be transient and session-specific.

### Empty alternative pool
If no alternative exists in the current tier after excluding the failed model, the dice action should be disabled or report that no same-tier alternative is available.

### Visibility
After a successful dice reroute, the UI should make the model change visible, such as:

- lightweight notice in chat, or
- updated session model display.

Users should be able to understand that the retry succeeded because the session switched to another same-tier model.

## UI changes

### Tier selector
PaperChat model selection UI should shift from raw model IDs to tier-first behavior:

- expose `mini / pro / plus` as the primary selection,
- keep the current selected global tier persisted.

### Advanced tier override controls
In the PaperChat settings page advanced section, add three per-tier dropdowns:

- Mini model
- Pro model
- Plus model

Each dropdown contains:

- `Auto`
- all current chat-capable models

Default is `Auto` for all three tiers.

Behavior:

- `Auto` means the tier uses sticky auto-binding from its pricing-derived pool
- choosing a concrete model switches that tier into `manual` mode
- users may choose any available chat-capable model for any tier, even if it does not match the tier's pricing band
- if a manually selected model later disappears, that tier automatically falls back to `Auto`

### Session model visibility
The chat UI should have a lightweight way to reveal the session's actual concrete model, at least for troubleshooting and expectation-setting.

### Error message actions
Assistant error bubbles should support a retry affordance for soft failures, with the `🎲` control rendered on the message.

## Code structure recommendation

### New tier-routing module
Add a focused PaperChat routing module responsible for:

- deriving tier pools from models + ratios,
- validating / repairing auto bindings,
- resolving manual overrides,
- selecting replacement auto bindings,
- resolving session model choice,
- supporting same-tier reroll for the dice action.

This logic should not be spread across UI code, provider code, and auth refresh code.

### Provider boundary
`PaperChatProvider` should continue to receive one resolved concrete model string for actual API calls.

Tier logic should happen before request construction, not inside low-level OpenAI-compatible request assembly.

### Session boundary
`ChatManager` should own session-level model decisions because it already owns:

- current session lifecycle,
- sending flow,
- retry/error handling,
- session persistence.

### Auth / model refresh boundary
`AuthManager` should keep refreshing the PaperChat model list, but it should stop force-resetting the PaperChat chat model to `auto-smart` when the model disappears. Instead, tier-routing logic should validate and repair tier state.

## Data model changes

### `src/types/chat.ts`
Extend `ChatSession` with tier-routing session state.

### `src/modules/chat/db/StorageDatabase.ts`
Add new columns to `sessions` for:

- `selected_tier`
- `resolved_model_id`

and bump schema version with a forward migration.

### preferences / global settings
Add persisted PaperChat tier state, likely via prefs or existing provider settings storage, using a single serialized structure.

## Testing plan

Add tests for:

1. deriving tier pools from ratio-sorted model lists,
2. small model-count edge cases,
3. sticky auto binding that survives boundary drift,
4. rebinding only on hard invalidation,
5. manual override taking precedence over auto binding,
6. manual tier fallback to auto when the pinned model disappears,
7. new session inheriting the current global tier,
8. session snapshot stability across session switching,
9. switching tier updates session `resolvedModelId` from current global tier resolution,
10. pre-check fallback when session model disappears,
11. runtime fallback on `model not found`,
12. soft-failure retry-once behavior,
13. dice reroll excluding the current failed model,
14. dice reroll affecting only the current session.

## Implementation plan

1. **Introduce tier types and routing module**
   - add `paperchat-mini / pro / plus` aliases and persistence shape,
   - implement pool derivation, manual override resolution, and auto-binding validation helpers.

2. **Persist session model state**
   - extend `ChatSession`,
   - add SQLite migration for `selected_tier` and `resolved_model_id`,
   - load/save these fields in `SessionStorageService`.

3. **Replace raw PaperChat model preference path with tier selection**
   - update PaperChat preferences UI to select `mini / pro / plus`,
   - add advanced per-tier dropdowns with `Auto + all current models`,
   - persist global tier state,
   - stop depending on raw `pref("model")` for PaperChat chat routing.

4. **Integrate routing into `ChatManager` send flow**
   - resolve session model before send,
   - repair missing session models via global tier resolution,
   - handle hard-failure repair and soft-failure retry once.

5. **Add dice retry UX**
   - render retry action on soft-failure messages,
   - reroll from same-tier alternative pool,
   - retry failed send for current session only.

6. **Update refresh behavior**
   - keep model-list refresh in `AuthManager`,
   - remove PaperChat auto-smart reset behavior,
   - trigger tier-state validation instead.

7. **Add tests and verify behavior**
   - unit-test routing logic,
   - regression-test session persistence, manual override behavior, and fallback behavior.

## Open decisions intentionally deferred

These are intentionally out of scope for the first implementation:

- weighted random selection inside an auto tier,
- manual tier reroll UI outside the error-state dice action,
- advanced UI exposing raw model IDs in the primary chat selector,
- proactive background rebalance when better models appear.

The first version should optimize for clarity and stable behavior, not maximum routing sophistication.
