import { embed } from "../embeddings/embedder";
import { HNSWVectorStore } from "./hnswStore";
import { GraphStore } from "./graphStore";

export async function hybridSearch(
  query: string,
  vectorStore: HNSWVectorStore,
  graphStore: GraphStore
) {
  // 1️⃣ Embed query
  const queryVec = await embed(query);

  // 2️⃣ Vector search
  const top = vectorStore.search(queryVec, 5);

  // 3️⃣ Graph expansion
  const expanded = [];

  for (const result of top) {
    const neighbors = graphStore.getNeighbors(result.id!);

    expanded.push({
      ...result,
      neighbors,
    });
  }

  return expanded;
}