import * as vscode from "vscode";
import { AIProvider, ChatManager } from "../providers";
import { isStopped } from "../webview/agentExecution";
import { runShell } from "../utils/shellUtils";
import { buildGoalEvaluationPrompt, getExtensionContextInfo } from "./teamlead";

export enum AGENT_STATUS {
    STATUS_SUCCESS = "STATUS_SUCCESS",
    STATUS_FAILURE = "STATUS_FAILURE"
}

interface ExecutionResult {
    stdout: string;
    stderr: string;
}

interface CommandContext {
    goal_id?: string;
    goal?: string;
    command?: string;
    executionResult?: ExecutionResult;
    response?: string;
    timestamp?: number;
    reviewComments?: string;
    status?: AGENT_STATUS;
}

interface ReviewContext {
    latestAttempt: CommandContext;
    commandHistory: CommandContext[];
}

const MAX_ITERATIONS = 8;
const REVIEW_RESPONSE_SCORE_THRESHOLD = 3.5;

export class ShellAgent {

    buildSystemPrompt(): string {
        const envInfo = getExtensionContextInfo();
        return `
You are a File System agent which accepts user goals and tries to execute them using shell tool.
Here is the basic info about the current shell execution environment.
${envInfo}

If the goal_msg is a plain text response (not a file operation or data query),
your command should simply be: echo "<the goal_msg text>".

Based on the conversation history you need to respond with the following attributes:

{
    "goal" : <goal from input>,
    "response" : <empty if a command needs to be run>,
    "command" : <shell command to run — ALWAYS provide a command, use echo for text-only responses>
}

IMPORTANT: You MUST always provide a non-empty "command". If the goal requires a text response,
use: echo "<your response here>"
Never leave "command" empty or null.

Your conversation history will occasionally also contain inputs from your team lead who has analysed your previous attempts, use that to steer approach in right direction.
DO NOT REPLY ANYTHING other than JSON.
`;
    }

    private safeParseJSON(raw: string, label: string): any | null {
        try {
            const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
            return JSON.parse(cleaned);
        } catch (e) {
            console.error(`[ShellAgent] Failed to parse ${label} JSON:`, raw);
            return null;
        }
    }

