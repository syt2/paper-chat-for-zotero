# PaperChat Reading Loop Implementation Plan

## Scope

Implement the first Reading Loop MVP:

1. Settings switch, default on.
2. Entry icon status badge.
3. One suggestion strip below the PaperChat panel header.
4. Text-selection suggestion.
5. Highlight-threshold suggestion.
6. Accepted suggestion execution through existing PaperChat capabilities.

Out of scope for MVP:

- page dwell suggestions
- reader-close checkpoint suggestions
- related-work lookup suggestions
- persistent suggestion history across app restarts
- separate PDF-surface mini toolbar

## Preferences

Add a boolean preference:

```ts
readingLoopEnabled: boolean;
```

Default:

```ts
true;
```

Settings page:

- add a small `Reading Loop` section or place it near `AI Summary`
- label:
  - zh-CN: `阅读时自动显示 PaperChat 建议`
  - en-US: `Show PaperChat suggestions while reading`
- description:
  - zh-CN: `根据选中文本和高亮等本地阅读行为，在 PaperChat 入口和面板内显示轻量建议。`
  - en-US: `Shows lightweight suggestions in the PaperChat entry and panel based on local reading actions such as text selection and highlights.`

Implementation touchpoints:

- `addon/content/preferences.xhtml`
- `addon/locale/zh-CN/preferences.ftl`
- `addon/locale/en-US/preferences.ftl`
- preference typings under `typings/`
- preference initialization / binding code under `src/modules/preferences/`

When disabled:

- no new automatic suggestions are created
- icon badge from automatic suggestions is cleared
- suggestion strip is hidden
- manual chat and context-menu actions still work

## Types

Add Reading Loop domain types near chat UI or in a new module:

```ts
export type ReadingLoopState =
  | "idle"
  | "suggested"
  | "running"
  | "completed"
  | "attention";

export type ReadingSuggestionKind =
  | "explain_selection"
  | "save_selection_note"
  | "highlight_digest";

export interface ReadingSuggestion {
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
  payload?: Record<string, unknown>;
}
```

MVP can keep these in memory. Persistence can be added later if completed
results should survive app restart.

## Service

Create:

```text
src/modules/reading-loop/ReadingLoopService.ts
src/modules/reading-loop/index.ts
```

Responsibilities:

- read `readingLoopEnabled`
- track current reader item key
- accept lightweight events
- create, update, expire, dismiss, and prioritize suggestions
- notify UI subscribers
- expose accept/dismiss/view methods
- dispatch accepted tasks to existing chat / note functionality

Suggested service API:

```ts
interface ReadingLoopSnapshot {
  enabled: boolean;
  state: ReadingLoopState;
  activeSuggestion?: ReadingSuggestion;
}

type ReadingLoopListener = (snapshot: ReadingLoopSnapshot) => void;

class ReadingLoopService {
  init(): void;
  destroy(): void;
  subscribe(listener: ReadingLoopListener): () => void;
  getSnapshot(): ReadingLoopSnapshot;
  setCurrentItem(item: Zotero.Item | null): void;
  handleTextSelected(text: string): void;
  handleSelectionCleared(): void;
  handleAnnotationCreated(annotation?: Zotero.Item): void;
  acceptSuggestion(id: string): Promise<void>;
  dismissSuggestion(id: string): void;
  viewResult(id: string): void;
}
```

## Event Capture

### Current Item

Reuse:

```ts
getActiveReaderItem();
```

from the chat panel layer, or extract a small shared reader helper if import
direction becomes awkward.

On reader item changes:

- call `ReadingLoopService.setCurrentItem(item)`
- expire stale selection suggestions
- preserve completed state only if it belongs to the same item

### Text Selection

Preferred first implementation:

- use the existing `get_pdf_selection` capability when executing
- for suggestion creation, observe selection changes in the active reader iframe
  if available
- debounce selection changes by about 300ms
- ignore empty selections and very short noise

Rules:

- selection under 3 visible chars: ignore
- selection over a safe preview limit: store a preview only before acceptance
- selection cleared: expire selection-driven suggestions
- classify selected figure/table/image references as `explain_visual_context`
- classify selected formulas or math symbols as `explain_formula`
- classify selected numeric or author-year references as `trace_reference`

### Highlights

Use Zotero item notifier or reader annotation events where available.

Rules:

- increment per-item session highlight count on new highlight annotations
- create `highlight_digest` after 3 highlights in the current reading session
- create `highlight_digest` when opening a paper that already has 5 highlights
- do not run annotation summarization until accepted

### Reading Progress

Use reader polling only for low-priority, local signals:

