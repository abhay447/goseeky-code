import { HybridStore } from "../core/search/hybridStore";
import { extractCodeSnippetFromFile } from "../core/parser/utils";
import { AgentTool } from "./types";
import { runShell } from "../utils/shellUtils";


export class ShellExecute implements AgentTool {
  name: string = 'ShellExecute'
  toolDescription: string = `
    This tools allows the agent to execute shell commands. Arguments {"shell_command" : <shell_script>}
  `
  async execute(input: string): Promise<string> {
    let jsonInput = JSON.parse(input);
    let result = await runShell(jsonInput["shell_command"]);
    return JSON.stringify(result)
  }

}