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
        Your job is to:
            1. look at the available tools and current goal/sub goal .
            2. Pick the correct tool and correct args which help us solve the goal/sub goal.
        Respond in the following format:
            {
                "tool" : <tool_name>,
                "arguments" : {ARGUMENTS_JSON_AS_PER_TOOL_DETAILS}
            }
        Here is the tools list:
            ${JSON.stringify(this.toolsList)}
        DO NOT RESPOND WITH ANYTHING OTHER THAN JSON.
        `
    }

    executeTool(toolsJson : string){
        let invocationJSON = JSON.parse(toolsJson)
        let toolName = invocationJSON['tool']
        if(!toolName || !this.toolsMap.has(toolName)){
            throw `Invalid tool name selected : ${toolName}`
        }
        let tool = this.toolsMap.get(invocationJSON['tool'])!;
        let args = invocationJSON["arguments"]!;
        return tool.execute(JSON.stringify(args));
    }


}