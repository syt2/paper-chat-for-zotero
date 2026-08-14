import { getString } from "../../../utils/locale";
import type {
  PresentationCardProgress,
  PresentationCardStage,
} from "../../presentation/contracts";
import { isDarkMode } from "./ChatPanelTheme";
import { HTML_NS } from "./types";

export type PresentationProgressCardStatus = "calling" | "completed" | "error";

const PRESENTATION_CARD_STAGE_ORDER: readonly PresentationCardStage[] = [
  "preparing",
  "planning",
  "extracting",
  "drafting",
  "refining",
  "saving",
];

const PRESENTATION_PROGRESS_PHASES = new Set<PresentationCardProgress["phase"]>(
  [
    "analyzing",
    "planning",
    "resolving_media",
    "rendering",
    "reviewing",
    "repairing",
    "exporting",
    "attaching",
    "completed",
  ],
);

const palettes = {
  light: {
    cardBg: "#f6f8fa",
    cardBorder: "#d0d7de",
    nameText: "#24292f",
    mutedText: "#57606a",
    active: "#0969da",
    track: "#d8dee4",
    done: "#1a7f37",
    error: "#cf222e",
  },
  dark: {
    cardBg: "#161b22",
    cardBorder: "#30363d",
    nameText: "#c9d1d9",
    mutedText: "#8b949e",
    active: "#58a6ff",
    track: "#30363d",
    done: "#3fb950",
    error: "#f85149",
  },
};

const PRESENTATION_LONG_STAGE_THRESHOLD_MS = 45_000;
const presentationProgressStyledDocuments = new WeakSet<Document>();

interface PresentationProgressTimerEntry {
  root: HTMLElement;
  elapsed: HTMLElement;
  longHint: HTMLElement;
  progress: PresentationCardProgress;
  status: PresentationProgressCardStatus;
}

interface PresentationProgressTimerState {
  entries: Set<PresentationProgressTimerEntry>;
  intervalId: number;
}

const presentationProgressTimers = new WeakMap<
  Document,
  PresentationProgressTimerState
>();

function getPresentationCardString(
  key: string,
  fallback: string,
  args?: Record<string, unknown>,
): string {
  try {
    const value = args ? getString(key, { args }) : getString(key);
    return value && !value.startsWith("paperchat-") ? value : fallback;
  } catch {
    return fallback;
  }
}

function getPresentationStageLabel(stage: PresentationCardStage): string {
  const fallbacks: Record<PresentationCardStage, string> = {
    preparing: "Prepare paper",
    planning: "Plan structure",
    extracting: "Extract assets",
    drafting: "Build draft",
    refining: "Visual polish",
    saving: "Save to Zotero",
  };
  return getPresentationCardString(
    `chat-presentation-progress-stage-${stage}`,
    fallbacks[stage],
  );
}

function formatElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) {
    return `${String(totalMinutes).padStart(2, "0")}:${seconds}`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = String(totalMinutes % 60).padStart(2, "0");
  return `${hours}:${minutes}:${seconds}`;
}

function ensureProgressStyles(doc: Document): void {
  if (presentationProgressStyledDocuments.has(doc)) return;
  presentationProgressStyledDocuments.add(doc);
  const style = doc.createElementNS(HTML_NS, "style") as HTMLElement;
  style.setAttribute("data-paperchat-presentation-progress-styles", "true");
  style.textContent = `
@keyframes paperchat-presentation-pulse {
  0%, 100% { opacity: 0.45; transform: scale(0.82); }
  50% { opacity: 1; transform: scale(1); }
}
@keyframes paperchat-presentation-shimmer {
  0% { transform: translateX(-115%); }
  100% { transform: translateX(315%); }
}`;
  const target = doc.head || doc.documentElement || doc.body;
  target?.appendChild(style);
}

function updateTimerEntry(
  entry: PresentationProgressTimerEntry,
  now: number,
): void {
  const endTime = entry.status === "calling" ? now : entry.progress.updatedAt;
  const elapsed = formatElapsed(
    Math.max(0, endTime - entry.progress.startedAt),
  );
  entry.elapsed.textContent = getPresentationCardString(
    "chat-presentation-progress-elapsed",
    `Elapsed ${elapsed}`,
    { time: elapsed },
  );

  const showLongHint =
    entry.status === "calling" &&
    now - entry.progress.stageStartedAt >= PRESENTATION_LONG_STAGE_THRESHOLD_MS;
  entry.longHint.style.display = showLongHint ? "block" : "none";
}

