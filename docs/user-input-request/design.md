# PaperChat User Input Request Design

## Goal

Add a blocking user-input request capability for the agent.

When the model is uncertain, faces multiple valid paths, or needs an explicit
user decision before continuing, it can call a special tool that pauses the
current agent turn, asks the user a small structured question, waits for the
answer, then resumes the same task with the answer as tool result.

The intended product behavior is close to:

- Codex `request_user_input`: a model-callable tool that emits a client-side
  request, waits for an answer, then continues the turn.
- Claude Code permission / MCP elicitation flows: a pending UI request is
  rendered as an interactive decision surface and resolved through a structured
  response.

## Non-Goals

- Do not use this for automatic Reading Loop suggestions. Reading Loop should
  stay non-blocking.
- Do not ask the user when the model can make a reasonable reversible choice.
- Do not use this as a generic replacement for normal chat.
- Do not ask open-ended clarification questions for every minor ambiguity.
- Do not expose raw secret values in rendered chat history.
- Do not allow multiple simultaneous blocking requests in one session in the
  first implementation.

## Core Product Contract

The agent may ask only when the answer changes the next action materially.

Good cases:

- choosing between several analysis paths
- confirming ambiguous target paper / note / selection
- asking whether to continue after external search failures
- choosing output format when the user did not specify it and the task is broad
- confirming a write-like action when the existing approval system is not the
  right semantic fit

Bad cases:

- asking "should I continue?" after every normal step
- asking for information already present in the conversation
- asking about low-impact wording choices
- asking during passive reading suggestions
- asking repeatedly for the same unresolved choice

## Reference Notes

### Codex

Codex exposes `request_user_input` as a model-callable tool.

Observed shape:

```json
{
  "questions": [
    {
      "id": "confirm_path",
      "header": "Confirm",
      "question": "Proceed with the plan?",
      "options": [
        {
          "label": "Yes (Recommended)",
          "description": "Continue the current plan."
        },
        {
          "label": "No",
          "description": "Stop and revisit the approach."
        }
      ]
    }
  ],
  "autoResolutionMs": 60000
}
```

The app-server emits a `ToolRequestUserInput` server request. The client
responds with:

```json
{
  "answers": {
    "confirm_path": {
      "answers": ["yes"]
    }
  }
}
```

The turn emits a resolved notification before completion.

Important design points to borrow:

- tool call is explicit and model-initiated
- answer is structured by question id
- UI owns the interactive form
- runtime treats this as a turn pause, not a final assistant answer
- optional auto-resolution is part of the request

### Claude Code

Claude Code has two relevant patterns:

- remote permission control requests: pending request map, callback to UI,
  response sent back to the remote session
- MCP elicitation dialog: structured fields, select controls, text input,
  secret-like input behavior, accept / decline actions

Important design points to borrow:

- pending requests have stable ids
- cancellation is explicit
- unknown tools can still render a minimal request UI
- UI can render field types from a schema without hardcoding every case

## Proposed Tool

Expose one special tool:

```ts
type PaperToolName = ... | "request_user_input";
```

The tool should be available only in agent/tool-calling mode. It should not go
through normal tool permissions because its only side effect is asking the user.

### MVP Args

```ts
interface RequestUserInputArgs {
  reason?: string;
  questions: RequestUserInputQuestion[];
}

interface RequestUserInputQuestion {
  id: string;
  header: string;
  question: string;
  options: RequestUserInputOption[];
  allowOther?: boolean;
}

interface RequestUserInputOption {
  label: string;
  description: string;
  value?: string;
}
```

MVP constraints:

- exactly one question
- 2-4 options
- optional free-form "Other"
- no secret field
- no auto-resolution
- one pending request per session

### Full Args

The full protocol should extend the MVP shape instead of replacing it.

```ts
type RequestUserInputQuestionType =
  | "single_choice"
  | "multi_choice"
  | "text"
  | "secret"
  | "confirm";

interface RequestUserInputArgs {
  reason?: string;
  questions: RequestUserInputQuestion[];
  autoResolutionMs?: number;
}

interface RequestUserInputQuestion {
  id: string;
  header: string;
  question: string;
  type?: RequestUserInputQuestionType;
  options?: RequestUserInputOption[];
  allowOther?: boolean;
  required?: boolean;
  placeholder?: string;
  defaultValue?: string | string[] | boolean;
  minSelections?: number;
  maxSelections?: number;
  isSecret?: boolean;
}

interface RequestUserInputOption {
  label: string;
  description: string;
  value?: string;
  recommended?: boolean;
}

interface RequestUserInputResponse {
  answers: Record<string, RequestUserInputAnswer>;
}

interface RequestUserInputAnswer {
  answers: string[];
  other?: string;
  text?: string;
  secretRef?: string;
  autoResolved?: boolean;
  cancelled?: boolean;
}
```

Notes:

- `type` defaults to `single_choice` when `options` exists.
- `confirm` is equivalent to a two-option yes/no choice, but the UI can render
  it more compactly.
