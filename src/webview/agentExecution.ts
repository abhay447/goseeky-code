import * as vscode from "vscode";
import { ChatManager, GeminiProvider, SarvamProvider } from "../providers";
import { buildSystemPrompt } from "./webviewRenderer";
import { runShell } from "../utils/shellUtils";

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

// ── Stop flag ─────────────────────────────────────────────────────────────────
let stopRequested = false;
export function isStopped(): boolean {
    return stopRequested;
}

export function resetStop(): void {
    stopRequested = false;
}

export function requestStop() {
    stopRequested = true;
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
            results.push(text.slice(idx + startTag.length).trim());
            break;
        }
        results.push(text.slice(idx + startTag.length, endIdx).trim());
        idx = text.indexOf(startTag, endIdx + endTag.length);
    }
    return results;
}

// ── Parse agent XML response ──────────────────────────────────────────────────
// Resilient: always extracts ALL <run-shell> commands from anywhere in the reply,
// regardless of how mangled the XML structure is.
export function parseAgentResponse(raw: string): AgentResponse {
    // Try to get goal/status from first <response> block if present
    const firstResponseStart = raw.indexOf("<response>");
    const firstResponseEnd = raw.indexOf("</response>");
    const firstBlock = (firstResponseStart !== -1 && firstResponseEnd !== -1)
        ? raw.slice(firstResponseStart, firstResponseEnd + "</response>".length)
        : raw;

    const goal = extractTag(firstBlock, "goal") || extractTag(raw, "goal");
    const stage = extractTag(firstBlock, "stage") || extractTag(raw, "stage");

    // Top-level status — extract from <response> block AFTER stripping sub-goals,
    // so sub-goal <status> tags don't bleed into the top-level status
    const responseBlockForStatus = firstBlock
        .replace(/<sub-goals>[\s\S]*?<\/sub-goals>/gi, "")
        .replace(/<sub-goal>[\s\S]*?<\/sub-goal>/gi, "");
    const topLevelStatuses = extractAllTags(responseBlockForStatus, "status");
    const status = topLevelStatuses[topLevelStatuses.length - 1] ?? "";

    // ── Extract commands only from non-FINISHED sub-goals ─────────────────────
    // Flat fallback: if no sub-goal blocks found, take all <run-shell> from reply
    let subGoals: SubGoal[] = [];
    const subGoalBlocks = extractAllTags(raw, "sub-goal");

    if (subGoalBlocks.length > 0) {
        subGoals = subGoalBlocks
            .map(sg => {
                const title = extractTag(sg, "title");
                const sgStatus = extractTag(sg, "status");
                const commandsBlock = extractTag(sg, "commands");
                const commands = extractAllTags(commandsBlock || sg, "run-shell");
                return { title, status: sgStatus, commands };
            })
            .filter(sg => !["FINISHED", "COMPLETED", "ABORTED", "TERMINATED"].includes(sg.status.toUpperCase()));
    } else {
        // Fallback: malformed XML — take all commands from entire reply
        const allCommands = extractAllTags(raw, "run-shell");
        if (allCommands.length > 0) {
            subGoals = [{ title: goal || "Executing", status: "INPROGRESS", commands: allCommands }];
        }
    }

    return { goal, stage, subGoals, status };
}

