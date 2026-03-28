import * as vscode from "vscode";
import { ChatManager } from "../providers";
import { AgentState, applyEdit, createFile, switchProvider, requestStop } from "./agentExecution";
import { runShell } from "../utils/shellUtils";
import { ToolRegistry } from "../tools/toolRegistry";
import { MultiStepAgent } from "../agents/types";
import { GoSeekyAgent } from "../agents/goseekyAgent";

export { AgentState };

let goSeekyAgent: MultiStepAgent | null = null;

function getAgent(): MultiStepAgent {
    if (!goSeekyAgent) {
        goSeekyAgent = new GoSeekyAgent();
    }
    return goSeekyAgent;
}

export async function handleAgentMessage(
    state: AgentState,
    chatManager: ChatManager,
    toolRegistry: ToolRegistry,
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
        await getAgent().runAgenticLoop(state.activeProvider, msg.text, toolRegistry, context, webviewView);
    }

    if (msg.type === "stopAgent") {
        requestStop();
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
        // Clear both the passed-in chatManager and the agent's internal history
        chatManager.clear();
        getAgent().clearHistory();
        webviewView.webview.postMessage({ type: "historyCleared" });
    }
}