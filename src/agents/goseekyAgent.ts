import * as vscode from "vscode";
import { AIProvider, ChatManager, ChatMessage } from "../providers";
import { resetStop } from "../webview/agentExecution";
import { ToolRegistry, ToolResult } from "../tools/toolRegistry";
import { stringToSingleJsonBlock } from "../utils/jsonUtils";
import { buildPlannerSystemPrompt } from "./prompts";

// ── Types ─────────────────────────────────────────────────────────────────────
interface AgentState {
    query: string;

    // evolving context
    messages: ChatMessage[];

    // tool outputs
    toolResults: ToolResult[];

    // control
    steps: number;
    maxSteps: number;

    // final output
    answer?: string;
};

interface PlanningDecision {
    type: string;
    tool_name?: string;
    arguments?: Record<string, unknown>;

    answer?: string;
    reasoning: string;
}

const MAX_STEPS = 20;

export class GoSeekyAgent {
    // ChatManager held as instance variable so history persists across user messages
    // private teamLeadChatManager: ChatManager | null = null;

    private safeParseJSON(raw: string, label: string): any | null {
        try {
            const cleaned = stringToSingleJsonBlock(raw)!.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
            return JSON.parse(cleaned);
        } catch (e) {
            let msg = `[TeamLeadAgent] Failed to parse ${label} JSON:${raw}`
            console.error(msg);
            throw msg;
        }
    }

    clearHistory() {
        // this.teamLeadChatManager?.clear();
    }

    async runAgenticLoop(
        client: AIProvider,
        userQuery: string,
        toolRegistry: ToolRegistry,
        context: vscode.ExtensionContext,
        webviewView: vscode.WebviewView
    ): Promise<string> {
        resetStop();

        let state: AgentState = {
            query: userQuery,
            messages: [],
            toolResults: [],
            steps: 0,
            maxSteps: MAX_STEPS
        }
        let chatMsgs: ChatMessage[] = []
        for (let iteration = 0; iteration < MAX_STEPS; iteration++) {
            const decision: PlanningDecision = await this.runPlanner(client, state, toolRegistry, chatMsgs);
            console.log(JSON.stringify(decision))
            chatMsgs.push({ "role": "user", "content": `Agent suggested me to :${decision.reasoning}` });

            if (decision.type === "tool") {
                const result = await toolRegistry.executeTool(decision.tool_name!, decision.arguments!, client);
                webviewView?.webview.postMessage({
                    type: "toolResult",
                    tool: result.tool,
                    arguments: result.args,
                    result: result.result || "(no output)",
                });
                // state = updateStateWithTool(state, decision, result);
                state.toolResults.push(result);
                state.steps += 1;
                chatMsgs.push({ "role": "user", "content": "Executed the requested tool and added results to state" });
            } else if (decision.type === "final") {
                state.answer = decision.answer;
                webviewView.webview.postMessage({
                    type: "agentDone",
                    status: "FINISHED",
                    message: decision.answer
                }); 

                return "SUCCESS";
            }
        }

        webviewView.webview.postMessage({
            type: "agentDone",
            status: "MAX_ITERATIONS",
            message: `Could not complete task in ${MAX_STEPS} planning iterations.`
        });
        return "FAILURE";
    }

    async runPlanner(client: AIProvider, state: AgentState, toolRegistry: ToolRegistry, chatMsgs: ChatMessage[]): Promise<PlanningDecision> {
        let plannerPrompt = buildPlannerSystemPrompt(toolRegistry);
        console.log("Planner Prompt: " + plannerPrompt);
        let planReply = await client.chat([
            { "role": "system", "content": plannerPrompt },
            ...chatMsgs,
            { "role": "user", "content": buildUserPrompt(state, toolRegistry) }
        ]);
        console.log(planReply);
        return this.safeParseJSON(planReply, "Planner") as PlanningDecision;

    }
}

