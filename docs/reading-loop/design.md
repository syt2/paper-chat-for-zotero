# PaperChat Reading Loop Design

## Goal

Make PaperChat feel present while the user reads in Zotero, without interrupting
the reading flow.

The product loop is:

1. Observe lightweight reading signals.
2. Derive one high-confidence suggestion.
3. Show only a tiny state indicator on the existing PaperChat entry icon.
4. When the user opens PaperChat, show one suggestion strip under the panel
   header.
5. Execute only after the user confirms.
6. Write results back to PaperChat, Zotero notes, tags, or memory when allowed.

## Non-Goals

- Do not auto-open the PaperChat panel.
- Do not show suggestion strips while the PaperChat panel is closed.
- Do not add floating cards inside the PDF reading surface.
- Do not change the existing click behavior of the PaperChat entry icon.
- Do not automatically write notes, tags, collections, or items without user
  confirmation.
- Do not show multiple stacked suggestions in the first version.
- Do not run expensive AI tasks merely because the user opened or scrolled a
  paper.

## UX Contract

### Preference Switch

Add a settings-page switch for the automatic reading suggestions.

Default:

```ts
readingLoopEnabled = true;
```

Suggested labels:

```text
中文：阅读时自动显示 PaperChat 建议
English: Show PaperChat suggestions while reading
```

Behavior:

- When enabled, Reading Loop may observe lightweight local reading signals and
  surface icon badges / panel suggestion strips.
- When disabled, Reading Loop should not create new automatic suggestions.
- When disabled, existing running tasks may continue unless the user cancels
  them.
- When disabled, existing pending suggestions should be hidden or expired.
- Manual PaperChat chat, right-click AI Summary, and explicit user-triggered
  actions remain available.

This switch controls automatic suggestion triggering only. It does not disable
PaperChat itself.

### Panel Closed

Only the existing PaperChat entry icon is visible.

The icon may show a tiny status badge:

- no badge: idle
- blue dot: suggestion available
- subtle progress ring: task running
- check badge: task completed and result is available
- orange dot: attention needed, failed, or waiting for confirmation

Hover may show a one-line tooltip preview:

```text
有 1 个阅读建议：整理刚才的高亮
```

Hover should not be the primary action surface. It should preview, not replace
the panel.

### Icon Click

Clicking the entry icon always keeps the existing behavior: open PaperChat.

If a suggestion exists, the panel opens normally and renders the suggestion
strip inside the panel.

### Panel Open

Render a single lightweight suggestion strip directly below the PaperChat
header.

Example layout:

```text
┌────────────────────────────┐
│ PaperChat        model ...  │
├────────────────────────────┤
│ ● 整理 4 条高亮为阅读笔记   执行 × │
├────────────────────────────┤
│                            │
│        chat messages        │
│                            │
├────────────────────────────┤
│ input...                   │
└────────────────────────────┘
```

Visual constraints:

- height: 32-40px
- one line only
- short label, preferably under 20 Chinese characters
- no markdown
- no paragraph explanation
- one primary action
- one dismiss action
- if multiple suggestions exist, show only the highest-priority one

Suggested text patterns:

```text
整理 4 条高亮为阅读笔记
解释当前选中文本
生成本次阅读 checkpoint
提取这篇的实验设置
```

When running:

```text
正在整理高亮...             处理中
```

When completed:

```text
已发送到 PaperChat          查看
```

## Product States

```ts
type ReadingLoopState =
  | "idle"
  | "suggested"
  | "running"
  | "completed"
  | "attention";
```

State meaning:

- `idle`: no visible suggestion.
- `suggested`: a suggestion is available and can be executed.
- `running`: an accepted suggestion is executing.
- `completed`: a result is ready to view.
- `attention`: the user needs to confirm, retry, or resolve a failed task.

State display:

| State       | Entry icon           | Panel strip                    |
| ----------- | -------------------- | ------------------------------ |
| `idle`      | no badge             | hidden                         |
| `suggested` | blue dot             | suggestion + execute + dismiss |
| `running`   | subtle progress ring | running label + processing     |
| `completed` | check badge          | sent/result label + view       |
| `attention` | orange dot           | attention label + action       |

## Suggestion Model

