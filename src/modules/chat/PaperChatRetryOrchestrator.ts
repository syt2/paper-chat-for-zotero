/**
 * PaperChatRetryOrchestrator - PaperChat tier-routing failure recovery.
 *
 * Owns the reroute/reroll glue that sits between ChatManager's send loop and
 * the pure routing helpers in paperchat-session-state / paperchat-retry-
 * orchestration: repairing a session's model binding after a hard failure,
 * emitting the user-facing "model rerouted" notice, and tracking analytics.
 * ChatManager delegates here, injecting only the two collaborators it owns
 * (session-meta persistence and system-notice insertion).
 */

import type { ChatMessage, ChatSession } from "../../types/chat";
import type { AIProvider, PaperChatProviderConfig } from "../../types/provider";
import {
  isPaperChatModelHardFailure,
  type PaperChatTier,
} from "../providers/paperchat-tier-routing";
import {
  applyPaperChatSessionBinding,
  repairPaperChatSessionBindingAfterHardFailure,
} from "./paperchat-session-state";
import { repairPaperChatSessionAfterHardFailureWithRollback } from "./paperchat-retry-orchestration";
import {
  getModelRatios,
  getModelRoutingMeta,
} from "../preferences/ModelsFetcher";
import { getPref, setPref } from "../../utils/prefs";
import { getString } from "../../utils/locale";
import { ANALYTICS_EVENTS, getAnalyticsService } from "../analytics";
import { getProviderManager } from "../providers";
import { isEmbeddingModel } from "../embedding/providers/PaperChatEmbedding";

export interface PaperChatRerouteDetails {
  previousModel: string;
  nextModel: string;
  tier: PaperChatTier;
}

/**
 * Collaborators owned by ChatManager that the orchestrator needs to persist
 * session changes and surface user-facing notices.
 */
export interface PaperChatRetryDeps {
  updateSessionMeta: (session: ChatSession) => Promise<void>;
  insertSystemNotice: (
    session: ChatSession,
    content: string,
  ) => Promise<ChatMessage>;
}

/**
 * Weighted random pick over candidate models. Falls back to a uniform pick
 * when no positive weights are supplied.
 */
export function pickRandomCandidate(
  candidates: string[],
  weights: Record<string, number> = {},
): string | null {
  if (candidates.length === 0) {
    return null;
  }

  let totalWeight = 0;
  for (const candidate of candidates) {
    const weight = weights[candidate] ?? 1;
    if (Number.isFinite(weight) && weight > 0) {
      totalWeight += weight;
    }
  }

  if (totalWeight <= 0) {
    const index = Math.floor(Math.random() * candidates.length);
    return candidates[index] ?? null;
  }

  let cursor = Math.random() * totalWeight;
  for (const candidate of candidates) {
    const weight = weights[candidate] ?? 1;
    if (!Number.isFinite(weight) || weight <= 0) {
      continue;
    }
    cursor -= weight;
    if (cursor < 0) {
      return candidate;
    }
  }

  return candidates[candidates.length - 1] ?? null;
}

/** Configured PaperChat chat models, excluding embedding models. */
export function getPaperChatChatModels(): string[] {
  const providerConfig = getProviderManager().getProviderConfig(
    "paperchat",
  ) as PaperChatProviderConfig | null;
  const configuredModels = providerConfig?.availableModels;
  if (Array.isArray(configuredModels) && configuredModels.length > 0) {
    return configuredModels.filter((model) => !isEmbeddingModel(model));
  }

  return [];
}

export class PaperChatRetryOrchestrator {
  constructor(private readonly deps: PaperChatRetryDeps) {}

  buildReroutedNotice(
    tier: PaperChatTier,
    previousModel: string,
    nextModel: string,
  ): string {
    const tierLabel =
      tier === "paperchat-lite"
        ? getString("chat-tier-lite")
        : tier === "paperchat-ultra"
          ? getString("chat-tier-ultra")
          : tier === "paperchat-pro"
            ? getString("chat-tier-pro")
            : getString("chat-tier-standard");

    return getString("chat-model-rerouted", {
      args: {
        tier: tierLabel,
        old: previousModel,
        new: nextModel,
      },
    });
  }

