import * as vscode from "vscode";
import * as os from 'os';
import * as process from 'process';
import { AIProvider, ChatManager } from "../providers";
import { ShellAgent, AGENT_STATUS } from "./shell_agent";
// import { runShell } from "../webview/agentExecution";

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

export function buildGoalEvaluationPrompt(): string {
    return `
You are a team lead who has access a goal and the execution results from a subagent for that task.
Your job is to evaluate firstly if the results look satisfactory to the goal.
Secondly look at the underlying commands , thinking , errors and results to make sugestions to subagent.
You will be provided with a history of commands run by subagent to steer the reasoning on the right direction.

Please respond in the following format.
{
    "goal" : <subagent goal from request>,
    "subagent_response_score" : <floating point, between 1 and 5>,
    "review_comments" : <describe what went wrong/right in this attempt, if it failed then why did it fail>,
    "modified_goal": <modified goal that will lead subagent to better command generation/execution, this be used by sugagent as the user goal in next iteration>
}

DO NOT REPLY ANYTHING other than JSON.
`;
}

export function buildTaskBreakdownPrompt(): string {
    return `
You are a team lead who is responsible for dealing with user queries and breaking them into smaller goals/tasks to be executed by a shell subagent.
You are an expert in planning and task breakdown.

1. Since the subagent is able to run only shell inline scripts thus all goals should be small enough to fit into a one line shell script.
2. Sometimes alongwith user query you will also get an existing task breakdown list and why it didn't work.
    a. Use that information to modify the plan. Retain relevant goal_id and goal_msgs as they will used to cache inputs.
3. Since goals can have a depenedencies amongst themselves, try to return goals in topologically sorted order.


Please respond in the following format.
{
    "query" : <subagent goal from request>,
    "goals" : [
        {
            "goal_id": <string, human readable, use underscore instead of space>,
            "goal_msg" : <meesage used by sub agent>,
            "parent_goal_ids" : [list of goal_ids whose output will be required to execute this goal]
        },
        {
            "goal_id": <string>,
            "goal_msg" : <>,
            "parent_goal_ids" : [list of goal_ids whose output will be required to execute this goal]
        },
        ...
    ]
}
DO NOT REPLY ANYTHING other than JSON.
`;
}

interface TaskBreakDownRequest {
    userQuery: String;

}

interface Goal {
    goal_id: string,
    goal_msg: string,
    output: string,
    parent_goal_ids: string[]
}

interface GoalsHolder {
    query: string,
    goals: Goal[]
}

const MAX_ITERATIONS = 8;
export class TeamLeadAgent {

    buildSubAgentSpecificGoal(goalCache: Map<String, Goal>, currentGoal: Goal) {
        let previousGoalInfo = ''
        for(const parentGoalId of currentGoal.parent_goal_ids){
            previousGoalInfo += ` 
                ${JSON.stringify(goalCache.get(parentGoalId))}
            `;
        }
        return `
            Your goal is : ${currentGoal.goal_msg},
            Here is some information about the previous goals:
            ${previousGoalInfo}
        `;
    }

    async runAgenticLoop(
        client: AIProvider,
        userQuery: String,
        context: vscode.ExtensionContext,
        webviewView: vscode.WebviewView,
    ) {
        let teamLeadChatManager = new ChatManager(context, "teamlead_plan_agent.key");
        let shellSubAgent = new ShellAgent();
        let currentQuery = userQuery;
        let goalCache = new Map<String, Goal>();
        teamLeadChatManager.clear();
        for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
            webviewView.webview.postMessage({ type: "agentIteration", iteration, max: MAX_ITERATIONS });
            let systemMsg = buildTaskBreakdownPrompt();
            let reply = await teamLeadChatManager.chat(
                client,
                { role: "system", content: systemMsg },
                { role: "user", content: currentQuery.toString() }
            );
            let goalsHolder = JSON.parse(reply) as GoalsHolder;
            let failedGoal = null;
            for(const goal of goalsHolder.goals){
                if(!goalCache.has(goal.goal_id)){
                    let subAgentResult = await shellSubAgent.runAgenticLoop(client,goal.goal_id,this.buildSubAgentSpecificGoal(goalCache, goal),context);
                    goal.output = JSON.stringify(subAgentResult);
                    if(subAgentResult.status == AGENT_STATUS.STATUS_FAILURE) {    
                        // should trigger replan                        
                        failedGoal = goal;
                        break;
                    } else {
                        goalCache.set(goal.goal_id, goal);
                    }
                }
            }

            if(failedGoal != null){
                // regen plan and supply failed step info.
                currentQuery += `
                    Previously failed goal ${JSON.stringify(failedGoal)}.
                `;
            } else {
                // all goals done successfully
                return "Task completed successfully"
            }
        }
    }

}