```ts
type ReadingSuggestionKind =
  | "explain_selection"
  | "save_selection_note"
  | "highlight_digest"
  | "explain_visual_context"
  | "explain_formula"
  | "trace_reference"
  | "reading_checkpoint"
  | "section_checkpoint"
  | "method_extraction"
  | "evidence_lookup"
  | "related_work_lookup"
  | "followup_questions";

interface ReadingSuggestion {
  id: string;
  kind: ReadingSuggestionKind;
  itemKey: string;
  title: string;
  reason: string;
  priority: number;
  status: ReadingLoopState;
  sourceEventIds: string[];
  createdAt: number;
  updatedAt: number;
  expiresAt?: number;
  dismissedUntil?: number;
  payload?: Record<string, unknown>;
}
```

Rules:

- At most one active visible suggestion per paper in MVP.
- Suggestions should expire when the underlying context becomes stale.
- Dismissal is scoped to the current paper by default.
- The strip title is user-facing; `reason` is for tooltip or debugging and
  should stay short.
- `payload` may contain selected text, annotation keys, page index, or target
  note key, but should not contain full PDF text unless execution has been
  accepted.

## Reading Events

Reading Loop should convert UI and task observations into explicit internal
events. These events are cheap to collect and should not call the model by
themselves.

```ts
type ReadingLoopEventType =
  | "reader_opened"
  | "reader_closed"
  | "reader_item_changed"
  | "reader_idle"
  | "reader_resumed"
  | "page_changed"
  | "page_dwelled"
  | "text_selected"
  | "selection_cleared"
  | "annotation_created"
  | "annotation_updated"
  | "annotation_selected"
  | "annotation_threshold_reached"
  | "panel_opened"
  | "panel_closed"
  | "suggestion_created"
  | "suggestion_dismissed"
  | "suggestion_accepted"
  | "suggestion_expired"
  | "task_started"
  | "task_completed"
  | "task_failed"
  | "result_viewed";

interface ReadingLoopEvent {
  id: string;
  type: ReadingLoopEventType;
  itemKey?: string;
  pageIndex?: number;
  createdAt: number;
  payload?: Record<string, unknown>;
}
```

## Trigger Behaviors

### Reader Lifecycle

| Behavior                                               | Event                 | Suggested Action                            | MVP   |
| ------------------------------------------------------ | --------------------- | ------------------------------------------- | ----- |
| User opens a PDF reader tab                            | `reader_opened`       | start passive observation window            | Yes   |
| Active reader item changes                             | `reader_item_changed` | reset per-paper visible suggestion state    | Yes   |
| User closes or leaves reader after meaningful activity | `reader_closed`       | suggest reading checkpoint                  | Yes   |
| User idles on the same paper                           | `reader_idle`         | allow checkpoint only after enough activity | Yes   |
| User resumes reading                                   | `reader_resumed`      | clear idle timers                           | Later |

Lifecycle triggers should not create AI suggestions immediately. They mostly
start, reset, or end observation windows.

### Page And Dwell Signals

| Behavior                               | Event          | Suggested Action                                                                  | MVP |
| -------------------------------------- | -------------- | --------------------------------------------------------------------------------- | --- |
| User changes pages                     | `page_changed` | update current page context                                                       | Yes |
| User stays on one page for N seconds   | `page_dwelled` | suggest explaining current page only if combined with selection or repeated dwell | Yes |
| User dwells near Methods/Results pages | `page_dwelled` | suggest extracting methods or experiments through selected text                   | Yes |

Page dwell is risky because it can feel speculative. It should require a
second signal before showing a badge.

### Text Selection

| Behavior                              | Event               | Suggested Action                     | MVP |
| ------------------------------------- | ------------------- | ------------------------------------ | --- |
| User selects meaningful text          | `text_selected`     | suggest explaining selection         | Yes |
| Selected text is short phrase or term | `text_selected`     | suggest definition / evidence lookup | Yes |
| Selected text is long paragraph       | `text_selected`     | suggest summarize or save as note    | Yes |
| Selected text looks like figure/table | `text_selected`     | suggest visual-context explanation   | Yes |
| Selected text looks like formula      | `text_selected`     | suggest formula explanation          | Yes |
| Selected text looks like citation     | `text_selected`     | suggest reference tracing            | Yes |
| Selection is cleared quickly          | `selection_cleared` | expire selection suggestion          | Yes |

Selection is the safest first trigger because it is already an intentional user
signal.

Suggested mapping:

