import * as vscode from "vscode";
import { StateGraph, END, Annotation } from "@langchain/langgraph";

import { AIProvider } from "../providers";
import { ToolRegistry } from "../tools/toolRegistry";
import { stringToSingleJsonBlock } from "../utils/jsonUtils";
import { isStopped, resetStop } from "../webview/agentExecution";
import { MultiStepAgent } from "./types";
import { ChatHistoryManager } from "../providers/chatHistoryManager";

// ─────────────────────────────────────────
// STATE DEFINITION
// ─────────────────────────────────────────
const AgentState = Annotation.Root({
  query: Annotation<string>({ reducer: (_, b) => b, default: () => "" }),
  messages: Annotation<any[]>({ reducer: (a, b) => [...a, ...b], default: () => [] }),
  toolResults: Annotation<any[]>({ reducer: (a, b) => [...a, ...b], default: () => [] }),
  steps: Annotation<number>({ reducer: (_, b) => b, default: () => 0 }),
  maxSteps: Annotation<number>({ reducer: (_, b) => b, default: () => 20 }),
  decision: Annotation<any>({ reducer: (_, b) => b, default: () => null }),
  answer: Annotation<string>({ reducer: (_, b) => b, default: () => "" }),
  agentError: Annotation<string>({ reducer: (_, b) => b, default: () => "" }),
});

type AgentStateType = typeof AgentState.State;

export class GoSeekyAgent implements MultiStepAgent {
  private chatHistoryManager: ChatHistoryManager;

