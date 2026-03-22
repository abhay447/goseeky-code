import { HybridStore } from "../core/search/hybridStore";
import { GetEntityCode, RepoSearch } from "./codeAnalysisTools";
import { ShellExecute } from "./shellTools";
import { AgentTool } from "./types";


export class ToolRegistry {
    hybridStore: HybridStore;
    toolsList: (RepoSearch | GetEntityCode | ShellExecute)[];
    toolsMap: Map<string, AgentTool>;

    // toolsMap
    constructor(hybridStore: HybridStore) {
        this.hybridStore = hybridStore;

        this.toolsList = [
            new RepoSearch(hybridStore),
            new GetEntityCode(hybridStore),
            new ShellExecute()
        ]

        this.toolsMap = new Map(this.toolsList.map(t => [t.name, t] as const))

    }

    listToolsPrompt() {
        `
        Here is the tools list:
            ${JSON.stringify(this.toolsList)}
        Respond in the following format:
            {
                "tool" : <tool_name>,
                "arguments" : {ARGUMENTS_JSON_AS_PER_TOOL_DETAILS}
            }
        `
    }

    executeTool(toolName: string, args: string){
        if(!this.toolsMap.has(toolName)){
            throw `Invalid tool name selected : ${toolName}`
        }
        let tool = this.toolsMap.get(toolName)!;
        return tool.execute(args);
    }


}