import { AIProvider } from "../providers";
import { ToolRegistry } from "../tools/toolRegistry";
import * as vscode from "vscode";

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