function buildUserPrompt(state: AgentState, toolRegistry: ToolRegistry): string {
    const { query, toolResults, steps, maxSteps } = state;

    const searchResults = toolResults.filter(t => t.tool === "RepoSearch");
    const analyzeResults = toolResults.filter(t => t.tool === "AnalyseEntityCode");
    const shellResults = toolResults.filter(t => t.tool === "ShellExecute");

    // --- Visited entities ---
    const visitedEntities = new Set<string>();
    for (const t of analyzeResults) {
        try {
            const args = JSON.parse(t.args);
            if (args.entityId) visitedEntities.add(args.entityId);
        } catch { }
    }

    // --- Candidates from search ---
    const candidates: { id: string; reason?: string }[] = [];
    for (const t of searchResults.slice(-2)) {
        try {
            const parsed = JSON.parse(t.result);
            for (const item of parsed.slice(0, 5)) {
                if (!visitedEntities.has(item.id)) {
                    candidates.push({
                        id: item.id,
                        reason: item.description || item.name || ""
                    });
                }
            }
        } catch { }
    }

    const uniqueCandidates = Array.from(
        new Map(candidates.map(c => [c.id, c])).values()
    ).slice(0, 5);

    // --- Analysis summary ---
    const analysisSummary = analyzeResults
        .slice(-3)
        .map(t => {
            try {
                const args = JSON.parse(t.args);
                return `- ${args.entityId}: ${t.result.slice(0, 200)}`;
            } catch {
                return "";
            }
        })
        .filter(Boolean)
        .join("\n");

    // --- Shell summary ---
    const shellSummary = shellResults
        .slice(-2)
        .map(t => `- Command: ${t.args}\n  Output: ${t.result.slice(0, 200)}`)
        .join("\n");

    // --- Search summary ---
    const searchSummary = searchResults
        .slice(-1)
        .map(t => {
            try {
                const parsed = JSON.parse(t.result);
                return parsed
                    .slice(0, 5)
                    .map((r: any) => `- ${r.id}: ${r.description || ""}`)
                    .join("\n");
            } catch {
                return "";
            }
        })
        .join("\n");

    return `
## TASK
Solve the following query using the available tools.

Query:
${query}

---

## CURRENT STATE

Steps Taken: ${steps}/${maxSteps}

---

### Visited Entities (DO NOT REVISIT)
${[...visitedEntities].join("\n") || "None"}

---

### Candidate Entities (Next Best Options)
${uniqueCandidates
            .map(c => `- ${c.id}${c.reason ? `: ${c.reason}` : ""}`)
            .join("\n") || "None"}

---

### Recent Search Results
${searchSummary || "None"}

---

### Code Understanding So Far
${analysisSummary || "None"}

---

### Execution Results (if any)
${shellSummary || "None"}

---

## RULES

- Do NOT analyze the same entity twice
- Prefer analysis over repeated search
- Avoid unnecessary shell commands
- Use shell only if it adds real value (e.g., testing behavior, running code)
- If enough information is available → respond
- Assume read tools to be idempotent unless you add a write action in between. So Do not repeat read tools with same args. Look for fallbacks.

---

## Available tools
${toolRegistry.listToolsPrompt()}

---

## Output format (STRICT JSON ONLY)

{
    "type": "tool" | "final",
    "reasoning": "<REQUIRED: explain why this step is chosen>",
    "tool_name" : <tool_name selected from "Available tools", required if "type" is "tool">,
    "arguments" : {ARGUMENTS_JSON as per Argument schema definition for the tool in "Available tools", should be valid json, required if "type" is "tool"}

    // if type = final
    "answer": string,
}

* If type=tool then always include tool_name and arguments.
* arguments should AWLAYS BE  as per Argument schema definition for the tool in "Available tools".
* Your response will be rejected if:
    - reasoning is missing when
    - reasoning is empty
    - reasoning is shorter than 10 words
    - tool_name is not correct.
    - arguments DO NOT Match prescribed SCHEMA.
    - answer is missing and type is final.

* DO NOT REPLY ANYTHING other than JSON.
`;
}