- create `reading_checkpoint` after sustained dwell on the current paper
- create `section_checkpoint` when the reader crosses coarse progress buckets
- upgrade to `reading_checkpoint` near the end of the paper
- apply cooldown so progress suggestions do not repeatedly repaint the UI

### Chat Follow-Up

After a user message is accepted by `ChatManager`, count lightweight question or
confusion signals for the current paper:

- question marks and common Chinese/English confusion phrases count as signals
- three signals within ten minutes create `followup_questions`
- normal one-off messages do not create suggestions

## UI Integration

### Entry Icon Badge

Find existing toolbar / entry icon creation code and add a tiny badge element
inside the existing button.

State mapping:

- `idle`: no badge
- `suggested`: blue dot
- `running`: subtle progress ring
- `completed`: check badge
- `attention`: orange dot

Constraints:

- do not change click behavior
- badge must not affect layout size
- badge should be hidden when `readingLoopEnabled` is false
- hover tooltip can use the active suggestion title

### Suggestion Strip

Render below the PaperChat header in `ChatPanelManager` / chat panel UI code.

Strip states:

- suggested: title + execute + close
- running: running title + disabled processing label
- completed: sent/result title + view
- attention: error title + retry/detail

Rules:

- one strip maximum
- one line
- 32-40px height
- no markdown rendering
- hidden when panel is closed
- hidden when no active suggestion
- hidden when setting is off

## Execution

### `explain_selection`

Accept behavior:

1. Read current selection.
2. Open or focus PaperChat panel if needed.
3. Insert a user-visible prompt or start a chat turn:

```text
解释当前选中的文本，并结合这篇论文的上下文。
```

Implementation choice:

- simplest MVP: prefill chat input with the prompt and selected text
- stronger MVP: send the prompt automatically after user clicks `执行`

Because the user explicitly clicked `执行`, automatic send is acceptable.

### `highlight_digest`

Accept behavior:

1. Read recent/current paper annotations.
2. Summarize highlights.
3. Append result to the dedicated `PaperChat Notes` child note.
4. Show sent/completed state with `查看`; only claim a note was generated if a
   stronger write-success signal is available.

Reuse existing tools where possible:

- `get_annotations`
- `append_to_note`
- existing provider/tool loop

Writing to Zotero is allowed here because the strip action explicitly says it
will create/update a reading note.

### Specialized Selection Suggestions

`explain_visual_context`, `explain_formula`, and `trace_reference` reuse the same
execution path as `explain_selection`, but send a more specific prompt to
PaperChat.

### Checkpoint Suggestions

`section_checkpoint`, `reading_checkpoint`, and `followup_questions` send a
PaperChat prompt that summarizes local reading progress or recent questions.
They do not write to Zotero unless the resulting PaperChat turn explicitly asks
for a tool action and the existing permission flow allows it.

## Rate Limits

MVP limits:

- one active suggestion per item
- minimum 5 minutes between new badges for the same item and kind
- dismissing a suggestion silences the same kind for 30 minutes
- two dismisses in the same item silence Reading Loop for that item until item
  changes or app restarts

## Analytics

If analytics is enabled for this product area, add events later:

- `reading_loop_suggestion_created`
- `reading_loop_suggestion_dismissed`
- `reading_loop_suggestion_accepted`
- `reading_loop_task_completed`
- `reading_loop_disabled`

Do not include selected text, annotation text, PDF text, or paper title in
analytics payloads.

## Testing Checklist

Manual verification:

- default setting is enabled after install/update
- turning setting off hides badge and strip
- clicking PaperChat icon still opens the panel normally
- no suggestion strip appears while the panel is closed
- selecting text creates a blue badge
- selecting figure/table/formula/citation text creates a specialized suggestion
- opening panel shows the strip under the header
- hovering the toolbar entry with an active suggestion shows a tiny popover
- dismissing strip clears badge
- clearing selection expires selection suggestion
- creating enough highlights creates a digest suggestion
- opening a paper with enough existing highlights creates a digest suggestion
- sustained reading/progress creates checkpoint suggestions
- repeated questions create a follow-up reading-route suggestion
- accepting digest shows running state, then completed state
- completed result view clears check badge
- switching papers clears stale suggestions
- dark/light themes render badge and strip legibly

Code checks:

- `npm run build`
- targeted tests if a pure `ReadingLoopService` test file is added

## Development Order

1. Add preference, locale strings, and preference binding.
2. Add Reading Loop types and in-memory service.
3. Wire current item updates into the service.
4. Render entry icon badge from service snapshot.
5. Render suggestion strip below header.
6. Add text-selection suggestion creation and expiry.
7. Add highlight-threshold suggestion creation.
8. Implement accept/dismiss/view actions.
9. Add rate limits and quieting.
10. Verify in Zotero with light and dark themes.
