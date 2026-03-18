import * as vscode from "vscode";
import * as os from 'os';
import * as process from 'process';
import { runShell } from "../utils/shellUtils";
import * as fs from 'fs';

/**
 * Reads a specific character range from a file.
 * end is inclusive in fs.createReadStream.
 */
function readCharRange(filePath: string, start: number, end: number): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(filePath)) {
      return reject(new Error(`File not found: ${filePath}`));
    }

    const stream = fs.createReadStream(filePath, { 
      encoding: 'utf8', 
      start: start, 
      end: end 
    });

    let data = '';
    stream.on('data', chunk => data += (chunk as string));
    stream.on('end', () => resolve(data));
    stream.on('error', err => reject(err));
  });
}

// ── Prompts ───────────────────────────────────────────────────────────────────

export async function buildFileAnalysisPrompt(
    maxChars: number = 1000, 
    overlapWindow: number = 200, 
    chunkIndex: number = 0, 
    filePath: string
) {
    // Calculate the window based on chunkIndex
    // We subtract the overlap to ensure context continuity
    const start = chunkIndex === 0 ? 0 : chunkIndex * (maxChars - overlapWindow);
    const end = start + maxChars;

    const fileContent = await readCharRange(filePath, start, end);

    // Prompt construction
    return `
### Contextual File Analysis
**File Path:** ${filePath}
**Character Range:** ${start} to ${end}
**Chunk Index:** ${chunkIndex}

---
### Source Code Segment:
\`\`\`
${fileContent}
\`\`\`
---

### Instructions:
Your job is to analyze this specific segment of the file. 
1. **Identify Structures:** List any classes, functions, or interface definitions that *start*, *end*, or are *contained* within this range.
2. **Method Signatures:** Extract full method signatures and their docstrings/comments.
3. **Purpose & Logic:** Summarize the primary purpose of this code block.
4. **Context Awareness:** If a definition is cut off at the beginning or end of this segment, note it as "Partial Definition" so the coding agent knows to look at adjacent chunks.

Only provide facts found within the provided text. Do not guess code that is not visible.
`;
}