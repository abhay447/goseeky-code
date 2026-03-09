import * as vscode from "vscode";
import { ChatManager } from "../providers";
import { AgentState, applyEdit, createFile, runShell, runAgenticLoop, switchProvider } from "./agentExecution";

export { AgentState };

export async function handleAgentMessage(
    state: AgentState,
    chatManager: ChatManager,
    context: vscode.ExtensionContext,
    lastActiveEditor: vscode.TextEditor | undefined,
    webviewView: vscode.WebviewView,
    msg: any
) {
    if (msg.type === "switchProvider") {
        await switchProvider(state, chatManager, context, webviewView);
    }

    if (msg.type === "ask") {
        if (!state.activeProvider) {
            webviewView.webview.postMessage({ type: "error", text: "No API key set. Run 'Goseeky: Set API Key'." });
            return;
        }
        const config = vscode.workspace.getConfiguration("goseeky-code");
        const temperature = config.get<number>("temperature", 0.0);
        await runAgenticLoop(state, chatManager, msg.text, temperature, webviewView);
    }

    if (msg.type === "applyEdit") {
        await applyEdit(msg.code, lastActiveEditor, webviewView);
    }

    if (msg.type === "createFile") {
        await createFile(msg.filename, msg.code, webviewView);
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