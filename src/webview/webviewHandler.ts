import * as vscode from "vscode";
import { AIProvider, GeminiProvider, SarvamProvider } from "../providers";

export async function handleMessage(activeProvider: AIProvider | null, activeProviderName: String, context: vscode.ExtensionContext, lastActiveEditor: vscode.TextEditor | undefined, webviewView: vscode.WebviewView, msg: any) {

    // ── Switch provider ───────────────────────────────────────────
    if (msg.type === "switchProvider") {
        const pick = await vscode.window.showQuickPick(
            [
                {
                    label: "$(sparkle) Sarvam AI",
                    description: activeProviderName === "sarvam" ? "● active" : "",
                    detail: "sarvam-m — best for Indic languages",
                    id: "sarvam"
                },
                {
                    label: "$(globe) Gemini",
                    description: activeProviderName === "gemini" ? "● active" : "",
                    detail: "gemini-2.5-flash — Google's model",
                    id: "gemini"
                },
            ],
            { placeHolder: "Select AI provider" }
        );

        if (!pick) return;

        const key = await context.secrets.get(`goseeky.${pick.id}.apiKey`);
        if (!key) {
            const setNow = await vscode.window.showWarningMessage(
                `No API key found for ${pick.id}. Set it now?`,
                "Yes", "No"
            );
            if (setNow === "Yes") {
                await vscode.commands.executeCommand("goseeky-code.setApiKey");
            }
            return;
        }

        activeProviderName = pick.id as "sarvam" | "gemini";
        activeProvider = pick.id === "sarvam"
            ? new SarvamProvider(key)
            : new GeminiProvider(key);

        // Now post directly — we are still inside resolveWebviewView scope
        webviewView.webview.postMessage({
            type: "providerChanged",
            provider: activeProviderName
        });

        vscode.window.showInformationMessage(`✅ Switched to ${pick.id}`);
    }

    // ── Basic chat ────────────────────────────────────────────────
    if (msg.type === "ask") {
        if (!activeProvider) {
            webviewView.webview.postMessage({
                type: "error",
                text: "No API key set. Run 'Goseeky: Set API Key' from Command Palette."
            });
            return;
        }

        const client = activeProvider;

        try {
            const fileContext = getCurrentFileContext(lastActiveEditor);
            const systemPrompt = buildSystemPrompt(fileContext);
            const config = vscode.workspace.getConfiguration("goseeky-code");
            const temperature = config.get<number>("temperature", 0.2);

            const reply = await client.chat(
                [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: msg.text }
                ],
                { temperature }
            );

            // Check for HIGH confidence edit — auto apply
            const editMatch = reply.match(/<edit-file confidence="(\w+)">([\s\S]*?)<\/edit-file>/);
            if (editMatch) {
                const confidence = editMatch[1];
                const inner = editMatch[2];
                const codeMatch = inner.match(/```(?:\w+)?\n([\s\S]*?)```/);
                const code = codeMatch ? codeMatch[1] : inner.trim();
                const cleanReply = reply.replace(/<edit-file[\s\S]*?<\/edit-file>/, "").trim();

                if (confidence === "HIGH") {
                    const editor = vscode.window.activeTextEditor || lastActiveEditor;
                    if (editor) {
                        const edit = new vscode.WorkspaceEdit();
                        const fullRange = new vscode.Range(
                            editor.document.positionAt(0),
                            editor.document.positionAt(editor.document.getText().length)
                        );
                        edit.replace(editor.document.uri, fullRange, code);
                        await vscode.workspace.applyEdit(edit);
                        webviewView.webview.postMessage({
                            type: "reply",
                            text: cleanReply,
                            autoApplied: true,
                            confidence: "HIGH"
                        });
                    } else {
                        webviewView.webview.postMessage({
                            type: "reply",
                            text: cleanReply,
                            code,
                            confidence: "HIGH",
                            autoApplied: false
                        });
                    }
                } else {
                    webviewView.webview.postMessage({
                        type: "reply",
                        text: cleanReply,
                        code,
                        confidence: "LOW",
                        autoApplied: false
                    });
                }
                return;
            }

            // Check for create-file
            const createMatch = reply.match(/<create-file name="([^"]+)">([\s\S]*?)<\/create-file>/);
            if (createMatch) {
                const filename = createMatch[1];
                const inner = createMatch[2];
                const codeMatch = inner.match(/```(?:\w+)?\n([\s\S]*?)```/);
                const code = codeMatch ? codeMatch[1] : inner.trim();
                const cleanReply = reply.replace(/<create-file[\s\S]*?<\/create-file>/, "").trim();
                webviewView.webview.postMessage({
                    type: "reply",
                    text: cleanReply,
                    createFile: { filename, code }
                });
                return;
            }

            // Plain reply
            webviewView.webview.postMessage({ type: "reply", text: reply });

        } catch (e: any) {
            webviewView.webview.postMessage({ type: "error", text: e.message });
        }
    }

    // ── Read current file ─────────────────────────────────────────
    if (msg.type === "readFile") {
        const ctx = getCurrentFileContext(lastActiveEditor);
        if (ctx) {
            webviewView.webview.postMessage({ type: "fileContent", ...ctx });
        } else {
            webviewView.webview.postMessage({ type: "error", text: "No file open" });
        }
    }

    // ── Apply edit to current file ────────────────────────────────
    if (msg.type === "applyEdit") {
        const editor = vscode.window.activeTextEditor || lastActiveEditor;

        if (!editor) {
            const uri = await vscode.window.showSaveDialog({
                defaultUri: vscode.Uri.joinPath(
                    vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(""),
                    "new-file.ts"
                ),
                filters: {
                    "TypeScript": ["ts"],
                    "JavaScript": ["js"],
                    "Python": ["py"],
                    "All Files": ["*"]
                }
            });
            if (uri) {
                await vscode.workspace.fs.writeFile(uri, Buffer.from(msg.code, "utf8"));
                const doc = await vscode.workspace.openTextDocument(uri);
                await vscode.window.showTextDocument(doc);
                lastActiveEditor = vscode.window.activeTextEditor;
                webviewView.webview.postMessage({ type: "editApplied" });
            }
            return;
        }

        const edit = new vscode.WorkspaceEdit();
        const fullRange = new vscode.Range(
            editor.document.positionAt(0),
            editor.document.positionAt(editor.document.getText().length)
        );
        edit.replace(editor.document.uri, fullRange, msg.code);
        await vscode.workspace.applyEdit(edit);
        webviewView.webview.postMessage({ type: "editApplied" });
    }

    // ── Create new file ───────────────────────────────────────────
    if (msg.type === "createFile") {
        const uri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.joinPath(
                vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(""),
                msg.filename || "new-file.ts"
            ),
            filters: { "All Files": ["*"] }
        });
        if (uri) {
            await vscode.workspace.fs.writeFile(uri, Buffer.from(msg.code, "utf8"));
            const doc = await vscode.workspace.openTextDocument(uri);
            await vscode.window.showTextDocument(doc);
            lastActiveEditor = vscode.window.activeTextEditor;
            webviewView.webview.postMessage({ type: "editApplied" });
        }
    }

    // ── Open file picker ──────────────────────────────────────────
    if (msg.type === "openFile") {
        const uris = await vscode.window.showOpenDialog({ canSelectMany: false });
        if (uris && uris[0]) {
            const doc = await vscode.workspace.openTextDocument(uris[0]);
            await vscode.window.showTextDocument(doc);
            lastActiveEditor = vscode.window.activeTextEditor;
            webviewView.webview.postMessage({
                type: "fileContent",
                path: uris[0].fsPath,
                content: doc.getText(),
                language: doc.languageId
            });
        }
    }

    // ── List workspace files ──────────────────────────────────────
    if (msg.type === "listFiles") {
        const files = await vscode.workspace.findFiles("**/*", "**/node_modules/**", 50);
        const names = files.map(f => vscode.workspace.asRelativePath(f));
        webviewView.webview.postMessage({ type: "fileList", files: names });
    }

}

