import { embed } from "../embeddings/embedder";
import { HNSWVectorStore } from "./hnswStore";
import { GraphStore } from "./graphStore";
import { Edge, Entity } from "../parser/types";

export class HybridStore {
    private vectorStore = new HNSWVectorStore(384); // MiniLM dim
    private graphStore = new GraphStore();
    private entityDb = new Map<String, Entity>();


    putEntity(entity: Entity) {
        this.entityDb.set(entity.id, entity);
    }

    putEdges(edges: Edge[]) {
        this.graphStore.addEdges(edges);
    }

    putEmbeddings(embedddings: { id: string; vector: number[] }[]) {
        this.vectorStore.addMany(
            embedddings.map(e => ({
                id: e.id,
                vector: e.vector,
            }))
        );
    }

    async search(
        query: string
    ) {
        // 1️⃣ Embed query
        const queryVec = await embed(query);

        // 2️⃣ Vector search
        const top = this.vectorStore.search(queryVec, 5);

        // 3️⃣ Graph expansion
        const expanded = [];

        for (const result of top) {
            const neighbors = this.graphStore.getNeighbors(result.id!);

            expanded.push({
                ...result,
                neighbors,
            });
        }

        for (let entry of top) {
            console.log(entry)
            console.log(this.entityDb.get(entry.id!))
        }

        return expanded;
    }

}
