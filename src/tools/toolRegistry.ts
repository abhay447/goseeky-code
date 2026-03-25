import { HybridStore } from "../core/search/hybridStore";
import { AIProvider } from "../providers";
import { AnalyseEntityCode, GetEntityCode, RepoSearch } from "./codeAnalysisTools";
import { SendToUser } from "./ioTools";
import { ShellExecute } from "./shellTools";
import { AgentTool } from "./types";


export interface ToolResult {
    tool: string;
    args: string;
    result: string;
}

export class ToolRegistry {
    hybridStore: HybridStore;
    toolsList: (RepoSearch | GetEntityCode | ShellExecute)[];
    toolsMap: Map<string, AgentTool>;
    toolsMetaMap: Map<string, string>;

    // toolsMap
    constructor(hybridStore: HybridStore) {
        this.hybridStore = hybridStore;

        this.toolsList = [
            new RepoSearch(hybridStore),
            // new GetEntityCode(hybridStore),
            new ShellExecute(),
            new AnalyseEntityCode(hybridStore),
            new SendToUser()
        ]

        this.toolsMap = new Map(this.toolsList.map(t => [t.name, t] as const))
        this.toolsMetaMap = new Map(this.toolsList.map(t => [t.name, t.toolDescription] as const))
        console.log(this.toolsList);
        console.log(this.toolsMetaMap);

        for (const [k, v] of this.toolsMetaMap) {
        console.log(k, v)
        }

    }

    listToolsPrompt() {
        return `
        ${JSON.stringify(Object.fromEntries(this.toolsMetaMap), null, 2)}
        `
    }

    async summariseToolResult(client: AIProvider, tool: string, args: string, result: string){
        const prompt = `
        You will be given a tool, args and it's execution output.
        Summarise the result of the  tool execution.
        Summarised result should be less than 1000 chars.
        RETURN SUMARRIZED result string only.
        `
        return await client?.chat(
        [
            {"role" : "system", "content": prompt,},
            {"role" : "user", "content": `tool: ${tool} || args: ${args}  || result: ${result}`,}
        ]
        )!;
        
    }

    async executeTool(toolName: string, args: Record<string, unknown>, client: AIProvider){
        if(!this.toolsMap.has(toolName)){
            throw `Invalid tool name selected : ${toolName}`
        }
        let tool = this.toolsMap.get(toolName)!;
        tool.setAiProvider(client);
        let result = await tool.execute(args);
        if(result.length > 1000) {
            result = await this.summariseToolResult(client, toolName, JSON.stringify(args), result);
        }
        console.log(`tool : ${tool}, result: ${result}`);
        return {
            "tool" : toolName,
            "args" : JSON.stringify(args),
            "result": result
        };
    }


}