    async runAgenticLoop(
        client: AIProvider,
        goalId: string,
        userGoal: string,
        context: vscode.ExtensionContext,
        webviewView?: vscode.WebviewView
    ): Promise<CommandContext> {
        let currentGoal = userGoal;
        const commandRunHistory: CommandContext[] = [];
        const subAgentChatManager = new ChatManager(context, `shell_agent.${goalId}`);
        const teamLeadChatManager = new ChatManager(context, `teamlead_eval.${goalId}`);
        subAgentChatManager.clear();
        teamLeadChatManager.clear();

        for (let i = 0; i < MAX_ITERATIONS; i++) {
            if (isStopped()) {
                return {
                    goal_id: goalId,
                    goal: currentGoal,
                    timestamp: Date.now(),
                    response: "Stopped by user",
                    status: AGENT_STATUS.STATUS_FAILURE
                };
            }

            let reply: string;
            try {
                reply = await subAgentChatManager.chat(
                    client,
                    { role: "system", content: this.buildSystemPrompt() },
                    { role: "user", content: currentGoal }
                );
            } catch (e: any) {
                return {
                    goal_id: goalId,
                    goal: currentGoal,
                    timestamp: Date.now(),
                    response: `API error: ${e.message}`,
                    status: AGENT_STATUS.STATUS_FAILURE
                };
            }

            if (isStopped()) {
                return {
                    goal_id: goalId,
                    goal: currentGoal,
                    timestamp: Date.now(),
                    response: "Stopped by user",
                    status: AGENT_STATUS.STATUS_FAILURE
                };
            }

            const parsedMsg = this.safeParseJSON(reply, "subagent");
            if (!parsedMsg) {
                commandRunHistory.push({
                    goal_id: goalId,
                    goal: currentGoal,
                    timestamp: Date.now(),
                    response: `Non-JSON reply from model: ${reply.slice(0, 200)}`,
                    status: AGENT_STATUS.STATUS_FAILURE
                });
                continue;
            }

            const response: string = parsedMsg["response"] ?? "";
            const command: string = (parsedMsg["command"] ?? "").trim();

            if (!command) {
                // Model disobeyed — if there's a response text, echo it as fallback
                const fallbackCommand = response
                    ? `echo "${response.replace(/"/g, '\\"')}"`
                    : null;

                if (fallbackCommand) {
                    const result = await runShell(fallbackCommand);
                    webviewView?.webview.postMessage({ type: "shellRunning", command: fallbackCommand });
                    webviewView?.webview.postMessage({
                        type: "shellResult",
                        command: fallbackCommand,
                        stdout: result.stdout || "(no output)",
                        stderr: result.stderr || ""
                    });
                    return {
                        goal_id: goalId,
                        goal: currentGoal,
                        command: fallbackCommand,
                        executionResult: { stdout: result.stdout, stderr: result.stderr },
                        response,
                        timestamp: Date.now(),
                        status: AGENT_STATUS.STATUS_SUCCESS
                    };
                }

                return {
                    goal_id: goalId,
                    goal: currentGoal,
                    timestamp: Date.now(),
                    response: response || "No command generated",
                    status: AGENT_STATUS.STATUS_FAILURE
                };
            }

            if (isStopped()) {
                return {
                    goal_id: goalId,
                    goal: currentGoal,
                    timestamp: Date.now(),
                    response: "Stopped by user",
                    status: AGENT_STATUS.STATUS_FAILURE
                };
            }

            let stdout = "";
            let stderr = "";
            try {
                const result = await runShell(command);
                stdout = result.stdout;
                stderr = result.stderr;
            } catch (e: any) {
                stderr = e.message;
            }

            webviewView?.webview.postMessage({ type: "shellRunning", command });
            webviewView?.webview.postMessage({
                type: "shellResult",
                command,
                stdout: stdout || "(no output)",
                stderr: stderr || ""
            });

            const currCtx: CommandContext = {
                goal_id: goalId,
                goal: currentGoal,
                command,
                executionResult: { stdout, stderr },
                response,
                timestamp: Date.now()
            };

            if (isStopped()) {
                return {
                    goal_id: goalId,
                    goal: currentGoal,
                    timestamp: Date.now(),
                    response: "Stopped by user",
                    status: AGENT_STATUS.STATUS_FAILURE
                };
            }

            const reviewCtx: ReviewContext = {
                latestAttempt: currCtx,
                commandHistory: commandRunHistory
            };

            let teamLeadReply: string;
            try {
                teamLeadReply = await teamLeadChatManager.chat(
                    client,
                    { role: "system", content: buildGoalEvaluationPrompt() },
                    { role: "user", content: JSON.stringify(reviewCtx) }
                );
            } catch (e: any) {
                currCtx.status = AGENT_STATUS.STATUS_SUCCESS;
                return currCtx;
            }

            const teamLeadParsed = this.safeParseJSON(teamLeadReply, "teamlead");
            if (!teamLeadParsed) {
                currCtx.status = AGENT_STATUS.STATUS_SUCCESS;
                return currCtx;
            }

            const reviewScore = (teamLeadParsed["subagent_response_score"] as number) ?? 0;

            if (reviewScore >= REVIEW_RESPONSE_SCORE_THRESHOLD) {
                currCtx.status = AGENT_STATUS.STATUS_SUCCESS;
                return currCtx;
            }

            currCtx.reviewComments = teamLeadParsed["review_comments"];
            currentGoal = teamLeadParsed["modified_goal"] ?? currentGoal;
            commandRunHistory.push(currCtx);
        }

        const last = commandRunHistory.at(-1);
        return {
            goal_id: goalId,
            goal: last?.goal ?? userGoal,
            command: last?.command,
            executionResult: last?.executionResult,
            timestamp: Date.now(),
            response: "Goal couldn't be finished in requisite number of iterations",
            reviewComments: last?.reviewComments,
            status: AGENT_STATUS.STATUS_FAILURE
        };
    }
}