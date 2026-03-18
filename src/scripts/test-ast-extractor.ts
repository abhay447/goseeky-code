import fs from "fs";
import path from "path";
import { TypeScriptExtractor } from "../core/parser/languages/typescript/extractor";
import { PythonExtractor } from "../core/parser/languages/python/extractor";
import { walkDir } from "../core/parser/filewalker";
import { getExtractorForFile } from "../core/parser/registry";
import { buildEmbeddingDocs } from "../core/embeddings/buildDocs";
import { embed } from "../core/embeddings/embedder";

// --- CONFIG ---
// const LANGUAGE = process.argv[2]; // pass file OR fallback
// const TEST_FILE = process.argv[3]; // pass file OR fallback
const SCAN_PATH = process.argv[2]; // pass file OR fallback


async function processFile(filePath: string) {
  const extractor = getExtractorForFile(filePath);
  if (!extractor) return;

  const code = fs.readFileSync(filePath, "utf-8");

  const result = extractor.extract(code, filePath);

  // 👉 Build embedding docs
  const docs = buildEmbeddingDocs(result.entities, result.edges);

  // 👉 Generate embeddings
  const embeddings = await Promise.all(
    docs.map(async (doc) => ({
      id: doc.id,
      vector: await embed(doc.content),
      content: doc.content,
    }))
  );

  // 👉 store (for now just log)
  console.log("EMBEDDED:", embeddings.length);

  return {
    entities: result.entities,
    edges: result.edges,
    embeddings,
  };
}

// --- Runner ---
function run() {
  let code: string;
  let filePath: string;

    // filePath = path.resolve(TEST_FILE);
    // code = fs.readFileSync(filePath, "utf-8");

  for(let file of walkDir(SCAN_PATH)) {
    console.log(file);
    processFile(file);
  }

  // const extractor = LANGUAGE.toUpperCase().startsWith("PYTHON") ? new PythonExtractor() : new TypeScriptExtractor();

  // console.log("🚀 Running TypeScript Extractor...\n");

  // const result = extractor.extract(code, filePath);

  // console.log(`📦 Entities Found: ${result.entities.length}\n`);

  // for (const entity of result.entities) {
  //   console.log(
  //     `[${entity.type.toUpperCase()}] ${entity.name}\n` +
  //     `  📍 ${entity.filePath}:${entity.startLine}-${entity.endLine}\n`
  //   );
  // }

  // if (result.edges.length > 0) {
  //   console.log(`\n🔗 Edges Found: ${result.edges.length}\n`);

  //   for (const edge of result.edges) {
  //     console.log(`${edge.from} --${edge.type}--> ${edge.to}`);
  //   }
  // } else {
  //   console.log("\n(no edges yet)");
  // }
}

run();