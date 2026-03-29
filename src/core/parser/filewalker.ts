import fs from "fs";
import path from "path";
import ignore from "ignore";
import { getExtractorForFile } from "./registry";

export function walkDir(root: string): string[] {
    const ig = ignore();

    // =========================
    // Load .gitignore
    // =========================
    const gitignorePath = path.join(root, ".gitignore");
    if (fs.existsSync(gitignorePath)) {
        ig.add(fs.readFileSync(gitignorePath, "utf-8"));
    }

    // =========================
    // Global ignores
    // =========================
    ig.add([
        ".git",
        "node_modules",
        "dist",
        "build",
        ".next",
        ".turbo",
        ".cache",
        "__pycache__",
        "*.pyc",
        ".venv",
        "venv",
        ".mypy_cache",
        ".pytest_cache",
        "coverage",
        "*.log",
        ".idea",
        ".vscode",
    ]);

    const results: string[] = [];

    function walk(current: string) {
        const relPath = path.relative(root, current);

        // ✅ HARD GUARD — NEVER call ignore on empty
        if (relPath === "") {
            // root directory — always allow
        } else {
            const normalized = relPath.split(path.sep).join("/");
            if (normalized.length > 0 && ig.ignores(normalized)) {
                return;
            }
        }

        let stat;
        try {
            stat = fs.statSync(current);
            
        } catch(e) {
            console.error(e)
            return;
        }

        if (stat.isDirectory()) {
            let files: string[];
            try {
                files = fs.readdirSync(current);
            } catch(e) {
                console.error(e)
                return;
            }

            for (const file of files) {
                walk(path.join(current, file));
            }
        } else {
            // if (!getExtractorForFile(current)) return;
            results.push(current);
        }
    }

    walk(root);
    return results;
}