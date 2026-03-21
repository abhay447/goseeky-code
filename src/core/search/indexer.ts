import fs from "fs";
import { walkDir } from "../../core/parser/filewalker";
import { getExtractorForFile } from "../../core/parser/registry";
import { buildEmbeddingDocs } from "../../core/embeddings/buildDocs";
import { embedBatch, initEmbedder } from "../../core/embeddings/embedder";
import { HybridStore } from "./hybridStore";
import { resolve } from 'path';

// -----------------------------
// Process one file
// -----------------------------
async function processFile(filePath: string, hybridStore: HybridStore) {
    const extractor = getExtractorForFile(filePath);
    if (!extractor) return null;

    const code = fs.readFileSync(filePath, "utf-8");

    const result = extractor.extract(code, filePath);
    for (let entity of result.entities) {
        hybridStore.putEntity(entity);
    }

    const docs = buildEmbeddingDocs(result.entities, result.edges);

    hybridStore.putEdges(result.edges);

    if (docs.length === 0) {
        return null;
    }

    // ✅ BATCH embedding
    const vectors = await embedBatch(docs.map(d => d.content));

    const embeddings = docs.map((doc, i) => ({
        id: doc.id,
        vector: vectors[i],
        content: doc.content,
    }));

    hybridStore.putEmbeddings(
        embeddings
    );

    console.log(`EMBEDDED: ${embeddings.length} (${filePath})`);

    return {
        entities: result.entities,
        edges: result.edges,
        embeddings,
    };
}

// -----------------------------
// Runner with concurrency control
// -----------------------------
export async function indexRepo(repoRoot?: string) {
    let scanDir = repoRoot;
    if (!scanDir) {

        // This moves: Current -> Parent -> Grandparent -> Great-grandparent
        const scanDir = resolve(__dirname, '..', '..');

        console.log(scanDir);
    }

    // ✅ init model once
    await initEmbedder();

    const files = walkDir(scanDir!);

    console.log(`📂 Found ${files.length} files\n`);

    const CONCURRENCY = 4; // tweak (4–8 ideal)
    let hybridStore = new HybridStore();
    for (let i = 0; i < files.length; i += CONCURRENCY) {
        const batch = files.slice(i, i + CONCURRENCY);

        await Promise.all(batch.map(file => processFile(file, hybridStore)));
    }
    hybridStore.finalize();
    return hybridStore;
}