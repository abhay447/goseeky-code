import { resolve } from 'path';
import { indexRepo } from '../core/search/indexer';

// This moves: Current -> Parent -> Grandparent -> Great-grandparent
const repoRoot = resolve(__dirname, '..', '..');

console.log(repoRoot);

// -----------------------------
// Runner with concurrency control
// -----------------------------
async function run() {
  const hybridStore = await indexRepo(repoRoot)

  const results = await hybridStore.search("eval prompt definition");

  console.log(results);
}

run();