- short selection, under about 120 chars:
  `explain_selection` or `evidence_lookup`
- medium selection:
  `explain_selection`
- long selection:
  `save_selection_note` or `explain_selection`
- figure/table/image references:
  `explain_visual_context`
- equations or mathematical symbols:
  `explain_formula`
- numeric or author-year citation references:
  `trace_reference`
- method, experiment, dataset, baseline, or hyperparameter text:
  `method_extraction`
- result, performance, evaluation, or conclusion text:
  `evidence_lookup`
- related-work phrasing or grouped citations:
  `related_work_lookup`

Strip examples:

```text
解释当前选中文本
查找这句话的全文证据
保存选中文本到笔记
```

### Annotation And Highlight Signals

| Behavior                          | Event                          | Suggested Action                         | MVP   |
| --------------------------------- | ------------------------------ | ---------------------------------------- | ----- |
| User creates a highlight          | `annotation_created`           | increment per-paper highlight counter    | Yes   |
| Paper opens with many highlights  | `paper_opened`                 | suggest highlight digest                 | Yes   |
| User edits an annotation comment  | `annotation_updated`           | update note-digest candidate context     | Later |
| User selects annotations          | `annotation_selected`          | suggest summarizing selected annotations | Later |
| Highlight count reaches threshold | `annotation_threshold_reached` | suggest highlight digest                 | Yes   |

Initial threshold:

- 3 highlights in the current paper during the current reading session
- or 5 total unsummarized highlights in the paper

Suggested strip:

```text
整理 4 条高亮为阅读笔记
```

The execute action can use existing annotation and note tools:

- read annotations
- summarize selected/recent highlights
- append to the dedicated `PaperChat Notes` child note

### Panel Signals

| Behavior              | Event                  | Suggested Action                                  | MVP |
| --------------------- | ---------------------- | ------------------------------------------------- | --- |
| PaperChat panel opens | `panel_opened`         | render current suggestion strip if any            | Yes |
| Panel closes          | `panel_closed`         | hide strip; keep icon badge if suggestion remains | Yes |
| User dismisses strip  | `suggestion_dismissed` | silence same suggestion for this paper            | Yes |
| User accepts strip    | `suggestion_accepted`  | start task                                        | Yes |

Panel events should not create suggestions on their own. They only expose or
act on suggestions generated by reading events.

### Reading Progress Signals

| Behavior                          | Event                  | Suggested Action                    | MVP |
| --------------------------------- | ---------------------- | ----------------------------------- | --- |
| User stays on a paper for a while | `reading_dwell`        | suggest reading checkpoint          | Yes |
| Reader crosses a progress bucket  | `reader_progress_tick` | suggest section/progress checkpoint | Yes |
| Reader is near the end            | `reader_progress_tick` | suggest paper-level checkpoint      | Yes |

These are heuristic and lower priority than selection, highlight, and attention
states. They should never auto-open PaperChat.

### Chat Signals

| Behavior                         | Event                | Suggested Action                  | MVP |
| -------------------------------- | -------------------- | --------------------------------- | --- |
| User asks repeated questions     | `chat_question_sent` | suggest organizing a reading path | Yes |
| Message contains confusion terms | `chat_question_sent` | count toward follow-up threshold  | Yes |
| One-off normal chat message      | `chat_message_sent`  | no suggestion                     | Yes |

The first implementation uses a local heuristic: three question/confusion
signals in ten minutes for the current paper.

### Task Signals

| Behavior                   | Event            | Suggested Action                                | MVP |
| -------------------------- | ---------------- | ----------------------------------------------- | --- |
| Accepted suggestion starts | `task_started`   | icon shows progress ring                        | Yes |
| Task completes             | `task_completed` | icon shows check badge; strip shows view action | Yes |
| Task fails                 | `task_failed`    | icon shows orange dot; strip shows retry/detail | Yes |
| User views result          | `result_viewed`  | clear completion badge                          | Yes |

## MVP Trigger Set

The first implementation should include only these suggestion sources:

1. Text selection
   - event: `text_selected`
   - suggestion: `explain_selection`
   - expires when selection clears or reader item changes

2. Highlight threshold
   - events: `annotation_created`, `annotation_threshold_reached`
   - suggestion: `highlight_digest`
   - action: summarize recent highlights and append to `PaperChat Notes`