// ── Execute all sub-goals, collect results ────────────────────────────────────
async function executeSubGoals(
subGoals: SubGoal[], webviewView: vscode.WebviewView, alreadyRun: string[]): Promise<CommandResult[]> {
    const results: CommandResult[] = [];

    for (const sg of subGoals) {
        if (sg.commands.length === 0) { continue; }

        webviewView.webview.postMessage({
            type: "agentSubGoal",
            title: sg.title,
            status: sg.status
        });

        for (const command of sg.commands) {
            if (stopRequested) { return results; }
            if(alreadyRun.includes(command)){
                console.log("command already tried" + command)
                continue
            }

            webviewView.webview.postMessage({ type: "shellRunning", command });

            try {
                const { stdout, stderr } = await runShell(command);
                console.log("command outputs" + command + " || " + stdout + " || " + stderr)
                results.push({ command, stdout: stdout || "(no output)", stderr: stderr || "" });
                webviewView.webview.postMessage({
                    type: "shellResult",
                    command,
                    stdout: stdout || "(no output)",
                    stderr: stderr || ""
                });
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

            if (stopRequested) { return results; }
        }
    }

    return results;
}

// ── Format results for next AI turn ──────────────────────────────────────────
function formatResultsForAI(results: CommandResult[]): string {
    if (results.length === 0) { return "No commands were executed."; }
    return results.map(r => {
        const lines = [`$ ${r.command}`];
        if (r.error) {
            lines.push(`FAILED: ${r.error}`);
        } else {
            lines.push(`EXIT: success`);
            if (r.stdout && r.stdout !== "(no output)") {
                lines.push(`stdout:\n${r.stdout}`);
            } else {
                lines.push(`stdout: (empty — command ran successfully but produced no output)`);
            }
            if (r.stderr) {
                lines.push(`stderr:\n${r.stderr}`);
            }
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
    stopRequested = false;
    const MAX_ITERATIONS = 100;
    let iteration = 0;
    let accumulatedResults: CommandResult[] = [];
    let goalShown = false;
    let lastCommandSignature = "";
    let repeatedCommandCount = 0;
    const executedCommands = new Set<string>(); // track all commands run so far

    while (iteration < MAX_ITERATIONS) {
        iteration++;

        if (stopRequested) {
            webviewView.webview.postMessage({ type: "agentDone", status: "STOPPED" });
            return;
        }

        webviewView.webview.postMessage({ type: "agentIteration", iteration, max: MAX_ITERATIONS });

        const systemPrompt = buildSystemPrompt();
        const attemptsLeft = MAX_ITERATIONS - iteration;

        const alreadyRun = accumulatedResults.map(r => r.command);
        console.log("alreadyRun" + alreadyRun);
        const userMessage = accumulatedResults.length === 0
            ? userText
            : `Original goal: ${userText}\n\nCommands already executed (DO NOT repeat these):\n${alreadyRun.map(c => `- ${c}`).join("\n")}\n\nResults:\n${formatResultsForAI(accumulatedResults)}\n\nAttempts remaining: ${attemptsLeft}. Continue with NEW commands only. If the goal is achieved or cannot be achieved, set status to FINISHED or ABORTED.`;
        console.log(userMessage)
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

        if (stopRequested) {
            webviewView.webview.postMessage({ type: "agentDone", status: "STOPPED" });
            return;
        }

        const parsed = parseAgentResponse(reply);

        // Show goal once
        if (!goalShown && parsed.goal) {
            webviewView.webview.postMessage({ type: "agentGoal", goal: parsed.goal });
            goalShown = true;
        }

        // Show explanation text — prefer text before <response>, fall back to inside
        const firstResponseIdx = reply.indexOf("<response>");
        const lastResponseEnd = reply.lastIndexOf("</response>");
        const outsideResponse = firstResponseIdx !== -1
            ? reply.slice(0, firstResponseIdx).trim()
            : "";

        // Extract full inner content of all <response> blocks, strip XML tags, show as text
        const insideResponse = (firstResponseIdx !== -1 && lastResponseEnd !== -1)
            ? reply.slice(firstResponseIdx, lastResponseEnd + "</response>".length)
                .replace(/<\/?response>/g, "")
                .replace(/<goal>[\s\S]*?<\/goal>/g, "")
                .replace(/<stage>[\s\S]*?<\/stage>/g, "")
                .replace(/<status>[\s\S]*?<\/status>/g, "")
                .replace(/<sub-goals>[\s\S]*?<\/sub-goals>/g, "")
                .replace(/<sub-goal>[\s\S]*?<\/sub-goal>/g, "")
                .replace(/<commands>[\s\S]*?<\/commands>/g, "")
                .replace(/<run-shell>[\s\S]*?<\/run-shell>/g, "")
                .replace(/<title>[\s\S]*?<\/title>/g, "")
                .trim()
            : "";

        const displayText = outsideResponse || insideResponse;
        if (displayText) {
            webviewView.webview.postMessage({ type: "reply", text: displayText });
        }

        const hasCommands = parsed.subGoals.some(sg => sg.commands.length > 0);
        const terminalStatus = ["FINISHED", "COMPLETED", "ABORTED", "TERMINATED"].includes(parsed.status.toUpperCase());

        // If model omitted top-level <status> but all sub-goals are done, treat as terminal
        const allSubGoalsDone = parsed.subGoals.length > 0 &&
            parsed.subGoals.every(sg =>
                ["FINISHED", "COMPLETED", "ABORTED", "TERMINATED"].includes(sg.status.toUpperCase())
            );
        const effectivelyDone = terminalStatus || (allSubGoalsDone && !hasCommands);

        if (!hasCommands && !effectivelyDone && !displayText && parsed.goal) {
            webviewView.webview.postMessage({ type: "reply", text: parsed.goal });
        }

        if (hasCommands) {
            // Detect repeated commands — if same set of commands runs twice, break
            const currentSignature = parsed.subGoals
                .flatMap(sg => sg.commands)
                .join("|");

            // Check if ALL commands in this batch have already been run
            const allCommandsAlreadyRun = parsed.subGoals
                .flatMap(sg => sg.commands)
                .every(cmd => executedCommands.has(cmd.trim()));

            if (allCommandsAlreadyRun) {
                repeatedCommandCount++;
                if (repeatedCommandCount >= 3) {
                    webviewView.webview.postMessage({
                        type: "agentDone",
                        status: "ABORTED",
                        message: "Stuck in a loop — same commands repeated. Try rephrasing your request."
                    });
                    return;
                }
            } else {
                repeatedCommandCount = 0;
            }
            lastCommandSignature = currentSignature;

            const newResults = await executeSubGoals(parsed.subGoals, webviewView, alreadyRun);
            // Track all executed commands
            parsed.subGoals.flatMap(sg => sg.commands).forEach(cmd => executedCommands.add(cmd.trim()));
            accumulatedResults = [...accumulatedResults, ...newResults]; // append, not replace

            if (stopRequested) {
                webviewView.webview.postMessage({ type: "agentDone", status: "STOPPED" });
                return;
            }
        }

        if (effectivelyDone) {
            const finalStatus = terminalStatus ? parsed.status.toUpperCase() : "FINISHED";
            // If nothing was shown as a reply yet, summarize the last results
            if (!displayText && accumulatedResults.length > 0) {
                const summary = accumulatedResults
                    .map(r => r.error ? `Error: ${r.error}` : r.stdout && r.stdout !== "(no output)" ? r.stdout.trim() : "")
                    .filter(Boolean)
                    .join("\n");
                if (summary) {
                    webviewView.webview.postMessage({ type: "reply", text: summary });
                }
            }
            webviewView.webview.postMessage({ type: "agentDone", status: finalStatus });
            return;
        }

        // If no commands and not done — treat as finished
        if (!hasCommands) {
            webviewView.webview.postMessage({ type: "agentDone", status: "FINISHED" });
            return;
        }
    }

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