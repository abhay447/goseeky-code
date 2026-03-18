import fs from "fs";
import { walkDir } from "../core/parser/filewalker";
import { getExtractorForFile } from "../core/parser/registry";
import { buildEmbeddingDocs } from "../core/embeddings/buildDocs";
import { embed, embedBatch, initEmbedder } from "../core/embeddings/embedder";
import { HNSWVectorStore } from "../core/search/hnswStore";
import { GraphStore } from "../core/search/graphStore";
import { hybridSearch } from "../core/search/hybridSearch";
import { Entity } from "../core/parser/types";

const SCAN_PATH = process.argv[2];

const vectorStore = new HNSWVectorStore(384); // MiniLM dim
const graphStore = new GraphStore();
const entityDb = new Map<String, Entity>();

// -----------------------------
// Process one file
// -----------------------------
async function processFile(filePath: string) {
  const extractor = getExtractorForFile(filePath);
  if (!extractor) return null;

  const code = fs.readFileSync(filePath, "utf-8");

  const result = extractor.extract(code, filePath);
  for(let entity of  result.entities) {
    entityDb.set(entity.id, entity);
  }

  const docs = buildEmbeddingDocs(result.entities, result.edges);

  graphStore.addEdges(result.edges);

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

  vectorStore.addMany(
    embeddings.map(e => ({
      id: e.id,
      vector: e.vector,
    }))
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
async function run() {
  if (!SCAN_PATH) {
    console.error("❌ Provide path");
    process.exit(1);
  }

  // ✅ init model once
  await initEmbedder();

  const files = walkDir(SCAN_PATH);

  console.log(`📂 Found ${files.length} files\n`);

  const CONCURRENCY = 4; // tweak (4–8 ideal)

  for (let i = 0; i < files.length; i += CONCURRENCY) {
    const batch = files.slice(i, i + CONCURRENCY);

    await Promise.all(batch.map(file => processFile(file)));
  }

  console.log("\n✅ Done");

  // const queryVec = await embed("eval prompt definition");

  const results = await hybridSearch("eval prompt definition", vectorStore, graphStore);

  for(let entry of results){
    console.log(entry)
    console.log(entityDb.get(entry.id!))
  }

  console.log(results);
}

run();