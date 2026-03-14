import * as vscode from "vscode";
import * as os from 'os';
import * as process from 'process';
import { AIProvider, ChatManager } from "../providers";
import { runShell } from "../webview/agentExecution";
import { buildGoalEvaluationPrompt, getExtensionContextInfo } from "../agents/teamlead";

export enum AGENT_STATUS {
    STATUS_SUCCESS = "STATUS_SUCCESS",
    STATUS_FAILURE = "STATUS_FAILURE"
}

interface ExecutionResult {
    stdout: string;
    stderr: string;
}

interface CommandContext {
    goal_id?: string,
    goal?: String;
    command?: string;
    executionResult?: ExecutionResult;
    response?: String;
    timestamp?: number;
    reviewComments?: string; // Replace 'any' with a specific type (e.g., string, number) if known
    status?: AGENT_STATUS;
}

interface ReviewContext {
    latestAttempt: CommandContext;
    commandHistory: CommandContext[];
}

const MAX_ITERATIONS = 8;
const TERMINAL_STATUSES = ["ABORTED", "FAILED", "SUCCESSFUL"]
const REVIEW_RESPONSE_SCORE_THRESHOLD = 3.5;

export class ShellAgent {

    buildSystemPrompt(): string {
        const envInfo = getExtensionContextInfo();
        return `
            You are a File System agent which accepts user goals and tries to execute them using shell tool.
            Here is the basic info about the current shell execution environment.
            ${envInfo}

            Based on the conversation history you need to respond with the following attributes:

            {
                "goal" : <goal from input>,
                "response" : <empty if a command needs to be run>,
                "command" : <shell command that needs to be run with all args in a single json string, empty when status is aborted, failed, successful>
            }

            Your conversation history will occassionaly also contain inputs from your team lead who has analysed your previous attempts, use that to steer approach in right direction.
            DO NOT REPLY ANYTHING other than JSON.
            `;
    }


    async runAgenticLoop(
        client: AIProvider,
        goalId: String,
        userGoal: String,
        context: vscode.ExtensionContext
    ) : Promise<CommandContext> {
        let currentGoal = new String(userGoal);
        let commandRunHistory: CommandContext[] = []
        let subAgentChatManager = new ChatManager(context, "filesystem_agent.key");
        let teamLeadChatManager = new ChatManager(context, "teamlead_eval_agent.key");
        subAgentChatManager.clear();
        teamLeadChatManager.clear();
        for (let i = 0; i < MAX_ITERATIONS; i++) {
            let systemMsg = this.buildSystemPrompt();
            let reply = await subAgentChatManager.chat(
                client,
                { role: "system", content: systemMsg },
                { role: "user", content: currentGoal.toString() }
            );
            let parsedMsg = JSON.parse(reply)
            
            let response = parsedMsg["response"];
            let command = parsedMsg["command"];
            if (null != command) {
                const { stdout, stderr } = await runShell(command);
                let currCtx: CommandContext = {
                    goal_id: goalId.toString(),
                    "goal": currentGoal.toString(),
                    "command": command,
                    "executionResult": {
                        "stdout": stdout,
                        "stderr": stderr,
                    },
                    "response": response,
                    "timestamp": Date.now(),
                };

                const reviewCtx: ReviewContext = {
                    "latestAttempt": currCtx,
                    "commandHistory": commandRunHistory
                }

                let teamLeadReply = await teamLeadChatManager.chat(
                    client,
                    { role: "system", content: buildGoalEvaluationPrompt() },
                    { role: "user", content: JSON.stringify(reviewCtx) }
                );
                let teamLeadParsedMsg = JSON.parse(teamLeadReply);
                let reviewScore = teamLeadParsedMsg["subagent_response_score"] as number;
                if (reviewScore < REVIEW_RESPONSE_SCORE_THRESHOLD) {
                    currCtx.reviewComments = teamLeadParsedMsg["review_comments"]
                    currentGoal = teamLeadParsedMsg["modified_goal"]
                    commandRunHistory.push(currCtx)
                    continue;
                } else {
                    currCtx.status = AGENT_STATUS.STATUS_SUCCESS
                    return currCtx;
                }


            } else {
                console.log("Sub Agent Message " + parsedMsg)
                let result: CommandContext = commandRunHistory.at(-1)!;
                result = {
                    goal_id: goalId.toString(),
                    goal: result.goal,
                    timestamp: Date.now(),
                    response: "FAILURE: Goal finished without an executable command or terminal state response, check logs",
                    status: AGENT_STATUS.STATUS_FAILURE
                }
                return result
            }

        }

        if(commandRunHistory.length > 0){
            let result: CommandContext = commandRunHistory.at(-1)!;
            result = {
                goal_id: goalId.toString(),
                goal: result.goal,
                command: result.command,
                executionResult: result.executionResult,
                timestamp: Date.now(),
                response: "Goal couldn't be finished in requisite number of iterations",
                reviewComments: result.reviewComments,
                status: AGENT_STATUS.STATUS_FAILURE
            }
            return result
        }   

        return {
            goal_id: goalId.toString(),
            goal: userGoal,
            timestamp: Date.now(),
            response: "No commands run and Goal couldn't be finished in requisite number of iterations",
            status: AGENT_STATUS.STATUS_FAILURE
        };

    }

}