function registerProgressTimer(
  doc: Document,
  entry: PresentationProgressTimerEntry,
): void {
  updateTimerEntry(entry, Date.now());
  if (entry.status !== "calling" || !doc.defaultView) return;

  let state = presentationProgressTimers.get(doc);
  if (!state) {
    const entries = new Set<PresentationProgressTimerEntry>();
    const intervalId = doc.defaultView.setInterval(() => {
      const currentState = presentationProgressTimers.get(doc);
      if (!currentState) return;
      const now = Date.now();
      for (const currentEntry of currentState.entries) {
        if (currentEntry.root.isConnected === false) {
          currentState.entries.delete(currentEntry);
          continue;
        }
        updateTimerEntry(currentEntry, now);
      }
      if (currentState.entries.size === 0) {
        doc.defaultView?.clearInterval(currentState.intervalId);
        presentationProgressTimers.delete(doc);
      }
    }, 1000);
    state = { entries, intervalId };
    presentationProgressTimers.set(doc, state);
  }
  state.entries.add(entry);
}

function summarizeError(text: string): string {
  const firstLine = text
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) return "";
  const normalized = firstLine
    .replace(/^Error:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.length <= 120
    ? normalized
    : `${normalized.slice(0, 117)}...`;
}

export function parsePresentationCardProgress(
  phase: string | undefined,
  stage: string | undefined,
  message: string | undefined,
  startedAtText: string | undefined,
  stageStartedAtText: string | undefined,
  updatedAtText: string | undefined,
): PresentationCardProgress | undefined {
  if (
    !phase ||
    !PRESENTATION_PROGRESS_PHASES.has(
      phase as PresentationCardProgress["phase"],
    ) ||
    !stage ||
    !PRESENTATION_CARD_STAGE_ORDER.includes(stage as PresentationCardStage)
  ) {
    return undefined;
  }
  const startedAt = Number(startedAtText);
  const stageStartedAt = Number(stageStartedAtText);
  const updatedAt = Number(updatedAtText);
  if (
    !Number.isSafeInteger(startedAt) ||
    !Number.isSafeInteger(stageStartedAt) ||
    !Number.isSafeInteger(updatedAt) ||
    startedAt <= 0 ||
    stageStartedAt < startedAt ||
    updatedAt < stageStartedAt
  ) {
    return undefined;
  }
  return {
    phase: phase as PresentationCardProgress["phase"],
    stage: stage as PresentationCardStage,
    message: message || "",
    startedAt,
    stageStartedAt,
    updatedAt,
  };
}

