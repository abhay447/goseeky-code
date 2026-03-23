import * as vscode from "vscode";
import { AIProvider, ChatManager } from "../providers";
import { isStopped } from "../webview/agentExecution";
import { runShell } from "../utils/shellUtils";
import { buildGoalEvaluationPrompt, getExtensionContextInfo } from "./teamlead";
import { ToolRegistry } from "../tools/toolRegistry";
import { stringToSingleJsonBlock } from "../utils/jsonUtils";

export enum AGENT_STATUS {
    STATUS_SUCCESS = "STATUS_SUCCESS",
    STATUS_FAILURE = "STATUS_FAILURE"
}

interface ExecutionResult {
    stdout: string;
    stderr: string;
}

interface Command {
    tool: string
    arguments: Record<string, unknown>
}

interface CommandContext {
    goal_id?: string;
    goal?: string;
    tool?: string;
    arguments?: Record<string, unknown>;
    executionResult?: string;
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

export class CodeAgent {
    toolRegistry: ToolRegistry;
    constructor(toolRegistry: ToolRegistry){
        this.toolRegistry = toolRegistry;
    }
    buildSystemPrompt(): string {
        const envInfo = getExtensionContextInfo();
        return `
You are a coding System agent which accepts user goals and tries to execute them tools at hand.

${this.toolRegistry.listToolsPrompt()}

Here is the basic info about the current shell execution environment.
${envInfo}

Based on the conversation history you need to respond with the following attributes:

{
    "goal" : <goal from input>,
    "tool" : <tool_name>,
    "arguments" : {ARGUMENTS_JSON_AS_PER_TOOL_DETAILS, should be valid json}
}

IMPORTANT:
1. You MUST always provide a non-empty "tool" and "arguments". If the goal requires a text response,
    use: tool=ShellExecute arguments={"shell_command" : "echo \"<msg to user>\" "} .
2. Never leave "tool" and "arguments"  empty or null.
3. arguments field should always comply with argument schema of selected tool
4. Try to avoid retries of tool+argument combinations unless there is a strong reason for it.

Your conversation history will occasionally also contain inputs from your team lead who has analysed your previous attempts, use that to steer approach in right direction.
DO NOT REPLY ANYTHING other than JSON.
`;
    }

    private safeParseJSON(raw: string, label: string): any | null {
        try {
            const cleaned = stringToSingleJsonBlock(raw)!.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
            return JSON.parse(cleaned);
        } catch (e) {
            console.error(`[CodeAgent] Failed to parse ${label} JSON:`, raw);
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
        const subAgentChatManager = new ChatManager(context, `code_agent.${goalId}`);
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
                )!;
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
            console.log("subagent reply " + reply)
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
            console.log("parsedMsg " + JSON.stringify(parsedMsg))
            const response: string = parsedMsg["response"] ?? "";
            const tool: string = (parsedMsg["tool"] ?? "").trim();
            const args = (parsedMsg["arguments"]);
            const command = {"tool": tool, "arguments": args}

            if (!tool) {
                // Model disobeyed — if there's a response text, echo it as fallback
                const fallbackCommand: Command|null = response
                    ? {
                        "tool" : "ShellExecute",
                        "arguments": {"shell_command": "echo ${response}" }
                    }
                    : null;

                if (fallbackCommand) {
                    const result = await this.toolRegistry.executeTool(fallbackCommand.tool, fallbackCommand.arguments);
                    webviewView?.webview.postMessage({ type: "toolRunning", command: fallbackCommand });
                    webviewView?.webview.postMessage({
                        type: "toolResult",
                        tool: fallbackCommand.tool,
                        arguments: fallbackCommand.arguments,
                        result: result || "(no output)",
                    });
                    return {
                        goal_id: goalId,
                        goal: currentGoal,
                        tool: fallbackCommand.tool,
                        arguments: fallbackCommand.arguments,
                        executionResult: result,
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
            let result = null;
            try {
                result = await this.toolRegistry.executeTool(tool, args);
            } catch (e: any) {
                result = e.message;
            }

            webviewView?.webview.postMessage({ type: "toolRunning", command });
            webviewView?.webview.postMessage({
                type: "toolResult",
                tool: tool,
                arguments: args,
                result: result || "(no output)",
            });

            const currCtx: CommandContext = {
                goal_id: goalId,
                goal: currentGoal,
                tool: tool,
                arguments: args,
                executionResult: result,
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
                )!;
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
            tool: last?.tool,
            arguments: last?.arguments,
            executionResult: last?.executionResult,
            timestamp: Date.now(),
            response: "Goal couldn't be finished in requisite number of iterations",
            reviewComments: last?.reviewComments,
            status: AGENT_STATUS.STATUS_FAILURE
        };
    }
}