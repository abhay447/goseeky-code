import { Chat } from "@xenova/transformers";
import { AIProvider } from "../providers";
import { ToolRegistry } from "../tools/toolRegistry";
import * as vscode from "vscode";
import { ChatHistoryManager } from "../providers/chatHistoryManager";

export interface MultiStepAgent {
    clearHistory(): unknown;
    runAgenticLoop(
        client: AIProvider,
        userQuery: string,
        toolRegistry: ToolRegistry,
        context: vscode.ExtensionContext,
        webviewView: vscode.WebviewView
    ): Promise<string>;
}

export interface AgentNodeConfig {
    client: AIProvider;
    toolRegistry: ToolRegistry;
    webviewView: vscode.WebviewView;
}