  constructor(chatHistoryManager: ChatHistoryManager) {
    this.chatHistoryManager = chatHistoryManager;
  }
  clearHistory(): void {
    this.chatHistoryManager.clear();
  }
  // ─────────────────────────────────────────
  // JSON SAFE PARSE
  // ─────────────────────────────────────────
  private safeParseJSON(raw: string): { ok: true; value: any } | { ok: false; error: string } {
    try {
      const cleaned = stringToSingleJsonBlock(raw)!
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/, "")
        .trim();
      return { ok: true, value: JSON.parse(cleaned) };
    } catch (err) {
      const error = `JSON parse failed: ${err}. Raw: ${raw}`;
      console.error(error);
      return { ok: false, error };
    }
  }

  // ─────────────────────────────────────────
  // PLANNER NODE
  // ─────────────────────────────────────────
  private plannerNode(config: any) {
    return async (state: AgentStateType): Promise<Partial<AgentStateType>> => {
      const { client, toolRegistry, webviewView } = config;

      if (isStopped()) return { answer: "STOPPED" };

      const MAX_ATTEMPTS = 3;

      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        try {
          const isRetry = attempt > 0;
          const userPrompt = isRetry
            ? `Attempt ${attempt + 1}/${MAX_ATTEMPTS}: previous response could not be parsed as valid JSON. Fix the format and try again.\n\n${this.buildUserPrompt(state, toolRegistry)}`
            : this.buildUserPrompt(state, toolRegistry, this.chatHistoryManager);

          const messages = [
            { role: "system", content: this.buildPlannerSystemPrompt(toolRegistry) },
            ...(state.messages || []),
            { role: "user", content: userPrompt },
          ];

          const reply: string = await (client as any).chat(messages);
          webviewView.webview.postMessage({ type: "agentGoal", content: reply });

          const parsed = this.safeParseJSON(reply);
          if (!parsed.ok) continue; // retry

          return {
            decision: parsed.value,
            messages: [{ role: "assistant", content: parsed.value.reasoning }],
          };
        } catch (err) {
          console.error(`Planner attempt ${attempt + 1} threw:`, err);
        }
      }

      return { agentError: `Planner failed after ${MAX_ATTEMPTS} attempts` };
    };
  }
  // ─────────────────────────────────────────
  // TOOL NODE
  // ─────────────────────────────────────────
  private toolNode(config: any) {
    return async (state: AgentStateType): Promise<Partial<AgentStateType>> => {
      const { client, toolRegistry, webviewView } = config;

      if (isStopped()) return { answer: "STOPPED" };

      try {
        const result = await toolRegistry.executeTool(
          state.decision.tool_name,
          state.decision.arguments,
          state.decision.reasoning,
          state.query,
          client
        );

        webviewView.webview.postMessage({
          type: "toolResult",
          tool: result.tool,
          arguments: result.args,
          result: result.result || "(no output)",
        });

        return {
          toolResults: [result],
          steps: (state.steps || 0) + 1,
        };
      } catch (e: any) {
        return {
          agentError: e?.stack || "Tool failed",
          steps: (state.steps || 0) + 1,
        };
      }
    };
  }

  // ─────────────────────────────────────────
  // FINAL NODE
  // ─────────────────────────────────────────
  private finalNode(config: any) {
    return async (state: AgentStateType): Promise<Partial<AgentStateType>> => {
      const { webviewView } = config;
      const answer = state.decision?.answer || state.answer;

      webviewView.webview.postMessage({
        type: "agentDone",
        status: "FINISHED",
        message: answer,
      });

      return { answer };
    };
  }

  // ─────────────────────────────────────────
  // ERROR HANDLER NODE
  // ─────────────────────────────────────────
  private errorHandlerNode(config: any) {
    return async (state: AgentStateType): Promise<Partial<AgentStateType>> => {
      const { webviewView } = config;

      webviewView.webview.postMessage({
        type: "agentDone",
        status: "ERROR",
        message: state.agentError,
      });

      return { answer: state.agentError };
    };
  }

  // ─────────────────────────────────────────
  // ROUTER
  // ─────────────────────────────────────────
  private router(state: AgentStateType): string {
    if (state.agentError) return "errorHandler";
    if ((state.steps || 0) >= (state.maxSteps || 20)) return "__end__";
    if (state.decision?.type === "final") return "final";
    return "tool";
  }

  // ─────────────────────────────────────────
  // GRAPH
  // ─────────────────────────────────────────
  private createGraph(config: any) {
    const graph = new StateGraph(AgentState)
      .addNode("planner", this.plannerNode(config))
      .addNode("tool", this.toolNode(config))
      .addNode("final", this.finalNode(config))
      .addNode("errorHandler", this.errorHandlerNode(config))
      .addEdge("__start__", "planner")
      .addConditionalEdges("planner", this.router.bind(this), {
        tool: "tool",
        final: "final",
        errorHandler: "errorHandler",
        __end__: END,
      })
      .addEdge("tool", "planner")
      .addEdge("final", "__end__")
      .addEdge("errorHandler", "__end__");

    return graph.compile();
  }

  // ─────────────────────────────────────────
  // RUNNER
  // ─────────────────────────────────────────
  async runAgenticLoop(
    client: AIProvider,
    userQuery: string,
    toolRegistry: ToolRegistry,
    context: vscode.ExtensionContext,
    webviewView: vscode.WebviewView,
  ): Promise<string> {
    resetStop();

    const graph = this.createGraph({ client, toolRegistry, context, webviewView });

    const result = await graph.invoke({
      query: userQuery,
      messages: [],
      toolResults: [],
      steps: 0,
      maxSteps: 20,
    },{ recursionLimit: 100 });
    let agentResponse = "";
    console.log(JSON.stringify(result))
    if (typeof result?.answer === "string" && result.answer) {
      this.chatHistoryManager.addHistory(client, userQuery, result.answer);
      return result.answer;
    }
    // console.log(JSON.stringify(result))
    if (result.steps >= result.maxSteps) {
      this.chatHistoryManager.addHistory(client, userQuery, "Failed: max execution/planning steps reached");
      webviewView.webview.postMessage({
        type: "agentDone",
        status: "MAX_ITERATIONS",
        message: "Could not complete task within step limit.",
      });
      return "FAILURE";
    }

    console.log("Final agent result", result);
    this.chatHistoryManager.addHistory(client, userQuery, "Failed:could not complete task");
    webviewView.webview.postMessage({
      type: "error",
      status: "FAILURE",
      text: "Could not complete task",
    });

    return "FAILURE";
  }

  // ─────────────────────────────────────────
  // PROMPTS
  // ─────────────────────────────────────────
  private buildUserPrompt(state: AgentStateType, toolRegistry: ToolRegistry, chatHistoryManager?: ChatHistoryManager) {
    return `
    Query:
    ${state.query}

    Steps: ${state.steps || 0}

    Tool Results:
    ${JSON.stringify(state.toolResults || [])}

    Tools:
    ${toolRegistry.listToolsPrompt()}

    Recent Conversation History:
    ${chatHistoryManager ? chatHistoryManager.getHistory().map(h => `User: ${h.userQuery}\nAgent: ${h.agentResponse}`).join("\n\n") : "No history."}

    STRICT JSON ONLY.
    `;
  }

  private buildPlannerSystemPrompt(toolRegistry: ToolRegistry) {
    return `
    You are an expert agent.

    ${toolRegistry.listToolsPrompt()}

    ALWAYS RETURN A JSON IN THIS FORMAT :
    {
      "type": "tool" | "final", 
      "reasoning": "...",
      "tool_name": "...", // only when type is "tool".
      "arguments": {},
      "answer": "..."
    }

    Response instructions:
      - NEVER RETURN PLAIN TEXT, XML, HTML.
      - Use type=final if you want to return the answer to the user and no tool calls are pending. 
      - Any tool_name and args should be ignored if type=final, only answer and reasoning will be considered by the system.
      - DO NOT SendToUser with final since incase of final only answer and reasoning is expected, tool_name and arguments will be ignored by the system.
`;
  }
}