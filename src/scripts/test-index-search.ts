import { resolve } from 'path';
import { indexRepo } from '../core/search/indexer';
import { getExtractorForFile } from '../core/parser/registry';
import fs from "fs";

// This moves: Current -> Parent -> Grandparent -> Great-grandparent
const repoRoot = resolve(__dirname, '..', '..');

console.log(repoRoot);

// -----------------------------
// Runner with concurrency control
// -----------------------------
async function run() {
  const hybridStore = await indexRepo(repoRoot)

  const results = await hybridStore.search("ChatManager");
  // const filePath = "/Users/rishikamishra/work/sarvam_poc/sarvam-code/src/providers/chatManager.ts";
  // const extractor = getExtractorForFile(filePath);
  //   if (!extractor) return null;

  //   const code = fs.readFileSync(filePath, "utf-8");

  //   const result = extractor.extract(code, filePath);
  //   console.log(result);

  console.log(results);
  // console.log(JSON.stringify(results));
}

run();