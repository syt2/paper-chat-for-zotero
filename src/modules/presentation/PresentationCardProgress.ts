import type {
  PresentationCardProgress,
  PresentationCardStage,
  PresentationProgressUpdate,
} from "./contracts";

const PRESENTATION_CARD_STAGES: readonly PresentationCardStage[] = [
  "preparing",
  "planning",
  "extracting",
  "drafting",
  "refining",
  "saving",
];

function getPresentationCardStage(
  phase: PresentationProgressUpdate["phase"],
  hasDraft: boolean,
): PresentationCardStage {
  switch (phase) {
    case "analyzing":
      return "preparing";
    case "planning":
      return "planning";
    case "resolving_media":
      return "extracting";
    case "rendering":
    case "exporting":
      return hasDraft ? "refining" : "drafting";
    case "reviewing":
      return "refining";
    case "repairing":
      return hasDraft ? "refining" : "planning";
    case "attaching":
    case "completed":
      return "saving";
  }
}

/**
 * Converts renderer-level progress into the six stable stages shown by the
 * presentation card. Internal repair loops may change the phase and message,
 * but this tracker never lets the user-facing stage move backwards.
 */
export class PresentationCardProgressTracker {
  private hasDraft = false;
  private current: PresentationCardProgress;

  constructor(now = Date.now()) {
    this.current = {
      phase: "analyzing",
      stage: "preparing",
      message: "",
      startedAt: now,
      stageStartedAt: now,
      updatedAt: now,
    };
  }

  get progress(): PresentationCardProgress {
    return this.current;
  }

  update(
    update: PresentationProgressUpdate,
    now = Date.now(),
  ): PresentationCardProgress {
    const proposedStage = getPresentationCardStage(update.phase, this.hasDraft);
    const currentIndex = PRESENTATION_CARD_STAGES.indexOf(this.current.stage);
    const proposedIndex = PRESENTATION_CARD_STAGES.indexOf(proposedStage);
    const stage =
      proposedIndex > currentIndex ? proposedStage : this.current.stage;
    const stageAdvanced = stage !== this.current.stage;

    this.current = {
      phase: update.phase,
      stage,
      message: update.message,
      startedAt: this.current.startedAt,
      stageStartedAt: stageAdvanced ? now : this.current.stageStartedAt,
      updatedAt: now,
    };
    this.hasDraft =
      this.hasDraft || Boolean(update.pptxPath && update.isDraft !== false);
    return this.current;
  }

  finish(succeeded: boolean, now = Date.now()): PresentationCardProgress {
    if (!succeeded) {
      this.current = { ...this.current, updatedAt: now };
      return this.current;
    }
    const stageAdvanced = this.current.stage !== "saving";
    this.current = {
      ...this.current,
      phase: "completed",
      stage: "saving",
      stageStartedAt: stageAdvanced ? now : this.current.stageStartedAt,
      updatedAt: now,
    };
    return this.current;
  }
}
