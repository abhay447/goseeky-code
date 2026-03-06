import * as vscode from "vscode";
import * as cp from "child_process";
import { ChatManager, GeminiProvider, SarvamProvider } from "../providers";
import { buildSystemPrompt, getCurrentFileContext } from "./webviewRenderer";

export interface AgentState {
    activeProvider: SarvamProvider | GeminiProvider | null;
    activeProviderName: "sarvam" | "gemini";
}

// ── Types ─────────────────────────────────────────────────────────────────────
interface SubGoal {
    title: string;
    status: string;
    commands: string[];
}

interface AgentResponse {
    goal: string;
    stage: string;
    subGoals: SubGoal[];
    status: string;
}

interface CommandResult {
    command: string;
    stdout: string;
    stderr: string;
    error?: string;
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

// ── XML helpers ───────────────────────────────────────────────────────────────
function extractTag(text: string, tag: string): string {
    const startTag = `<${tag}>`;
    const endTag = `</${tag}>`;
    const start = text.indexOf(startTag);
    const end = text.indexOf(endTag);
    if (start === -1 || end === -1) { return ""; }
    return text.slice(start + startTag.length, end).trim();
}

function extractAllTags(text: string, tag: string): string[] {
    const results: string[] = [];
    const startTag = `<${tag}>`;
    const endTag = `</${tag}>`;
    let idx = text.indexOf(startTag);
    while (idx !== -1) {
        const endIdx = text.indexOf(endTag, idx + startTag.length);
        if (endIdx === -1) {
            // unclosed — take to end of string
            results.push(text.slice(idx + startTag.length).trim());
            break;
        }
        results.push(text.slice(idx + startTag.length, endIdx).trim());
        idx = text.indexOf(startTag, endIdx + endTag.length);
    }
    return results;
}

// ── Parse agent XML response ──────────────────────────────────────────────────
export function parseAgentResponse(raw: string): AgentResponse {
    const responseBlock = extractTag(raw, "response") || raw;

    const goal = extractTag(responseBlock, "goal");
    const stage = extractTag(responseBlock, "stage");

    // Extract top-level status — last one wins to avoid matching sub-goal status
    const allStatuses = extractAllTags(responseBlock, "status");
    const status = allStatuses[allStatuses.length - 1] ?? "";

    const subGoalBlocks = extractAllTags(responseBlock, "sub-goal");
    const subGoals: SubGoal[] = subGoalBlocks.map(sg => {
        const title = extractTag(sg, "title");
        const sgStatus = extractTag(sg, "status");
        const commandsBlock = extractTag(sg, "commands");
        const commands = extractAllTags(commandsBlock || sg, "run-shell");
        return { title, status: sgStatus, commands };
    });

    return { goal, stage, subGoals, status };
}

// ── Execute all sub-goals, collect results ────────────────────────────────────
async function executeSubGoals(
    subGoals: SubGoal[],
    webviewView: vscode.WebviewView
): Promise<CommandResult[]> {
    const results: CommandResult[] = [];

    for (const sg of subGoals) {
        if (sg.commands.length === 0) { continue; }

        webviewView.webview.postMessage({
            type: "agentSubGoal",
            title: sg.title,
            status: sg.status
        });

        for (const command of sg.commands) {
            webviewView.webview.postMessage({ type: "shellRunning", command });

            try {
                const { stdout, stderr } = await runShell(command);
                results.push({ command, stdout: stdout || "(no output)", stderr: stderr || "" });
                webviewView.webview.postMessage({
                    type: "shellResult",
                    command,
                    stdout: stdout || "(no output)",
                    stderr: stderr || ""
                });
                // Reload editor after each file-touching command
                await vscode.commands.executeCommand("workbench.action.files.revert");
            } catch (e: any) {
                results.push({ command, stdout: "", stderr: "", error: e.message });
                webviewView.webview.postMessage({
                    type: "shellResult",
                    command,
                    stdout: "",
                    stderr: e.message
                });
            }
        }
    }

    return results;
}

// ── Format results for next AI turn ──────────────────────────────────────────
function formatResultsForAI(results: CommandResult[]): string {
    if (results.length === 0) { return "No commands were executed."; }
    return results.map(r => {
        const lines = [`$ ${r.command}`];
        if (r.error) { lines.push(`ERROR: ${r.error}`); }
        else {
            if (r.stdout) { lines.push(`stdout:\n${r.stdout}`); }
            if (r.stderr) { lines.push(`stderr:\n${r.stderr}`); }
        }
        return lines.join("\n");
    }).join("\n---\n");
}

// ── Agentic loop ──────────────────────────────────────────────────────────────
export async function runAgenticLoop(
    state: AgentState,
    chatManager: ChatManager,
    userText: string,
    temperature: number,
    webviewView: vscode.WebviewView
): Promise<void> {
    const MAX_ITERATIONS = 8;
    let iteration = 0;
    let accumulatedResults: CommandResult[] = [];
    let goalShown = false;

    while (iteration < MAX_ITERATIONS) {
        iteration++;

        webviewView.webview.postMessage({ type: "agentIteration", iteration, max: MAX_ITERATIONS });

        // Rebuild system prompt with latest file context each iteration
        const fileContext = getCurrentFileContext(undefined);
        const systemPrompt = buildSystemPrompt();

        // On first turn use raw user text; subsequent turns feed back results
        const userMessage = accumulatedResults.length === 0
            ? userText
            : `Original goal: ${userText}\n\nResults from previous commands:\n${formatResultsForAI(accumulatedResults)}\n\nContinue working towards the goal. If done, set status to FINISHED.`;

        let reply: string;
        try {
            reply = await chatManager.chat(
                state.activeProvider!,
                { role: "system", content: systemPrompt },
                { role: "user", content: userMessage },
                { temperature }
            );
        } catch (e: any) {
            webviewView.webview.postMessage({ type: "error", text: e.message });
            return;
        }

        const parsed = parseAgentResponse(reply);

        // Show goal once
        if (!goalShown && parsed.goal) {
            webviewView.webview.postMessage({ type: "agentGoal", goal: parsed.goal });
            goalShown = true;
        }

        // Show any explanation text outside the XML block
        const cleanReply = reply.replace(/<response>[\s\S]*<\/response>/g, "").trim();
        if (cleanReply) {
            webviewView.webview.postMessage({ type: "reply", text: cleanReply });
        }

        // Check for terminal status before executing
        const terminalStatus = ["FINISHED", "ABORTED", "TERMINATED"].includes(parsed.status.toUpperCase());
        const hasCommands = parsed.subGoals.some(sg => sg.commands.length > 0);

        if (!hasCommands && !terminalStatus) {
            // AI returned no commands and no terminal status — treat as done
            webviewView.webview.postMessage({ type: "agentDone", status: "FINISHED" });
            return;
        }

        if (hasCommands) {
            const iterationResults = await executeSubGoals(parsed.subGoals, webviewView);
            accumulatedResults = iterationResults; // pass only latest results to next turn
        }

        if (terminalStatus) {
            webviewView.webview.postMessage({ type: "agentDone", status: parsed.status.toUpperCase() });
            return;
        }

        // INPROGRESS — loop again with results
    }

    // Hit max iterations
    webviewView.webview.postMessage({
        type: "agentDone",
        status: "MAX_ITERATIONS",
        message: `Reached max iterations (${MAX_ITERATIONS}). Review results above.`
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
            defaultUri: vscode.Uri.joinPath(vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(""), "new-file.ts"),
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
        const edit = new vscode.WorkspaceEdit();
        const fullRange = new vscode.Range(editor.document.positionAt(0), editor.document.positionAt(editor.document.getText().length));
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
        defaultUri: vscode.Uri.joinPath(vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(""), filename || "new-file.ts"),
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