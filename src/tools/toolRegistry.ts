import { HybridStore } from "../core/search/hybridStore";
import { GetEntityCode, RepoSearch } from "./codeAnalysisTools";
import { ShellExecute } from "./shellTools";
import { AgentTool } from "./types";


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
            new GetEntityCode(hybridStore),
            new ShellExecute()
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
        Here is the tools list:
        ${JSON.stringify(Object.fromEntries(this.toolsMetaMap), null, 2)}

        Respond in the following format:
        {
            "tool" : <tool_name>,
            "arguments" : {ARGUMENTS_JSON_AS_PER_TOOL_DETAILS}
        }
        `
    }

    async executeTool(toolName: string, args: Record<string, unknown>){
        if(!this.toolsMap.has(toolName)){
            throw `Invalid tool name selected : ${toolName}`
        }
        let tool = this.toolsMap.get(toolName)!;
        let result = await tool.execute(args);
        console.log(`tool : ${tool}, result: ${result}`);
        return result;
    }


}