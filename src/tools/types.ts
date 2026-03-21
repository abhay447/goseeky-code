export interface AgentTool {
    name: string;
    toolDescription : string;
    execute(input: string) : Promise<string>;
}