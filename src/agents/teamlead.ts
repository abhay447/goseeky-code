import * as vscode from "vscode";
import * as os from 'os';
import * as process from 'process';
import { AIProvider, ChatManager } from "../providers";
import { ShellAgent, AGENT_STATUS } from "./shellAgent";
import { isStopped, resetStop } from "../webview/agentExecution";

// ── Shared env info ───────────────────────────────────────────────────────────
export function getExtensionContextInfo(): string {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    const currentFolder = workspaceFolders ? workspaceFolders[0].uri.fsPath : 'No workspace open';
    const operatingSystem = `${os.type()} (${os.platform()}) ${os.release()}`;
    const shell = process.env.SHELL || process.env.ComSpec || 'Unknown Shell';
    const dateTime = new Date().toLocaleString();
    return `current_working_directory: ${currentFolder}
operating_system: ${operatingSystem}
shell: ${shell}
date_time: ${dateTime}`;
}

// ── Prompts ───────────────────────────────────────────────────────────────────
export function buildGoalEvaluationPrompt(): string {
    return `
You are a team lead who has access to a goal and the execution results from a subagent for that task.
Your job is to evaluate firstly if the results look satisfactory to the goal.
Secondly look at the underlying commands, thinking, errors and results to make suggestions to the subagent.
You will be provided with a history of commands run by the subagent to steer the reasoning in the right direction.

Please respond in the following format.
{
    "goal" : <subagent goal from request>,
    "subagent_response_score" : <floating point, between 1 and 5>,
    "review_comments" : <describe what went wrong/right in this attempt, if it failed then why did it fail>,
    "modified_goal": <modified goal that will lead subagent to better command generation/execution, this will be used by subagent as the user goal in next iteration>
}

DO NOT REPLY ANYTHING other than JSON.
`;
}

export function buildTaskBreakdownPrompt(): string {
    return `
You are a team lead responsible for dealing with user queries and breaking them into smaller goals/tasks to be executed by a shell subagent.
You are an expert in planning and task breakdown.

1. Since the subagent is able to run only shell inline scripts, all goals should be small enough to fit into a one line shell script.
2. Sometimes along with the user query you will also get an existing task breakdown list and why it didn't work.
   a. Use that information to modify the plan. Retain relevant goal_id and goal_msgs as they will be used to cache inputs.
3. Since goals can have dependencies amongst themselves, return goals in topologically sorted order.
4. ALWAYS include at least one goal. For queries that require a text-only response
   (greetings, explanations, questions), compose the actual answer yourself and wrap
   it in a single echo goal. The goal_msg should be the complete answer, not instructions
   about how to answer.
   e.g. for "hi": { "goal_id": "greet", "goal_msg": "Hello! How can I help you today?", "parent_goal_ids": [] }
   The subagent will run: echo "<goal_msg>".
5. Be mindful that you and the sub agent are both backed by a smaller llm (9000 tokens).
    a. Always check filesizes before completely reading them.
    b. Don't read multiple files in same command.
    c. Don't read more than 500 lines at once.


Please respond in the following format.
{
    "query" : <user query>,
    "goals" : [
        {
            "goal_id": <string, human readable, use underscore instead of space>,
            "goal_msg" : <message used by subagent>,
            "parent_goal_ids" : [list of goal_ids whose output will be required to execute this goal]
        }
    ]
}
DO NOT REPLY ANYTHING other than JSON.
`;
}

// ── Types ─────────────────────────────────────────────────────────────────────
interface Goal {
    goal_id: string;
    goal_msg: string;
    output: string;
    parent_goal_ids: string[];
}

interface GoalsHolder {
    query: string;
    goals: Goal[];
}

const MAX_ITERATIONS = 8;

export class TeamLeadAgent {
    // ChatManager held as instance variable so history persists across user messages
    private teamLeadChatManager: ChatManager | null = null;

    private safeParseJSON(raw: string, label: string): any | null {
        try {
            const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
            return JSON.parse(cleaned);
        } catch (e) {
            console.error(`[TeamLeadAgent] Failed to parse ${label} JSON:`, raw);
            return null;
        }
    }

    clearHistory() {
        this.teamLeadChatManager?.clear();
    }

    buildSubAgentSpecificGoal(goalCache: Map<string, Goal>, currentGoal: Goal): string {
        let previousGoalInfo = '';
        for (const parentGoalId of currentGoal.parent_goal_ids) {
            const parent = goalCache.get(parentGoalId);
            if (parent) {
                previousGoalInfo += `\n${JSON.stringify(parent)}`;
            }
        }
        return `Your goal is: ${currentGoal.goal_msg}${previousGoalInfo ? `\n\nContext from previous goals:\n${previousGoalInfo}` : ''}`;
    }