  private trackModelRerouted(
    tier: PaperChatTier,
    previousModel: string,
    nextModel: string,
    reason: "streaming" | "tool_calling" | "failure_repair",
  ): void {
    getAnalyticsService().track(ANALYTICS_EVENTS.paperChatModelRerouted, {
      tier,
      previous_model: previousModel,
      next_model: nextModel,
      reason,
    });
  }

  private async repairSessionAfterHardFailure(
    session: ChatSession,
    failedModelId: string | null,
    persist: boolean = true,
  ): Promise<PaperChatRerouteDetails | null> {
    const previousTierStateRaw =
      (getPref("paperchatTierState") as string | undefined) || "";
    const updateProviderOverride = (modelId: string | undefined) => {
      getProviderManager().getProvider("paperchat")?.updateConfig({
        resolvedModelOverride: modelId,
      });
    };

    if (!persist) {
      const repair = repairPaperChatSessionBindingAfterHardFailure(
        session,
        previousTierStateRaw,
        getPaperChatChatModels(),
        getModelRatios(),
        failedModelId,
        pickRandomCandidate,
        getModelRoutingMeta(),
      );

      if (!repair || !repair.previousModelId) {
        return null;
      }

      setPref("paperchatTierState", JSON.stringify(repair.state));
      applyPaperChatSessionBinding(session, repair);
      updateProviderOverride(repair.modelId);

      return {
        previousModel: repair.previousModelId,
        nextModel: repair.modelId,
        tier: repair.selectedTier,
      };
    }

    const reroute = await repairPaperChatSessionAfterHardFailureWithRollback({
      session,
      failedModelId,
      previousTierStateRaw,
      availableModels: getPaperChatChatModels(),
      ratios: getModelRatios(),
      routingMeta: getModelRoutingMeta(),
      persistSessionMeta: (updatedSession) =>
        this.deps.updateSessionMeta(updatedSession),
      setTierStateRaw: (raw) => {
        setPref("paperchatTierState", raw);
      },
      updateProviderOverride,
      pickRandom: pickRandomCandidate,
    });

    if (!reroute) {
      return null;
    }

    return reroute;
  }

  /**
   * Shared one-shot reroute for PaperChat hard model failures. Returns the
   * reroute details when the caller should replay the request on the new
   * model, or null when the error must be rethrown as-is.
   */
  async reroutePaperChatSessionForHardFailure(params: {
    session: ChatSession;
    provider: AIProvider;
    error: unknown;
    failedModelId: string | null;
    alreadyRerouted: boolean;
    reason: "streaming" | "tool_calling";
    ensureSessionTracked: () => void;
  }): Promise<PaperChatRerouteDetails | null> {
    const {
      session,
      provider,
      error,
      failedModelId,
      alreadyRerouted,
      reason,
      ensureSessionTracked,
    } = params;
    if (
      provider.config.id !== "paperchat" ||
      !(error instanceof Error) ||
      !isPaperChatModelHardFailure(error) ||
      alreadyRerouted
    ) {
      return null;
    }

    const reroute = await this.repairSessionAfterHardFailure(
      session,
      failedModelId,
    );
    ensureSessionTracked();
    if (!reroute) {
      return null;
    }

    provider.updateConfig({
      resolvedModelOverride: reroute.nextModel,
    });
    await this.deps.insertSystemNotice(
      session,
      this.buildReroutedNotice(
        reroute.tier,
        reroute.previousModel,
        reroute.nextModel,
      ),
    );
    this.trackModelRerouted(
      reroute.tier,
      reroute.previousModel,
      reroute.nextModel,
      reason,
    );
    ensureSessionTracked();
    return reroute;
  }
}