function getCurrentFileContext(lastActiveEditor: vscode.TextEditor | undefined) {
    const editor = vscode.window.activeTextEditor || lastActiveEditor;
    if (!editor) return null;
    return {
        path: editor.document.fileName,
        content: editor.document.getText(),
        language: editor.document.languageId,
        selection: editor.document.getText(editor.selection) || null
    };
}

function buildSystemPrompt(fileContext: ReturnType<typeof getCurrentFileContext>): string {
    const fileSection = fileContext
        ? `The user currently has this file open (${fileContext.language}):
\`\`\`${fileContext.language}
${fileContext.content}
\`\`\`
${fileContext.selection ? `\nSelected text:\n\`\`\`\n${fileContext.selection}\n\`\`\`` : ""}`
        : "No file is currently open.";

    return `You are Goseeky, a helpful AI coding assistant integrated into VS Code.
You can respond in English or any Indian language the user writes in (Hindi, Kannada, Tamil, Telugu, Bengali, etc.).

${fileSection}

IMPORTANT RULES:
- When the user asks you to CREATE a new file, end your response with this exact format:
<create-file name="filename.ext">
\`\`\`language
code here
\`\`\`
</create-file>

- When editing the existing open file, wrap your code with a confidence tag:
<edit-file confidence="HIGH">
\`\`\`language
full updated code here
\`\`\`
</edit-file>

Use confidence="HIGH" when the request is clear and unambiguous.
Use confidence="LOW" when the request is vague or you are unsure.

- Always use code blocks with the correct language identifier.
- Be concise and practical.`;
}