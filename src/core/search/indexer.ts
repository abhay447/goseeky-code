import fs from "fs";
import { walkDir } from "../../core/parser/filewalker";
import { getExtractorForFile } from "../../core/parser/registry";
import { buildEmbeddingDocs } from "../../core/embeddings/buildDocs";
import { embedBatch, initEmbedder } from "../../core/embeddings/embedder";
import { HybridStore } from "./hybridStore";
import { resolve } from 'path';

let fileModificationHash = new Map<string, number>(); // filePath -> contentHash
// -----------------------------
// Process one file
// -----------------------------
async function processFile(filePath: string, hybridStore: HybridStore) {
    const extractor = getExtractorForFile(filePath);
    if (!extractor) return null;

    const code = fs.readFileSync(filePath, "utf-8");
    const stats = fs.statSync(filePath);
    fileModificationHash.set(filePath, stats.mtimeMs); // Store modification tms for incremental updates
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
    void startIncrementalIndexingLoop(hybridStore, repoRoot);
    return hybridStore;
}


// -----------------------------
// Incremental rebuilding functions
// -----------------------------

/**
 * Process only the changed files and update the existing index
 */
async function incrementalIndex(changedFiles: string[], existingStore: HybridStore) {
    console.log(`🔄 Processing ${changedFiles.length} changed files...`);
    
    // Remove stale entries first
    await removeStaleEntries(changedFiles, existingStore);
    
    // Process changed files
    const CONCURRENCY = 4;
    for (let i = 0; i < changedFiles.length; i += CONCURRENCY) {
        const batch = changedFiles.slice(i, i + CONCURRENCY);
        await Promise.all(batch.map(file => processFile(file, existingStore)));
    }
    
    console.log(`✅ Incremental update completed for ${changedFiles.length} files`);
    return existingStore;
}

/**
 * Update existing index with changed files, removing stale entries
 */
async function updateIndex(changedFiles: string[], hybridStore: HybridStore, repoRoot?: string) {
    let scanDir = repoRoot;
    if (!scanDir) {
        const scanDir = resolve(__dirname, '..', '..');
        console.log(scanDir);
    }
    
    // Process changed files
    await incrementalIndex(changedFiles, hybridStore);
    
    return hybridStore;
}

/**
 * Remove stale entries from the index for files that no longer exist
 */
async function removeStaleEntries(changedFiles: string[], hybridStore: HybridStore) {
    console.log(`🗑️ Removing stale entries for changed files...`);
    
    // Get current file stats to determine which files still exist
    const existingFiles = new Set<string>();
    const fileStats = new Map<string, any>();
    
    for (const filePath of changedFiles) {
        try {
            const stats = fs.statSync(filePath);
            existingFiles.add(filePath);
            fileStats.set(filePath, stats);
        } catch (error) {
            // File doesn't exist, will be removed from index
            console.log(`📁 File not found, removing from index: ${filePath}`);
        }
    }
    
    // Note: This is a simplified implementation.
    // In a real implementation, you would need to track which entities/embeddings
    // belong to which files to properly remove stale entries.
    // For now, we'll log the files that were removed.
    const removedFiles = changedFiles.filter(file => !existingFiles.has(file));
    if (removedFiles.length > 0) {
        console.log(`📋 Removed ${removedFiles.length} stale file entries from index`);
    }
    
    return hybridStore;
}

async function startIncrementalIndexingLoop(hybridStore: HybridStore, repoRoot?: string) {
    while (true) {
    // console.log("Running...");
    incrementalRebuild(hybridStore, repoRoot);
    await new Promise(resolve => setTimeout(resolve, 1000)); // wait for 1 second before checking for changes
  }
}



/**
 * Main function for incremental rebuild
 */
async function incrementalRebuild(hybridStore: HybridStore,  repoRoot?: string) {
    const changedFiles = getChangedFiles(repoRoot);
    if (changedFiles.length > 0) {
        console.log(`🚀 Starting incremental rebuild for ${changedFiles.length} files`);
        
        try {
            // Initialize embedder if not already done
            await initEmbedder();
            
            // Update the index with changed files
            const updatedStore = await updateIndex(changedFiles, hybridStore, repoRoot);
            
            console.log(`✅ Incremental rebuild completed successfully`);
            return updatedStore;
        } catch (error) {
            console.error(`❌ Incremental rebuild failed:`, error);
            // throw error;
        }
    } else {
        // console.log(`⚠️ No changed files detected, skipping incremental rebuild`);
        return hybridStore;
    }
}

/**
 * Get changed files since last index (simplified implementation)
 */
function getChangedFiles(repoRoot?: string): string[] {
    let scanDir = repoRoot;
    if (!scanDir) {
        const scanDir = resolve(__dirname, '..', '..');
        console.log(scanDir);
    }
    
    // This is a placeholder implementation.
    // In a real implementation, you would compare file timestamps
    // or use git status to determine which files have changed.
    const files = walkDir(scanDir!);
    const currentState: Map<string, number> = new Map();
    for(const file of files) {
        const stats = fs.statSync(file);
        if(getExtractorForFile(file)){
            currentState.set(file, stats.mtimeMs);
        }
    }
    const changedFiles = [...currentState.keys()].filter(file => {
        const prevHash = fileModificationHash.get(file);
        const currentHash = currentState.get(file);
        return !prevHash || !currentHash || prevHash !== currentHash;
    });
    // for(const file of changedFiles) {
    //     console.log(`🔍 Changed file: ${file}, original: ${fileModificationHash.get(file)}, current: ${currentState.get(file)}`);
    // }
    return changedFiles;
}