3. Existing highlight threshold on paper open
   - events: `paper_opened`
   - suggestion: `highlight_digest`
   - action: summarize existing highlights and append to `PaperChat Notes`

4. Special selection patterns
   - events: `text_selected`
   - suggestions: `explain_visual_context`, `explain_formula`,
     `trace_reference`, `method_extraction`, `evidence_lookup`,
     `related_work_lookup`
   - action: explain or route the selected figure/table/formula/citation/method/evidence/related-work context

5. Reading progress
   - events: `reading_dwell`, `reader_progress_tick`, `page_dwelled`,
     `reader_closed`
   - suggestions: `section_checkpoint`, `reading_checkpoint`
   - action: generate a concise checkpoint for the current reading position

6. Repeated questions
   - events: `chat_question_sent`
   - suggestion: `followup_questions`
   - action: organize recent questions into a reading route

7. Completed task result
   - events: `task_completed`, `result_viewed`
   - suggestion state: `completed`
   - action: view result in PaperChat or Zotero note

Reading checkpoint and page dwell suggestions are lower-priority and throttled.
They should never auto-open PaperChat.

## Priority Rules

When multiple suggestions exist, show the highest-priority suggestion only.

Initial priority:

1. `attention`: failed or needs confirmation
2. `completed`: result available
3. `running`: active task
4. special `text_selected`: figure/table, formula, reference
5. generic `text_selected`: current selection
6. `followup_questions`: repeated confusion/questions
7. `highlight_digest`: accumulated highlights
8. `section_checkpoint` / `reading_checkpoint`: progress and dwell suggestions

Tie breakers:

1. Current item beats background item.
2. Current selection beats older annotation suggestions.
3. Newer suggestion beats older suggestion.

## Rate Limits And Quieting

To keep the loop lightweight:

- no auto-open
- no PDF-surface card
- no more than one visible suggestion per paper
- no more than one new badge per paper every 5 minutes
- dismissing a suggestion silences the same kind for the current paper for at
  least 30 minutes
- dismissing two suggestions in one paper silences Reading Loop for that paper
  until the reader item changes or the app restarts
- if the user ignores the badge for several minutes, keep the badge but do not
  animate it

## Execution Policy

Suggestion creation should be cheap and mostly local.

If `readingLoopEnabled` is false:

- do not collect new Reading Loop events beyond the minimum needed to clear UI
  state
- do not create suggestions
- do not show entry icon badges from automatic suggestions
- do not render the suggestion strip

Allowed before user acceptance:

- observe reader item key
- observe selected text length and short preview
- count annotations or highlights
- read lightweight annotation metadata when already available locally

Not allowed before user acceptance:

- model calls
- web search
- full PDF extraction for speculative work
- writing notes, tags, collections, items, or memory

Allowed after user acceptance:

- call the selected provider
- read relevant PDF sections or annotations
- create or append Zotero notes
- update tags when the action explicitly says so
- save stable user preferences to memory when the user has opted into the
  action or the existing memory policy allows it

## Technical Design

### New Service

Add a `ReadingLoopService` later with these responsibilities:

- collect reading events
- maintain per-item suggestion state
- apply priority and quieting rules
- expose subscription callbacks for UI
- dispatch accepted suggestions to existing chat/task/tool paths

The service should not own chat rendering.

### UI Integration

Expected integration points:

- PaperChat entry icon:
  - render badge based on `ReadingLoopState`
  - keep existing click behavior
  - show optional tooltip preview on hover
- `ChatPanelManager`:
  - render one suggestion strip below the panel header
  - update strip when suggestion state changes
  - send accept/dismiss/view actions back to `ReadingLoopService`

### Existing Capabilities To Reuse

- `getActiveReaderItem()` from the chat panel layer
- `get_pdf_selection`
- `get_annotations`
- `create_note`
- `append_to_note`
- `TaskManager`
- `AgentRuntime` / existing tool loop for accepted AI tasks
- `MemoryService` only for explicit or policy-approved memory writes

## Open Questions

- Should hover tooltip be native Zotero tooltip only, or a custom preview?
- Should selection suggestions appear only in the panel strip, or should a
  separate mini toolbar be added later?
- Should highlight digest include all paper highlights or only highlights from
  the current reading session?
- Should completed results clear automatically after a timeout, or only after
  the user views them?
- Should `ReadingLoopService` persist suggestions across app restarts, or keep
  MVP state in memory only?
