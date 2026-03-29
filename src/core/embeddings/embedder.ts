// src/embeddings/embedder.ts
import { pipeline } from "@xenova/transformers";

let embedder: any;

export async function initEmbedder() {
  if (!embedder) {
    embedder = await pipeline(
      "feature-extraction",
      "Xenova/all-MiniLM-L6-v2"
    );
  }
}

export async function embed(text: string): Promise<number[]> {
  if (!embedder) {
    await initEmbedder();
  }

  const output = await embedder(text, {
    pooling: "mean",
    normalize: true,
  });

  return Array.from(output.data);
}

export async function embedBatch(texts: string[]) {
  if (!embedder) await initEmbedder();

  const output = await embedder(texts, {
    pooling: "mean",
    normalize: true,
  });

  return output.tolist(); // array of vectors
}