- `secret` answers should not be persisted in clear text.
- `autoResolutionMs` should require either a recommended option or a
  `defaultValue`.

## Tool Description For The Model

The tool prompt should tell the model:

- use this only when user choice materially changes the next action
- prefer 2-3 concrete options
- mark one option as recommended when possible
- do not ask if a reasonable default is safe
- do not ask about trivial formatting unless the task output depends on it
- do not request secrets unless the user explicitly asked to configure an
  integration that requires one
- use the same language as the user

Suggested description:

```text
Ask the user a blocking clarification or decision question and wait for their
answer before continuing. Use this only when multiple materially different next
steps are possible, required context is missing, or user confirmation is needed.
Prefer concrete options over free-form questions. Do not use this for minor
style choices or when a safe default is obvious.
```

## Runtime Flow

### MVP Flow

1. Model emits `request_user_input`.
2. Agent runtime detects the special tool before normal scheduler execution.
3. Runtime creates a pending request:

```ts
interface UserInputRequestState {
  pendingRequests: UserInputRequest[];
  updatedAt: number;
}

interface UserInputRequest {
  id: string;
  toolCallId: string;
  assistantMessageId: string;
  sessionId: string;
  status: "pending" | "resolved" | "cancelled" | "expired";
  reason?: string;
  questions: RequestUserInputQuestion[];
  createdAt: number;
  updatedAt: number;
  autoResolutionAt?: number;
}
```

4. Runtime renders the assistant message as still in progress.
5. UI shows the request card.
6. Runtime awaits an in-memory promise for the answer.
7. User answers.
8. Runtime synthesizes a `tool` message with `tool_call_id` equal to the
   original request tool call id.
9. Runtime continues the existing tool loop and asks the model to continue.

### Full Flow

Full implementation keeps the same flow but adds:

- multiple questions in one request
- field validation before resolve
- secret storage / redaction
- auto-resolution timer
- persisted pending state
- recovered UI after panel rerender

## Persistence Strategy

### MVP

Persist pending request metadata in `ChatSession.userInputRequestState` so the
UI can re-render while the current JS runtime is alive.

MVP can require the current in-memory turn to still exist for exact resume. If
Zotero reloads while a request is pending, mark the request as cancelled or
expired and show a recovery message.

This is acceptable for MVP because it validates the UX and protocol without a
large resumable-runtime refactor.

### Full

For exact resume after reload, the runtime needs a resumable turn state. That is
a bigger architectural change because the current loop keeps continuation state
in local variables.

Full persistence options:

1. pragmatic recovery:
   - persist pending request
   - after restart, user can answer
   - answer is sent as a normal user message referencing the request
   - previous assistant turn is marked interrupted

2. exact continuation:
   - persist enough runtime state to reconstruct the loop
   - assistant message id, tool call id, iteration, accumulated display,
     current model transcript, pending tool calls
   - on response, recreate the continuation and append the `tool` message

Recommendation:

- MVP: in-memory exact continuation.
- First full version: pragmatic recovery.
- Only implement exact continuation if this feature becomes central to long
  background tasks.

## UI Design

Use a compact inline card in the chat panel, visually related to the existing
approval banner but semantically separate.

Placement:

- inside the current assistant turn area or execution banner area
- above the input box if the assistant message is still streaming
- do not use a modal for MVP

MVP card:

```text
需要确认
你希望我优先分析哪一部分？

[Methods]  [Experiments]  [Other...]
```

Full card:

- one title row: header + pending indicator
- one form body with 1-N fields
- compact validation text below active field
- footer actions: `提交`, `取消`
- auto-resolution countdown if applicable

Interaction rules:

- selecting an option does not auto-submit when there are multiple questions
- single-question single-choice MVP may submit immediately after click
- Enter submits when valid
- Esc cancels only if focus is not inside text input
- pending request blocks sending a new user message by default
- user can still click cancel / stop

## Secret Input Rules

Secret input is high risk and should be handled conservatively.

Rules:

- never render the secret value after submission
- never include the raw value in visible assistant or user messages
- avoid storing raw value in SQLite
- if the model only needs confirmation, return a redacted marker
- if a later local action needs the secret, store it in a short-lived in-memory
  secret registry and return `secretRef`

Example answer:

```json
{
  "answers": {
    "api_key": {
      "secretRef": "secret:user-input:1730000000:abc",
      "answers": ["<secret provided>"]
    }
  }
}
```

The model should see enough to continue, but not the raw secret unless there is
a deliberate decision to expose it.

## Auto-Resolution

Auto-resolution is for non-blocking, low-risk choices where a default is safe.

Requirements:

- `autoResolutionMs` minimum: 10 seconds
- maximum: 4 minutes
- requires `recommended: true` or `defaultValue`
- UI must show countdown
- user action cancels the timer
- auto-resolved answer sets `autoResolved: true`

Do not auto-resolve:

- secret input
- write actions
- destructive choices
- ambiguous target paper or note
- anything involving irreversible library changes

## Agent Runtime Integration Points

Likely files:

- `src/types/tool.ts`
  - add args / response types
  - add tool name
