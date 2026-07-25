import type {
  RequestUserInputArgs,
  RequestUserInputResponse,
  ToolCall,
} from "../../types/tool";
import { getString } from "../../utils/locale";
import { normalizeSourceItemKeys } from "./note-source-provenance";

export const NOTE_SUMMARY_DESTINATION_QUESTION_ID = "note_summary_destination";
export const NOTE_SUMMARY_STANDALONE_DESTINATION_VALUE = "standalone";
/** Leaves one slot for the standalone choice under the 100-option app limit. */
export const MAX_NOTE_SUMMARY_SOURCE_ITEMS = 99;
const PAPER_DESTINATION_PREFIX = "paper:";

export interface NoteSummarySourceItem {
  itemKey: string;
  title: string;
}

export type NoteSummaryDestinationState =
  | { status: "pending" }
  | { status: "resolved"; itemKey: string | null }
  | { status: "cancelled" };

export interface NoteSummaryContext {
  sourceItems: NoteSummarySourceItem[];
  destination: NoteSummaryDestinationState;
  noteCreated: boolean;
}

export function createNoteSummaryContext(
  sourceItems: readonly NoteSummarySourceItem[],
): NoteSummaryContext {
  const normalizedKeys = normalizeSourceItemKeys(
    sourceItems.map((source) => source.itemKey),
  );
  const sourceByKey = new Map(
    sourceItems.map((source) => [source.itemKey.toUpperCase(), source]),
  );
  const normalizedSources = normalizedKeys
    .slice(0, MAX_NOTE_SUMMARY_SOURCE_ITEMS)
    .map((itemKey) => ({
      itemKey,
      title: sourceByKey.get(itemKey)?.title.trim() || itemKey,
    }));

  return {
    sourceItems: normalizedSources,
    noteCreated: false,
    destination:
      normalizedSources.length > 1
        ? { status: "pending" }
        : {
            status: "resolved",
            itemKey: normalizedSources[0]?.itemKey || null,
          },
  };
}

export function buildNoteSummaryDestinationRequestArgs(
  context: NoteSummaryContext,
): RequestUserInputArgs {
  return {
    questions: [
      {
        id: NOTE_SUMMARY_DESTINATION_QUESTION_ID,
        header: getString("chat-note-summary-destination-header"),
        question: getString("chat-note-summary-destination-question"),
        type: "single_choice",
        required: true,
        defaultValue: NOTE_SUMMARY_STANDALONE_DESTINATION_VALUE,
        options: [
          {
            label: getString("chat-note-summary-destination-standalone"),
            description: getString(
              "chat-note-summary-destination-standalone-description",
            ),
            value: NOTE_SUMMARY_STANDALONE_DESTINATION_VALUE,
            recommended: true,
          },
          ...context.sourceItems.map((source) => ({
            label: source.title,
            description: getString(
              "chat-note-summary-destination-paper-description",
            ),
            value: `${PAPER_DESTINATION_PREFIX}${source.itemKey}`,
          })),
        ],
      },
    ],
  };
}

export function applyNoteSummaryDestinationResponse(
  context: NoteSummaryContext,
  response: RequestUserInputResponse,
): void {
  if (response.cancelled) {
    context.destination = { status: "cancelled" };
    return;
  }

  const answer =
    response.answers[NOTE_SUMMARY_DESTINATION_QUESTION_ID]?.answers?.[0];
  if (answer === NOTE_SUMMARY_STANDALONE_DESTINATION_VALUE) {
    context.destination = { status: "resolved", itemKey: null };
    return;
  }

  if (answer?.startsWith(PAPER_DESTINATION_PREFIX)) {
    const itemKey = answer.slice(PAPER_DESTINATION_PREFIX.length);
    if (context.sourceItems.some((source) => source.itemKey === itemKey)) {
      context.destination = { status: "resolved", itemKey };
      return;
    }
  }

  context.destination = { status: "cancelled" };
}

export function rewriteCreateNoteTarget(
  toolCall: ToolCall,
  itemKey: string | null,
): ToolCall | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(toolCall.function.arguments || "{}");
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }

  const args = { ...(parsed as Record<string, unknown>) };
  delete args.itemKey;
  delete args.item_key;
  delete args.itemkey;
  if (itemKey) {
    args.itemKey = itemKey;
  }
  return {
    ...toolCall,
    function: {
      ...toolCall.function,
      arguments: JSON.stringify(args),
    },
  };
}

export function buildNoteSummaryRuntimeInstruction(
  context: NoteSummaryContext,
): string {
  if (context.noteCreated) {
    return [
      "This is an application-initiated note summary action.",
      "The note has already been created. Do not call create_note or request_user_input again.",
      "Briefly confirm completion to the user.",
    ].join(" ");
  }
  const destinationInstruction = (() => {
    switch (context.destination.status) {
      case "pending":
        return "Before creating the note, call request_user_input by itself and wait for the user to choose a destination. The application supplies and validates the choices. Do not call create_note in the same response as request_user_input.";
      case "cancelled":
        return "The user cancelled destination selection. End this action without calling create_note or request_user_input again.";
      case "resolved":
        return "The application has already selected the note destination; do not ask the user where to save it.";
    }
  })();
  return [
    "This is an application-initiated note summary action.",
    destinationInstruction,
    "Use create_note exactly once after the destination is resolved. The application controls the destination, so do not infer, change, or override itemKey.",
    "If the user cancels destination selection, do not create a note.",
  ].join(" ");
}
