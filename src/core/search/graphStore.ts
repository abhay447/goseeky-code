// src/search/graphStore.ts

import { Edge } from "../parser/types";

export class GraphStore {
  private adjacency = new Map<string, Edge[]>();

  addEdges(edges: Edge[]) {
    for (const edge of edges) {
      if (!this.adjacency.has(edge.from)) {
        this.adjacency.set(edge.from, []);
      }
      this.adjacency.get(edge.from)!.push(edge);
    }
  }

  getNeighbors(id: string) {
    return this.adjacency.get(id) || [];
  }
}