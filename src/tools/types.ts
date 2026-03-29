import { AIProvider } from "../providers";

export interface AgentTool {
    name: string;
    toolDescription : string;
    shouldSummariseResult() : boolean;
    execute(input: Record<string, unknown>) : Promise<string>;
    setAiProvider(client: AIProvider): void;
}