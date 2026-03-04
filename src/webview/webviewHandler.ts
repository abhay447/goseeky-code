import * as vscode from "vscode";
import * as cp from "child_process";
import { ChatManager, GeminiProvider, SarvamProvider } from "../providers";

export interface AgentState {
    activeProvider: SarvamProvider | GeminiProvider | null;
    activeProviderName: "sarvam" | "gemini";
}

function extractShellCommands(text: string): string[] {
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

function removeShellBlocks(text: string): string {
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

function runShell(command: string, cwd?: string): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
        const workspacePath = cwd ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
        cp.exec(command, { cwd: workspacePath, shell: "/bin/bash" }, (err, stdout, stderr) => {
            if (err) { reject(new Error(stderr || err.message)); }
            else { resolve({ stdout, stderr }); }
        });
    });
}

export async function handleAgentMessage(
    state: AgentState,
    chatManager: ChatManager,
    context: vscode.ExtensionContext,
    lastActiveEditor: vscode.TextEditor | undefined,
    webviewView: vscode.WebviewView,
    msg: any
) {
    if (msg.type === "switchProvider") {
        const pick = await vscode.window.showQuickPick([
            { label: "$(sparkle) Sarvam AI", description: state.activeProviderName === "sarvam" ? "active" : "", detail: "sarvam-m", id: "sarvam" },
            { label: "$(globe) Gemini", description: state.activeProviderName === "gemini" ? "active" : "", detail: "gemini-2.0-flash-lite", id: "gemini" },
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

    if (msg.type === "ask") {
        if (!state.activeProvider) {
            webviewView.webview.postMessage({ type: "error", text: "No API key set. Run 'Goseeky: Set API Key'." });
            return;
        }
        const client = state.activeProvider;
        try {
            const fileContext = getCurrentFileContext(lastActiveEditor);
            const systemPrompt = buildSystemPrompt(fileContext);
            const config = vscode.workspace.getConfiguration("goseeky-code");
            const temperature = config.get<number>("temperature", 0.2);

            const reply = await chatManager.chat(
                client,
                { role: "system", content: systemPrompt },
                { role: "user", content: msg.text },
                { temperature }
            );

            const commands = extractShellCommands(reply);

            if (commands.length > 0) {
                const cleanReply = removeShellBlocks(reply);
                if (cleanReply) {
                    webviewView.webview.postMessage({ type: "reply", text: cleanReply });
                }
                for (const command of commands) {
                    webviewView.webview.postMessage({ type: "shellRunning", command });
                    try {
                        const { stdout, stderr } = await runShell(command);
                        webviewView.webview.postMessage({ type: "shellResult", command, stdout: stdout || "(no output)", stderr: stderr || "" });
                        await vscode.commands.executeCommand("workbench.action.files.revert");
                    } catch (e: any) {
                        webviewView.webview.postMessage({ type: "shellResult", command, stdout: "", stderr: e.message });
                        break;
                    }
                }
                return;
            }

            webviewView.webview.postMessage({ type: "reply", text: reply, historySize: chatManager.size() });

        } catch (e: any) {
            webviewView.webview.postMessage({ type: "error", text: e.message });
        }
    }

    if (msg.type === "readFile") {
        const ctx = getCurrentFileContext(lastActiveEditor);
        if (!ctx) { webviewView.webview.postMessage({ type: "error", text: "No file open" }); return; }
        try {
            const { stdout } = await runShell(`cat "${ctx.path}"`);
            webviewView.webview.postMessage({ type: "fileContent", path: ctx.path, content: stdout, language: ctx.language });
        } catch (e: any) { webviewView.webview.postMessage({ type: "error", text: e.message }); }
    }

    if (msg.type === "applyEdit") {
        const editor = vscode.window.activeTextEditor || lastActiveEditor;
        if (!editor) {
            const uri = await vscode.window.showSaveDialog({
                defaultUri: vscode.Uri.joinPath(vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(""), "new-file.ts"),
                filters: { "All Files": ["*"] }
            });
            if (uri) {
                await vscode.workspace.fs.writeFile(uri, Buffer.from(msg.code, "utf8"));
                const doc = await vscode.workspace.openTextDocument(uri);
                await vscode.window.showTextDocument(doc);
                webviewView.webview.postMessage({ type: "editApplied" });
            }
            return;
        }
        const filePath = editor.document.uri.fsPath;
        try {
            await runShell(`cat > '${filePath}' << 'GOSEEKY_EOF'\n${msg.code}\nGOSEEKY_EOF`);
            await vscode.commands.executeCommand("workbench.action.files.revert");
            webviewView.webview.postMessage({ type: "editApplied" });
        } catch (e: any) {
            const edit = new vscode.WorkspaceEdit();
            const fullRange = new vscode.Range(editor.document.positionAt(0), editor.document.positionAt(editor.document.getText().length));
            edit.replace(editor.document.uri, fullRange, msg.code);
            await vscode.workspace.applyEdit(edit);
            webviewView.webview.postMessage({ type: "editApplied" });
        }
    }

    if (msg.type === "createFile") {
        const uri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.joinPath(vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(""), msg.filename || "new-file.ts"),
            filters: { "All Files": ["*"] }
        });
        if (uri) {
            try {
                await runShell(`cat > '${uri.fsPath}' << 'GOSEEKY_EOF'\n${msg.code}\nGOSEEKY_EOF`);
                const doc = await vscode.workspace.openTextDocument(uri);
                await vscode.window.showTextDocument(doc);
                webviewView.webview.postMessage({ type: "editApplied" });
            } catch (e: any) {
                await vscode.workspace.fs.writeFile(uri, Buffer.from(msg.code, "utf8"));
                const doc = await vscode.workspace.openTextDocument(uri);
                await vscode.window.showTextDocument(doc);
                webviewView.webview.postMessage({ type: "editApplied" });
            }
        }
    }

    if (msg.type === "openFile") {
        const uris = await vscode.window.showOpenDialog({ canSelectMany: false });
        if (uris && uris[0]) {
            try {
                const { stdout } = await runShell(`cat "${uris[0].fsPath}"`);
                const doc = await vscode.workspace.openTextDocument(uris[0]);
                await vscode.window.showTextDocument(doc);
                lastActiveEditor = vscode.window.activeTextEditor;
                webviewView.webview.postMessage({ type: "fileContent", path: uris[0].fsPath, content: stdout, language: doc.languageId });
            } catch (e: any) { webviewView.webview.postMessage({ type: "error", text: e.message }); }
        }
    }

    if (msg.type === "listFiles") {
        const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        try {
            const { stdout } = await runShell(`find . -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/out/*' -type f`, cwd);
            const names = stdout.trim().split("\n").filter(Boolean);
            webviewView.webview.postMessage({ type: "fileList", files: names });
        } catch (e: any) { webviewView.webview.postMessage({ type: "error", text: e.message }); }
    }

    if (msg.type === "runShell") {
        try {
            const { stdout, stderr } = await runShell(msg.command);
            webviewView.webview.postMessage({ type: "shellResult", command: msg.command, stdout: stdout || "(no output)", stderr: stderr || "" });
        } catch (e: any) {
            webviewView.webview.postMessage({ type: "shellResult", command: msg.command, stdout: "", stderr: e.message });
        }
    }

    if (msg.type === "clearHistory") {
        chatManager.clear();
        webviewView.webview.postMessage({ type: "historyCleared" });
    }
}

function getCurrentFileContext(lastActiveEditor: vscode.TextEditor | undefined) {
    const editor = vscode.window.activeTextEditor || lastActiveEditor;
    if (!editor) { return null; }
    return {
        path: editor.document.fileName,
        content: editor.document.getText(),
        language: editor.document.languageId,
        selection: editor.document.getText(editor.selection) || null
    };
}

function buildSystemPrompt(fileContext: ReturnType<typeof getCurrentFileContext>): string {
    let fileSection = "No file is currently open.";
    if (fileContext) {
        const numbered = fileContext.content.split("\n").map((line, i) => `${String(i + 1).padStart(4, " ")} | ${line}`).join("\n");
        fileSection = `The user currently has this file open: ${fileContext.path} (${fileContext.language})\n\n\`\`\`${fileContext.language}\n${numbered}\n\`\`\`${fileContext.selection ? `\n\nSelected text:\n\`\`\`\n${fileContext.selection}\n\`\`\`` : ""}`;
    }

    return `You are Goseeky, a precise AI coding assistant integrated into VS Code.
You can respond in English or any Indian language the user writes in.

${fileSection}

IMPORTANT: USE SHELL COMMANDS FOR ALL FILE OPERATIONS.
Wrap EVERY shell command with BOTH opening AND closing tags. The closing tag </run-shell> is MANDATORY.

Example - creating a file:
<run-shell>
cat > path/to/file.ts << 'GOSEEKY_EOF'
content here
GOSEEKY_EOF
</run-shell>

Example - simple command:
<run-shell>ls -la</run-shell>

Example - replacing full file:
<run-shell>
cat > path/to/file.ts << 'GOSEEKY_EOF'
full new content
GOSEEKY_EOF
</run-shell>

Example - targeted line edit (use exact line numbers from file above):
<run-shell>sed -i '' '10,15d' path/to/file.ts</run-shell>

Example - insert after line N:
<run-shell>
sed -i '' 'Na\\
new content
' path/to/file.ts
</run-shell>

Example - install package:
<run-shell>npm install express</run-shell>

RULES:
- EVERY <run-shell> MUST have a </run-shell> closing tag. No exceptions.
- NEVER use <edit-file> or <create-file> — shell only.
- Use exact line numbers from the numbered file shown above.
- On macOS: sed -i '' (with empty string argument).
- Prefer heredoc over sed for multi-line changes.
- Explain commands before the shell block.
- Be concise and practical.`;
}