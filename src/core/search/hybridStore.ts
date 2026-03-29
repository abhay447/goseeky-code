import { embed } from "../embeddings/embedder";
import { HNSWVectorStore } from "./hnswStore";
import { GraphStore } from "./graphStore";
import { Edge, Entity } from "../parser/types";
import { KWStore, tokenize } from "./keywordStore";

export interface SearchResult {
    score: number;
    id: string;
    entity: Entity;
    neighbors: Edge[];
}

export class HybridStore {
    private vectorStore = new HNSWVectorStore(384); // MiniLM dim
    private graphStore = new GraphStore();
    private entityDb = new Map<String, Entity>();
    private kwStore = new KWStore();
    private finalized = false;


    putEntity(entity: Entity) {
        this.entityDb.set(entity.id, entity);
    }

    putEdges(edges: Edge[]) {
        this.graphStore.addEdges(edges);
    }

    putEmbeddings(embedddingDocs: { id: string; vector: number[], content: string }[]) {
        this.vectorStore.addMany(
            embedddingDocs.map(e => ({
                id: e.id,
                vector: e.vector,
            }))
        );

        embedddingDocs.forEach(doc => {
            this.kwStore.add({
                id: doc.id,
                text: doc.content,
            });
        });
        this.finalized = false;
    }

    finalize() {
        this.kwStore.finalize();
        this.finalized = true;
        // console.log(this.graphStore.listEntities());
    }

    async search(query: string, topK = 5) : Promise<SearchResult[]> {
        if (!this.finalized) {
            throw new Error("Search attempted before finalize");
        }

        // =========================
        // 🔧 Tunable constants
        // =========================

        // Balance between semantic (vector) and exact (BM25)
        const VECTOR_WEIGHT = 0.5;
        const KEYWORD_WEIGHT = 0.5;

        // 🔥 Strongest signal: exact identifier match
        const EXACT_NAME_MATCH_BOOST = 5.0;

        // Partial match (e.g. "chat" → ChatManager)
        const PARTIAL_NAME_MATCH_BOOST = 2.0;

        // Mild boost for token overlap
        const TOKEN_MATCH_BOOST = 1.5;

        // Prefer structural/connected entities
        const GRAPH_NEIGHBOR_BOOST = 0.2;

        // Prefer classes slightly (useful for symbol queries)
        const CLASS_MATCH_BOOST = 1.5;

        // Penalize entities that only "mention" the term in code
        const MENTION_ONLY_DEBOOST = 0.7;

        // Filter noise
        const MIN_SCORE_THRESHOLD = 0.01;

        // =========================
        // 1️⃣ Embed query
        // =========================
        const queryVec = await embed(query);

        // =========================
        // 2️⃣ Retrieve candidates
        // =========================
        const vectorResults = this.vectorStore.search(queryVec, topK * 2);
        const keywordResults = this.kwStore.search(query, topK * 2);

        // =========================
        // 3️⃣ Combine scores
        // =========================
        const combinedScores = new Map<string, number>();

        // ---- Vector scores (semantic similarity) ----
        for (const r of vectorResults) {
            if (!r.id) continue;

            const similarity = 1 - r.score; // convert distance → similarity

            combinedScores.set(r.id, similarity * VECTOR_WEIGHT);
        }

        // ---- Normalize BM25 scores ----
        const maxBM25 = Math.max(...keywordResults.map(r => r.score), 1);

        // ---- Keyword (BM25) scores ----
        for (const r of keywordResults) {
            const normalized = r.score / maxBM25; // ⚠️ prevents BM25 dominance
            const existing = combinedScores.get(r.id) || 0;

            combinedScores.set(
                r.id,
                existing + normalized * KEYWORD_WEIGHT
            );
        }

        // =========================
        // 4️⃣ Apply boosts / penalties
        // =========================
        const queryTokens = tokenize(query);
        const normalizedQuery = query.toLowerCase().trim();

        const finalResults = [];

        for (const [id, baseScore] of combinedScores.entries()) {
            let score = baseScore;

            const entity = { ... this.entityDb.get(id)!};
            if (!entity) continue;

            const name = entity.name!.toLowerCase();

            // --------------------------------
            // 🔥 EXACT MATCH BOOST
            // --------------------------------
            // Highest priority: exact identifier match
            if (name === normalizedQuery) {
                score += EXACT_NAME_MATCH_BOOST;
            }

            // --------------------------------
            // 🔥 PARTIAL NAME MATCH BOOST
            // --------------------------------
            else if (name.includes(normalizedQuery)) {
                score += PARTIAL_NAME_MATCH_BOOST;
            }

            // --------------------------------
            // 🔥 TOKEN OVERLAP BOOST
            // --------------------------------
            else if (queryTokens.some(t => name.includes(t))) {
                score *= TOKEN_MATCH_BOOST;
            }

            // --------------------------------
            // 🔻 DEBOOST: mention-only matches
            // --------------------------------
            // If entity doesn't match name but appears in code → penalize
            else {
                score *= MENTION_ONLY_DEBOOST;
            }

            // --------------------------------
            // 🔥 TYPE BOOST (class preference)
            // --------------------------------
            if (entity.type === "class") {
                score *= CLASS_MATCH_BOOST;
            }

            // --------------------------------
            // 🔥 GRAPH BOOST
            // --------------------------------
            const neighbors = this.graphStore.getNeighbors(entity.name!);
            if (neighbors.length > 0) {
                score += GRAPH_NEIGHBOR_BOOST;
            }

            // --------------------------------
            // 🔻 FILTER NOISE
            // --------------------------------
            if (score < MIN_SCORE_THRESHOLD) continue;

            entity.code = "REDACTED"

            finalResults.push({
                id,
                score,
                entity,
                neighbors,
            });
        }

        // =========================
        // 5️⃣ Final ranking
        // =========================
        // console.log("unsorted search results " + JSON.stringify(finalResults));
        // console.log("topK:", topK, typeof topK);
        return finalResults
            .map(r => ({
                ...r,
                score: typeof r.score === "number" ? r.score : 0
            }))
            .sort((a, b) => b.score - a.score)
            .slice(0, topK);
        
    }

    async getEntity(entityId : string): Promise<Entity>{
        return this.entityDb.get(entityId)!;
    }  

}
