export interface AgentTool {
    name: string;
    toolDescription : string;
    execute(input: Record<string, unknown>) : Promise<string>;
}