- `src/types/chat.ts`
  - add `UserInputRequestState`
  - add runtime events:
    - `user_input_requested`
    - `user_input_resolved`
    - `user_input_cancelled`
- `src/modules/chat/pdf-tools/PdfToolManager.ts`
  - expose tool schema, or exclude execution because runtime intercepts it
- `src/modules/chat/agent-runtime/AgentRuntime.ts`
  - intercept `request_user_input`
  - create pending state
  - await response
  - synthesize tool result
  - continue the turn
- `src/modules/chat/SessionStorageService.ts`
  - persist request state
- `src/modules/ui/chat-panel/MessageRenderer.ts`
  - render request card / form
- `src/modules/ui/chat-panel/ChatPanelEvents.ts`
  - wire submit / cancel
- `addon/locale/*`
  - strings for UI labels

## Scheduling And Parallelism

`request_user_input` must be blocking.

Rules:

- never execute in parallel with other tool calls
- if a model emits it together with other tools, run earlier safe read tools
  only if they are already ordered before it; otherwise defer all later tools
- once a request is pending, no further tool execution starts until resolved
- repeated identical pending request in the same session should be ignored or
  converted into a clear tool error

Tool metadata:

```ts
{
  name: "request_user_input",
  executionClass: "interaction",
  concurrency: "exclusive",
  mutatesState: false,
  requiresActivePaper: false
}
```

If the existing metadata union does not support `interaction`, either add it or
model this as a special runtime-only tool.

## Error And Cancellation Semantics

Tool result examples:

User answered:

```json
{
  "status": "answered",
  "answers": {
    "scope": {
      "answers": ["methods"]
    }
  }
}
```

User cancelled:

```json
{
  "status": "cancelled",
  "reason": "user_cancelled"
}
```

Auto-resolved:

```json
{
  "status": "answered",
  "autoResolved": true,
  "answers": {
    "scope": {
      "answers": ["methods"],
      "autoResolved": true
    }
  }
}
```

The model should be instructed:

- if cancelled, continue with a safe default only if one is obvious
- otherwise explain what information is missing
- do not call `request_user_input` again with the same question immediately

## MVP Acceptance Criteria

- Model can call `request_user_input` with one single-choice question.
- Chat panel shows a compact choice card.
- User can answer by clicking one option.
- Runtime appends a valid tool result with the selected answer.
- Model continues the same assistant turn after the answer.
- Pending request is visible after chat panel rerender.
- User can cancel the request.
- Cancellation returns a structured tool result.
- New user message sending is blocked or clearly disabled while pending.
- TypeScript, lint, build pass.

## Full Acceptance Criteria

- Multiple questions render in one card.
- Supported field types:
  - single choice
  - multi choice
  - confirm
  - text
  - secret
- Required field validation works.
- `allowOther` works for choice questions.
- Secret input is masked and not persisted in clear text.
- Auto-resolution works with countdown and safe defaults.
- Pending state survives panel rerender.
- Restart recovery is at least graceful:
  - request does not silently hang forever
  - user sees expired / cancelled state
  - assistant turn is recoverable or clearly interrupted
- Runtime events appear in execution plan / debug context.
- Repeated same question is suppressed within one turn.

## Implementation Status

Current implementation supports the full interactive form surface for one
blocking request at a time:

- up to three questions per request
- single choice, multi choice, confirm, text, and secret fields
- required-field validation
- `allowOther` for choice questions
- optional `autoResolutionMs` with default/recommended-answer validation
- pending request persistence in `ChatSession.userInputRequestState`
- graceful stale-request cleanup after restart

Secret input is masked in the UI and converted to a `secretRef` in the tool
result. Raw secret text is not included in the tool result or persisted in chat
messages. A future secret registry can attach real secret values to these refs
when a local integration needs to consume them.

Exact model-call continuation after app restart is intentionally not included;
the current implementation clears stale pending state because the original
runtime promise cannot be reconstructed after process loss.

## Test Plan

Unit tests:

- args validation
- option normalization
- duplicate id rejection
- max questions / max options limits
- auto-resolution default requirements
- secret redaction
- cancel response formatting

Runtime tests:

- one question answered and turn continues
- cancel returns tool result and model continues
- pending request blocks later tools
- request plus parallel tools is ordered correctly
- request state clears after answer

UI tests:

- card renders below current assistant turn
- clicking option resolves
- cancel resolves
- text field validation
- secret field masking
- auto-resolution countdown

Manual Zotero acceptance:

- trigger from model prompt
- verify no duplicate normal user message is sent
- verify tool result is hidden or compact in visible transcript
- switch sessions while pending
- close and reopen panel while pending

## Open Questions

- Should user-input requests be allowed in normal chat mode, or only agent/tool
  mode?
- Should the input card live in the assistant message body or in the execution
  banner area?
- Should answering a pending request appear as a visible user bubble, or only as
  a compact tool-result history cell?
- Should secret input ever be passed raw to the model, or only through local
  secret references?
- Should restart recovery attempt exact continuation, or is graceful
  interruption enough?
