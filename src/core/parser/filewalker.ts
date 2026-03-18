// src/core/fileWalker.ts
import fs from "fs";
import path from "path";

export function walkDir(dir: string): string[] {
  let results: string[] = [];

  const list = fs.readdirSync(dir);
  list.forEach((file) => {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);

    if (stat && stat.isDirectory()) {
      results = results.concat(walkDir(fullPath));
    } else {
      results.push(fullPath);
    }
  });

  return results;
}