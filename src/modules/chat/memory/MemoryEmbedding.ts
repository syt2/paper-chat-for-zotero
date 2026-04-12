export async function getMemoryEmbeddingProvider() {
  try {
    const { getEmbeddingProviderFactory } = await import(
      "../../embedding/EmbeddingProviderFactory"
    );
    return await getEmbeddingProviderFactory().getProvider();
  } catch {
    return null;
  }
}
