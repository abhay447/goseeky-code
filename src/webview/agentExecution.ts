import * as vscode from "vscode";
import * as cp from "child_process";
import { ChatManager, GeminiProvider, SarvamProvider } from "../providers";

export interface AgentState {
    activeProvider: SarvamProvider | GeminiProvider | null;
    activeProviderName: "sarvam" | "gemini";
}

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

// ── Shell command extractor — handles unclosed tags ───────────────────────────
export function extractShellCommands(text: string): string[] {
    const commands: string[] = [];
    const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const startTag = '<run-shell>';
    const endTag = '</run-shell>';
    let startIdx = normalized.indexOf(startTag);
    while (startIdx !== -1) {
        const contentStart = startIdx + startTag.length;
        const endIdx = normalized.indexOf(endTag, contentStart);
        const command = endIdx === -1
            ? normalized.slice(contentStart).trim()
            : normalized.slice(contentStart, endIdx).trim();
        if (command) { commands.push(command); }
        if (endIdx === -1) { break; }
        startIdx = normalized.indexOf(startTag, endIdx + endTag.length);
    }
    return commands;
}

// ── Remove shell blocks from reply text ───────────────────────────────────────
export function removeShellBlocks(text: string): string {
    let result = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const startTag = '<run-shell>';
    const endTag = '</run-shell>';
    let startIdx = result.indexOf(startTag);
    while (startIdx !== -1) {
        const endIdx = result.indexOf(endTag, startIdx);
        result = endIdx === -1
            ? result.slice(0, startIdx).trim()
            : result.slice(0, startIdx) + result.slice(endIdx + endTag.length);
        startIdx = result.indexOf(startTag);
    }
    return result.trim();
}

// ── Run commands sequentially and post results to webview ─────────────────────
export async function runCommandsSequentially(
    commands: string[],
    webviewView: vscode.WebviewView
): Promise<void> {
    for (const command of commands) {
        webviewView.webview.postMessage({ type: "shellRunning", command });
        try {
            const { stdout, stderr } = await runShell(command);
            webviewView.webview.postMessage({
                type: "shellResult",
                command,
                stdout: stdout || "(no output)",
                stderr: stderr || ""
            });
            await vscode.commands.executeCommand("workbench.action.files.revert");
        } catch (e: any) {
            webviewView.webview.postMessage({
                type: "shellResult",
                command,
                stdout: "",
                stderr: e.message
            });
            break; // Stop on failure
        }
    }
}

// ── Ask AI and handle reply ───────────────────────────────────────────────────
export async function askAI(
    state: AgentState,
    chatManager: ChatManager,
    systemPrompt: string,
    userText: string,
    temperature: number,
    webviewView: vscode.WebviewView
): Promise<void> {
    const client = state.activeProvider!;

    const reply = await chatManager.chat(
        client,
        { role: "system", content: systemPrompt },
        { role: "user", content: userText },
        { temperature }
    );

    const commands = extractShellCommands(reply);

    if (commands.length > 0) {
        const cleanReply = removeShellBlocks(reply);
        if (cleanReply) {
            webviewView.webview.postMessage({ type: "reply", text: cleanReply });
        }
        await runCommandsSequentially(commands, webviewView);
        return;
    }

    webviewView.webview.postMessage({
        type: "reply",
        text: reply,
        historySize: chatManager.size()
    });
}

// ── Apply edit to file ────────────────────────────────────────────────────────
export async function applyEdit(
    code: string,
    lastActiveEditor: vscode.TextEditor | undefined,
    webviewView: vscode.WebviewView
): Promise<void> {
    const editor = vscode.window.activeTextEditor || lastActiveEditor;

    if (!editor) {
        const uri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.joinPath(
                vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(""),
                "new-file.ts"
            ),
            filters: { "All Files": ["*"] }
        });
        if (uri) {
            await vscode.workspace.fs.writeFile(uri, Buffer.from(code, "utf8"));
            const doc = await vscode.workspace.openTextDocument(uri);
            await vscode.window.showTextDocument(doc);
            webviewView.webview.postMessage({ type: "editApplied" });
        }
        return;
    }

    const filePath = editor.document.uri.fsPath;
    try {
        await runShell(`cat > '${filePath}' << 'GOSEEKY_EOF'\n${code}\nGOSEEKY_EOF`);
        await vscode.commands.executeCommand("workbench.action.files.revert");
        webviewView.webview.postMessage({ type: "editApplied" });
    } catch (e: any) {
        // Fallback to VS Code API
        const edit = new vscode.WorkspaceEdit();
        const fullRange = new vscode.Range(
            editor.document.positionAt(0),
            editor.document.positionAt(editor.document.getText().length)
        );
        edit.replace(editor.document.uri, fullRange, code);
        await vscode.workspace.applyEdit(edit);
        webviewView.webview.postMessage({ type: "editApplied" });
    }
}

// ── Create new file ───────────────────────────────────────────────────────────
export async function createFile(
    filename: string,
    code: string,
    webviewView: vscode.WebviewView
): Promise<void> {
    const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.joinPath(
            vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(""),
            filename || "new-file.ts"
        ),
        filters: { "All Files": ["*"] }
    });
    if (uri) {
        try {
            await runShell(`cat > '${uri.fsPath}' << 'GOSEEKY_EOF'\n${code}\nGOSEEKY_EOF`);
            const doc = await vscode.workspace.openTextDocument(uri);
            await vscode.window.showTextDocument(doc);
            webviewView.webview.postMessage({ type: "editApplied" });
        } catch (e: any) {
            await vscode.workspace.fs.writeFile(uri, Buffer.from(code, "utf8"));
            const doc = await vscode.workspace.openTextDocument(uri);
            await vscode.window.showTextDocument(doc);
            webviewView.webview.postMessage({ type: "editApplied" });
        }
    }
}

// ── Switch provider ───────────────────────────────────────────────────────────
export async function switchProvider(
    state: AgentState,
    chatManager: ChatManager,
    context: vscode.ExtensionContext,
    webviewView: vscode.WebviewView
): Promise<void> {
    const pick = await vscode.window.showQuickPick([
        { label: "$(sparkle) Sarvam AI", description: state.activeProviderName === "sarvam" ? "● active" : "", detail: "sarvam-m", id: "sarvam" },
        { label: "$(globe) Gemini", description: state.activeProviderName === "gemini" ? "● active" : "", detail: "gemini-2.0-flash-lite", id: "gemini" },
    ], { placeHolder: "Select AI provider" });

    if (!pick) { return; }

    const key = await context.secrets.get(`goseeky.${pick.id}.apiKey`);
    if (!key) {
        const setNow = await vscode.window.showWarningMessage(`No API key for ${pick.id}. Set it now?`, "Yes", "No");
        if (setNow === "Yes") { await vscode.commands.executeCommand("goseeky-code.setApiKey"); }
        return;
    }

    state.activeProviderName = pick.id as "sarvam" | "gemini";
    state.activeProvider = pick.id === "sarvam" ? new SarvamProvider(key) : new GeminiProvider(key);
    chatManager.clear();

    webviewView.webview.postMessage({ type: "providerChanged", provider: state.activeProviderName });
    vscode.window.showInformationMessage(`Switched to ${pick.id} — history cleared`);
}