// src/embeddings/buildDocs.ts
import { Entity, Edge } from "../parser/types";

export function buildEmbeddingDocs(entities: Entity[], edges: Edge[]) {
    const edgesBySource = new Map<string, Edge[]>();

    for (const edge of edges) {
        if (!edgesBySource.has(edge.from)) {
            edgesBySource.set(edge.from, []);
        }
        edgesBySource.get(edge.from)!.push(edge);
    }

    return entities
        .filter(e => ["function", "method", "class"].includes(e.type))
        .map(entity => {
            const calls = (edgesBySource.get(entity.name) || [])
                .filter(e => e.type === "calls")
                .map(e => e.to)
                .join(", ");

            return {
                id: entity.id,
                content: `
Type: ${entity.type}
Name: ${entity.name}
File: ${entity.filePath}
Code: ${entity.code}

Calls: ${calls || "None"}
        `.trim(),
            };
        });
}