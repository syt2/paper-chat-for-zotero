# Agent System Plan

## Goal

Evolve `paper-chat-for-zotero` from a chat-with-tools plugin into a task-oriented agent runtime for Zotero workflows.

The target system should support:

- structured execution plans
- resumable task state
- tool scheduling and permission decisions
- long-running/background work
- eventual multi-agent delegation

This document is the implementation plan and should be updated as work progresses.

## Current State

The current architecture already has several useful building blocks:

- session storage and message persistence
- tool-calling providers
- Zotero and PDF tools
- summary and memory extraction
- basic streaming tool-call visualization

The main limitation is that execution still lives inside `ChatManager` as a single tool-calling loop. That makes it hard to add planning, approvals, task resumption, and delegation without repeatedly reworking the same path.

## Target Architecture

### Core Layers

1. `ChatManager`
   Owns session lifecycle, item selection, and UI callbacks.

2. `AgentRuntime`
   Owns a single turn execution loop, tool orchestration, and runtime state transitions.

3. `ExecutionPlan`
   Stores the current plan and step statuses for a turn or long-running task.

4. `ToolScheduler`
   Runs tools serially or concurrently based on tool class and safety.

5. `ToolPermissionManager`
   Decides whether tools are auto-allowed, denied, or require approval.

6. `TaskManager`
   Persists long-running/background work and supports resume, cancel, and progress display.

7. `DelegationRuntime`
   Launches child agents or specialized workers after the base runtime is stable.

## Principles

- Preserve current behavior while extracting architecture.
- Prefer internal seams before UI changes.
- Keep all new layers serializable where possible.
- Avoid introducing multi-agent complexity before task/runtime foundations exist.
- Treat plan state as first-class persisted data, not prompt text only.

## Phases

## Phase 0: Stabilize Interfaces

Status: in progress

Goals:

- introduce a tool permission interface with default `auto_allow`
- start extracting tool execution from `ChatManager`
- write down the runtime and migration plan

Delivered / planned work:

- `ToolPermissionManager` added with default auto-allow policy
- `AgentRuntime` extraction started
- this document added

## Phase 1: Extract `AgentRuntime`

Status: next active phase

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

## Phase 2: Introduce Structured Plans

Goals:

- give each turn an explicit execution plan
- persist plan state for display and recovery
- allow the model to revise a plan after tool failures or denials

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

## Phase 3: Add `ToolScheduler`

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

## Phase 4: Upgrade Permissions

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
2. Add UI approval dialogs.
3. Return structured denial results back into runtime.
4. Let the model continue planning after denial instead of failing the turn.

Exit criteria:

- at least write, memory, network, and high-cost tools can be configured independently

## Phase 5: Add `TaskManager`

Goals:

- support long-running and background operations
- make execution resumable and cancellable

Candidate task types:

- multi-paper comparison
- batch tagging
- batch note generation
- deep library search
- memory extraction and maintenance

Concrete tasks:

1. Add task persistence schema.
2. Add task state machine.
3. Expose task progress in UI.
4. Support cancellation and recovery after restart.

Exit criteria:

- long-running work is no longer tied only to one assistant message

## Phase 6: Add Multi-Agent Delegation

Goals:

- support specialized agents once runtime, plan, permissions, and tasks are stable

Delegation candidates:

- literature search agent
- comparison agent
- note drafting agent
- metadata cleanup agent

Concrete tasks:

1. Add `delegate_to_agent` or equivalent runtime primitive.
2. Give child agents isolated context and constrained tool sets.
3. Merge child outputs back into parent plan/task state.

Exit criteria:

- child agents can be launched without bypassing task, permission, or plan systems

## Suggested Storage Changes

Near-term:

- store plan state in session metadata if keeping scope small

Medium-term:

- add dedicated tables for:
  - `execution_plans`
  - `execution_plan_steps`
  - `tasks`
  - `task_events`

## UI Changes By Stage

Near-term:

- no major UI changes required
- keep existing chat renderer working through adapters

Mid-term:

- plan panel
- tool activity panel
- permission dialog
- task list and task detail view

Later:

- child agent status and transcript view

## Immediate Next Steps

1. Complete `AgentRuntime` extraction.
2. Define `ExecutionPlan` types.
3. Decide whether plan persistence should start in session metadata or a dedicated table.
4. Add a minimal internal plan object even before UI display.