    async runAgenticLoop(
        client: AIProvider,
        userQuery: string,
        context: vscode.ExtensionContext,
        webviewView: vscode.WebviewView
    ): Promise<string> {
        resetStop();

        // Initialise ChatManager once — reuse across calls to preserve conversation history
        if (!this.teamLeadChatManager) {
            this.teamLeadChatManager = new ChatManager(context, "teamlead_plan_agent");
        }

        const shellSubAgent = new ShellAgent();
        let currentQuery = userQuery;
        const goalCache = new Map<string, Goal>();

        for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
            if (isStopped()) {
                webviewView.webview.postMessage({ type: "agentDone", status: "STOPPED" });
                return "STOPPED";
            }

            webviewView.webview.postMessage({ type: "agentIteration", iteration: iteration + 1, max: MAX_ITERATIONS });

            let reply: string;
            try {
                reply = await this.teamLeadChatManager.chat(
                    client,
                    { role: "system", content: buildTaskBreakdownPrompt() },
                    { role: "user", content: currentQuery }
                );
            } catch (e: any) {
                webviewView.webview.postMessage({ type: "error", text: `TeamLead API error: ${e.message}` });
                return "FAILURE";
            }

            if (isStopped()) {
                webviewView.webview.postMessage({ type: "agentDone", status: "STOPPED" });
                return "STOPPED";
            }

            const goalsHolder = this.safeParseJSON(reply, "task breakdown") as GoalsHolder | null;
            if (!goalsHolder) {
                webviewView.webview.postMessage({ type: "error", text: "TeamLead returned invalid JSON for task breakdown" });
                return "FAILURE";
            }

            webviewView.webview.postMessage({ type: "agentGoal", goal: goalsHolder.query });

            let failedGoal: Goal | null = null;

            for (const goal of goalsHolder.goals) {
                if (isStopped()) {
                    webviewView.webview.postMessage({ type: "agentDone", status: "STOPPED" });
                    return "STOPPED";
                }

                if (goalCache.has(goal.goal_id)) { continue; }

                const parentsComplete = goal.parent_goal_ids.every(id => goalCache.has(id));
                if (!parentsComplete) {
                    failedGoal = goal;
                    webviewView.webview.postMessage({
                        type: "agentSubGoal",
                        title: `Skipped: ${goal.goal_id} — parents not complete`,
                        status: "ABORTED"
                    });
                    break;
                }

                webviewView.webview.postMessage({
                    type: "agentSubGoal",
                    title: goal.goal_id,
                    status: "INPROGRESS"
                });

                const subAgentGoal = this.buildSubAgentSpecificGoal(goalCache, goal);
                const subAgentResult = await shellSubAgent.runAgenticLoop(
                    client,
                    goal.goal_id,
                    subAgentGoal,
                    context,
                    webviewView
                );

                goal.output = JSON.stringify(subAgentResult);

                if (subAgentResult.status === AGENT_STATUS.STATUS_FAILURE) {
                    failedGoal = goal;
                    webviewView.webview.postMessage({
                        type: "agentSubGoal",
                        title: `Failed: ${goal.goal_id}`,
                        status: "ABORTED"
                    });
                    break;
                }

                goalCache.set(goal.goal_id, goal);
                webviewView.webview.postMessage({
                    type: "agentSubGoal",
                    title: goal.goal_id,
                    status: "FINISHED"
                });
            }

            if (failedGoal) {
                currentQuery = `${userQuery}\n\nPreviously failed goal: ${JSON.stringify(failedGoal)}. Please revise the plan.`;
            } else {
                const outputs = Array.from(goalCache.values())
                    .map(g => {
                        try {
                            const parsed = JSON.parse(g.output);
                            return parsed?.executionResult?.stdout?.trim()
                                || parsed?.response?.trim()
                                || "";
                        } catch {
                            return g.output ?? "";
                        }
                    })
                    .filter(Boolean)
                    .join("\n\n");

                if (outputs) {
                    webviewView.webview.postMessage({ type: "reply", text: outputs });
                }
                webviewView.webview.postMessage({ type: "agentDone", status: "FINISHED" });
                return "Task completed successfully";
            }
        }

        webviewView.webview.postMessage({
            type: "agentDone",
            status: "MAX_ITERATIONS",
            message: `Could not complete task in ${MAX_ITERATIONS} planning iterations.`
        });
        return "FAILURE";
    }
}