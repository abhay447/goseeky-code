import * as vscode from "vscode";
import * as cp from "child_process";


// ── Shell executor ────────────────────────────────────────────────────────────
export function runShell(command: string, cwd?: string): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
        const workspacePath = cwd ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
        cp.exec(command, { cwd: workspacePath, shell: "/bin/bash" }, (err, stdout, stderr) => {
            if (err) { reject(new Error(stderr || err.message)); }
            else { resolve({ stdout, stderr }); }
        });
    });
}