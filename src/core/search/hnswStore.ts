import { HierarchicalNSW } from "hnswlib-node";

export class HNSWVectorStore {
  private index: HierarchicalNSW;
  private dim: number;
  private idMap = new Map<number, string>(); // numeric → entity id
  private reverseMap = new Map<string, number>(); // entity id → numeric

  private nextId = 0;

  constructor(dim: number) {
    this.dim = dim;

    this.index = new HierarchicalNSW("cosine", dim);
    this.index.initIndex(10000); // capacity
  }

  add(id: string, vector: number[]) {
    const numericId = this.nextId++;

    this.index.addPoint(vector, numericId);

    this.idMap.set(numericId, id);
    this.reverseMap.set(id, numericId);
  }

  addMany(items: { id: string; vector: number[] }[]) {
    for (const item of items) {
      this.add(item.id, item.vector);
    }
  }

  search(query: number[], k = 5) {
    const result = this.index.searchKnn(query, k);

    return result.neighbors.map((n: number, i: number) => ({
      id: this.idMap.get(n),
      score: result.distances[i],
    }));
  }
}