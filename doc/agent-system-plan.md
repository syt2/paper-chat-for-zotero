# Agent System Plan

## Goal

Evolve `paper-chat-for-zotero` from a chat-with-tools plugin into a turn-oriented agent runtime for Zotero research workflows.

The target system should support:

- structured execution plans
- tool scheduling and permission decisions
- source-grounded answers
- denial-aware replanning
- optional background work where it is actually useful
- eventual specialized delegation only after the single-agent runtime is mature

This document is the implementation plan and should be updated as work progresses.

## Current State

The current architecture already has several useful building blocks:

- session storage and message persistence
- tool-calling providers
- Zotero and PDF tools
- summary and memory extraction
- basic streaming tool-call visualization
- structured execution plans
- scheduler-level tool metadata and batching
- persisted approval state and approval UI strip

The main limitation is no longer runtime extraction. The remaining gaps are higher-level:

- plans are still mostly tool-step mirrors rather than user-task plans
- permission policy exists but is still mostly `auto_allow`
- answers can still lose source structure after multiple tool calls
- the product has very few genuine long-running workflows, so `TaskManager` should stay secondary until a real need appears

## Target Architecture

### Core Layers

1. `ChatManager`
   Owns session lifecycle, item selection, and UI callbacks.

2. `AgentRuntime`
   Owns a single turn execution loop, tool orchestration, and runtime state transitions.

3. `ExecutionPlan`
   Stores the current plan and step statuses for a single user turn.

4. `ToolScheduler`
   Runs tools serially or concurrently based on tool class and safety.

5. `ToolPermissionManager`
   Decides whether tools are auto-allowed, denied, or require approval.

6. `TaskManager`
   Persists long-running/background work when a workflow truly needs it.

7. `DelegationRuntime`
   Launches specialized workers only after the base runtime is stable and there is a concrete product need.

## Principles

- Preserve current behavior while extracting architecture.
- Prefer internal seams before UI changes.
- Keep all new layers serializable where possible.
- Avoid introducing multi-agent complexity before the single-agent runtime is strong.
- Treat plan state as first-class persisted data, not prompt text only.
- Prefer explicit tool inputs over hidden UI-driven state.
- Do not invent background-task machinery unless a real Zotero workflow needs it.

## Phases

## Phase 0: Stabilize Interfaces

Status: completed

Goals:

- introduce a tool permission interface with default `auto_allow`
- start extracting tool execution from `ChatManager`
- write down the runtime and migration plan

Delivered / planned work:

- `ToolPermissionManager` added with default auto-allow policy
- `AgentRuntime` extraction started
- this document added

## Phase 1: Extract `AgentRuntime`

Status: completed

Goals:

- move streaming and non-streaming tool loops out of `ChatManager`
- define runtime inputs, outputs, and callback surface
- make execution state explicit without changing user behavior

Concrete tasks:

1. Create `AgentRuntime` and move tool loop logic there.
2. Keep `ChatManager` as coordinator only.
3. Add runtime event primitives such as:
   - turn started
   - text delta
   - reasoning delta
   - tool started
   - tool completed
   - turn completed
   - turn failed
4. Preserve current UI updates through an adapter layer.

Exit criteria:

- `ChatManager` no longer directly owns the tool execution loop
- behavior remains equivalent for existing tool-calling chat

Delivered:

- streaming and non-streaming tool loops moved into `AgentRuntime`
- `ChatManager` now coordinates session setup, provider selection, and UI callbacks
- runtime lifecycle events exposed for:
  - turn started
  - text delta
  - reasoning delta
  - tool started
  - tool completed
  - turn completed
  - turn failed

## Phase 2: Introduce Structured Plans

Status: in progress

Goals:

- give each turn an explicit execution plan
- persist plan state for display and recovery
- allow the model to revise a plan after tool failures or denials
- make steps represent user-intent progress, not only raw tool calls

Data model:

- `ExecutionPlan`
- `ExecutionPlanStep`
- `PlanStatus`
- `StepStatus`

Minimum fields:

- plan id
- session id
- source message id
- summary
- steps
- created / updated timestamps
- active step id

Concrete tasks:

1. Add plan types to chat domain types.
2. Persist the current plan with the session or a dedicated table.
3. Expose plan updates to the UI.
4. Add a plan-aware prompt layer so the model can see current progress.

Exit criteria:

- a running turn has a visible structured plan
- tool results update step status instead of only appending message text
- denied or failed steps cause a visible plan revision path

## Phase 3: Add `ToolScheduler`

Status: in progress

Goals:

- decouple “tool requested” from “tool executed”
- support concurrent read-only tools
- centralize retries, failures, and progress updates

Tool classes:

- read
- network
- write
- memory
- high-cost

Concrete tasks:

1. Represent tool execution as structured objects instead of raw message text only.
2. Add concurrency-safe metadata to tools.
3. Run read-only tools concurrently where safe.
4. Keep write and stateful tools serial.

Exit criteria:

- tools run through one scheduler
- scheduler emits progress and result objects
- runtime can safely distinguish between read, network, write, memory, and high-cost execution paths

Delivered so far:

- introduced a minimal serial `ToolScheduler`
- moved permission decision and tool execution result shaping into scheduler
- preserved current behavior by keeping all tools `auto_allow`
- kept `ExecutionPlan` updates in `AgentRuntime` while switching execution to structured scheduler results
- refreshed the tool-calling system prompt on each runtime iteration with current execution plan state and recent tool results
- added a dedicated tool runtime metadata registry for execution class, target scope, mutation behavior, and future concurrency decisions
- scheduler now batches `parallel_safe` read-only tool calls and executes those batches concurrently while keeping serial tools ordered
- scheduler results now persist into session-level runtime state instead of existing only as rendered tool message text

## Phase 4: Upgrade Permissions

Status: in progress

Goals:

- move from `auto_allow` to real decisions without rewriting tool execution again
- support approval scopes and denial recovery

Policy capabilities:

- allow once
- allow for session
- allow always
- deny

Concrete tasks:

1. Extend `ToolPermissionManager` to maintain policy state.
2. Keep compact in-context approval UI instead of building heavyweight dialogs first.
3. Return structured denial results back into runtime.
4. Let the model continue planning after denial instead of failing the turn.
5. Move selected tool classes from `auto_allow` to real policy-driven behavior.

Exit criteria:

- at least write, memory, network, and high-cost tools can be configured independently

Delivered so far:

- `ToolPermissionManager` now supports internal `once`, `session`, and `always` policy state
- persistent policy entries are stored separately from the default descriptor table
- runtime still defaults to `auto_allow` unless explicit policy state is set
- added a pending approval interface so `ask` mode can pause tool execution and later be resumed by an external approval decision
- kept all current tool descriptors on `auto_allow`, so no new user-facing approval UI is required yet
- chat runtime now mirrors pending approval state onto the active session and emits approval lifecycle events for UI updates
- the top execution bar now switches to a compact permission approval strip with `once / session / always / deny` actions when a tool enters `ask`
- pending approval state is now persisted with the session and reconciled against live in-memory requests on load, so stale approval UI does not survive a runtime restart

## Phase 5: Strengthen Answer Grounding And Replanning

Status: in progress

Goals:

- make final answers reflect tool provenance more clearly
- make replanning after denial/failure part of normal turn execution
- reduce cases where the model loses structure after multiple tool calls

Concrete tasks:

1. Improve plan-step labeling so the UI reflects user-facing intent, not only tool names.
2. Strengthen denial-aware prompt instructions and runtime recovery paths.
3. Improve answer composition so citations / paper identities / note identities survive tool orchestration.
4. Decide whether tool results need explicit source-grouped rendering in the UI.

Delivered so far:

- execution plan state is persisted with the session
- scheduler results are stored as structured runtime state
- denial outcomes already feed back into the runtime as structured results
- final-answer prompt now defines a stable `<source-group ...>` markup for multi-source synthesis
- chat markdown rendering now turns `<source-group ...>` blocks into compact source-grouped evidence cards

Exit criteria:

- plan / tool / answer flow feels like one coherent agent turn rather than “chat plus raw tool traces”

## Phase 6: Selective `TaskManager` Adoption

Status: deferred unless concrete workflows emerge

Goals:

- use background tasks only for workflows that are genuinely long-running or batch-oriented
- avoid forcing ordinary paper chat into a task model

Candidate workflows:

- batch note generation
- batch tagging
- deep library search across many items
- pre-indexing or maintenance jobs

Concrete tasks:

1. Keep existing `TaskManager` and persistence schema available.
2. Wire in the first real background workflow only after validating that it cannot stay inside one turn.
3. Add minimal task UI only when an adopted workflow actually needs progress, cancel, or resume.

Exit criteria:

- at least one real workflow benefits from persisted background execution

## Phase 7: Add Specialized Delegation

Status: deferred

Goals:

- support specialized sub-agents only after the single-agent runtime is stable

Delegation candidates:

- literature search specialist
- note drafting specialist
- metadata cleanup specialist

Concrete tasks:

1. Add `delegate_to_agent` or equivalent runtime primitive.
2. Give child agents isolated context and constrained tool sets.
3. Merge child outputs back into parent plan and permission systems.

Exit criteria:

- child agents can be launched without bypassing plan, permission, or source-grounding rules

## Suggested Storage Changes

Near-term:

- store plan state in session metadata if keeping scope small

Medium-term:

- add dedicated tables for:
  - `execution_plans`
  - `execution_plan_steps`
  - `tasks`
  - `task_events`
    only if the single-session metadata model becomes a bottleneck

## UI Changes By Stage

Near-term:

- no major UI changes required
- keep existing chat renderer working through adapters

Mid-term:

- plan panel
- richer tool activity panel
- compact approval controls
- optional source-grouped answer rendering

Later:

- task list and task detail view for adopted background workflows
- child agent status and transcript view

## Immediate Next Steps

1. Make `ExecutionPlan` steps more user-task-oriented and less tool-name-oriented.
2. Upgrade selected permission classes from `auto_allow` to real policy-driven behavior, starting with `network`, `write`, `memory`, and `high_cost`.
3. Improve denial/failure replanning so the model revises the plan instead of repeating rejected calls.
4. Improve source-grounded answer composition and decide whether the UI needs explicit source-grouped rendering.
5. Revisit `TaskManager` only when a real background or batch workflow appears.
