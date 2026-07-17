export interface ExistingSearchBackfillOwner {
  stopSearchHistoryBackfill(): Promise<void>;
}

/** Stop and drain only an already-created backfill owner during app shutdown. */
export async function stopExistingSearchBackfillForShutdown(
  owner: ExistingSearchBackfillOwner | null,
): Promise<void> {
  if (!owner) return;
  await owner.stopSearchHistoryBackfill();
}
