import { getEmbeddingProviderFactory } from "../../embedding/EmbeddingProviderFactory";

export async function getMemoryEmbeddingProvider() {
  try {
    return await getEmbeddingProviderFactory().getProvider();
  } catch {
    return null;
  }
}