export function buildPresentationProgressCardElement(
  doc: Document,
  input: {
    status: PresentationProgressCardStatus;
    progress: PresentationCardProgress;
    errorText?: string;
  },
  artifactElement?: HTMLElement,
): HTMLElement {
  ensureProgressStyles(doc);
  const palette = isDarkMode() ? palettes.dark : palettes.light;
  const { status, progress } = input;
  const activeIndex = PRESENTATION_CARD_STAGE_ORDER.indexOf(progress.stage);
  const accent =
    status === "error"
      ? palette.error
      : status === "completed"
        ? palette.done
        : palette.active;

  const card = doc.createElementNS(HTML_NS, "div") as HTMLElement;
  card.setAttribute("data-presentation-progress-card", "true");
  card.setAttribute("data-presentation-card-status", status);
  card.setAttribute("data-presentation-active-stage", progress.stage);
  Object.assign(card.style, {
    display: "flex",
    flexDirection: "column",
    gap: "10px",
    margin: "8px 0",
    padding: "12px",
    border: `1px solid ${status === "error" ? palette.error : palette.cardBorder}`,
    borderRadius: "10px",
    background: palette.cardBg,
    overflow: "hidden",
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif',
    fontSize: "12px",
  });

  const header = doc.createElementNS(HTML_NS, "div") as HTMLElement;
  Object.assign(header.style, {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "12px",
  });
  const title = doc.createElementNS(HTML_NS, "div") as HTMLElement;
  title.setAttribute("data-presentation-progress-title", "true");
  Object.assign(title.style, {
    color: palette.nameText,
    fontSize: "13px",
    fontWeight: "700",
  });
  title.textContent = getPresentationCardString(
    "chat-presentation-progress-title",
    "Generate PPT",
  );
  header.appendChild(title);

  const elapsed = doc.createElementNS(HTML_NS, "div") as HTMLElement;
  elapsed.setAttribute("data-presentation-elapsed", "true");
  Object.assign(elapsed.style, {
    color: palette.mutedText,
    fontSize: "10px",
    fontVariantNumeric: "tabular-nums",
    flexShrink: "0",
  });
  header.appendChild(elapsed);
  card.appendChild(header);

  const activity = doc.createElementNS(HTML_NS, "div") as HTMLElement;
  activity.setAttribute("data-presentation-current-activity", "true");
  Object.assign(activity.style, {
    display: "flex",
    alignItems: "flex-start",
    gap: "7px",
    color: palette.nameText,
    fontSize: "12px",
    lineHeight: "1.4",
  });
  const activityMarker = doc.createElementNS(HTML_NS, "span") as HTMLElement;
  activityMarker.textContent =
    status === "completed" ? "✓" : status === "error" ? "!" : "●";
  Object.assign(activityMarker.style, {
    color: accent,
    flexShrink: "0",
    fontWeight: "700",
  });
  if (status === "calling") {
    activityMarker.style.animation =
      "paperchat-presentation-pulse 1.4s ease-in-out infinite";
  }
  activity.appendChild(activityMarker);
  const currentMessage = doc.createElementNS(HTML_NS, "span") as HTMLElement;
  const stageLabel = getPresentationStageLabel(progress.stage);
  const errorSummary =
    status === "error" ? summarizeError(input.errorText || "") : "";
  currentMessage.textContent =
    errorSummary ||
    progress.message ||
    getPresentationCardString(
      "chat-presentation-progress-current",
      `Working on ${stageLabel}`,
      { stage: stageLabel },
    );
  activity.appendChild(currentMessage);
  card.appendChild(activity);

  if (status === "calling") {
    const track = doc.createElementNS(HTML_NS, "div") as HTMLElement;
    track.setAttribute("data-presentation-indeterminate-progress", "true");
    Object.assign(track.style, {
      position: "relative",
      height: "3px",
      borderRadius: "999px",
      overflow: "hidden",
      background: palette.track,
    });
    const shimmer = doc.createElementNS(HTML_NS, "div") as HTMLElement;
    Object.assign(shimmer.style, {
      position: "absolute",
      inset: "0 auto 0 0",
      width: "32%",
      borderRadius: "999px",
      background: accent,
      animation: "paperchat-presentation-shimmer 1.65s ease-in-out infinite",
    });
    track.appendChild(shimmer);
    card.appendChild(track);
  }

  const stages = doc.createElementNS(HTML_NS, "div") as HTMLElement;
  stages.setAttribute("data-presentation-stage-rail", "true");
  Object.assign(stages.style, {
    display: "grid",
    gridTemplateColumns: "repeat(6, minmax(0, 1fr))",
    gap: "4px",
    paddingBottom: "2px",
  });
  for (const [index, stage] of PRESENTATION_CARD_STAGE_ORDER.entries()) {
    const stageState =
      status === "completed" || index < activeIndex
        ? "completed"
        : index === activeIndex
          ? status === "error"
            ? "error"
            : "active"
          : "pending";
    const stageElement = doc.createElementNS(HTML_NS, "div") as HTMLElement;
    stageElement.setAttribute("data-presentation-stage", stage);
    stageElement.setAttribute("data-presentation-stage-state", stageState);
    Object.assign(stageElement.style, {
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      gap: "4px",
      minWidth: "0",
      color:
        stageState === "completed"
          ? palette.done
          : stageState === "active"
            ? accent
            : stageState === "error"
              ? palette.error
              : palette.mutedText,
    });
    const marker = doc.createElementNS(HTML_NS, "span") as HTMLElement;
    marker.textContent =
      stageState === "completed"
        ? "✓"
        : stageState === "active"
          ? "●"
          : stageState === "error"
            ? "!"
            : "○";
    Object.assign(marker.style, {
      fontSize: "11px",
      fontWeight: "700",
      lineHeight: "1",
    });
    if (stageState === "active") {
      marker.style.animation =
        "paperchat-presentation-pulse 1.4s ease-in-out infinite";
    }
    stageElement.appendChild(marker);
    const label = doc.createElementNS(HTML_NS, "span") as HTMLElement;
    Object.assign(label.style, {
      fontSize: "9px",
      lineHeight: "1.25",
      textAlign: "center",
      whiteSpace: "normal",
    });
    label.textContent = getPresentationStageLabel(stage);
    stageElement.appendChild(label);
    stages.appendChild(stageElement);
  }
  card.appendChild(stages);

  const longHint = doc.createElementNS(HTML_NS, "div") as HTMLElement;
  longHint.setAttribute("data-presentation-long-running-hint", "true");
  longHint.textContent = getPresentationCardString(
    "chat-presentation-progress-long-running",
    `${stageLabel} usually takes a while. The task is still running.`,
    { stage: stageLabel },
  );
  Object.assign(longHint.style, {
    display: "none",
    color: palette.mutedText,
    fontSize: "10px",
    lineHeight: "1.4",
  });
  card.appendChild(longHint);

  if (artifactElement) card.appendChild(artifactElement);

  registerProgressTimer(doc, {
    root: card,
    elapsed,
    longHint,
    progress,
    status,
  });
  return card;
}
