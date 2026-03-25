import * as vscode from "vscode";
import * as os from 'os';
import * as process from 'process';
import { AIProvider, ChatManager, ChatMessage } from "../providers";
import { CodeAgent, AGENT_STATUS } from "./codeAgent";
import { isStopped, resetStop } from "../webview/agentExecution";
import { ToolRegistry } from "../tools/toolRegistry";
import { stringToSingleJsonBlock } from "../utils/jsonUtils";

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

export function buildPlannerSystemPrompt(toolRegistry: ToolRegistry) {
    return `
        You are an expert but helpful software engineering agent operating on a codebase.

        Your goal is to solve the user's query by iteratively leveraging the tools supplied .

        You must reason step-by-step and choose the optimal next action.

        ---

        ## Strategy Rules
        - Pick tools carefully.
        - Always add reasons to your responses.
        - Avoid unnecessary exploration
        - Keep sending out intermdiate thoughts and approaches to user whenever necessary.
        - Assume read tools to be idempotent unless you add a write action in between. So Do not repeat read tools with same args. Look for fallbacks.

        ---

        ## When to STOP

        Return final answer when:
        - You have enough information to confidently answer
        - OR no new useful entities remain

        ---

        ## Available tools
        ${toolRegistry.listToolsPrompt()}

        ---

        ## Output format (STRICT JSON ONLY)

        {
            "type": "tool" | "final",
            "tool_name" : <tool_name selected from "Available tools", required if "type" is "tool">,
            "reasoning": "<REQUIRED: explain why this step is chosen>",
            "arguments" : {ARGUMENTS_JSON as per Argument schema definition for the tool in "Available tools", should be valid json, required if "type" is "tool"}

            // if type = final
            "answer": string,
        }

        ALWAYS INCLUDE reasoning.
        * If type=tool then always include tool_name and arguments.
        * arguments should AWLAYS BE  as per Argument schema definition for the tool in "Available tools".
        * Your response will be rejected if:
            - reasoning is missing
            - reasoning is empty
            - reasoning is shorter than 10 words
            - tool_name is not correct.
            - arguments DO NOT Match prescribed SCHEMA.
            - answer is missing and type is final.

        * DO NOT REPLY ANYTHING other than JSON.


        DO NOT REPLY ANYTHING other than JSON.
    `;
}